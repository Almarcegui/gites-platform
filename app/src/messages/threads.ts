// Fils de l'écran Messages. La liste vient du serveur, un fil par ligne (le dernier message reçu),
// paginée : le groupement (réservation, sinon client, sinon adresse) se fait en base.
// Un fil rattaché à une réservation est dans « Réservations », les autres dans « Autres »
// (Google, Drive, divers).
import type { Message } from "../api/types";

export interface ThreadRow {
  key: string;
  /** Le message reçu le plus récent du fil : c'est lui qui ouvre le fil. */
  last: Message;
  /** Messages encore à répondre dans ce fil. */
  pending: number;
  count: number;
  booked: boolean;
}

export interface ThreadPage {
  threads: ThreadRow[];
  more: boolean;
  counts: { resa: number; autres: number };
  origins: { channel: string; canal: string | null; n: number; pending: number }[];
}

/** Clé de la conversation d'un message, la même règle que le serveur (réservation, client, adresse). */
export function threadKey(m: Pick<Message, "bookingId" | "guestId" | "fromEmail" | "toEmail" | "direction">): string {
  if (m.bookingId != null) return `b:${m.bookingId}`;
  if (m.guestId != null) return `g:${m.guestId}`;
  return `e:${(m.direction === "in" ? m.fromEmail : (m.toEmail ?? m.fromEmail)).toLowerCase()}`;
}
