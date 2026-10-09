// Dates « très en avant » pour les tests qui veulent le tarif de base.
//
// Plusieurs tests partaient de `aujourd'hui + 300 jours` en supposant n'y trouver
// aucune saison du seed. C'était vrai le 30/08/2026 ; à partir du 04/09/2026,
// `+300` tombe dans « Haute — juillet-août 2027 » (migrations/0002), dont le tarif
// et les nuits minimales remplacent ceux de la règle de base : cinq tests
// tombaient sans qu'une ligne de code ait changé. Ce helper décale la date par
// semaines entières (le jour de la semaine, donc semaine/week-end, ne change
// pas) jusqu'après la dernière saison datée du seed.
import { addDays, todayInZone } from "../../src/core/dates";

/** Dernier jour couvert par une saison datée du seed (migrations/0002_seed_pre_more.sql). */
export const FIN_DES_SAISONS_DU_SEED = "2027-08-31";

/** `aujourd'hui + offsetJours`, repoussé par semaines entières après les saisons du seed. */
export function horsSaisonsDuSeed(offsetJours: number): string {
  let d = addDays(todayInZone(), offsetJours);
  while (d <= FIN_DES_SAISONS_DU_SEED) d = addDays(d, 7);
  return d;
}
