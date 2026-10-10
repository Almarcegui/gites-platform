// Dates du calendrier : chaînes ISO « AAAA-MM-JJ », calculées en UTC pour
// qu'aucun changement d'heure ne décale un jour. « Aujourd'hui » se lit à
// Bruxelles, comme côté serveur.
import type { IsoDate } from "../api/types";

export function todayBrussels(now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function toUtc(d: IsoDate): Date {
  const [y, m, j] = d.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, j ?? 1));
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** 0 = lundi … 6 = dimanche. */
export function weekdayMon(d: IsoDate): number {
  return (toUtc(d).getUTCDay() + 6) % 7;
}

export function isWeekend(d: IsoDate): boolean {
  return weekdayMon(d) >= 5;
}

export function mondayOf(d: IsoDate): IsoDate {
  return addDays(d, -weekdayMon(d));
}

export function dayRange(from: IsoDate, count: number): IsoDate[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const JOURS_COURTS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export function dayNum(d: IsoDate): number {
  return Number(d.slice(8, 10));
}
function quantieme(d: IsoDate): string {
  const n = dayNum(d);
  return n === 1 ? "1er" : String(n);
}
export function monthName(d: IsoDate): string {
  return MOIS[Number(d.slice(5, 7)) - 1] ?? "";
}
export function monthShort(d: IsoDate): string {
  return MOIS_COURTS[Number(d.slice(5, 7)) - 1] ?? "";
}
export function weekdayShort(d: IsoDate): string {
  return JOURS_COURTS[weekdayMon(d)] ?? "";
}
export function weekdayLong(d: IsoDate): string {
  return JOURS[weekdayMon(d)] ?? "";
}

/** « samedi 10 octobre » */
export function longDate(d: IsoDate): string {
  return `${weekdayLong(d)} ${quantieme(d)} ${monthName(d)}`;
}
/** « Samedi 10 octobre » */
export function titleDate(d: IsoDate): string {
  const s = longDate(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** « 10 octobre » */
export function shortDate(d: IsoDate): string {
  return `${quantieme(d)} ${monthName(d)}`;
}
/** « du 23 au 30 octobre » ou « du 30 octobre au 2 novembre » */
export function stayRange(a: IsoDate, b: IsoDate): string {
  if (a.slice(0, 7) === b.slice(0, 7)) return `du ${quantieme(a)} au ${shortDate(b)}`;
  return `du ${shortDate(a)} au ${shortDate(b)}`;
}

/** « 16:00 » → « 16 h », « 10:30 » → « 10 h 30 » */
export function hourLabel(hhmm: string | undefined | null): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":");
  const hh = String(Number(h));
  return m && m !== "00" ? `${hh} h ${m}` : `${hh} h`;
}

/** Date-heure SQL « 2026-10-10 08:42:00 » (UTC) → « 8 h 42 », « hier », « jeudi », « 8 oct. » */
export function whenLabel(sql: string, today: IsoDate): string {
  const iso = sql.includes("T") ? sql : sql.replace(" ", "T") + "Z";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  const day = todayBrussels(dt);
  const delta = diffDays(day, today);
  if (delta === 0) {
    const parts = new Intl.DateTimeFormat("fr-BE", { timeZone: "Europe/Brussels", hour: "numeric", minute: "2-digit" }).formatToParts(dt);
    const h = parts.find((p) => p.type === "hour")?.value ?? "";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${Number(h)} h ${m}`;
  }
  if (delta === 1) return "hier";
  if (delta > 1 && delta < 7) return weekdayLong(day);
  return `${dayNum(day)} ${monthShort(day)}`;
}
