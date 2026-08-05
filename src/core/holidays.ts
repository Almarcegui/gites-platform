// Jours fériés légaux belges — calculés à la volée, aucune table à maintenir.
// Pâques : computus grégorien (algorithme de Gauss dans la forme anonyme
// dite de Butcher/Meeus — exacte pour tout le calendrier grégorien).

import { addDays, dayOfWeek, type IsoDate } from "./dates";

export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = mars, 4 = avril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Les 10 jours fériés légaux belges d'une année (date → nom). */
export function belgianHolidays(year: number): Map<IsoDate, string> {
  const easter = easterSunday(year);
  return new Map<IsoDate, string>([
    [`${year}-01-01`, "Nouvel An"],
    [addDays(easter, 1), "Lundi de Pâques"],
    [`${year}-05-01`, "Fête du Travail"],
    [addDays(easter, 39), "Ascension"],
    [addDays(easter, 50), "Lundi de Pentecôte"],
    [`${year}-07-21`, "Fête nationale"],
    [`${year}-08-15`, "Assomption"],
    [`${year}-11-01`, "Toussaint"],
    [`${year}-11-11`, "Armistice"],
    [`${year}-12-25`, "Noël"],
  ]);
}

/** Ponts : jour ouvrable unique coincé entre un férié et le weekend.
 *  Férié un mardi → le lundi fait le pont ; férié un jeudi → le vendredi. */
export function bridgeDays(year: number): Set<IsoDate> {
  const holidays = belgianHolidays(year);
  const bridges = new Set<IsoDate>();
  for (const date of holidays.keys()) {
    const dow = dayOfWeek(date);
    if (dow === 2) bridges.add(addDays(date, -1));
    if (dow === 4) bridges.add(addDays(date, 1));
  }
  for (const b of bridges) if (holidays.has(b)) bridges.delete(b);
  return bridges;
}

/** Jours « à majoration » (fériés + ponts) pour un ensemble d'années. */
export function holidayRatedDays(years: number[]): Set<IsoDate> {
  const set = new Set<IsoDate>();
  for (const y of years) {
    for (const d of belgianHolidays(y).keys()) set.add(d);
    for (const d of bridgeDays(y)) set.add(d);
  }
  return set;
}

/** Une NUIT est majorée si sa date est un jour majoré, ou si elle en précède
 *  un (la veille d'un férié est la nuit la plus demandée).
 *  Ex. Noël : les nuits du 24 ET du 25/12 sont majorées. */
export function isHolidayRatedNight(night: IsoDate, ratedDays: Set<IsoDate>): boolean {
  return ratedDays.has(night) || ratedDays.has(addDays(night, 1));
}

/** Années couvertes par un séjour (checkout inclus, pour la veille du 01/01). */
export function yearsSpanned(checkin: IsoDate, checkout: IsoDate): number[] {
  const from = Number(checkin.slice(0, 4));
  const to = Number(checkout.slice(0, 4));
  const years: number[] = [];
  for (let y = from; y <= to; y++) years.push(y);
  return years;
}
