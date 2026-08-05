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
