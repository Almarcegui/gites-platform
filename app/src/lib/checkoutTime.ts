// Heure de départ selon le jour : copie de src/core/checkout-time.ts (à garder
// identique). Dimanche + réglage renseigné = heure du dimanche, sinon l'heure
// commune.

export function checkoutTimeFor(s: { checkoutTime: string; checkoutTimeSunday?: string }, date: string | null | undefined): string {
  const sunday = (s.checkoutTimeSunday ?? "").trim();
  if (sunday && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0) return sunday;
  }
  return s.checkoutTime;
}
