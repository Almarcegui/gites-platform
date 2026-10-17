// Dates du calendrier : chaînes ISO « AAAA-MM-JJ », calculées en UTC pour
// qu'aucun changement d'heure ne décale un jour. « Aujourd'hui » se lit à
// Bruxelles, comme côté serveur.
import { i18n } from "@lingui/core";

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

// Noms des jours et des mois dans la langue de l'écran (français ou
// néerlandais de Belgique), lus au moment de l'affichage.
const NAMES = {
  fr: {
    jours: ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
    joursCourts: ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
    mois: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    moisCourts: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
  },
  nl: {
    jours: ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"],
    joursCourts: ["ma", "di", "wo", "do", "vr", "za", "zo"],
    mois: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
    moisCourts: ["jan.", "feb.", "mrt.", "apr.", "mei", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."],
  },
};
const isNl = () => i18n.locale === "nl";
const names = () => (isNl() ? NAMES.nl : NAMES.fr);

export function dayNum(d: IsoDate): number {
  return Number(d.slice(8, 10));
}
function quantieme(d: IsoDate): string {
  const n = dayNum(d);
  return n === 1 && !isNl() ? "1er" : String(n);
}
export function monthName(d: IsoDate): string {
  return names().mois[Number(d.slice(5, 7)) - 1] ?? "";
}
export function monthShort(d: IsoDate): string {
  return names().moisCourts[Number(d.slice(5, 7)) - 1] ?? "";
}
/** Mois abrégé d'après son rang 0 = janvier … 11 = décembre (« janv. », « jan. »). */
export function monthShortOfIndex(i: number): string {
  return names().moisCourts[i] ?? "";
}
export function weekdayShort(d: IsoDate): string {
  return names().joursCourts[weekdayMon(d)] ?? "";
}
/** Jour de la semaine abrégé d'après son numéro 0 = dimanche … 6 = samedi (« ven. », « vr »). */
export function weekdayShortOfIndex(day: number): string {
  return names().joursCourts[(day + 6) % 7] ?? "";
}
export function weekdayLong(d: IsoDate): string {
  return names().jours[weekdayMon(d)] ?? "";
}

/** « samedi 10 octobre » · « zaterdag 10 oktober » */
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
/** « du 23 au 30 octobre » ou « du 30 octobre au 2 novembre » · « van 23 tot 30 oktober » */
export function stayRange(a: IsoDate, b: IsoDate): string {
  const [du, au] = isNl() ? ["van", "tot"] : ["du", "au"];
  if (a.slice(0, 7) === b.slice(0, 7)) return `${du} ${quantieme(a)} ${au} ${shortDate(b)}`;
  return `${du} ${shortDate(a)} ${au} ${shortDate(b)}`;
}

/** « 16:00 » → « 16 h », « 10:30 » → « 10 h 30 » ; en néerlandais « 16 u », « 10.30 u » */
export function hourLabel(hhmm: string | undefined | null): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":");
  const hh = String(Number(h));
  if (isNl()) return m && m !== "00" ? `${hh}.${m} u` : `${hh} u`;
  return m && m !== "00" ? `${hh} h ${m}` : `${hh} h`;
}

/** Date-heure de la base (UTC, « 2026-10-10 12:32:00 » ou ISO) → jour et heure de Belgique :
 *  { day: "2026-10-10", time: "14:32" }. Rend null si le texte n'est pas une date-heure. */
export function sqlToBrussels(s: string | null | undefined): { day: IsoDate; time: string } | null {
  const m = (s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(utc)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
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
    return hourLabel(`${Number(h)}:${m}`);
  }
  if (delta === 1) return isNl() ? "gisteren" : "hier";
  if (delta > 1 && delta < 7) return weekdayLong(day);
  return `${dayNum(day)} ${monthShort(day)}`;
}
