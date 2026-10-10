/** 120500 → « 1 205 € » ; 20550 → « 205,50 € ». Espaces fines insécables. */
export function eur(cents: number): string {
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
