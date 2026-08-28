// Moteur de disponibilité LIÉ — la raison d'être de la plateforme.
//
// Modèle : une ligne unit_links (unitId → blocksUnitId) signifie « toute
// réservation active sur unitId rend blocksUnitId indisponible sur les mêmes
// nuits ». Pré Moré : Scieur↔Domaine, Scierie↔Domaine.
//
// La VÉRITÉ transactionnelle (anti-course) est la requête SQL atomique de
// src/db/repo.ts (createBookingAtomic). Ce module implémente la MÊME logique
// en pur TypeScript pour la recherche publique, le planning et l'export iCal ;
// les deux implémentations sont couvertes par les mêmes cas de test.

import { rangesOverlap, type IsoDate } from "./dates";

export interface UnitLink {
  unitId: number;
  blocksUnitId: number;
}

export interface BookingSpan {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate; // exclusif
  status: "pending" | "confirmed" | "cancelled";
  holdExpiresAt?: string | null; // 'YYYY-MM-DD HH:MM:SS' UTC (format sqlNow)
}

/** Blocage manuel (travaux, usage personnel) — issue #74. Ce n'est pas une
 *  vente, mais c'est la même occupation de stock. */
export interface ManualBlockSpan {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
}

/** Convertit des blocages manuels en périodes occupées, pour les faire entrer
 *  dans le MÊME moteur de liaison que les réservations (`isUnitFree`,
 *  `busySpans`). Un blocage occupe comme une réservation confirmée : ni option
 *  qui expire, ni statut à interpréter.
 *
 *  Le passage par cette fonction est volontaire : c'est le seul endroit où la
 *  question « un blocage occupe-t-il comme une résa ? » reçoit une réponse. */
export function blocksAsSpans(blocks: ManualBlockSpan[]): BookingSpan[] {
  return blocks.map((b) => ({
    unitId: b.unitId,
    checkin: b.checkin,
    checkout: b.checkout,
    status: "confirmed" as const,
    holdExpiresAt: null,
  }));
}

/** Une résa bloque-t-elle le stock à l'instant `now` (format sqlNow) ?
 *  confirmed → oui ; pending → tant que son option court ; cancelled → non. */
export function isActiveBooking(b: Pick<BookingSpan, "status" | "holdExpiresAt">, now: string): boolean {
  if (b.status === "confirmed") return true;
  if (b.status === "pending") return !!b.holdExpiresAt && b.holdExpiresAt > now;
  return false;
}

/** Unités dont les résas bloquent `unitId` : elle-même + celles qui la bloquent. */
export function blockingUnitIds(unitId: number, links: UnitLink[]): Set<number> {
  const set = new Set([unitId]);
  for (const l of links) if (l.blocksUnitId === unitId) set.add(l.unitId);
  return set;
}

/** L'unité est-elle libre sur [checkin, checkout) ? */
export function isUnitFree(
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  bookings: BookingSpan[],
  links: UnitLink[],
  now: string,
): boolean {
  const blockers = blockingUnitIds(unitId, links);
  return !bookings.some(
    (b) =>
      blockers.has(b.unitId) &&
      isActiveBooking(b, now) &&
      rangesOverlap(b.checkin, b.checkout, checkin, checkout),
  );
}

/** Unités TIERCES dont une occupation active recouvre [checkin, checkout) et
 *  rendent donc `unitId` indisponible — la contrepartie « pourquoi » de
 *  `isUnitFree` (issue #45). L'unité elle-même est exclue : quand c'est sa
 *  propre réservation qui occupe les nuits, il n'y a rien à expliquer.
 *  Résultat trié par identifiant, pour un affichage stable. */
export function blockingSourceUnitIds(
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  bookings: BookingSpan[],
  links: UnitLink[],
  now: string,
): number[] {
  const blockers = blockingUnitIds(unitId, links);
  const out = new Set<number>();
  for (const b of bookings) {
    if (b.unitId === unitId || !blockers.has(b.unitId)) continue;
    if (!isActiveBooking(b, now)) continue;
    if (!rangesOverlap(b.checkin, b.checkout, checkin, checkout)) continue;
    out.add(b.unitId);
  }
  return [...out].sort((a, b) => a - b);
}

export interface BusySpan {
  checkin: IsoDate;
  checkout: IsoDate;
  /** unité porteuse de la résa d'origine (≠ unitId ⇒ blocage par liaison) */
  sourceUnitId: number;
}

/** Périodes occupées d'une unité (résas propres + blocages par liaison),
 *  triées par date — base du planning et de l'export iCal. */
export function busySpans(
  unitId: number,
  bookings: BookingSpan[],
  links: UnitLink[],
  now: string,
): BusySpan[] {
  const blockers = blockingUnitIds(unitId, links);
  return bookings
    .filter((b) => blockers.has(b.unitId) && isActiveBooking(b, now))
    .map((b) => ({ checkin: b.checkin, checkout: b.checkout, sourceUnitId: b.unitId }))
    .sort((a, b) => (a.checkin < b.checkin ? -1 : a.checkin > b.checkin ? 1 : 0));
}

/** Fusionne des périodes triables qui se chevauchent ou se touchent —
 *  pour un export iCal compact. */
export function mergeSpans(spans: { checkin: IsoDate; checkout: IsoDate }[]): { checkin: IsoDate; checkout: IsoDate }[] {
  const sorted = [...spans].sort((a, b) => (a.checkin < b.checkin ? -1 : a.checkin > b.checkin ? 1 : 0));
  const out: { checkin: IsoDate; checkout: IsoDate }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.checkin <= last.checkout) {
      if (s.checkout > last.checkout) last.checkout = s.checkout;
    } else {
      out.push({ checkin: s.checkin, checkout: s.checkout });
    }
  }
  return out;
}
