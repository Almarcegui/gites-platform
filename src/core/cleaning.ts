// Ménage dérivé des départs (plan v4, fonction 1) — logique pure.
//
// Un départ = un ménage, le jour du départ, à l'heure de départ du domaine.
// L'« arrivée suivante » se cherche sur le bien ET sur les biens qui partagent
// ses murs (liaisons unit_links dans un sens ou dans l'autre) : après le
// Domaine entier, les deux maisons sont à préparer, et l'arrivée suivante dans
// l'une d'elles fixe l'heure limite. Même règle que l'écran pilote
// (app/src/lib/derive.ts, cleaningTasks), désormais calculée côté serveur.
import type { UnitLink } from "./availability";
import type { IsoDate } from "./dates";

export interface CleaningBooking {
  id: number;
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  status: string;
  source: string;
  holdExpiresAt: string | null;
  persons: number;
}

export interface DesiredTask {
  bookingId: number;
  unitId: number;
  dueDate: IsoDate;
  dueTime: string;
  nextCheckin: IsoDate | null;
  nextCheckinTime: string | null;
  nextUnitId: number | null;
  nextPersons: number | null;
}

/** Une réservation produit-elle un ménage ? Confirmée, ou option posée à la
 *  main encore valable. Le tunnel public pose des « holds » de 30 minutes
 *  (source direct, pending) : ils ne créent rien, sinon chaque paiement
 *  abandonné laisserait une tâche annulée derrière lui. */
export function makesCleaning(b: Pick<CleaningBooking, "status" | "source" | "holdExpiresAt">, nowSql: string): boolean {
  if (b.status === "confirmed") return true;
  if (b.status !== "pending" || b.source === "direct") return false;
  return !!b.holdExpiresAt && b.holdExpiresAt > nowSql;
}

/** Biens qui partagent les murs de `unitId` (lui compris). */
export function relatedUnits(unitId: number, links: UnitLink[]): Set<number> {
  const s = new Set([unitId]);
  for (const l of links) {
    if (l.unitId === unitId) s.add(l.blocksUnitId);
    if (l.blocksUnitId === unitId) s.add(l.unitId);
  }
  return s;
}

/** Ménages voulus pour les départs de [from, to). `bookings` doit couvrir aussi
 *  les arrivées au-delà de `to` (pour trouver l'arrivée suivante). */
export function desiredCleaningTasks(
  bookings: CleaningBooking[],
  links: UnitLink[],
  times: { checkinTime: string; checkoutTime: string },
  from: IsoDate,
  to: IsoDate,
  nowSql: string,
): DesiredTask[] {
  const active = bookings.filter((b) => makesCleaning(b, nowSql));
  const out: DesiredTask[] = [];
  for (const b of active) {
    if (b.checkout < from || b.checkout >= to) continue;
    const rel = relatedUnits(b.unitId, links);
    const next = active
      .filter((x) => x.id !== b.id && rel.has(x.unitId) && x.checkin >= b.checkout)
      .sort((x, y) => (x.checkin < y.checkin ? -1 : x.checkin > y.checkin ? 1 : x.id - y.id))[0];
    out.push({
      bookingId: b.id,
      unitId: b.unitId,
      dueDate: b.checkout,
      dueTime: times.checkoutTime,
      nextCheckin: next?.checkin ?? null,
      nextCheckinTime: next ? times.checkinTime : null,
      nextUnitId: next?.unitId ?? null,
      nextPersons: next ? next.persons : null,
    });
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.unitId - b.unitId));
}
