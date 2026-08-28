// Identité d'un conflit de synchronisation (issue #72) — pur, sans I/O.
//
// Un conflit se répète : le cron passe toutes les 15 minutes et redétecte le
// même écart tant qu'il n'est pas tranché. Ce module dit ce qu'est « le même
// conflit », pour qu'il reste UNE ligne au lieu de 96 par jour.
//
// L'écriture en base vit dans src/db/repo.ts, le repérage dans les services de
// synchro (ical.ts, beds24-sync.ts) — ici, uniquement l'identité et le libellé.

import type { IsoDate } from "./dates";

export type SyncConflictSource = "ical" | "beds24";

/** Nature de l'écart. Le mot dit ce que la source demandait et que nous
 *  n'avons pas pu refléter :
 *   import      un séjour annoncé par la source, créneau déjà occupé chez nous ;
 *   move        un séjour connu, déplacé vers des dates déjà occupées ;
 *   relocate    un séjour connu, basculé vers un AUTRE hébergement déjà occupé ;
 *   reactivate  un séjour annulé puis rouvert par la source, créneau revendu. */
export type SyncConflictKind = "import" | "move" | "relocate" | "reactivate";

export type SyncConflictStatus = "open" | "resolved" | "ignored";

/** Ce qu'un service de synchro sait d'un conflit au moment où il le détecte. */
export interface SyncConflictInput {
  source: SyncConflictSource;
  /** Ensemble balayé par le passage de synchro (cf. `icalScope` / `beds24Scope`). */
  scope: string;
  kind: SyncConflictKind;
  /** Hébergement concerné — celui de DESTINATION pour un relogement. */
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  /** Identifiant de l'événement côté source (`feed3:uid`, `beds24:12345`). */
  externalUid?: string | null;
  /** Notre référence de séjour, quand le conflit porte sur une résa connue. */
  bookingReference?: string | null;
  channelLabel?: string | null;
  /** Phrase française déjà affichable — celle du journal de synchro. */
  label: string;
}

/** Un passage d'import iCal balaie UN flux : lui seul peut refermer ses propres
 *  conflits. */
export function icalScope(feedId: number): string {
  return `ical:feed:${feedId}`;
}

/** Un passage canaux balaie tous les hébergements MAPPÉS du domaine — pull
 *  incrémental comme rapatriement complet quotidien. On scope à
 *  l'hébergement : c'est le plus petit ensemble dont un passage garantit la
 *  couverture complète, et l'appelant l'a déjà sous la main (la table de
 *  correspondance room → unité), sans avoir à porter l'id du domaine. */
export function beds24UnitScope(unitId: number): string {
  return `beds24:unit:${unitId}`;
}

/** Identité d'un conflit. Deux détections de la MÊME anomalie donnent la même
 *  empreinte ; changer une date ou d'hébergement de destination en fait un
 *  autre conflit (l'ancien se referme tout seul au passage suivant, puisqu'il
 *  n'est plus reproduit).
 *
 *  Le libellé n'entre PAS dans l'empreinte : reformuler une phrase ne doit pas
 *  ressusciter un conflit déjà connu. */
export function conflictFingerprint(c: SyncConflictInput): string {
  return [c.source, c.kind, c.unitId, c.checkin, c.checkout, c.externalUid ?? ""].join("|");
}
