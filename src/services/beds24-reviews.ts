// Avis Airbnb et Booking.com relevés par Beds24 (lot 3, migration 0025).
//
// Le cron relève au plus toutes les 6 heures (les avis bougent peu ; le quota
// Beds24 se partage avec le calendrier et les messages) :
//   Airbnb   GET /channels/airbnb/reviews?roomId=<chambre>        une chambre par appel
//   Booking  GET /channels/booking/reviews?propertyId=<p>&from=<date>
// Seuls les avis des VOYAGEURS sur nous comptent (Airbnb rend aussi ceux que
// l'hôte écrit sur le voyageur : reviewer_role = host, écartés). La note est
// ramenée sur 5 ; l'alerte part sous 4. Répondre se fait dans Beds24 (l'API ne
// le permet pas) : la carte de l'écran y renvoie.
import { sqlNow } from "../core/dates";
import { audit } from "../db/repo";
import { beds24Configured, beds24Fetch } from "./beds24";
import { getSetting, setSetting } from "./settings";

export const REVIEWS_STATE_KEY = "beds24_reviews_last";
export const REVIEWS_EVERY_HOURS = 6;
/** Sous cette note (sur 5), l'avis est signalé sur Aujourd'hui. */
export const REVIEWS_LOW_SCORE = 4;
const FIRST_FROM_DAYS = 365;
/** Adresse où l'on répond aux avis, dans Beds24. */
export const BEDS24_REVIEWS_URL = "https://beds24.com/control3.php";

export interface AirbnbReview {
  id?: string | number;
  overall_rating?: number | null;
  public_review?: string | null;
  reviewee_response?: string | null;
  responded_at?: string | null;
  reviewer_role?: string | null;
  submitted?: boolean | null;
  submitted_at?: string | null;
  first_completed_at?: string | null;
  hidden?: boolean | null;
}

export interface BookingReview {
  review_id?: string | number;
  created_timestamp?: string | null;
  content?: { language_code?: string | null; headline?: string | null; positive?: string | null; negative?: string | null } | null;
  reservation_id?: number | string | null;
  scoring?: { review_score?: number | null } | null;
  reviewer?: { name?: string | null } | null;
  reply?: { text?: string | null; last_change_timestamp?: string | null } | null;
}

export interface ReviewRow {
  channel: "airbnb" | "booking";
  externalId: string;
  propertyId: number | null;
  unitId: number | null;
  bookingRef: string | null;
  rating: number | null;
  rawScore: number | null;
  rawScale: number;
  reviewerName: string | null;
  language: string | null;
  headline: string | null;
  body: string | null;
  negative: string | null;
  reply: string | null;
  repliedAt: string | null;
  submittedAt: string | null;
}

const txt = (s: string | null | undefined, max = 4000): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/** Horodatage du canal → format SQL UTC ; null si illisible. */
function sqlTime(s: string | null | undefined): string | null {
  if (!s) return null;
  // Booking donne « 2018-05-13 12:16:33 » (sans fuseau, on le lit en UTC).
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(t) ? null : sqlNow(new Date(t));
}

/** Avis Airbnb → ligne, ou null (avis de l'hôte, sans identifiant, pas encore soumis). */
export function fromAirbnb(r: AirbnbReview, propertyId: number | null, unitId: number | null): ReviewRow | null {
  if (r.id == null || (r.reviewer_role && r.reviewer_role !== "guest") || r.submitted === false) return null;
  const score = typeof r.overall_rating === "number" && r.overall_rating > 0 ? r.overall_rating : null;
  return {
    channel: "airbnb", externalId: String(r.id), propertyId, unitId, bookingRef: null,
    rating: score, rawScore: score, rawScale: 5, reviewerName: null, language: null, headline: null,
    body: txt(r.public_review), negative: null, reply: txt(r.reviewee_response), repliedAt: sqlTime(r.responded_at),
    submittedAt: sqlTime(r.submitted_at ?? r.first_completed_at),
  };
}

export function fromBooking(r: BookingReview, propertyId: number | null): ReviewRow | null {
  if (r.review_id == null) return null;
  const raw = typeof r.scoring?.review_score === "number" ? r.scoring.review_score : null;
  return {
    channel: "booking", externalId: String(r.review_id), propertyId, unitId: null,
    bookingRef: r.reservation_id != null ? String(r.reservation_id) : null,
    rating: raw == null ? null : Math.round((raw / 2) * 10) / 10, rawScore: raw, rawScale: 10,
    reviewerName: txt(r.reviewer?.name, 80), language: txt(r.content?.language_code, 8), headline: txt(r.content?.headline, 300),
    body: txt(r.content?.positive), negative: txt(r.content?.negative), reply: txt(r.reply?.text),
    repliedAt: sqlTime(r.reply?.last_change_timestamp), submittedAt: sqlTime(r.created_timestamp),
  };
}

/** Insère ou met à jour ; true si l'avis est nouveau. */
export async function upsertReview(db: D1Database, r: ReviewRow): Promise<boolean> {
  const known = await db.prepare("SELECT id FROM channel_reviews WHERE channel = ?1 AND external_id = ?2").bind(r.channel, r.externalId).first();
  await db
    .prepare(
      `INSERT INTO channel_reviews (channel, external_id, property_id, unit_id, booking_ref, rating, raw_score, raw_scale,
                                    reviewer_name, language, headline, body_text, negative_text, reply_text, replied_at, submitted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(channel, external_id) DO UPDATE SET
         rating = excluded.rating, raw_score = excluded.raw_score, headline = excluded.headline,
         body_text = excluded.body_text, negative_text = excluded.negative_text, reply_text = excluded.reply_text,
         replied_at = excluded.replied_at, submitted_at = COALESCE(excluded.submitted_at, channel_reviews.submitted_at),
         updated_at = datetime('now')`,
    )
    .bind(r.channel, r.externalId, r.propertyId, r.unitId, r.bookingRef, r.rating, r.rawScore, r.rawScale,
      r.reviewerName, r.language, r.headline, r.body, r.negative, r.reply, r.repliedAt, r.submittedAt)
    .run();
  return !known;
}

export interface ReviewsPullResult {
  ran: boolean;
  fetched: number;
  inserted: number;
  low: number;
  errors: string[];
}

/** La relève du cron : sans Beds24 configuré, ou moins de 6 h après la dernière, ne fait rien. */
export async function pullChannelReviews(env: Env, now: Date = new Date(), force = false): Promise<ReviewsPullResult> {
  const db = env.DB;
  const result: ReviewsPullResult = { ran: false, fetched: 0, inserted: 0, low: 0, errors: [] };
  if (!(await beds24Configured(env))) return result;
  let state: { at?: string } = {};
  try {
    state = JSON.parse((await getSetting(db, REVIEWS_STATE_KEY)) ?? "{}") as { at?: string };
  } catch {
    state = {};
  }
  const last = state.at ? Date.parse(state.at) : Number.NaN;
  if (!force && !Number.isNaN(last) && now.getTime() - last < REVIEWS_EVERY_HOURS * 3_600_000) return result;
  result.ran = true;
  // Booking : depuis la dernière relève, moins une semaine (un avis peut
  // arriver avec retard) ; un an au premier passage.
  const fromMs = Number.isNaN(last) ? now.getTime() - FIRST_FROM_DAYS * 86_400_000 : last - 7 * 86_400_000;
  const from = new Date(fromMs).toISOString().slice(0, 10);

  const props = (await db.prepare("SELECT id, beds24_property_id FROM properties WHERE beds24_property_id IS NOT NULL").all<{ id: number; beds24_property_id: number }>()).results ?? [];
  const keep = async (row: ReviewRow | null) => {
    if (!row) return;
    result.fetched += 1;
    if (await upsertReview(db, row)) {
      result.inserted += 1;
      if (row.rating != null && row.rating < REVIEWS_LOW_SCORE) result.low += 1;
    }
  };
  for (const p of props) {
    const rooms = (await db.prepare("SELECT id, beds24_room_id FROM units WHERE property_id = ?1 AND beds24_room_id IS NOT NULL AND active = 1").bind(p.id).all<{ id: number; beds24_room_id: number }>()).results ?? [];
    for (const u of rooms) {
      try {
        const res = await beds24Fetch<{ data?: AirbnbReview[] }>(env, "/channels/airbnb/reviews", { query: { roomId: String(u.beds24_room_id) } });
        for (const r of res.data ?? []) await keep(fromAirbnb(r, p.id, u.id));
      } catch (e) {
        result.errors.push(`airbnb chambre ${u.beds24_room_id} : ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      }
    }
    try {
      const res = await beds24Fetch<{ data?: BookingReview[] }>(env, "/channels/booking/reviews", { query: { propertyId: String(p.beds24_property_id), from } });
      for (const r of res.data ?? []) await keep(fromBooking(r, p.id));
    } catch (e) {
      result.errors.push(`booking propriété ${p.beds24_property_id} : ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
  // Une relève sans aucune réponse ne repousse pas la suivante : on retentera au prochain passage.
  const allFailed = result.errors.length > 0 && result.fetched === 0 && result.errors.length >= props.length;
  if (!allFailed) await setSetting(db, REVIEWS_STATE_KEY, JSON.stringify({ at: now.toISOString(), fetched: result.fetched, inserted: result.inserted }));
  if (result.inserted || result.errors.length) {
    await audit(db, "cron", result.errors.length ? "beds24.reviews.error" : "beds24.reviews", null, { ...result });
  }
  return result;
}

export interface ReviewItem {
  id: number;
  channel: "airbnb" | "booking";
  rating: number | null;
  rawScore: number | null;
  rawScale: number;
  reviewerName: string | null;
  headline: string | null;
  body: string | null;
  negative: string | null;
  replied: boolean;
  submittedAt: string | null;
  unitName: string | null;
}

/** Note moyenne, nombre, derniers avis, avis sous 4 sans réponse, pour la carte « Avis ». */
export async function reviewsSummary(db: D1Database, propertyId: number | null) {
  const where = propertyId ? "WHERE r.property_id = ?1" : "";
  const bind = (s: D1PreparedStatement) => (propertyId ? s.bind(propertyId) : s);
  const agg = await bind(db.prepare(`SELECT COUNT(rating) AS n, AVG(rating) AS avg FROM channel_reviews r ${where}`)).first<{ n: number; avg: number | null }>();
  const byChannel = (await bind(db.prepare(`SELECT channel, COUNT(rating) AS n, AVG(rating) AS avg FROM channel_reviews r ${where} GROUP BY channel`)).all<{ channel: string; n: number; avg: number | null }>()).results ?? [];
  const rows = (await bind(
    db.prepare(
      `SELECT r.id, r.channel, r.rating, r.raw_score, r.raw_scale, r.reviewer_name, r.headline, r.body_text, r.negative_text,
              r.reply_text, r.submitted_at, u.name AS unit_name
         FROM channel_reviews r LEFT JOIN units u ON u.id = r.unit_id ${where}
        ORDER BY COALESCE(r.submitted_at, r.created_at) DESC LIMIT 30`,
    ),
  ).all<Record<string, unknown>>()).results ?? [];
  const item = (r: Record<string, unknown>): ReviewItem => ({
    id: Number(r.id), channel: r.channel as "airbnb" | "booking",
    rating: r.rating == null ? null : Number(r.rating), rawScore: r.raw_score == null ? null : Number(r.raw_score), rawScale: Number(r.raw_scale),
    reviewerName: (r.reviewer_name as string | null) ?? null, headline: (r.headline as string | null) ?? null,
    body: (r.body_text as string | null) ?? null, negative: (r.negative_text as string | null) ?? null,
    replied: r.reply_text != null, submittedAt: (r.submitted_at as string | null) ?? null, unitName: (r.unit_name as string | null) ?? null,
  });
  const all = rows.map(item);
  const avg = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    count: Number(agg?.n ?? 0),
    average: avg(agg?.avg),
    byChannel: byChannel.map((c) => ({ channel: c.channel, count: Number(c.n), average: avg(c.avg) })),
    latest: all.slice(0, 5),
    // Les avis sous 4 sans réponse, des 30 derniers : ceux qui demandent un geste.
    low: all.filter((r) => r.rating != null && r.rating < REVIEWS_LOW_SCORE && !r.replied),
    replyUrl: BEDS24_REVIEWS_URL,
  };
}

export { sqlTime as reviewSqlTime };
