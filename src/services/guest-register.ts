// Purge de conservation du registre des personnes hébergées (issue #84).
//
// Le registre se conserve 7 ans, puis les lignes s'effacent. La purge est
// portée par le traitement planifié (*/15) mais ne s'exécute qu'UNE FOIS PAR
// JOUR : le cron passe 96 fois, et un DELETE quotidien suffit à tenir le
// délai à la journée près. Le marqueur de passage vit dans `app_settings`,
// comme ceux du rapatriement complet et du résumé quotidien — pas de
// migration pour un compteur.

import { todayInZone, type IsoDate } from "../core/dates";
import { retentionCutoff } from "../core/guest-register";
import { purgeGuestRegisterBefore } from "../db/repo";
import { getSetting, setSetting } from "./settings";

/** Date (Bruxelles) de la dernière purge — garde-fou anti-rejeu. */
export const GUEST_REGISTER_PURGE_KEY = "guest_register_last_purge";

export interface GuestRegisterPurgeResult {
  /** Faux si la purge du jour a déjà eu lieu. */
  ran: boolean;
  deleted: number;
  cutoff: IsoDate | null;
}

/** Efface les séjours dont le départ le plus récent précède la butoir de
 *  conservation. Le marqueur du jour est posé APRÈS le DELETE : si la purge
 *  échoue, le tick suivant réessaie au lieu de sauter la journée. */
export async function runGuestRegisterPurge(
  db: D1Database,
  now: Date = new Date(),
): Promise<GuestRegisterPurgeResult> {
  const today = todayInZone(now);
  if ((await getSetting(db, GUEST_REGISTER_PURGE_KEY)) === today) {
    return { ran: false, deleted: 0, cutoff: null };
  }
  const cutoff = retentionCutoff(today);
  const deleted = await purgeGuestRegisterBefore(db, cutoff);
  await setSetting(db, GUEST_REGISTER_PURGE_KEY, today);
  return { ran: true, deleted, cutoff };
}
