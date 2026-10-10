// Saisons « en langage simple » : l'écran ne montre jamais de priorité
// numérique. La règle dite à Julien est : « la période la plus courte
// l'emporte, un prix fixé à la main passe avant tout ». Le serveur, lui,
// départage les saisons qui se chevauchent par leur priorité (la plus haute
// gagne, puis l'identifiant le plus récent). L'écran calcule donc la priorité
// de chaque saison à partir de sa durée, et l'enregistre à chaque changement.
import type { DayRate, IsoDate } from "../api/types";
import type { Season } from "../api/types2";
import { addDays, diffDays } from "./dates";

/** Nombre de nuits couvertes (bornes incluses). */
export function seasonNights(s: Pick<Season, "dateStart" | "dateEnd">): number {
  return diffDays(s.dateStart, s.dateEnd) + 1;
}

/** Priorité voulue pour chaque saison : la plus courte reçoit la plus haute.
 *  À durée égale, la plus récente (id le plus grand) passe devant, comme le
 *  serveur à priorité égale. */
export function wantedPriorities(seasons: readonly Season[]): Map<number, number> {
  const sorted = [...seasons].sort((a, b) => seasonNights(b) - seasonNights(a) || a.id - b.id);
  return new Map(sorted.map((s, i) => [s.id, (i + 1) * 10]));
}

/** Saisons dont la priorité enregistrée ne suit pas la règle. */
export function prioritiesToFix(seasons: readonly Season[]): { id: number; priority: number }[] {
  const want = wantedPriorities(seasons);
  return seasons.filter((s) => want.get(s.id) !== s.priority).map((s) => ({ id: s.id, priority: want.get(s.id)! }));
}

function overlap(a: Season, b: Season): boolean {
  return a.dateStart <= b.dateEnd && b.dateStart <= a.dateEnd;
}

function winner(a: Season, b: Season): Season {
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
  return a.id > b.id ? a : b;
}

/** Chevauchements où, aujourd'hui, la saison la plus longue l'emporte : ce
 *  que l'écran signale avant de proposer de ranger selon la règle. */
export function wrongOverlaps(seasons: readonly Season[]): { longer: Season; shorter: Season }[] {
  const out: { longer: Season; shorter: Season }[] = [];
  for (let i = 0; i < seasons.length; i++) {
    for (let j = i + 1; j < seasons.length; j++) {
      const a = seasons[i]!;
      const b = seasons[j]!;
      if (!overlap(a, b) || seasonNights(a) === seasonNights(b)) continue;
      const shorter = seasonNights(a) < seasonNights(b) ? a : b;
      const longer = shorter === a ? b : a;
      if (winner(a, b) === longer) out.push({ longer, shorter });
    }
  }
  return out;
}

/** Les saisons qui chevauchent celle-ci, pour l'écrire en clair. */
export function overlapsOf(s: Season, seasons: readonly Season[]): Season[] {
  return seasons.filter((o) => o.id !== s.id && overlap(o, s));
}

export interface OverrideRun {
  unitId: number;
  from: IsoDate;
  /** dernier jour inclus */
  to: IsoDate;
  priceCents: number | null;
  minNights: number | null;
  /** prix qui s'appliquerait sans la main (saison ou base) */
  fallbackCents: number | null;
}

/** Jours consécutifs portant le même prix ou minimum fixé à la main. */
export function overrideRuns(unitId: number, days: readonly DayRate[]): OverrideRun[] {
  const out: OverrideRun[] = [];
  let cur: OverrideRun | null = null;
  for (const d of days) {
    const has = d.overridePriceCents != null || d.overrideMinNights != null;
    if (!has) {
      cur = null;
      continue;
    }
    if (cur && addDays(cur.to, 1) === d.date && cur.priceCents === d.overridePriceCents && cur.minNights === d.overrideMinNights) {
      cur.to = d.date;
      continue;
    }
    cur = { unitId, from: d.date, to: d.date, priceCents: d.overridePriceCents, minNights: d.overrideMinNights, fallbackCents: d.fallbackPriceCents };
    out.push(cur);
  }
  return out;
}

/** Quatre niveaux de prix pour la vue de l'année, calés sur les prix
 *  distincts du bien (un « Domaine » à 520 € n'écrase pas l'échelle des
 *  maisons ; un tarif qui couvre l'année ne fabrique pas de paliers vides). */
export function priceLevels(prices: readonly (number | null)[]): { cuts: number[]; distinct: number[]; level: (c: number) => number } {
  const distinct = [...new Set(prices.filter((c): c is number => c != null))].sort((a, b) => a - b);
  const cuts = distinct.length > 4 ? [1, 2, 3].map((i) => distinct[Math.floor((distinct.length * i) / 4)]!) : [];
  const level = (c: number) => (cuts.length === 0 ? Math.max(0, distinct.indexOf(c)) : c < cuts[0]! ? 0 : c < cuts[1]! ? 1 : c < cuts[2]! ? 2 : 3);
  return { cuts, distinct, level };
}
