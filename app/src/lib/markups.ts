// Pourcentages des prix par plateforme (issue #97) : lecture d'une saisie
// (« 17,5 », « 18 ») et affichage à la française. Repris de l'ancien écran
// (public/admin/markups.js) quand il a été retiré, le 10/10/2026.

/** Lit un pourcentage saisi : virgule décimale acceptée, deux décimales au
 *  plus. `null` si la saisie n'est pas un nombre positif. */
export function parsePct(raw: unknown): number | null {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const pct = Number(text);
  return Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null;
}

/** « 17,5 », « 18 ». */
export function pctFr(pct: number): string {
  return String(pct).replace(".", ",");
}
