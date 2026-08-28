// Tenue du registre des conflits de synchronisation (issue #72).
//
// Les services de synchro (ical.ts, beds24-sync.ts) appellent ces deux
// fonctions et rien d'autre. Elles sont DÉFENSIVES à dessein : le registre est
// une aide à l'exploitation, il ne doit jamais faire tomber un import. Un
// import qui échoue laisse des calendriers faux ; un registre qui échoue laisse
// seulement une liste incomplète, et l'incident part au journal.

import { audit, recordSyncConflict, resolveUnseenSyncConflicts } from "../db/repo";
import type { SyncConflictInput } from "../core/sync-conflicts";

/** Consigne une détection (création ou mise à jour de la dernière détection). */
export async function noteSyncConflict(
  db: D1Database,
  conflict: SyncConflictInput,
  seenAt: string,
): Promise<void> {
  try {
    await recordSyncConflict(db, conflict, seenAt);
  } catch (e) {
    await safeAudit(db, "sync.conflict.record.error", conflict.scope, {
      error: e instanceof Error ? e.message : String(e),
      label: conflict.label,
    });
  }
}

/** Referme ce qui ne se reproduit plus. À n'appeler que sur un passage qui a
 *  vraiment balayé son périmètre (cf. `resolveUnseenSyncConflicts`). */
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
