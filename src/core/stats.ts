// Statistiques annuelles — calcul pur à partir des réservations.
//
// Définitions (affichées telles quelles dans le back-office) :
//  · Occupation : nuits occupées des unités PHYSIQUES / nuits disponibles.
//    Une résa « Domaine entier » occupe ses deux maisons composantes.
//  · Revenus : total TTC de chaque résa réparti au prorata de ses nuits
//    (une résa à cheval sur deux mois/années est ventilée nuit par nuit).
//  · ADR (prix moyen/nuit) : revenus / nuits VENDUES (une nuit « Domaine
//    entier » = 1 nuit vendue, même si elle occupe 2 maisons).
//  · Durée moyenne : moyenne des nuits des résas dont l'ARRIVÉE est dans l'année.

import { eachNight, type IsoDate } from "./dates";
import type { UnitLink } from "./availability";

export interface StatsUnit {
  id: number;
  name: string;
  isComposite: boolean;
  active: boolean;
}

export interface StatsBooking {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  totalCents: number;
}

export interface MonthStat {
  month: number; // 1..12
  occupiedNights: number;
  capacityNights: number;
  occupancyPct: number; // arrondi à 1 décimale
  revenueCents: number;
}

export interface UnitYearStat {
  unitId: number;
  name: string;
  nights: number;
  revenueCents: number;
}

export interface YearStats {
  year: number;
  months: MonthStat[];
  occupancyPct: number;
  revenueCents: number;
  adrCents: number;
  avgStayNights: number; // 1 décimale
  bookingsCount: number;
  soldNights: number;
  perUnit: UnitYearStat[];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Délai de réservation, entonnoir, recherches (issue #36)
//
// Ces trois indicateurs répondent à des questions de décision, pas de bilan :
// à quelle avance les gens réservent (faut-il ouvrir les calendriers plus tôt),
// où ils abandonnent, et ce qu'ils cherchent sans le trouver.
// ---------------------------------------------------------------------------

export interface LeadTimeBooking {
  unitId: number;
  unitName: string;
  checkin: IsoDate;
  /** Date de la réservation (jour seulement, fuseau du serveur). */
  bookedOn: IsoDate;
}

export interface LeadTimeGroup {
  /** Mois d'ARRIVÉE (1..12) ou identifiant d'unité selon la ventilation. */
  key: number;
  label: string;
  count: number;
  avgDays: number;    // 1 décimale
  medianDays: number; // 1 décimale
}

export interface LeadTimeStats {
  count: number;
  avgDays: number;
  medianDays: number;
  /** Ventilation par mois d'arrivée. */
  byMonth: LeadTimeGroup[];
  /** Ventilation par hébergement. */
  byUnit: LeadTimeGroup[];
}

const MONTH_LABELS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function daysBetween(a: IsoDate, b: IsoDate): number {
  const toUtc = (d: IsoDate): number => {
    const [y = 0, m = 1, day = 1] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Médiane d'une série déjà collectée (moyenne des deux valeurs centrales sur
 *  un effectif pair). La médiane compte autant que la moyenne ici : une seule
 *  réservation posée deux ans à l'avance suffit à décaler la moyenne d'un mois
 *  et à faire croire que la clientèle s'y prend très tôt. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function summarize(key: number, label: string, days: number[]): LeadTimeGroup {
  const sum = days.reduce((s, d) => s + d, 0);
  return {
    key,
    label,
    count: days.length,
    avgDays: days.length > 0 ? round1(sum / days.length) : 0,
    medianDays: days.length > 0 ? round1(median(days)) : 0,
  };
}

/** Délai de réservation : écart en jours entre la date de réservation et la
 *  date d'arrivée, ventilé par mois d'arrivée et par hébergement.
 *
 *  Les délais NÉGATIFS sont écartés : ils viennent des imports (une résa
 *  rapatriée d'un canal ou d'elloha porte la date de son import, pas celle de
 *  sa vente) et fausseraient l'indicateur dans le sens qui trompe le plus —
 *  vers le « les gens réservent au dernier moment ». */
export function computeLeadTime(year: number, bookings: LeadTimeBooking[]): LeadTimeStats {
  const all: number[] = [];
  const perMonth = new Map<number, number[]>();
  const perUnit = new Map<number, { name: string; days: number[] }>();

  for (const b of bookings) {
    if (!b.checkin.startsWith(String(year))) continue;
    const days = daysBetween(b.bookedOn, b.checkin);
    if (days < 0) continue;
    all.push(days);
    const month = Number(b.checkin.slice(5, 7));
    const monthDays = perMonth.get(month) ?? [];
    monthDays.push(days);
    perMonth.set(month, monthDays);
    const unit = perUnit.get(b.unitId) ?? { name: b.unitName, days: [] };
    unit.days.push(days);
    perUnit.set(b.unitId, unit);
  }

  const byMonth: LeadTimeGroup[] = [];
  for (let m = 1; m <= 12; m++) {
    byMonth.push(summarize(m, MONTH_LABELS[m - 1] ?? String(m), perMonth.get(m) ?? []));
  }
  const byUnit = [...perUnit.entries()]
    .map(([id, u]) => summarize(id, u.name, u.days))
    .sort((a, b) => a.key - b.key);

  return {
    count: all.length,
    avgDays: all.length > 0 ? round1(all.reduce((s, d) => s + d, 0) / all.length) : 0,
    medianDays: all.length > 0 ? round1(median(all)) : 0,
    byMonth,
    byUnit,
  };
}

export interface FunnelCounts {
  /** Recherches de disponibilité. */
  searches: number;
  /** Devis détaillés affichés. */
  quotes: number;
  /** Réservations démarrées : coordonnées saisies et créneau bloqué. */
  started: number;
  /** Réservations confirmées (paiement encaissé). */
  confirmed: number;
}

export interface FunnelStep {
  key: keyof FunnelCounts;
  label: string;
  count: number;
  /** Taux de passage depuis l'étape précédente (%), null pour la première. */
  fromPreviousPct: number | null;
  /** Part de l'étape initiale (%), null si aucune recherche enregistrée. */
  ofFirstPct: number | null;
}

export interface Funnel {
  steps: FunnelStep[];
  /** Recherche → réservation confirmée (%), null sans recherche enregistrée. */
  overallPct: number | null;
  /** Étape qui perd le plus de monde, en valeur absolue. Null si rien à perdre. */
  biggestDropKey: keyof FunnelCounts | null;
}

/** Entonnoir de conversion. Le taux de passage est null (et non 0) quand
 *  l'étape précédente est vide : « 0 % » se lirait comme un effondrement alors
 *  qu'il n'y a rien à convertir — c'est exactement l'erreur qui ferait chercher
 *  une panne là où il n'y a qu'un journal encore vide. */
export function computeFunnel(counts: FunnelCounts): Funnel {
  const defs: { key: keyof FunnelCounts; label: string }[] = [
    { key: "searches", label: "Recherches" },
    { key: "quotes", label: "Devis affichés" },
    { key: "started", label: "Réservations démarrées" },
    { key: "confirmed", label: "Réservations confirmées" },
  ];
  const first = counts[defs[0]!.key];
  const steps: FunnelStep[] = defs.map((d, i) => {
    const count = counts[d.key];
    const prev = i === 0 ? null : counts[defs[i - 1]!.key];
    return {
      key: d.key,
      label: d.label,
      count,
      fromPreviousPct: prev == null ? null : prev > 0 ? round1((count / prev) * 100) : null,
      ofFirstPct: first > 0 ? round1((count / first) * 100) : null,
    };
  });

  let biggestDropKey: keyof FunnelCounts | null = null;
  let biggestDrop = 0;
  for (let i = 1; i < defs.length; i++) {
    const drop = counts[defs[i - 1]!.key] - counts[defs[i]!.key];
    if (drop > biggestDrop) {
      biggestDrop = drop;
      biggestDropKey = defs[i]!.key;
    }
  }

  return {
    steps,
    overallPct: first > 0 ? round1((counts.confirmed / first) * 100) : null,
    biggestDropKey,
  };
}

export interface SearchLogEntry {
  checkin: IsoDate;
  checkout: IsoDate;
  nights: number;
  adults: number;
  children: number;
  found: boolean;
}

export interface EmptySearchGroup {
  checkin: IsoDate;
  checkout: IsoDate;
  nights: number;
  count: number;
  /** Occupants demandés au maximum sur ce groupe — dit si c'est un gros groupe. */
  maxPersons: number;
}

export interface SearchStats {
  total: number;
  empty: number;
  emptyPct: number;
  /** Dates les plus demandées SANS réponse, les plus fréquentes d'abord. */
  topEmpty: EmptySearchGroup[];
}

/** Synthèse du journal des recherches. La liste des demandes infructueuses est
 *  la sortie utile : elle dit quelles dates il faudrait ouvrir, et pour combien
 *  de personnes. */
export function summarizeSearches(entries: SearchLogEntry[], topN = 10): SearchStats {
  const groups = new Map<string, EmptySearchGroup>();
  let empty = 0;
  for (const e of entries) {
    if (e.found) continue;
    empty += 1;
    const key = `${e.checkin}|${e.checkout}`;
    const persons = e.adults + e.children;
    const g = groups.get(key) ?? { checkin: e.checkin, checkout: e.checkout, nights: e.nights, count: 0, maxPersons: 0 };
    g.count += 1;
    g.maxPersons = Math.max(g.maxPersons, persons);
    groups.set(key, g);
  }
  const topEmpty = [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.checkin < b.checkin ? -1 : 1))
    .slice(0, topN);
  return {
    total: entries.length,
    empty,
    emptyPct: entries.length > 0 ? round1((empty / entries.length) * 100) : 0,
    topEmpty,
  };
}

export function computeYearStats(
  year: number,
  units: StatsUnit[],
  links: UnitLink[],
  bookings: StatsBooking[],
): YearStats {
  const physical = units.filter((u) => !u.isComposite && u.active);
  const physicalIds = new Set(physical.map((u) => u.id));
  const componentsOf = (unitId: number): number[] => {
    const comps = links.filter((l) => l.unitId === unitId && physicalIds.has(l.blocksUnitId)).map((l) => l.blocksUnitId);
    return comps.length > 0 ? comps : [unitId];
  };
  const unitById = new Map(units.map((u) => [u.id, u]));

  const occupied = new Array<number>(13).fill(0);
  const revenue = new Array<number>(13).fill(0); // flottant, arrondi à la fin
  const perUnitMap = new Map<number, UnitYearStat>();
  let soldNights = 0;
  let bookingsCount = 0;
  let staySum = 0;

  for (const b of bookings) {
    const nights = eachNight(b.checkin, b.checkout);
    if (nights.length === 0) continue;
    const perNight = b.totalCents / nights.length;
    const unit = unitById.get(b.unitId);
    const expansion = unit?.isComposite ? componentsOf(b.unitId) : [b.unitId];

    let unitStat = perUnitMap.get(b.unitId);
    if (!unitStat) {
      unitStat = { unitId: b.unitId, name: unit?.name ?? `Unité ${b.unitId}`, nights: 0, revenueCents: 0 };
      perUnitMap.set(b.unitId, unitStat);
    }

    for (const night of nights) {
      if (!night.startsWith(String(year))) continue;
      const month = Number(night.slice(5, 7));
      revenue[month] = (revenue[month] ?? 0) + perNight;
      occupied[month] = (occupied[month] ?? 0) + expansion.length;
      soldNights += 1;
      unitStat.nights += 1;
      unitStat.revenueCents += perNight;
    }

    if (b.checkin.startsWith(String(year))) {
      bookingsCount += 1;
      staySum += nights.length;
    }
  }

  const months: MonthStat[] = [];
  let totalOccupied = 0;
  let totalCapacity = 0;
  let totalRevenue = 0;
  for (let m = 1; m <= 12; m++) {
    const capacity = daysInMonth(year, m) * physical.length;
    const occ = occupied[m] ?? 0;
    const rev = Math.round(revenue[m] ?? 0);
    months.push({
      month: m,
      occupiedNights: occ,
      capacityNights: capacity,
      occupancyPct: capacity > 0 ? Math.round((occ / capacity) * 1000) / 10 : 0,
      revenueCents: rev,
    });
    totalOccupied += occ;
    totalCapacity += capacity;
    totalRevenue += rev;
  }

  const perUnit = [...perUnitMap.values()]
    .map((u) => ({ ...u, revenueCents: Math.round(u.revenueCents) }))
    .sort((a, b) => a.unitId - b.unitId);

  return {
    year,
    months,
    occupancyPct: totalCapacity > 0 ? Math.round((totalOccupied / totalCapacity) * 1000) / 10 : 0,
    revenueCents: totalRevenue,
    adrCents: soldNights > 0 ? Math.round(totalRevenue / soldNights) : 0,
    avgStayNights: bookingsCount > 0 ? Math.round((staySum / bookingsCount) * 10) / 10 : 0,
    bookingsCount,
    soldNights,
    perUnit,
  };
}
