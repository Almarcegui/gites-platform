// Heure de départ selon le jour (décision du 23/10/2026) : départ avant
// `checkoutTime`, sauf le dimanche où `checkoutTimeSunday` s'applique s'il est
// renseigné. Vide = même heure tous les jours. Seul point de vérité côté
// serveur ; le tunnel (public/book/checkout-time.js) et le back-office
// (app/src/lib/checkoutTime.ts) en gardent une copie à l'identique.

import { dayOfWeek, type IsoDate } from "./dates";

export interface CheckoutTimes {
  checkoutTime: string;
  /** Absent ou vide = même heure que `checkoutTime`. */
  checkoutTimeSunday?: string;
}

/** Heure de départ (« HH:MM ») d'un séjour qui se termine le `date`. */
export function checkoutTimeFor(s: CheckoutTimes, date: IsoDate | null | undefined): string {
  const sunday = (s.checkoutTimeSunday ?? "").trim();
  if (sunday && date && /^\d{4}-\d{2}-\d{2}$/.test(date) && dayOfWeek(date) === 0) return sunday;
  return s.checkoutTime;
}
