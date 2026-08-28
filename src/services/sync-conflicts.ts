// Tenue du registre des conflits de synchronisation (issue #72).
//
// Les services de synchro (ical.ts, beds24-sync.ts) appellent ces deux
// fonctions et rien d'autre. Elles sont DÉFENSIVES à dessein : le registre est
// une aide à l'exploitation, il ne doit jamais faire tomber un import. Un
// import qui échoue laisse des calendriers faux ; un registre qui échoue laisse
// seulement une liste incomplète, et l'incident part au journal.

import { audit, recordSyncConflict, resolveSeenSyncConflicts, resolveUnseenSyncConflicts } from "../db/repo";
import type { SyncConflictInput } from "../core/sync-conflicts";

/** Consigne une détection (création ou mise à jour de la dernière détection).
 *
 *  Renvoie `false` si l'écriture a échoué : l'appelant DOIT alors renoncer à
 *  refermer quoi que ce soit sur ce périmètre. Sans ce retour, une écriture
 *  perdue laissait une dernière détection périmée, et l'étape de fermeture
 *  concluait que le conflit avait disparu — il aurait été effacé de l'écran
 *  par la panne même qui l'empêchait d'être noté (contre-review 2026-08-28). */
export async function noteSyncConflict(
  db: D1Database,
  conflict: SyncConflictInput,
  seenAt: string,
): Promise<boolean> {
  try {
    await recordSyncConflict(db, conflict, seenAt);
    return true;
  } catch (e) {
    await safeAudit(db, "sync.conflict.record.error", conflict.scope, {
      error: e instanceof Error ? e.message : String(e),
      label: conflict.label,
    });
    return false;
  }
}

/** Referme les conflits que la source vient de reprendre SANS les reproduire.
 *  C'est la fermeture des passages partiels : elle ne conclut que sur les
 *  identifiants effectivement rapportés par la fenêtre. */
export async function closeSeenSyncConflicts(
  db: D1Database,
  scope: string,
  externalUids: readonly string[],
  seenAt: string,
): Promise<number> {
  try {
    const closed = await resolveSeenSyncConflicts(db, scope, externalUids, seenAt);
    if (closed > 0) await safeAudit(db, "sync.conflict.resolved", scope, { closed });
    return closed;
  } catch (e) {
    await safeAudit(db, "sync.conflict.resolve.error", scope, {
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

/** Referme TOUT ce qui ne se reproduit plus. À n'appeler que sur un passage qui
 *  a réellement balayé son périmètre entier — un flux iCal relu de bout en
 *  bout, un rapatriement complet — jamais sur une fenêtre incrémentale. */
export async function closeUnseenSyncConflicts(
  db: D1Database,
  scope: string,
  seenAt: string,
): Promise<number> {
  try {
    const closed = await resolveUnseenSyncConflicts(db, scope, seenAt);
    if (closed > 0) await safeAudit(db, "sync.conflict.resolved", scope, { closed });
    return closed;
  } catch (e) {
    await safeAudit(db, "sync.conflict.resolve.error", scope, {
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

/** Le journal lui-même peut être indisponible (base en lecture seule, table
 *  absente) : on ne transforme pas ça en panne de synchro. */
async function safeAudit(db: D1Database, action: string, entity: string, detail: unknown): Promise<void> {
  try {
    await audit(db, "cron", action, entity, detail);
  } catch {
    console.error(`${action} — ${entity}`, detail);
  }
}
