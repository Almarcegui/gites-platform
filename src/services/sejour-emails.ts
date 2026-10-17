// Mails automatiques du séjour (comparaison Elloha / Beds24 du 17/10/2026) :
//   - J-30 « Préparer votre séjour », J-7 « Infos d'arrivée », J-3 « Rappel »,
//     lendemain du départ « Merci, et votre avis » ;
//   - relance quand un paiement en ligne n'aboutit pas sur une réservation confirmée.
//
// Garde-fous, dans l'ordre où le code les applique :
//   - interrupteur PAR DOMAINE (`stay_emails_enabled`), coupé par défaut ;
//   - réservations faites ICI seulement (source `direct` : le site, `manual` : la
//     vente au téléphone). Jamais les imports (agendas, Elloha : Elloha envoie déjà
//     ses propres mails au Moulin) ni l'iCal : leurs clients ne nous connaissent pas,
//     et Airbnb / Booking écrivent eux-mêmes à leurs voyageurs ;
//   - un type de mail (`kind`) par échéance, une seule fois par réservation
//     (`hasEmailOfKind` : un mail préparé en mode stub compte comme fait) ;
//   - fenêtres de jours : une réservation prise tard ne reçoit pas un « J-30 » à J-5,
//     et un passage manqué du cron se rattrape le lendemain ;
//   - l'envoi réel reste soumis à EMAILS_ENABLED (sinon : journalisé, statut stub).

import { addDays, diffDays, sqlNow, todayInZone } from "../core/dates";
import { audit, getBooking, getProperty, getSettings, hasEmailOfKind, listBookings, type BookingRow, type PropertyRow, type PropertySettings } from "../db/repo";
import { voucherUrl } from "./booking-flow";
import { formatDateFr, isNl, money, postalAddress, queueEmail, realContact, refSubject } from "./email";

export type StayKind = "stay_j30" | "stay_j7" | "stay_j3" | "stay_after";
export const PAYMENT_FAILED_KIND = "payment_failed";

/** Fenêtres en jours : avant l'arrivée (`before`, bornes incluses) ou après le départ (`after`). */
export const STAY_WINDOWS: { kind: StayKind; before?: [number, number]; after?: [number, number] }[] = [
  { kind: "stay_j30", before: [14, 30] },
  { kind: "stay_j7", before: [4, 7] },
  { kind: "stay_j3", before: [1, 3] },
  { kind: "stay_after", after: [1, 7] },
];

/** Sources dont les clients ont réservé chez nous. */
const OWN_SOURCES = new Set(["direct", "manual"]);

/** Une relance de paiement ne regarde que les échecs récents (48 h), et pas avant une
 *  heure : un refus de carte peut être suivi d'un nouvel essai réussi sur la même
 *  session Stripe (30 min de vie) ; passé ce délai, la session est morte. */
const PAYMENT_FAILED_LOOKBACK_HOURS = 48;
const PAYMENT_FAILED_GRACE_MINUTES = 60;

/** Verrou de passage : deux exécutions du cron qui se chevauchent n'envoient pas deux fois. */
export const STAY_EMAILS_LEASE_KEY = "stay_emails_lease";
const LEASE_MINUTES = 5;

export function stayKindFor(b: Pick<BookingRow, "checkin" | "checkout">, today: string): StayKind | null {
  const until = diffDays(today, b.checkin);
  const since = diffDays(b.checkout, today);
  for (const w of STAY_WINDOWS) {
    if (w.before && until >= w.before[0] && until <= w.before[1]) return w.kind;
    if (w.after && since >= w.after[0] && since <= w.after[1]) return w.kind;
  }
  return null;
}

function eligible(b: BookingRow): boolean {
  return b.status === "confirmed" && OWN_SOURCES.has(b.source) && !!b.guestEmail;
}

// --- textes ---------------------------------------------------------------------------

interface Ctx {
  b: BookingRow;
  property: PropertyRow;
  settings: PropertySettings;
  voucher: string;
}

const hour = (hhmm: string) => hhmm.replace(/^(\d{1,2}):(\d{2})$/, (_, h: string, m: string) => (m === "00" ? `${Number(h)} h` : `${Number(h)} h ${m}`));

function contactLines(p: PropertyRow, nl: boolean): string[] {
  const phone = realContact(p.contactPhone);
  const mail = realContact(p.contactEmail);
  const out: string[] = [];
  if (phone) out.push(`${nl ? "Telefoon" : "Téléphone"} : ${phone}`);
  if (mail) out.push(`${nl ? "E-mail" : "Mail"} : ${mail}`);
  return out;
}

function arrivalBlock(c: Ctx, nl: boolean): string[] {
  const address = postalAddress(c.property);
  const info = c.settings.arrivalInfoText.trim();
  return [
    ...(address ? [`${nl ? "Adres" : "Adresse"} : ${address}`] : []),
    nl
      ? `Aankomst vanaf ${c.settings.checkinTime}, vertrek uiterlijk om ${c.settings.checkoutTime}.`
      : `Arrivée à partir de ${hour(c.settings.checkinTime)}, départ au plus tard à ${hour(c.settings.checkoutTime)}.`,
    ...(info ? ["", info] : []),
  ];
}

function balanceLine(c: Ctx, nl: boolean): string[] {
  const due = c.b.totalCents - c.b.paidCents;
  if (due <= 0) return [];
  return nl
    ? [`Nog te betalen saldo: ${money(due, true)}${c.b.balanceDueDate ? ` (vervaldag ${formatDateFr(c.b.balanceDueDate)})` : ""}. U kunt het online betalen via de link hieronder.`, ""]
    : [`Solde restant : ${money(due, false)}${c.b.balanceDueDate ? ` (échéance le ${formatDateFr(c.b.balanceDueDate)})` : ""}. Vous pouvez le régler en ligne par le lien ci-dessous.`, ""];
}

/** Le merci d'après séjour part aussi sans lien d'avis (la phrase sur l'avis est alors omise). */
export function buildStayEmail(kind: StayKind, c: Ctx): { subject: string; bodyText: string } {
  const nl = isNl(c.b);
  const { b, property: p } = c;
  const unit = b.unitName ?? p.name;
  const dates = `${formatDateFr(b.checkin)} → ${formatDateFr(b.checkout)}`;
  const sign = ["", nl ? "Tot binnenkort," : "À bientôt,", p.name, ...contactLines(p, nl)];
  const review = (c.settings.reviewUrl ?? "").trim();


  if (!nl) {
    switch (kind) {
      case "stay_j30":
        return {
          subject: refSubject(b.reference, `Votre séjour approche — ${unit}`),
          bodyText: [
            `Bonjour,`, ``,
            `Votre séjour à ${unit} (${dates}) approche : il est temps de l'organiser.`, ``,
            ...balanceLine(c, false),
            `Votre réservation, le détail du séjour et les options (bois, sauna, bain chaud…) :`, c.voucher, ``,
            `Une question, une demande particulière ? Répondez simplement à ce mail.`,
            ...sign,
          ].join("\n"),
        };
      case "stay_j7":
        return {
          subject: refSubject(b.reference, `Infos d'arrivée — ${unit}`),
          bodyText: [
            `Bonjour,`, ``,
            `Dans une semaine, vous serez à ${unit}. Voici ce qu'il faut savoir pour arriver.`, ``,
            ...arrivalBlock(c, false), ``,
            ...balanceLine(c, false),
            `Votre réservation : ${c.voucher}`,
            ...sign,
          ].join("\n"),
        };
      case "stay_j3":
        return {
          subject: refSubject(b.reference, `À très vite — ${unit}`),
          bodyText: [
            `Bonjour,`, ``,
            `Plus que quelques jours avant votre arrivée à ${unit}, le ${formatDateFr(b.checkin)}.`, ``,
            ...arrivalBlock(c, false), ``,
            ...balanceLine(c, false),
            `Bonne route !`,
            ...sign,
          ].join("\n"),
        };
      case "stay_after":
        return {
          subject: refSubject(b.reference, `Merci pour votre séjour — ${p.name}`),
          bodyText: [
            `Bonjour,`, ``,
            `Merci d'avoir séjourné à ${unit}. Nous espérons que vous en gardez un beau souvenir.`, ``,
            ...(review
              ? [`Si vous avez deux minutes, votre avis aide beaucoup d'autres voyageurs à nous trouver :`, review, ``]
              : []),
            `Au plaisir de vous accueillir à nouveau.`,
            ...sign.slice(1),
          ].join("\n"),
        };
    }
  }
  switch (kind) {
    case "stay_j30":
      return {
        subject: refSubject(b.reference, `Uw verblijf komt eraan — ${unit}`),
        bodyText: [
          `Beste,`, ``,
          `Uw verblijf in ${unit} (${dates}) komt eraan: tijd om het te plannen.`, ``,
          ...balanceLine(c, true),
          `Uw reservering, de details van het verblijf en de opties (hout, sauna, hottub…):`, c.voucher, ``,
          `Een vraag of een bijzondere wens? Antwoord gewoon op deze e-mail.`,
          ...sign,
        ].join("\n"),
      };
    case "stay_j7":
      return {
        subject: refSubject(b.reference, `Aankomstinformatie — ${unit}`),
        bodyText: [
          `Beste,`, ``,
          `Over een week bent u in ${unit}. Dit moet u weten voor uw aankomst.`, ``,
          ...arrivalBlock(c, true), ``,
          ...balanceLine(c, true),
          `Uw reservering: ${c.voucher}`,
          ...sign,
        ].join("\n"),
      };
    case "stay_j3":
      return {
        subject: refSubject(b.reference, `Tot heel binnenkort — ${unit}`),
        bodyText: [
          `Beste,`, ``,
          `Nog enkele dagen tot uw aankomst in ${unit}, op ${formatDateFr(b.checkin)}.`, ``,
          ...arrivalBlock(c, true), ``,
          ...balanceLine(c, true),
          `Goede reis!`,
          ...sign,
        ].join("\n"),
      };
    case "stay_after":
      return {
        subject: refSubject(b.reference, `Bedankt voor uw verblijf — ${p.name}`),
        bodyText: [
          `Beste,`, ``,
          `Bedankt voor uw verblijf in ${unit}. We hopen dat u er een mooie herinnering aan overhoudt.`, ``,
          ...(review ? [`Hebt u twee minuten? Uw beoordeling helpt andere reizigers ons te vinden:`, review, ``] : []),
          `We verwelkomen u graag opnieuw.`,
          ...sign.slice(1),
        ].join("\n"),
      };
  }
}

export function buildPaymentFailedEmail(c: Ctx): { subject: string; bodyText: string } {
  const nl = isNl(c.b);
  const due = c.b.totalCents - c.b.paidCents;
  if (nl) {
    return {
      subject: refSubject(c.b.reference, `Uw betaling is niet gelukt — ${c.property.name}`),
      bodyText: [
        `Beste,`, ``,
        `Uw online betaling voor reservering ${c.b.reference} is niet gelukt. Er werd niets afgeschreven.`, ``,
        `Nog te betalen: ${money(due, true)}. U kunt het opnieuw proberen via deze link:`, c.voucher, ``,
        `Lukt het niet? Antwoord op deze e-mail, we helpen u graag.`,
        ``, `Met vriendelijke groet,`, c.property.name, ...contactLines(c.property, true),
      ].join("\n"),
    };
  }
  return {
    subject: refSubject(c.b.reference, `Votre paiement n'a pas abouti — ${c.property.name}`),
    bodyText: [
      `Bonjour,`, ``,
      `Votre paiement en ligne pour la réservation ${c.b.reference} n'a pas abouti. Rien n'a été débité.`, ``,
      `Reste à régler : ${money(due, false)}. Vous pouvez réessayer par ce lien :`, c.voucher, ``,
      `Un souci ? Répondez à ce mail, nous vous aidons volontiers.`,
      ``, `Bien à vous,`, c.property.name, ...contactLines(c.property, false),
    ].join("\n"),
  };
}

// --- traitement planifié ---------------------------------------------------------------

export interface StayEmailsResult {
  queued: Record<string, number>;
}

/** Contexte par domaine, chargé une fois par passage. */
async function contextLoader(db: D1Database) {
  const cache = new Map<number, { property: PropertyRow; settings: PropertySettings } | null>();
  return async (propertyId: number | null | undefined) => {
    const id = propertyId ?? -1;
    if (!cache.has(id)) {
      const property = await getProperty(db, id);
      cache.set(id, property ? { property, settings: await getSettings(db, id) } : null);
    }
    return cache.get(id) ?? null;
  };
}

export async function runStayEmails(env: Env, now: Date = new Date()): Promise<StayEmailsResult> {
  const db = env.DB;
  const today = todayInZone(now);
  const result: StayEmailsResult = { queued: {} };
  const load = await contextLoader(db);
  // séjours partis depuis 8 jours au plus et arrivant dans 31 jours au plus ; listBookings
  // plafonne à 1000 lignes, très au-delà de ce que deux domaines comptent sur 39 jours
  const bookings = await listBookings(db, { status: "confirmed", from: addDays(today, -8), to: addDays(today, 31), limit: 1000 });
  for (const b of bookings) {
    if (!eligible(b)) continue;
    const kind = stayKindFor(b, today);
    if (!kind) continue;
    const ctx = await load(b.propertyId);
    if (!ctx || !ctx.settings.stayEmailsEnabled) continue;
    if (await hasEmailOfKind(db, b.id, kind)) continue;
    const email = buildStayEmail(kind, { b, ...ctx, voucher: voucherUrl(env, b) });
    await queueEmail(db, env, { bookingId: b.id, to: b.guestEmail!, subject: email.subject, bodyText: email.bodyText, kind });
    await audit(db, "cron", `email.${kind}`, `booking:${b.id}`);
    result.queued[kind] = (result.queued[kind] ?? 0) + 1;
  }
  return result;
}

/** Réservations confirmées dont le dernier paiement en ligne vient d'échouer ou d'expirer,
 *  sans paiement plus récent en cours ou réussi, et un solde encore dû. */
export async function listFailedPaymentBookings(db: D1Database, now: Date): Promise<number[]> {
  const since = sqlNow(new Date(now.getTime() - PAYMENT_FAILED_LOOKBACK_HOURS * 3_600_000));
  const until = sqlNow(new Date(now.getTime() - PAYMENT_FAILED_GRACE_MINUTES * 60_000));
  const { results } = await db
    .prepare(
      `SELECT DISTINCT p.booking_id AS id
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
        WHERE p.status = 'failed' AND p.method = 'stripe' AND p.kind IN ('balance', 'full')
          AND p.created_at >= ?1 AND p.created_at <= ?2
          AND b.status = 'confirmed' AND b.total_cents > b.paid_cents
          AND NOT EXISTS (
            SELECT 1 FROM payments q
             WHERE q.booking_id = p.booking_id AND q.status IN ('pending', 'succeeded')
               AND q.created_at > p.created_at)`,
    )
    .bind(since, until)
    .all();
  return (results as { id: number }[]).map((r) => Number(r.id));
}

export async function runPaymentFailedReminders(env: Env, now: Date = new Date()): Promise<number> {
  const db = env.DB;
  const load = await contextLoader(db);
  let sent = 0;
  for (const id of await listFailedPaymentBookings(db, now)) {
    const b = await getBooking(db, id);
    if (!b || !eligible(b)) continue;
    const ctx = await load(b.propertyId);
    if (!ctx || !ctx.settings.stayEmailsEnabled) continue;
    if (await hasEmailOfKind(db, b.id, PAYMENT_FAILED_KIND)) continue;
    const email = buildPaymentFailedEmail({ b, ...ctx, voucher: voucherUrl(env, b) });
    await queueEmail(db, env, { bookingId: b.id, to: b.guestEmail!, subject: email.subject, bodyText: email.bodyText, kind: PAYMENT_FAILED_KIND });
    await audit(db, "cron", `email.${PAYMENT_FAILED_KIND}`, `booking:${b.id}`);
    sent += 1;
  }
  return sent;
}

async function acquireLease(db: D1Database, now: Date): Promise<string | null> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const until = `${new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString()}|${token}`;
  const res = await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        WHERE app_settings.value < ?3`,
    )
    .bind(STAY_EMAILS_LEASE_KEY, until, now.toISOString())
    .run();
  return res.meta.changes === 1 ? until : null;
}

async function releaseLease(db: D1Database, lease: string): Promise<void> {
  await db
    .prepare("UPDATE app_settings SET value = '' WHERE key = ?1 AND value = ?2")
    .bind(STAY_EMAILS_LEASE_KEY, lease)
    .run()
    .catch(() => undefined);
}

/** Le passage du cron : mails du séjour puis relances de paiement, sous verrou. */
export async function runStayEmailJobs(
  env: Env,
  now: Date = new Date(),
): Promise<{ ran: boolean; queued: Record<string, number>; paymentFailed: number }> {
  const lease = await acquireLease(env.DB, now);
  if (!lease) return { ran: false, queued: {}, paymentFailed: 0 };
  try {
    const stay = await runStayEmails(env, now);
    const paymentFailed = await runPaymentFailedReminders(env, now);
    return { ran: true, queued: stay.queued, paymentFailed };
  } finally {
    await releaseLease(env.DB, lease);
  }
}
