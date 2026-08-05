// Utilitaires de dates. Tout le domaine travaille en chaînes ISO 'YYYY-MM-DD',
// comparables lexicographiquement. Les nuitées d'un séjour forment l'intervalle
// SEMI-OUVERT [checkin, checkout) : un départ et une arrivée le même jour ne
// se chevauchent pas (rotation le jour même possible).

export type IsoDate = string; // 'YYYY-MM-DD'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Valide le format ET l'existence de la date (rejette 2026-02-30). */
export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== "string" || !ISO_RE.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUtc(date: IsoDate): Date {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(dt: Date): IsoDate {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const dt = toUtc(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toIso(dt);
}

/** Nombre de jours entre deux dates (b − a). Négatif si b < a. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** Jour de la semaine : 0=dimanche … 5=vendredi, 6=samedi. */
export function dayOfWeek(date: IsoDate): number {
  return toUtc(date).getUTCDay();
}

/** Les nuits d'un séjour : chaque date de [checkin, checkout). */
export function eachNight(checkin: IsoDate, checkout: IsoDate): IsoDate[] {
  const nights: IsoDate[] = [];
  for (let d = checkin; d < checkout; d = addDays(d, 1)) nights.push(d);
  return nights;
}

/** Chevauchement de deux intervalles semi-ouverts [aStart,aEnd) / [bStart,bEnd). */
export function rangesOverlap(aStart: IsoDate, aEnd: IsoDate, bStart: IsoDate, bEnd: IsoDate): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Date du jour dans un fuseau IANA — Europe/Brussels pour toute la logique
 *  métier (early bird, last minute, échéance de solde). */
export function todayInZone(now: Date = new Date(), timeZone = "Europe/Brussels"): IsoDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Horodatage UTC au format SQLite 'YYYY-MM-DD HH:MM:SS' — LE format canonique
 *  de tous les timestamps du projet (identique à datetime('now') côté D1),
 *  pour que les comparaisons lexicographiques SQL/TS soient toujours valides. */
export function sqlNow(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace("T", " ");
}
