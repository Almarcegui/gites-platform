// Contrôle de santé public et léger (issue #21).
//
// Le back-office a déjà sa carte « Santé du système », mais elle suppose que
// quelqu'un l'ouvre — et elle ne dit rien si l'application entière est tombée.
// Cet endpoint existe pour être interrogé de l'EXTÉRIEUR, par une sonde qui ne
// partage rien avec l'infrastructure surveillée.
//
// Deux exigences contradictoires à tenir :
//  - il est public : aucune donnée client, aucun détail d'infrastructure, rien
//    qui aide un attaquant. Deux champs, pas un de plus que nécessaire.
//  - il doit coûter presque rien : une seule lecture de `app_settings`, sinon
//    la sonde qui surveille devient elle-même une charge.

import { getSetting } from "./settings";

/** Clé de battement de cœur écrite par le traitement planifié à chaque tick. */
export const CRON_HEARTBEAT_KEY = "cron_last_run";

export interface PublicHealth {
  /** L'application répond ET sa base est lisible. La fraîcheur du traitement
   *  planifié n'entre PAS dans ce booléen : c'est à la sonde d'appliquer son
   *  seuil, sinon un déploiement tout frais (cron pas encore passé) se
   *  signalerait comme une panne. */
  ok: boolean;
  /** Dernier passage du traitement planifié, format SQL UTC, ou null s'il n'a
   *  jamais tourné depuis la mise en service. */
  lastCronAt: string | null;
  /** Âge de ce passage en minutes — évite à la sonde de parser des dates. */
  cronAgeMinutes: number | null;
}

export async function publicHealth(db: D1Database, now: Date = new Date()): Promise<PublicHealth> {
  let lastCronAt: string | null = null;
  try {
    lastCronAt = await getSetting(db, CRON_HEARTBEAT_KEY);
  } catch {
    // Base injoignable : c'est exactement le cas que la sonde doit voir.
    return { ok: false, lastCronAt: null, cronAgeMinutes: null };
  }

  let cronAgeMinutes: number | null = null;
  if (lastCronAt) {
    // Les horodatages du projet sont en UTC au format SQLite : on le remet en
    // ISO pour Date.parse, faute de quoi le fuseau local du runtime s'invite.
    const parsed = Date.parse(lastCronAt.replace(" ", "T") + "Z");
    if (!Number.isNaN(parsed)) {
      cronAgeMinutes = Math.round(((now.getTime() - parsed) / 60_000) * 10) / 10;
    }
  }

  return { ok: true, lastCronAt, cronAgeMinutes };
}
