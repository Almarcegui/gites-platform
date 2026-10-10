// Suggestions de prix en un clic — reprise telle quelle de la logique de
// l'ancien écran (public/admin/suggestions.js, testée par
// test/suggestions.test.ts) : une nuit coincée entre deux séjours, des dates
// proches encore libres, des fériés déjà majorés. Une suggestion PRÉ-REMPLIT
// la saisie ; rien ne s'enregistre sans le geste de la personne.
import { t } from "@lingui/core/macro";
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
  /** Changement de prix jour par jour, regroupé en plages contiguës au même
   *  nouveau prix : seules les nuits visées bougent (pas les nuits vendues ni
   *  les jours ordinaires entre deux fériés). */
  runs?: { from: IsoDate; to: IsoDate; priceCents: number }[];
}

/** Nouveau prix de chaque jour retenu, en plages contiguës homogènes. */
export function runsOf(days: readonly DayRate[], pct: number): { from: IsoDate; to: IsoDate; priceCents: number }[] {
  const out: { from: IsoDate; to: IsoDate; priceCents: number }[] = [];
  for (const d of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (d.priceCents == null) continue;
    const p = Math.round((d.priceCents * (100 + pct)) / 100);
    const last = out[out.length - 1];
    if (last && last.priceCents === p && addDays(last.to, 1) === d.date) last.to = d.date;
    else out.push({ from: d.date, to: d.date, priceCents: p });
  }
  return out;
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
    const min = d.minNights;
    const date = dfr(from);
    out.push({
      kind: "orphelines",
      title: nights > 1 ? t`Nuits orphelines du ${date}` : t`Nuit orpheline du ${date}`,
      why: nights > 1 ? t`${nights} nuits libres entre deux séjours, alors que le minimum est de ${min} nuits : personne ne peut réserver ce trou.` : t`1 nuit libre entre deux séjours, alors que le minimum est de ${min} nuits : personne ne peut réserver ce trou.`,
      action: nights > 1 ? t`Descendre le minimum à ${nights} nuits` : t`Descendre le minimum à 1 nuit`,
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
      title: t`Dernière minute : ${proches.length} nuits encore libres d'ici le ${dfr(last.date)}`,
      why: t`− ${LAST_MINUTE_PCT} % sur chacune de ces nuits libres, par exemple ${eur(first.priceCents!)} → ${eur(cut)}. Au-delà, vous vendriez moins cher que votre prix de base. Les nuits déjà vendues ne bougent pas.`,
      action: t`Proposer − ${LAST_MINUTE_PCT} %`,
      from: first.date,
      to: last.date,
      prefill: {},
      runs: runsOf(proches, -LAST_MINUTE_PCT),
    });
  }

  const fortes = days.filter((d) => d.holidayRated && d.date >= today && libre(d.date) && d.priceCents != null && d.overridePriceCents == null);
  if (fortes.length > 0) {
    const up = Math.round((fortes[0]!.priceCents! * (100 + STRONG_DATE_PCT)) / 100);
    const n = fortes.length;
    out.push({
      kind: "dates-fortes",
      title: n > 1 ? t`Dates fortes : ${n} jours fériés ou ponts` : t`Dates fortes : 1 jour férié ou pont`,
      why: t`Le prix est déjà majoré ces jours-là. Un cran de plus (+ ${STRONG_DATE_PCT} %) sur chacun d'eux seulement, par exemple le ${dfr(fortes[0]!.date)} : ${eur(fortes[0]!.priceCents!)} → ${eur(up)}.`,
      action: t`Proposer + ${STRONG_DATE_PCT} %`,
      from: fortes[0]!.date,
      to: fortes[fortes.length - 1]!.date,
      prefill: {},
      runs: runsOf(fortes, STRONG_DATE_PCT),
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
