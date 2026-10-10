// Tâche planifiée complète : celle des services (src/services/cron.ts), puis
// celles du lot 2 du nouvel écran. Appelée par le Worker (handler scheduled)
// et par le serveur Node (/internal/cron) : une seule liste, deux entrées.
//
// Le lot 2 vit à part pour ne pas toucher au cron des services, entretenu en
// parallèle sur une autre branche.
import { todayInZone } from "../core/dates";
import { runScheduled } from "../services/cron";
import { audit } from "../db/repo";
import { syncAllCleaningTasks } from "../db/tasks";
import { pullChannelReviews } from "../services/beds24-reviews";

/** Ménages dérivés des départs, pour tous les domaines. Jamais d'exception :
 *  une panne se lit dans le journal, elle ne casse pas la tâche planifiée. */
export async function runLot2Scheduled(env: Env, now: Date = new Date()): Promise<void> {
  try {
    const r = await syncAllCleaningTasks(env.DB, todayInZone(now), now);
    if (r.created + r.updated + r.cancelled > 0) await audit(env.DB, "cron", "tasks.sync", null, r);
  } catch (e) {
    await audit(env.DB, "cron", "tasks.sync.error", null, { error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
  }
}

/** Lot 3 : avis Airbnb et Booking par Beds24, au plus toutes les 6 h. */
export async function runLot3Scheduled(env: Env, now: Date = new Date()): Promise<void> {
  try {
    await pullChannelReviews(env, now);
  } catch (e) {
    await audit(env.DB, "cron", "beds24.reviews.error", null, { error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
  }
}

export async function runAllScheduled(env: Env, now: Date = new Date(), fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await runScheduled(env, now, fetcher);
  } finally {
    await runLot2Scheduled(env, now);
    await runLot3Scheduled(env, now);
  }
}
