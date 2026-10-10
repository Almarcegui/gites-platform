import { i18n } from "@lingui/core";

/** 120500 → « 1 205 € » ; 20550 → « 205,50 € ». En néerlandais (Belgique) :
 *  « € 1.205 », « € 205,50 ». */
export function eur(cents: number): string {
  if (i18n.locale === "nl") {
    const neg = cents < 0;
    const abs = Math.abs(Math.round(cents));
    const unites = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const centimes = abs % 100;
    return `${neg ? "−" : ""}€ ${unites}${centimes ? "," + String(centimes).padStart(2, "0") : ""}`;
  }
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const unites = Math.floor(abs / 100);
  const centimes = abs % 100;
  const groupes = String(unites).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "−" : ""}${groupes}${centimes ? "," + String(centimes).padStart(2, "0") : ""} €`;
}

/** Arrondi aux 5 € (en centimes), pour les hausses ou baisses relatives. */
export function roundTo5(cents: number): number {
  return Math.round(cents / 500) * 500;
}
