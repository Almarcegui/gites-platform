// Synchronisation SORTANTE vers Beds24 : notre moteur est la source de vérité,
// Beds24 reçoit des états calculés (jamais de logique métier chez lui).
//
// Pour chaque unité mappée (units.beds24_room_id) on pousse, jour par jour :
//   numAvail  = 0/1 depuis isUnitFree — la liaison Scieur/Scierie/Domaine est
//               donc reflétée automatiquement (Domaine réservé chez nous →
//               les deux rooms Beds24 passent à 0 sans configuration Beds24) ;
//   price1    = notre prix nuit (rateCalendar), en euros ;
//   minStay   = notre min-nuits du jour.
// Les jours consécutifs identiques sont regroupés en plages (payload compact).
//
// Déclenchement : cron 15 min (fenêtre glissante) + endpoint admin de push
// manuel. ⚠️ Dev local : les fetch sortants du Worker échouent sous VPN Emeria
// (cf. README § Beds24) — utiliser scripts/beds24_push_calendar.py ; en prod
// Cloudflare, ce module fonctionne tel quel.

import { addDays, isIsoDate, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { isUnitFree } from "../core/availability";
import { rateCalendar, type UnitPricingInfo } from "../core/pricing";
import {
  audit,
  bookingsInWindow,
  cancelBooking,
  createBookingAtomic,
  listBeds24Bookings,
  listLinks,
  listRateRules,
  listSeasons,
  listUnits,
  updateBookingDatesAtomic,
  updateSettings,
  upsertGuest,
  type UnitRow,
} from "../db/repo";
import { beds24Configured, beds24Fetch } from "./beds24";

export interface CalendarSpan {
  from: IsoDate;
  to: IsoDate;
  numAvail: number;
  price1?: number;
  minStay?: number;
}

/** Jours → plages compactes aux valeurs identiques. */
export function compactSpans(
  days: { date: IsoDate; numAvail: number; price1?: number; minStay?: number }[],
): CalendarSpan[] {
  const spans: CalendarSpan[] = [];
  for (const d of days) {
    const last = spans[spans.length - 1];
    if (
      last &&
      last.numAvail === d.numAvail &&
      last.price1 === d.price1 &&
      last.minStay === d.minStay &&
      addDays(last.to, 1) === d.date
    ) {
      last.to = d.date;
    } else {
      spans.push({ from: d.date, to: d.date, numAvail: d.numAvail, price1: d.price1, minStay: d.minStay });
    }
  }
  return spans;
}

/** Calcule les plages à pousser pour toutes les unités mappées d'une propriété. */
export async function buildCalendarPush(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  days: number,
): Promise<{ roomId: number; unitName: string; calendar: CalendarSpan[] }[]> {
  const to = addDays(from, days);
  const [units, links, seasons, rules, rows] = await Promise.all([
    listUnits(db, propertyId),
    listLinks(db, propertyId),
    listSeasons(db, propertyId),
    listRateRules(db, propertyId),
    bookingsInWindow(db, propertyId, from, to),
  ]);
  const now = sqlNow();
  const spans = rows.map((b) => ({
    unitId: b.unitId, checkin: b.checkin, checkout: b.checkout,
    status: b.status, holdExpiresAt: b.holdExpiresAt,
  }));
  const active = units.filter((u) => u.active);
  const physicalIds = new Set(active.filter((u) => !u.isComposite).map((u) => u.id));
  const toPricingUnit = (u: UnitRow): UnitPricingInfo => ({
    id: u.id,
    name: u.name,
    compositePricing: u.isComposite ? u.compositePricing : "own",
    cleaningFeeCents: u.cleaningFeeCents,
    components: u.isComposite
      ? links
          .filter((l) => l.unitId === u.id && physicalIds.has(l.blocksUnitId))
          .map((l) => {
            const c = active.find((x) => x.id === l.blocksUnitId);
            return { id: l.blocksUnitId, name: c?.name ?? "", cleaningFeeCents: c?.cleaningFeeCents ?? 0 };
          })
      : [],
  });

  const out = [];
  for (const u of active) {
    if (!u.beds24RoomId) continue;
    const rates = rateCalendar(toPricingUnit(u), from, to, seasons, rules);
    const days_ = rates.map((r) => ({
      date: r.date,
      numAvail: isUnitFree(u.id, r.date, addDays(r.date, 1), spans, links, now) ? 1 : 0,
      price1: r.priceCents != null ? r.priceCents / 100 : undefined,
      minStay: r.minNights ?? undefined,
    }));
    out.push({ roomId: u.beds24RoomId, unitName: u.name, calendar: compactSpans(days_) });
  }
  return out;
}

/** Pousse les calendriers vers Beds24. Fenêtre par défaut : 400 jours. */
export async function pushCalendars(
  db: D1Database,
  env: Env,
  propertyId: number,
  days = 400,
): Promise<{ pushed: { roomId: number; unitName: string; spans: number }[]; }> {
  if (!(await beds24Configured(env))) throw new Error("Beds24 non configuré");
  const today = todayInZone();
  const rooms = await buildCalendarPush(db, propertyId, today, days);
  const body = rooms.map((r) => ({ roomId: r.roomId, calendar: r.calendar }));
  if (body.length > 0) {
    await beds24Fetch(env, "/inventory/rooms/calendar", { method: "POST", body });
  }
  return { pushed: rooms.map((r) => ({ roomId: r.roomId, unitName: r.unitName, spans: r.calendar.length })) };
}

// ---------------------------------------------------------------------------
// Synchronisation ENTRANTE : les réservations des canaux OTA (via Beds24)
// descendent dans notre base — même mécanique éprouvée que l'import iCal
// (nouveau / déplacé / annulé / conflit → journal), mais avec les données
// riches de l'API (nom, email, téléphone, montant, canal).
// external_uid = 'beds24:<bookingId>' ; source = 'ical' (résa d'un canal
// externe synchronisé — choix documenté au README, pas de refonte du CHECK).
// ---------------------------------------------------------------------------

export interface Beds24Booking {
  id: number;
  roomId: number;
  status: string; // 'new' | 'confirmed' | 'request' | 'cancelled' | 'black' | …
  arrival: string;
  departure: string;
  numAdult?: number;
  numChild?: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  price?: number | null;
  channel?: string | null;     // 'airbnb', 'booking', …
  apiSource?: string | null;
  referer?: string | null;
}

export interface ChannelSyncResult {
  imported: number;
  updated: number;
  cancelled: number;
  skipped: number;
  conflicts: string[];
}

const ACTIVE_STATUSES = new Set(["new", "confirmed", "request"]);

function channelLabel(b: Beds24Booking): string {
  const raw = (b.channel ?? b.apiSource ?? b.referer ?? "").toString().trim();
  if (!raw) return "Canal Beds24";
  const known: Record<string, string> = {
    airbnb: "Airbnb", booking: "Booking.com", bookingcom: "Booking.com",
    expedia: "Expedia", vrbo: "Vrbo", direct: "Beds24 direct",
  };
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  return known[key] ?? `${raw} (Beds24)`;
}

/** Applique une liste de résas Beds24 à notre base. Pur (pas de réseau) → testé. */
export async function applyChannelBookings(
  db: D1Database,
  bookings: Beds24Booking[],
  roomToUnit: Map<number, number>,
  now: Date = new Date(),
): Promise<ChannelSyncResult> {
  const result: ChannelSyncResult = { imported: 0, updated: 0, cancelled: 0, skipped: 0, conflicts: [] };
  const nowSql = sqlNow(now);
  const today = todayInZone(now);
  const existing = await listBeds24Bookings(db);
  const byUid = new Map(existing.map((b) => [b.externalUid ?? "", b]));

  for (const b of bookings) {
    const unitId = roomToUnit.get(b.roomId);
    const extUid = `beds24:${b.id}`;
    const known = byUid.get(extUid);
    if (!unitId) {
      result.skipped += 1;
      continue;
    }
    if (!isIsoDate(b.arrival) || !isIsoDate(b.departure) || b.arrival >= b.departure) {
      result.skipped += 1;
      continue;
    }

    if (!ACTIVE_STATUSES.has(b.status)) {
      // annulée (ou statut inconnu) côté canal → libérer si pas commencée
      if (known && known.checkin >= today) {
        await cancelBooking(db, known.id, `canal:${b.status}`, nowSql);
        result.cancelled += 1;
      }
      continue;
    }

    if (!known) {
      if (b.departure <= today) continue; // séjour déjà terminé : rien à créer
      const lastName = (b.lastName ?? "").trim() || channelLabel(b);
      const guestId = await upsertGuest(db, {
        email: (b.email ?? "").trim() || null,
        firstName: (b.firstName ?? "").trim() || null,
        lastName,
        phone: (b.phone ?? "").trim() || null,
      });
      const created = await createBookingAtomic(db, {
        unitId,
        checkin: b.arrival,
        checkout: b.departure,
        adults: Math.max(0, Math.floor(b.numAdult ?? 0)),
        children: Math.max(0, Math.floor(b.numChild ?? 0)),
        status: "confirmed",
        source: "ical",
        channelLabel: channelLabel(b),
        externalUid: extUid,
        guestId,
        totalCents: b.price != null ? Math.round(b.price * 100) : 0,
        internalNotes: `Résa ${channelLabel(b)} rapatriée de Beds24 (#${b.id})`,
        now,
      });
      if (created.ok) {
        result.imported += 1;
      } else {
        result.conflicts.push(`beds24:${b.id} ${b.arrival}→${b.departure} : créneau déjà pris localement`);
      }
    } else if (known.checkin !== b.arrival || known.checkout !== b.departure) {
      const moved = await updateBookingDatesAtomic(db, known.id, known.unitId, b.arrival, b.departure, nowSql);
      if (moved) {
        result.updated += 1;
      } else {
        result.conflicts.push(`${known.reference} : déplacement ${b.arrival}→${b.departure} impossible (conflit)`);
      }
    }
  }
  return result;
}

/** Pull des résas depuis Beds24 (curseur modifiedFrom en settings) + apply. */
export async function pullBeds24Bookings(
  db: D1Database,
  env: Env,
  propertyId: number,
  beds24PropertyId: number,
  now: Date = new Date(),
): Promise<ChannelSyncResult> {
  if (!(await beds24Configured(env))) throw new Error("Beds24 non configuré");
  // curseur de pull incrémental (clé libre du key-value settings, hors SettingsRow typé)
  const raw = await db
    .prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'beds24_last_pull'")
    .bind(propertyId)
    .first<{ value: string }>();
  const query: Record<string, string> = { propertyId: String(beds24PropertyId), includeGuests: "true" };
  if (raw?.value) {
    query.modifiedFrom = raw.value;
  } else {
    query.arrivalFrom = todayInZone(now); // premier pull : toutes les résas futures
  }
  const res = await beds24Fetch<{ data?: Beds24Booking[] }>(env, "/bookings", { query });
  const units = await listUnits(db, propertyId);
  const roomToUnit = new Map(units.filter((u) => u.beds24RoomId != null).map((u) => [u.beds24RoomId as number, u.id]));
  const result = await applyChannelBookings(db, res.data ?? [], roomToUnit, now);
  // curseur : maintenant - 10 min de marge (horloges + latence Beds24)
  const next = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await updateSettings(db, propertyId, { beds24_last_pull: next });
  if (result.imported || result.updated || result.cancelled || result.conflicts.length) {
    await audit(db, "cron", "beds24.pull", `property:${propertyId}`, result);
  }
  return result;
}

/** Push TEMPS RÉEL, non bloquant : appelé à chaque mutation du stock ou des
 *  tarifs (résa publique, vente/annulation/déplacement admin, saisons, règles).
 *  Avec ctx (Workers) : ctx.waitUntil — la réponse part sans attendre le push.
 *  Sans ctx (tests) : await inline. Sans token : no-op silencieux.
 *  Le cron 15 min reste le filet de sécurité (holds expirés, échecs réseau). */
export function triggerBeds24Push(
  db: D1Database,
  env: Env,
  execCtx: ExecutionContext | undefined,
  propertyId: number,
): Promise<void> | undefined {
  const run = async (): Promise<void> => {
    if (!(await beds24Configured(env))) return; // no-op silencieux sans jeton
    try {
      const { pushed } = await pushCalendars(db, env, propertyId);
      await audit(db, "event", "beds24.push", `property:${propertyId}`, { rooms: pushed.length, trigger: "temps réel" });
    } catch (e) {
      await audit(db, "event", "beds24.push.error", `property:${propertyId}`, {
        trigger: "temps réel",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  if (execCtx) {
    execCtx.waitUntil(run());
    return undefined;
  }
  return run();
}

/** Push temps réel pour TOUTES les propriétés mappées — mutations tarifaires
 *  (saisons, règles) dont la propriété n'est pas sous la main. */
export async function triggerBeds24PushAll(
  db: D1Database,
  env: Env,
  execCtx: ExecutionContext | undefined,
): Promise<void> {
  if (!(await beds24Configured(env))) return;
  const { listProperties } = await import("../db/repo");
  const properties = await listProperties(db);
  for (const p of properties) {
    if (p.beds24PropertyId != null) triggerBeds24Push(db, env, execCtx, p.id);
  }
}
