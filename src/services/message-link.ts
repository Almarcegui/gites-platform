// Rattachement d'un mail reçu à une réservation. UNE seule fonction (linkMail), partagée par la
// relève IMAP (mailbox.ts) et la réception Cloudflare Email Routing (inbound-email.ts).
//
// Ordre : choix manuel du FIL > référence explicite (PM-2026-001) > réponse à l'un de nos messages
// > choix manuel pour l'ADRESSE (seulement si aucune réservation active plus récente) > adresse du
// client. Les adresses de l'équipe et de la famille sautent les deux étapes « par adresse ».

import {
  bookingsForGuest,
  getBooking,
  getBookingByReference,
  type BookingRow,
} from "../db/repo";
import { extractMessageIds, type ParsedEmail } from "./inbound-email";
import { getSetting } from "./settings";

function bareAddress(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1]! : value).trim().toLowerCase();
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Réservation la plus proche dans le temps (séjour en cours = 0), non annulée de préférence. */
export function closestBooking(bookings: BookingRow[], today: string): BookingRow | null {
  const live = bookings.filter((b) => b.status !== "cancelled");
  const pool = live.length ? live : bookings;
  let best: BookingRow | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const b of pool) {
    const inside = b.checkin <= today && today <= b.checkout;
    const score = inside ? 0 : Math.min(dayDiff(b.checkin, today), dayDiff(b.checkout, today));
    // à égalité, le séjour le plus tardif (à venir avant passé)
    if (score < bestScore || (score === bestScore && best && b.checkin > best.checkin)) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

export interface MailLink {
  booking: BookingRow | null;
  guestId: number | null;
  via: "manuel" | "reference" | "fil" | "adresse" | null;
  /** Le choix vient d'un rattachement fait à la main (le message hérite du drapeau). */
  manual?: boolean;
}

/** Adresses de l'équipe et de la famille : un mail venant d'elles n'est jamais rattaché par
 *  son expéditeur (seulement par référence explicite, ou par fil de réponse). Réglage global. */
export const TEAM_ADDRESSES_KEY = "messagerie_team_addresses";

/** « une adresse par ligne » (virgules et points-virgules tolérés) → liste propre, minuscules, sans doublon. */
export function parseTeamAddresses(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\r\n,;]+/)) {
    const a = bareAddress(part.trim());
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a) && !out.includes(a)) out.push(a);
  }
  return out.slice(0, 200);
}

export async function getTeamAddresses(db: D1Database): Promise<string[]> {
  return parseTeamAddresses((await getSetting(db, TEAM_ADDRESSES_KEY)) ?? "");
}

type LinkRow = { booking_id: number | null; guest_id: number | null };

function threadIds(parsed: ParsedEmail): string[] {
  return [...extractMessageIds(parsed.inReplyTo), ...extractMessageIds(parsed.references)].slice(0, 25);
}

/** Choix manuel fait sur le fil auquel ce mail répond. */
async function manualByThread(db: D1Database, ids: string[]): Promise<MailLink | null> {
  if (!ids.length) return null;
  const row = await db
    .prepare(
      `SELECT booking_id, guest_id FROM messages
        WHERE link_manual = 1 AND message_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(...ids)
    .first<LinkRow>();
  if (!row) return null;
  const booking = row.booking_id ? await getBooking(db, row.booking_id) : null;
  return { booking, guestId: booking?.guestId ?? null, via: "manuel", manual: true };
}

/** Choix manuel déjà fait pour cette adresse. Il ne vaut plus quand le client a depuis une
 *  réservation active plus récente que celle choisie (un nouveau séjour reprend la main). */
async function manualByAddress(db: D1Database, from: string): Promise<MailLink | null> {
  const row = await db
    .prepare(
      `SELECT booking_id, guest_id FROM messages
        WHERE link_manual = 1 AND (lower(from_email) = ?1 OR lower(to_email) = ?1)
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(from)
    .first<LinkRow>();
  if (!row) return null;
  const booking = row.booking_id ? await getBooking(db, row.booking_id) : null;
  if (booking) {
    const newer = await db
      .prepare(
        `SELECT 1 AS n FROM bookings b JOIN guests g ON g.id = b.guest_id
          WHERE lower(g.email) = ?1 AND b.status <> 'cancelled' AND b.id > ?2 LIMIT 1`,
      )
      .bind(from, booking.id)
      .first();
    if (newer) return null;
  }
  return { booking, guestId: booking?.guestId ?? null, via: "manuel", manual: true };
}

/** Rattache un mail (ordre décrit en tête de fichier). */
export async function linkMail(db: D1Database, parsed: ParsedEmail, today: string): Promise<MailLink> {
  const from = (parsed.from ?? "").toLowerCase();
  const team = (await getTeamAddresses(db)).includes(from);
  const ids = threadIds(parsed);
  const byThread = await manualByThread(db, ids);
  if (byThread) return byThread;
  const refMatch = /\b([A-Z]{2}-\d{4}-\d{3,})\b/.exec(`${parsed.subject} ${parsed.textBody}`);
  if (refMatch) {
    const booking = await getBookingByReference(db, refMatch[1]!);
    if (booking) return { booking, guestId: booking.guestId, via: "reference" };
  }
  if (ids.length) {
    const row = await db
      .prepare(
        `SELECT booking_id, guest_id FROM messages
          WHERE message_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
            AND (booking_id IS NOT NULL OR guest_id IS NOT NULL)
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(...ids)
      .first<LinkRow>();
    if (row) {
      const booking = row.booking_id ? await getBooking(db, row.booking_id) : null;
      return { booking, guestId: booking?.guestId ?? row.guest_id, via: "fil" };
    }
  }
  if (from && !team) {
    const byAddress = await manualByAddress(db, from);
    if (byAddress) return byAddress;
    const guest = await db
      .prepare("SELECT id FROM guests WHERE lower(email) = ?1 ORDER BY id LIMIT 1")
      .bind(from)
      .first<{ id: number }>();
    if (guest) {
      const booking = closestBooking(await bookingsForGuest(db, guest.id), today);
      return { booking, guestId: guest.id, via: "adresse" };
    }
  }
  return { booking: null, guestId: null, via: null };
}
