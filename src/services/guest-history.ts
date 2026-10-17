// Historique des échanges d'un client : les mails que la plateforme lui a
// ENVOYÉS (email_log) et les messages REÇUS ou écrits (messages : mail, site,
// Airbnb / Booking.com / Vrbo par Beds24, réponses de l'équipe), rangés par
// séjour. Lecture seule. Rien d'un autre client : un mail ou un message n'entre
// que s'il se rattache à ce client par sa réservation, son identifiant, ou (à
// défaut de tout rattachement) son adresse, si aucune autre fiche ne la porte.

export interface HistoryItem {
  /** « mail:12 » (journal des envois) ou « msg:5 » (messagerie) : clé stable côté écran. */
  key: string;
  source: "mail" | "message";
  /** out = parti de chez nous, in = écrit par le client. */
  direction: "in" | "out";
  /** Type du mail (email_log.kind) ; « message » pour la messagerie. */
  kind: string;
  /** Pour la messagerie : email, form (site) ou beds24 (plateforme). */
  channel: "email" | "form" | "beds24" | null;
  /** Nom de la plateforme (Airbnb, Booking.com…) quand channel = beds24. */
  canal: string | null;
  subject: string;
  bodyText: string;
  /** stub | sent | failed pour un mail ; delivery (aucune | stub | sent | failed) pour une réponse ; null pour un message reçu. */
  status: string | null;
  errorDetail: string | null;
  at: string;
  /** Séjour de ce client auquel l'échange se rattache ; null = hors séjour. */
  bookingId: number | null;
  /** Adresse de l'autre côté : destinataire d'un envoi, expéditeur d'un message reçu. */
  address: string | null;
  attachments: { name: string }[];
}

export interface HistoryStay {
  bookingId: number;
  reference: string;
  unitName: string | null;
  checkin: string;
  checkout: string;
  status: string;
}

export interface GuestHistory {
  guest: { id: number; name: string; email: string | null };
  stays: HistoryStay[];
  items: HistoryItem[];
}

type Raw = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));
const sn = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const n = (v: unknown): number => Number(v);

const LIMIT = 500;

function attachmentsOf(raw: unknown): { name: string }[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((a): a is Raw => !!a && typeof a === "object").map((a) => ({ name: s(a.filename ?? a.name).slice(0, 200) }));
  } catch {
    return [];
  }
}

export async function guestHistory(db: D1Database, guestId: number): Promise<GuestHistory | null> {
  const g = (await db.prepare("SELECT id, email, first_name, last_name FROM guests WHERE id = ?1").bind(guestId).first()) as Raw | null;
  if (!g) return null;
  const email = sn(g.email)?.toLowerCase() ?? null;

  const { results: bookingRows } = await db
    .prepare(
      `SELECT b.id, b.reference, b.checkin, b.checkout, b.status, u.name AS unit_name
         FROM bookings b LEFT JOIN units u ON u.id = b.unit_id
        WHERE b.guest_id = ?1 ORDER BY b.checkin DESC, b.id DESC`,
    )
    .bind(guestId)
    .all();
  const stays: HistoryStay[] = (bookingRows as Raw[]).map((r) => ({
    bookingId: n(r.id), reference: s(r.reference), unitName: sn(r.unit_name), checkin: s(r.checkin), checkout: s(r.checkout), status: s(r.status),
  }));
  const mine = new Set(stays.map((x) => x.bookingId));
  const stayOf = (id: unknown): number | null => (id != null && mine.has(n(id)) ? n(id) : null);

  // Envois. Les mails « reply » doublonnent la réponse déjà rangée dans la messagerie : écartés.
  const mailSql = `SELECT * FROM email_log
      WHERE kind <> 'reply'
        AND (booking_id IN (SELECT id FROM bookings WHERE guest_id = ?1)
             ${email ? "OR (booking_id IS NULL AND lower(to_email) = ?2 AND NOT EXISTS (SELECT 1 FROM guests g2 WHERE g2.id <> ?1 AND lower(g2.email) = ?2))" : ""})
      ORDER BY created_at DESC, id DESC LIMIT ${LIMIT}`;
  const { results: mailRows } = await (email ? db.prepare(mailSql).bind(guestId, email) : db.prepare(mailSql).bind(guestId)).all();

  const msgSql = `SELECT e.*, (SELECT cm.channel_label FROM channel_messages cm WHERE cm.message_id = e.id LIMIT 1) AS canal
      FROM messages e
      WHERE e.guest_id = ?1
         OR (e.guest_id IS NULL AND e.booking_id IN (SELECT id FROM bookings WHERE guest_id = ?1))
         ${email ? "OR (e.guest_id IS NULL AND e.booking_id IS NULL AND (lower(e.from_email) = ?2 OR lower(e.to_email) = ?2) AND NOT EXISTS (SELECT 1 FROM guests g2 WHERE g2.id <> ?1 AND lower(g2.email) = ?2))" : ""}
      ORDER BY e.received_at DESC, e.id DESC LIMIT ${LIMIT}`;
  const { results: msgRows } = await (email ? db.prepare(msgSql).bind(guestId, email) : db.prepare(msgSql).bind(guestId)).all();

  const items: HistoryItem[] = [];
  for (const r of mailRows as Raw[]) {
    items.push({
      key: `mail:${n(r.id)}`, source: "mail", direction: "out", kind: s(r.kind), channel: null, canal: null,
      subject: s(r.subject), bodyText: s(r.body_text), status: s(r.status), errorDetail: sn(r.error_detail), at: s(r.created_at),
      bookingId: stayOf(r.booking_id), address: sn(r.to_email), attachments: attachmentsOf(r.attachments),
    });
  }
  for (const r of msgRows as Raw[]) {
    const out = s(r.direction) === "out";
    const channel = s(r.channel) === "form" ? "form" : s(r.channel) === "beds24" ? "beds24" : "email";
    items.push({
      key: `msg:${n(r.id)}`, source: "message", direction: out ? "out" : "in", kind: "message", channel,
      canal: channel === "beds24" ? sn(r.canal) ?? "Canal Beds24" : null,
      subject: s(r.subject), bodyText: s(r.body_text), status: out ? sn(r.delivery) : null, errorDetail: null, at: s(r.received_at),
      bookingId: stayOf(r.booking_id), address: out ? sn(r.to_email) : sn(r.from_email), attachments: attachmentsOf(r.attachments),
    });
  }
  // Plus récent d'abord ; à égalité, l'identifiant le plus grand d'abord.
  items.sort((a, b) => (a.at === b.at ? (a.key < b.key ? 1 : -1) : a.at < b.at ? 1 : -1));

  return { guest: { id: n(g.id), name: [sn(g.first_name), s(g.last_name)].filter(Boolean).join(" "), email: sn(g.email) }, stays, items };
}
