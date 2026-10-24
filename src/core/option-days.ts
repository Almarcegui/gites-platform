// Options réservées à une date (24/10/2026) : jours proposés et prix, fonctions pures.
// Un jour par ligne `option_days` ; l'unicité en base fait foi, ce module ne fait que calculer.

import { addDays, dayOfWeek, type IsoDate } from "./dates";
import { checkoutTimeFor, type CheckoutTimes } from "./checkout-time";

export interface DatedPricing {
  /** prix d'un jour de semaine */
  priceCents: number;
  /** prix d'un jour de week-end ; null = même prix */
  weekendPriceCents: number | null;
  /** jours week-end (0 = dimanche … 6 = samedi) ; null = ven, sam, dim */
  weekendDays: number[] | null;
  /** pourcentage du prix pour un jour qui suit un jour choisi ; null = pas de remise */
  consecutivePct: number | null;
}

export const DEFAULT_WEEKEND_DAYS = [5, 6, 0];

export function parseWeekendDays(s: string | null | undefined): number[] | null {
  if (s == null || s.trim() === "") return null;
  const out = s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return out.length ? [...new Set(out)] : null;
}

/** Jours proposés : de l'arrivée à la veille du départ, plus le jour du départ s'il a
 *  l'horaire tardif du dimanche (départ à 18 h au lieu de 10 h). */
export function proposedDays(checkin: IsoDate, checkout: IsoDate, times: CheckoutTimes): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = checkin; d < checkout; d = addDays(d, 1)) out.push(d);
  const sundayRule = (times.checkoutTimeSunday ?? "").trim();
  if (sundayRule && dayOfWeek(checkout) === 0 && checkoutTimeFor(times, checkout) !== times.checkoutTime) out.push(checkout);
  return out;
}

export function dayPriceCents(p: DatedPricing, date: IsoDate): number {
  const we = p.weekendDays ?? DEFAULT_WEEKEND_DAYS;
  const isWeekend = we.includes(dayOfWeek(date));
  return isWeekend && p.weekendPriceCents != null ? p.weekendPriceCents : p.priceCents;
}

export interface PricedDay {
  date: IsoDate;
  amountCents: number;
  /** vrai si le jour suit immédiatement un autre jour choisi (remise appliquée) */
  consecutive: boolean;
}

/** Prix de chaque jour choisi, dans l'ordre des dates (doublons ignorés). */
export function priceDays(p: DatedPricing, days: readonly IsoDate[]): PricedDay[] {
  const sorted = [...new Set(days)].sort();
  const set = new Set(sorted);
  return sorted.map((date) => {
    const base = dayPriceCents(p, date);
    const consecutive = p.consecutivePct != null && set.has(addDays(date, -1));
    return { date, amountCents: consecutive ? Math.round((base * (p.consecutivePct as number)) / 100) : base, consecutive };
  });
}

const JOURS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

/** « sam 25/10 » */
export function dayShort(date: IsoDate): string {
  return `${JOURS[dayOfWeek(date)]} ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function eur(cents: number): string {
  const v = cents / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(".", ",")} €`;
}

/** « Sauna — sam 25/10 (180 €), dim 26/10 (126 €) » */
export function datedLabel(name: string, priced: readonly PricedDay[]): string {
  return `${name} — ${priced.map((d) => `${dayShort(d.date)} (${eur(d.amountCents)})`).join(", ")}`;
}
