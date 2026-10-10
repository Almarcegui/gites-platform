// Suggestions de prix en un clic — reprise telle quelle de la logique de
// l'ancien écran (public/admin/suggestions.js, testée par
// test/suggestions.test.ts) : une nuit coincée entre deux séjours, des dates
// proches encore libres, des fériés déjà majorés. Une suggestion PRÉ-REMPLIT
// la saisie ; rien ne s'enregistre sans le geste de la personne.
import type { DayRate, IsoDate } from "../api/types";
import { addDays, diffDays } from "./dates";
import { eur } from "./money";

export const LAST_MINUTE_PCT = 10;
export const STRONG_DATE_PCT = 15;
export const LAST_MINUTE_DAYS = 21;

const dfr = (iso: IsoDate) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export interface Suggestion {
  kind: "orphelines" | "derniere-minute" | "dates-fortes";
  title: string;
  why: string;
  action: string;
  from: IsoDate;
  to: IsoDate;
  prefill: { minNights?: number; priceCents?: number };
}

export function buildSuggestions(input: {
  days: readonly DayRate[];
  soldDates: ReadonlySet<IsoDate>;
  bookings: readonly { unitId: number; checkin: IsoDate; checkout: IsoDate }[];
  unitId: number;
  today: IsoDate;
  monthEnd: IsoDate;
}): Suggestion[] {
  const { days, soldDates, bookings, unitId, today, monthEnd } = input;
  const out: Suggestion[] = [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const libre = (iso: IsoDate) => !soldDates.has(iso);

  const stays = bookings
    .filter((b) => b.unitId === unitId)
    .map((b) => ({ checkin: b.checkin, checkout: b.checkout }))
    .sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
  for (let i = 0; i + 1 < stays.length; i++) {
    const from = stays[i]!.checkout;
    const to = addDays(stays[i + 1]!.checkin, -1);
    if (from > to || from < today) continue;
    const nights = diffDays(from, to) + 1;
    if (nights > 2) continue;
    const d = byDate.get(from);
    if (!d || d.minNights == null || d.minNights <= nights) continue;
    const s = nights > 1 ? "s" : "";
    out.push({
      kind: "orphelines",
      title: `Nuit${s} orpheline${s} du ${dfr(from)}`,
      why: `${nights} nuit${s} libre${s} entre deux séjours, alors que le minimum est de ${d.minNights} nuits : personne ne peut réserver ce trou.`,
      action: `Descendre le minimum à ${nights} nuit${s}`,
      from,
      to,
      prefill: { minNights: nights },
    });
    break;
  }

  const horizon = addDays(today, LAST_MINUTE_DAYS);
  const proches = days.filter((d) => d.date >= today && d.date <= horizon && d.date <= monthEnd && libre(d.date) && d.priceCents != null);
  if (proches.length >= 2) {
    const first = proches[0]!;
    const last = proches[proches.length - 1]!;
    const cut = Math.round((first.priceCents! * (100 - LAST_MINUTE_PCT)) / 100);
    out.push({
      kind: "derniere-minute",
      title: `Dernière minute : ${proches.length} nuits encore libres d'ici le ${dfr(last.date)}`,
      why: `Remise bornée à ${LAST_MINUTE_PCT} % sur ces dates proches : ${eur(first.priceCents!)} − ${LAST_MINUTE_PCT} % = ${eur(cut)}. Au-delà, vous vendez moins cher que votre prix de base.`,
      action: `Proposer − ${LAST_MINUTE_PCT} %`,
      from: first.date,
      to: last.date,
      prefill: { priceCents: cut },
    });
  }

  const fortes = days.filter((d) => d.holidayRated && d.date >= today && d.priceCents != null && d.overridePriceCents == null);
  if (fortes.length > 0) {
    const up = Math.round((fortes[0]!.priceCents! * (100 + STRONG_DATE_PCT)) / 100);
    const s = fortes.length > 1 ? "s" : "";
    out.push({
      kind: "dates-fortes",
      title: `Dates fortes : ${fortes.length} jour${s} férié${s} ou pont`,
      why: `Le prix est déjà majoré ces jours-là. Un cran de plus se justifie le ${dfr(fortes[0]!.date)} : ${eur(fortes[0]!.priceCents!)} + ${STRONG_DATE_PCT} % = ${eur(up)}.`,
      action: `Proposer + ${STRONG_DATE_PCT} %`,
      from: fortes[0]!.date,
      to: fortes[fortes.length - 1]!.date,
      prefill: { priceCents: up },
    });
  }
  return out;
}

/** Nuits vendues ou bloquées par liaison d'un bien. */
export function soldNights(
  planning: { bookings: readonly { unitId: number; checkin: IsoDate; checkout: IsoDate }[]; blocks: readonly { unitId: number; checkin: IsoDate; checkout: IsoDate }[] },
  unitId: number,
): Set<IsoDate> {
  const set = new Set<IsoDate>();
  for (const b of [...planning.bookings, ...planning.blocks].filter((x) => x.unitId === unitId)) {
    for (let d = b.checkin; d < b.checkout; d = addDays(d, 1)) set.add(d);
  }
  return set;
}
