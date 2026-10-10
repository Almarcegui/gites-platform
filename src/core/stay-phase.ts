// Où en est le séjour (issue #53) : « arrive aujourd'hui », « arrive demain »,
// « part aujourd'hui ». Logique pure, sans DOM ni import, partagée par le
// serveur et l'écran d'administration (app/, liste des réservations). Reprise
// de public/admin/badges.js quand l'ancien écran a été retiré (10/10/2026).

export type StayPhase = "arrive-today" | "arrive-tomorrow" | "leaves-today";

/** Lendemain d'une date ISO, sans dépendre du fuseau local. */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Où en est le séjour par rapport à `today` ? `movement` restreint la lecture
 * à une ligne d'arrivée ou de départ (un tableau qui liste une ligne par
 * mouvement ne doit pas dire « arrive aujourd'hui » en face d'un départ).
 * Une réservation annulée n'a plus de séjour : aucun badge. Une option non
 * payée en garde un : une arrivée demain encore en attente est ce qu'il faut voir.
 * Un jour de référence absent ou aberrant rend « rien à signaler », jamais une exception.
 */
export function stayPhase(
  booking: { status?: unknown; checkin?: unknown; checkout?: unknown } | null | undefined,
  today?: unknown,
  movement: "arrival" | "departure" | null = null,
): StayPhase | null {
  if (!booking || booking.status === "cancelled") return null;
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const { checkin, checkout } = booking;
  if (movement !== "departure" && checkin) {
    if (checkin === today) return "arrive-today";
    if (checkin === nextDay(today)) return "arrive-tomorrow";
  }
  if (movement !== "arrival" && checkout === today) return "leaves-today";
  return null;
}

/** Libellé français d'une phase (l'écran passe par ses propres traductions). */
export const STAY_LABELS: Record<StayPhase, string> = {
  "arrive-today": "Arrive aujourd’hui",
  "arrive-tomorrow": "Arrive demain",
  "leaves-today": "Part aujourd’hui",
};
