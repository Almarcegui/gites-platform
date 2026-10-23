// Heure de départ selon le jour : copie de src/core/checkout-time.ts (à garder
// identique). Dimanche + réglage renseigné = heure du dimanche, sinon l'heure
// commune.
export function checkoutTimeFor(settings, date) {
  const sunday = String(settings?.checkoutTimeSunday ?? "").trim();
  if (sunday && /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) {
    const [y, m, d] = String(date).split("-").map(Number);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0) return sunday;
  }
  return settings?.checkoutTime;
}
