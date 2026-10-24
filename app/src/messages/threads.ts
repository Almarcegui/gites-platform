// Fils de l'écran Messages : la liste groupe les messages reçus par conversation
// (réservation, sinon client, sinon adresse) et ne montre qu'une ligne par fil.
// Un fil rattaché à une réservation est dans « Réservations », les autres dans « Autres »
// (Google, Drive, divers).
import type { Message } from "../api/types";

export interface ThreadRow {
  key: string;
  /** Le message le plus récent du fil : c'est lui qui ouvre le fil. */
  last: Message;
  ids: number[];
  /** Messages encore à répondre dans ce fil. */
  pending: number;
  /** Rattaché à une réservation (onglet « Réservations »). */
  booked: boolean;
}

/** Clé d'une conversation, la même logique que le fil du serveur (getThread). */
export function threadKey(m: Pick<Message, "bookingId" | "guestId" | "fromEmail" | "toEmail" | "direction">): string {
  if (m.bookingId != null) return `b:${m.bookingId}`;
  if (m.guestId != null) return `g:${m.guestId}`;
  return `e:${(m.direction === "in" ? m.fromEmail : (m.toEmail ?? m.fromEmail)).toLowerCase()}`;
}

/** Un fil par conversation, du plus récent au plus ancien (id décroissant). */
export function groupThreads(list: Message[]): ThreadRow[] {
  const by = new Map<string, ThreadRow>();
  for (const m of [...list].sort((a, b) => b.id - a.id)) {
    const key = threadKey(m);
    const cur = by.get(key);
    if (cur) {
      cur.ids.push(m.id);
      if (m.status === "nouveau") cur.pending += 1;
    } else {
      by.set(key, { key, last: m, ids: [m.id], pending: m.status === "nouveau" ? 1 : 0, booked: m.bookingId != null });
    }
  }
  return [...by.values()];
}
