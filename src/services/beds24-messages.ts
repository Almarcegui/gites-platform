// Messagerie des canaux OTA par Beds24 (Airbnb, Booking.com, Vrbo, Expedia) —
// une seule boîte de réception dans la plateforme (décision de Julien, 10/10/2026).
//
// Beds24 n'a pas de webhook pour les messages : le cron les relève, UNE fois par
// passage et pour tout le compte (quota : crédits sur 5 minutes glissantes,
// partagés par tous les jetons — cf. findings Beds24 § 4 et § 9).
//
//   relève   GET  /bookings/messages?filter=unread&maxAge=N   (N = jours depuis
//            la dernière relève réussie + 1, 30 au premier passage, 999 au plus ;
//            l'API n'a pas de « modifiedFrom » pour les messages : la fenêtre
//            maxAge et le dédoublonnage par identifiant Beds24 en tiennent lieu)
//   lu       POST /bookings/messages [{id, read:true}…]  (un seul appel par
//            relève ; écriture, donc production seulement — beds24WritesAllowed)
//   réponse  POST /bookings/messages [{bookingId, message}]
//
// Chaque message Beds24 est gardé dans channel_messages ; ceux du voyageur et de
// l'hôte sont recopiés dans `messages` (channel 'beds24'), rattachés à notre
// réservation par external_uid 'beds24:<id>' : le fil, la liste « À répondre » et
// la réponse du back-office sont ceux qui existent déjà.
// Quota journalisé : app_settings 'beds24_messages_last' à chaque relève, et une
// ligne d'audit quand un message arrive, qu'une relève échoue ou que la réserve
// de crédits passe sous 20 %.

import { sqlNow } from "../core/dates";
import { audit, getBookingByExternalUid, type MessageRow } from "../db/repo";
import { Beds24Error, beds24Configured, beds24Fetch, beds24WritesAllowed, readBeds24Credit, type Beds24Credit } from "./beds24";
import { getSetting, setSetting } from "./settings";

/** Un message tel que le rend GET /bookings/messages (schéma `message` de l'API v2). */
export interface Beds24Message {
  id: number;
  bookingId: number;
  propertyId?: number | null;
  roomId?: number | null;
  time?: string | null;
  read?: boolean | null;
  message?: string | null;
  source?: string | null;
  attachmentName?: string | null;
}

export const MESSAGES_STATE_KEY = "beds24_messages_last";
const FIRST_MAX_AGE_DAYS = 30;
/** Pages lues au plus par relève (le reste passe au cycle suivant, puisque les
 *  messages lus sortent du filtre « unread »). */
const MAX_PAGES = 3;
const LOW_CREDIT_RATIO = 0.2;

export interface ChannelMessagesResult {
  ran: boolean;
  fetched: number;
  imported: number;
  /** dont rattachés à une de nos réservations */
  linked: number;
  markedRead: number;
  /** « bloqué hors production » quand l'écriture vers Beds24 n'est pas permise */
  markRead: "ok" | "aucun" | "bloqué hors production" | "reporté (quota)" | "échec";
  credit: Beds24Credit | null;
}

type Source = "guest" | "host" | "internalNote" | "system";

function normSource(s: string | null | undefined): Source {
  return s === "host" || s === "internalNote" || s === "system" ? s : "guest";
}

/** Horodatage Beds24 (ISO) → format SQL UTC du projet ; maintenant si illisible. */
function toSqlTime(time: string | null | undefined, now: Date): string {
  const t = time ? Date.parse(time) : Number.NaN;
  return sqlNow(Number.isNaN(t) ? now : new Date(t));
}

function maxAgeDays(lastAt: string | null, now: Date): number {
  if (!lastAt) return FIRST_MAX_AGE_DAYS;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return FIRST_MAX_AGE_DAYS;
  const days = Math.ceil((now.getTime() - t) / 86_400_000) + 1;
  return Math.min(999, Math.max(1, days));
}

/** Rattache par l'identifiant de réservation Beds24, et range sous le bon domaine. */
async function context(db: D1Database, m: Beds24Message) {
  const booking = await getBookingByExternalUid(db, `beds24:${m.bookingId}`);
  let propertyId = booking?.propertyId ?? null;
  if (propertyId == null && m.propertyId != null) {
    propertyId =
      (await db.prepare("SELECT id FROM properties WHERE beds24_property_id = ?1").bind(m.propertyId).first<{ id: number }>())?.id ?? null;
  }
  return { booking, propertyId };
}

/** Enregistre un message Beds24 (et sa copie dans `messages`) ; false s'il était déjà connu. */
async function ingest(db: D1Database, m: Beds24Message, now: Date): Promise<{ inserted: boolean; linked: boolean }> {
  const known = await db.prepare("SELECT id FROM channel_messages WHERE beds24_message_id = ?1").bind(m.id).first();
  if (known) return { inserted: false, linked: false };
  const source = normSource(m.source);
  const direction = source === "guest" ? "in" : source === "host" ? "out" : "note";
  const text = (m.message ?? "").trim() || (m.attachmentName ? `(pièce jointe : ${m.attachmentName})` : "(message vide)");
  const sentAt = toSqlTime(m.time, now);
  const { booking, propertyId } = await context(db, m);
  const label = booking?.channelLabel ?? "Canal Beds24";

  // Les deux lignes partent ensemble (une transaction) : jamais de copie dans la
  // boîte sans sa trace Beds24, ni l'inverse. Deux relèves concurrentes : la
  // seconde bute sur l'unicité de beds24_message_id et tout son lot est défait.
  const channelRow = (messageIdSql: string) =>
    db
      .prepare(
        `INSERT INTO channel_messages (beds24_message_id, beds24_booking_id, booking_id, property_id, message_id,
                                       source, direction, channel_label, body_text, read, sent_at)
         VALUES (?1, ?2, ?3, ?4, ${messageIdSql}, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(m.id, m.bookingId, booking?.id ?? null, propertyId, source, direction, label, text, m.read ? 1 : 0, sentAt);
  const statements: D1PreparedStatement[] = [];
  if (direction !== "note") {
    const guestName = (booking?.guestName ?? "").trim();
    const pseudo = `beds24:${m.bookingId}`;
    const guestAddr = booking?.guestEmail || pseudo;
    const subject = booking ? `${label} — ${booking.reference}` : `${label} — réservation Beds24 ${m.bookingId}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (property_id, message_id, direction, channel, from_email, from_name, to_email,
                                 subject, body_text, booking_id, guest_id, status, delivery, received_at)
           VALUES (?1, ?2, ?3, 'beds24', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          propertyId,
          `<beds24-${m.id}@beds24>`,
          direction,
          direction === "in" ? guestAddr : label,
          direction === "in" ? guestName || label : "Vous (Beds24)",
          direction === "in" ? null : guestAddr,
          subject,
          text,
          booking?.id ?? null,
          booking?.guestId ?? null,
          direction === "in" ? "nouveau" : "traité",
          direction === "out" ? "beds24" : null,
          sentAt,
        ),
      channelRow("last_insert_rowid()"),
    );
  } else {
    statements.push(channelRow("NULL"));
  }
  try {
    await db.batch(statements);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) return { inserted: false, linked: false };
    throw e;
  }
  return { inserted: true, linked: booking != null };
}

/** Une réponse POST /bookings/messages est un tableau d'éléments
 *  { success, errors } : beds24Fetch ne voit les refus que sur un objet. */
function arrayFailures(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((x) => x && typeof x === "object" && (x as { success?: unknown }).success === false)
    .map((x) => JSON.stringify((x as { errors?: unknown }).errors ?? "refusé").slice(0, 200));
}

/** La relève du cron. Sans Beds24 configuré : ne fait rien, sans réseau. */
export async function pullChannelMessages(env: Env, now: Date = new Date()): Promise<ChannelMessagesResult> {
  const db = env.DB;
  const result: ChannelMessagesResult = {
    ran: false, fetched: 0, imported: 0, linked: 0, markedRead: 0, markRead: "aucun", credit: null,
  };
  if (!(await beds24Configured(env))) return result;
  result.ran = true;

  let state: { at?: string } = {};
  try {
    state = JSON.parse((await getSetting(db, MESSAGES_STATE_KEY)) ?? "{}") as { at?: string };
  } catch {
    state = {};
  }
  const maxAge = maxAgeDays(state.at ?? null, now);
  const onHeaders = (h: Headers) => {
    result.credit = readBeds24Credit(h);
  };

  // Réserve de crédits : la page suivante et le marquage attendent le cycle
  // suivant dès qu'elle ne couvre plus largement un appel (quota partagé avec
  // le pull des réservations et le push des calendriers).
  const reserveOk = (): boolean => {
    const c = result.credit;
    if (!c || c.remaining == null) return true;
    return c.remaining > Math.max(5, (c.cost ?? 1) * 3);
  };
  const unread: number[] = [];
  let complete = false;
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (page > 1 && !reserveOk()) break;
      const res = await beds24Fetch<{ data?: Beds24Message[]; pages?: { nextPageExists?: boolean } }>(env, "/bookings/messages", {
        query: { filter: "unread", maxAge: String(maxAge), ...(page > 1 ? { page: String(page) } : {}) },
        onHeaders,
      });
      const list = (res.data ?? []).filter((m) => Number.isInteger(m?.id) && Number.isInteger(m?.bookingId));
      result.fetched += list.length;
      for (const m of list) {
        const r = await ingest(db, m, now);
        if (r.inserted) result.imported += 1;
        if (r.linked) result.linked += 1;
        if (!m.read) unread.push(m.id);
      }
      if (!res.pages?.nextPageExists) {
        complete = true;
        break;
      }
    }
  } catch (e) {
    await audit(db, "cron", "beds24.messages.error", undefined, {
      error: e instanceof Error ? e.message : String(e),
      credit: result.credit,
    });
    await setSetting(db, MESSAGES_STATE_KEY, JSON.stringify({ ...state, error: sqlNow(now), credit: result.credit }));
    throw e;
  }

  // Marquer lus chez Beds24, en un seul appel : la boîte de réception, c'est ici.
  if (unread.length > 0) {
    if (!beds24WritesAllowed(env)) {
      result.markRead = "bloqué hors production";
    } else if (!reserveOk()) {
      result.markRead = "reporté (quota)";
    } else {
      try {
        const res = await beds24Fetch<unknown>(env, "/bookings/messages", {
          method: "POST",
          body: unread.map((id) => ({ id, read: true })),
          onHeaders,
        });
        const failures = arrayFailures(res);
        if (failures.length > 0) throw new Beds24Error(`marquage lu refusé : ${failures.slice(0, 3).join(" · ")}`);
        for (const id of unread) {
          await db.prepare("UPDATE channel_messages SET read = 1 WHERE beds24_message_id = ?1").bind(id).run();
        }
        result.markedRead = unread.length;
        result.markRead = "ok";
      } catch (e) {
        // non bloquant : le dédoublonnage par identifiant évite tout doublon au cycle suivant
        result.markRead = "échec";
        await audit(db, "cron", "beds24.messages.read.error", undefined, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // La fenêtre ne recule que si tout ce qui a été lu est marqué lu chez Beds24 :
  // sinon un message resté « non lu » sortirait de la fenêtre maxAge suivante
  // et ne serait plus jamais marqué. (Le dédoublonnage évite toute copie double.)
  // Pagination interrompue (quota, 3 pages) : idem, la fenêtre attend.
  const cursorAt = complete && (result.markRead === "ok" || result.markRead === "aucun") ? now.toISOString() : state.at;
  await setSetting(db, MESSAGES_STATE_KEY, JSON.stringify({
    ...(cursorAt ? { at: cursorAt } : {}), seenAt: now.toISOString(), maxAge,
    fetched: result.fetched, imported: result.imported, markRead: result.markRead, credit: result.credit,
  }));
  const c = result.credit;
  const low = c?.limit != null && c.remaining != null && c.limit > 0 && c.remaining < c.limit * LOW_CREDIT_RATIO;
  if (result.imported > 0 || low) {
    await audit(db, "cron", low ? "beds24.messages.credit_bas" : "beds24.messages", undefined, {
      imported: result.imported, linked: result.linked, markRead: result.markRead, maxAge, credit: c,
    });
  }
  return result;
}

/** Réponse à un message venu d'un canal : part chez Beds24 (donc chez Airbnb,
 *  Booking…), puis s'inscrit dans le fil. Lève Beds24Error si Beds24 refuse ou
 *  si l'écriture n'est pas permise (hors production). */
export async function replyOnChannel(
  env: Env,
  original: MessageRow,
  text: string,
): Promise<{ id: number; delivery: "beds24" }> {
  const db = env.DB;
  const link = await db
    .prepare("SELECT beds24_booking_id, channel_label FROM channel_messages WHERE message_id = ?1 LIMIT 1")
    .bind(original.id)
    .first<{ beds24_booking_id: number; channel_label: string | null }>();
  if (!link) throw new Beds24Error("message de canal sans réservation Beds24 connue : réponse impossible");
  // Texte brut (les canaux n'acceptent pas de HTML) : envoyé tel quel.
  const message = text.trim();
  if (message.length < 2) throw new Beds24Error("réponse vide");
  if (!beds24WritesAllowed(env)) {
    throw new Beds24Error("écriture Beds24 bloquée hors production — poser BEDS24_WRITE_ENABLED=true pour forcer");
  }
  const nowSql = sqlNow();
  // La réponse est d'abord inscrite « en cours » (delivery 'pending'), puis
  // envoyée : un échec SQL après l'envoi ne peut plus provoquer de renvoi.
  // Même texte, même réservation, dans les 2 dernières minutes (double clic,
  // deux onglets) : l'inscription n'a pas lieu, et rien ne part. Contrôle et
  // inscription sont UNE transaction (le lot), donc sans course possible.
  const label = link.channel_label ?? original.canal ?? "Canal Beds24";
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO messages (property_id, direction, channel, from_email, from_name, to_email, subject, body_text,
                               booking_id, guest_id, status, delivery, received_at)
         SELECT ?1, 'out', 'beds24', ?2, 'Vous', ?3, ?4, ?5, ?6, ?7, 'traité', 'pending', ?8
          WHERE NOT EXISTS (SELECT 1 FROM channel_messages WHERE beds24_booking_id = ?9 AND direction = 'out'
                              AND body_text = ?5 AND sent_at > datetime(?8, '-2 minutes'))`,
      )
      .bind(
        original.propertyId, label, original.fromEmail,
        original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`,
        message, original.bookingId, original.guestId, nowSql, link.beds24_booking_id,
      ),
    db
      .prepare(
        `INSERT INTO channel_messages (beds24_message_id, beds24_booking_id, booking_id, property_id, message_id,
                                       source, direction, channel_label, body_text, read, sent_at)
         SELECT NULL, ?1, ?2, ?3, last_insert_rowid(), 'host', 'out', ?4, ?5, 1, ?6 WHERE changes() = 1`,
      )
      .bind(link.beds24_booking_id, original.bookingId, original.propertyId, label, message, nowSql),
  ]);
  if (!ins || ins.meta.changes !== 1) throw new Beds24Error("cette réponse vient déjà de partir (ou est en train de partir)");
  const id = ins.meta.last_row_id;
  try {
    const res = await beds24Fetch<unknown>(env, "/bookings/messages", {
      method: "POST",
      body: [{ bookingId: link.beds24_booking_id, message }],
    });
    const failures = arrayFailures(res);
    if (failures.length > 0) throw new Beds24Error(`Beds24 a refusé la réponse : ${failures.join(" · ")}`);
  } catch (e) {
    // Refus EXPLICITE de Beds24 (4xx ou élément refusé) : rien n'est
    // parti, la réservation locale « en cours » s'efface (elle n'a jamais été
    // une donnée métier) et le texte reste dans l'écran pour réessayer.
    // Panne réseau ou délai : l'envoi a PU avoir lieu — la ligne reste, marquée
    // « inconnu », et le garde-fou des 2 minutes empêche le renvoi immédiat.
    // Le classement vient de beds24Fetch (#104) : un 5xx ou une application
    // partielle y sont « inconnu », pas un refus — on garde alors la ligne.
    const refused = e instanceof Beds24Error && e.issue === "refus";
    if (refused) {
      await db.batch([
        db.prepare("DELETE FROM channel_messages WHERE message_id = ?1").bind(id),
        db.prepare("DELETE FROM messages WHERE id = ?1 AND delivery = 'pending'").bind(id),
      ]);
      throw e;
    }
    await db.prepare("UPDATE messages SET delivery = 'inconnu' WHERE id = ?1").bind(id).run();
    await audit(db, "admin", "message.reply.beds24.inconnu", `message:${id}`, { error: e instanceof Error ? e.message : String(e) });
    throw new Beds24Error("Beds24 n'a pas répondu : la réponse est peut-être partie — vérifier la conversation dans Beds24 avant de la renvoyer");
  }
  await db.prepare("UPDATE messages SET delivery = 'beds24' WHERE id = ?1").bind(id).run();
  await audit(db, "admin", "message.reply.beds24", `message:${id}`, { bookingId: original.bookingId, beds24BookingId: link.beds24_booking_id });
  return { id, delivery: "beds24" };
}
