// Rapatriement COMPLET quotidien des sources externes (issue #19).
//
// Le pull Beds24 des 15 minutes est incrémental : il ne demande que ce qui a
// changé depuis le curseur `beds24_last_pull`. C'est ce qu'il faut pour tenir
// le rythme, mais un curseur a des angles morts structurels :
//   - une modification datée AVANT le curseur ne repasse jamais (horloges
//     décalées, curseur avancé trop loin, changement rétroactif côté canal) ;
//   - un lot refusé pour conflit laissait un écart définitif (corrigé par la
//     retenue de curseur, mais l'écart déjà installé, lui, reste) ;
//   - rien ne comparait JAMAIS l'état complet : une divergence pouvait vivre
//     indéfiniment sans que personne l'apprenne.
//
// Une fois par jour, on redemande donc l'état complet de la source sur un
// horizon large (400 jours d'arrivées) et on le confronte à notre base. Le
// rapprochement s'appuie sur les mêmes primitives que l'incrémental
// (applyChannelBookings : création, déplacement, changement de logement,
// annulation, RÉACTIVATION d'une résa rouverte — issue #18), auxquelles
// s'ajoute la seule chose qu'un pull incrémental ne peut pas voir : ce qui a
// DISPARU de la source.
//
// Trois garde-fous, dans cet ordre de priorité :
//   1. source vide → on ne touche à rien (même garde que l'import iCal, lot
//      A₀ : une URL expirée répond « 200 avec zéro réservation », et la boucle
//      de disparition remettrait en vente des séjours confirmés) ;
//   2. une réservation DIRECTE n'est JAMAIS annulée automatiquement — un
//      conflit avec le direct est un arbitrage humain, il part en alerte ;
//   3. source injoignable ou refusée (401/403 — le cas réel aujourd'hui, le
//      lien Beds24 ayant expiré) → dégradation silencieuse journalisée, pas
//      d'exception qui remonte, pas de nouvelle tentative avant le lendemain.
//
// Aucune migration : le marqueur de passage et les comptes-rendus vivent dans
// `app_settings`, une clé par canal.

import { addDays, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import {
  audit,
  blockingBookings,
  cancelBooking,
  getBookingByExternalUid,
  listBeds24Bookings,
  listProperties,
  listUnits,
} from "../db/repo";
import { Beds24Error, beds24Configured, beds24Fetch, resetBeds24TokenCache } from "./beds24";
import { applyChannelBookings, type Beds24Booking } from "./beds24-sync";
import { hourInBrussels } from "./digest";
import { getSetting, setSetting } from "./settings";

/** Date (Bruxelles) du dernier rapatriement complet — garde-fou anti-doublon,
 *  le cron passant 96 fois par jour. */
export const RECONCILE_LAST_RUN_KEY = "reconcile_last_run";

/** Heure locale (Bruxelles) à partir de laquelle le rapatriement complet peut
 *  partir : au premier tick du matin, avant que la journée d'exploitation
 *  commence, et bien avant le résumé quotidien de 7 h qui le relaiera. */
export const RECONCILE_HOUR = 5;

/** Horizon d'arrivées comparé — au-delà, les canaux n'ouvrent pas la vente. */
export const RECONCILE_HORIZON_DAYS = 400;

/** Compte-rendu par canal, en `app_settings` (lu par la carte « Santé »). */
export function reconcileReportKey(propertyId: number): string {
  return `reconcile_last_report:${propertyId}`;
}

export interface ReconcileReport {
  propertyId: number;
  /** Réservations comparées côté source, sur la fenêtre. */
  compared: number;
  imported: number;
  updated: number;
  relocated: number;
  cancelled: number;
  reactivated: number;
  /** Actives chez nous, absentes de la source → libérées (jamais du direct). */
  disappeared: number;
  /** Somme des écarts effectivement corrigés — le chiffre que le propriétaire
   *  regarde : 0 = les deux états coïncident. */
  divergences: number;
  /** Ce qui demande un arbitrage humain (conflit avec le direct, notamment). */
  alerts: string[];
  errors: string[];
  /** Garde de sanité déclenchée : source vide, rien n'a été annulé. */
  suspended: boolean;
  /** Source refusée (401/403) ou injoignable — message, sinon null. */
  unavailable: string | null;
}

function emptyReport(propertyId: number): ReconcileReport {
  return {
    propertyId, compared: 0, imported: 0, updated: 0, relocated: 0, cancelled: 0,
    reactivated: 0, disappeared: 0, divergences: 0, alerts: [], errors: [],
    suspended: false, unavailable: null,
  };
}

/** LE point d'entrée du cron — un appel, une fonction (le branchement dans
 *  `runScheduled` tient en trois lignes, à dessein). Ne fait rien hors du
 *  créneau du matin ou si la journée est déjà faite. */
export async function runDailyReconcile(env: Env, now: Date = new Date()): Promise<ReconcileReport[]> {
  const db = env.DB;
  const today = todayInZone(now);
  if (hourInBrussels(now) < RECONCILE_HOUR) return [];
  if ((await getSetting(db, RECONCILE_LAST_RUN_KEY)) === today) return [];
  if (!(await beds24Configured(env))) return [];

  // Marqueur posé AVANT le travail, volontairement : si un rapatriement complet
  // échoue à mi-course, il ne doit pas repartir au tick suivant et boucler
  // toutes les 15 minutes sur la même panne. L'incrémental continue, le
  // journal porte l'incident, et on retente demain.
  await setSetting(db, RECONCILE_LAST_RUN_KEY, today);

  const reports: ReconcileReport[] = [];
  for (const p of await listProperties(db)) {
    if (p.beds24PropertyId == null) continue;
    try {
      reports.push(await reconcileBeds24Property(db, env, p.id, p.beds24PropertyId, now));
    } catch (e) {
      // Filet de dernier recours : un domaine qui casse ne doit pas emporter
      // les autres, ni le reste du traitement planifié.
      const report = emptyReport(p.id);
      report.errors.push(e instanceof Error ? e.message : String(e));
      reports.push(report);
      await audit(db, "cron", "beds24.reconcile.error", `property:${p.id}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return reports;
}

/** Réconciliation complète d'un domaine face à Beds24. Exportée pour être
 *  rejouable à la demande (et testable sans le cadencement du cron). */
export async function reconcileBeds24Property(
  db: D1Database,
  env: Env,
  propertyId: number,
  beds24PropertyId: number,
  now: Date = new Date(),
): Promise<ReconcileReport> {
  const report = emptyReport(propertyId);
  const today = todayInZone(now);
  const horizon = addDays(today, RECONCILE_HORIZON_DAYS);
  const nowSql = sqlNow(now);

  // 1. État complet de la source, par dates d'arrivée (aucun `modifiedFrom` :
  //    c'est précisément le curseur qu'on cherche à contourner).
  let remote: Beds24Booking[];
  try {
    const res = await beds24Fetch<{ data?: Beds24Booking[] }>(env, "/bookings", {
      query: {
        propertyId: String(beds24PropertyId),
        includeGuests: "true",
        arrivalFrom: today,
        arrivalTo: horizon,
      },
    });
    remote = res.data ?? [];
  } catch (e) {
    const status = e instanceof Beds24Error ? e.status : undefined;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 401 || status === 403) {
      // Jeton expiré ou révoqué (le cas réel depuis que le lien Beds24 a été
      // coupé). Ce n'est pas une panne de la plateforme : le direct continue,
      // les calendriers restent tels quels. On vide le cache de jeton pour que
      // la tentative de demain reparte propre, et on s'arrête là — aucune
      // relance, le marqueur du jour est déjà posé.
      resetBeds24TokenCache();
      report.unavailable = message;
      report.alerts.push("La liaison avec le gestionnaire de canaux est refusée (identifiants expirés) — synchronisation externe suspendue, les réservations directes ne sont pas affectées.");
      await audit(db, "cron", "beds24.reconcile.unauthorized", `property:${propertyId}`, { status, error: message });
      await saveReport(db, report);
      return report;
    }
    report.unavailable = message;
    report.errors.push(message);
    await audit(db, "cron", "beds24.reconcile.error", `property:${propertyId}`, { status: status ?? null, error: message });
    await saveReport(db, report);
    return report;
  }

  const units = await listUnits(db, propertyId);
  const roomToUnit = new Map(units.filter((u) => u.beds24RoomId != null).map((u) => [u.beds24RoomId as number, u.id]));
  const unitIds = new Set(units.map((u) => u.id));
  report.compared = remote.length;

  // Réservations externes actives chez nous, sur ce domaine et dans la fenêtre
  // comparée : ce sont les seules que la source est censée confirmer.
  const localAll = await listBeds24Bookings(db);
  const localInWindow = localAll.filter(
    (b) => unitIds.has(b.unitId) && b.checkin >= today && b.checkin <= horizon,
  );

  // 2. GARDE DE SANITÉ (reprise du lot A₀ sur l'import iCal). Une source qui
  //    répond « aucune réservation » alors que des séjours actifs en dépendent
  //    est presque toujours une source cassée, pas un carnet vidé : l'étape de
  //    disparition ci-dessous annulerait en masse des séjours confirmés et
  //    remettrait les dates en vente. On ne touche à RIEN.
  if (remote.length === 0 && localInWindow.length > 0) {
    report.suspended = true;
    report.alerts.push(
      `Le gestionnaire de canaux n'annonce aucune réservation alors que ${localInWindow.length} séjour(s) en dépendent — aucune annulation appliquée, vérification manuelle requise.`,
    );
    await audit(db, "cron", "beds24.reconcile.suspicious", `property:${propertyId}`, {
      localActive: localInWindow.length, horizon,
    });
    await saveReport(db, report);
    return report;
  }

  // 3. Rapprochement : exactement les mêmes primitives que l'incrémental —
  //    création, changement de dates, changement de LOGEMENT, annulation,
  //    réactivation d'une résa rouverte (#18). Rien n'est dupliqué ici.
  const applied = await applyChannelBookings(db, remote, roomToUnit, now);
  report.imported = applied.imported;
  report.updated = applied.updated;
  report.relocated = applied.relocated;
  report.cancelled = applied.cancelled;
  report.reactivated = applied.reactivated;
  report.errors.push(...applied.errors);

  // 4. Ce qu'un pull incrémental ne peut pas voir : les résas ACTIVES chez nous
  //    que la source ne connaît plus. `listBeds24Bookings` ne renvoie que des
  //    résas d'origine externe (external_uid 'beds24:…') : une réservation
  //    directe ne peut pas, par construction, tomber dans cette boucle.
  const seen = new Set(remote.map((b) => `beds24:${b.id}`));
  for (const b of localInWindow) {
    if (seen.has(b.externalUid ?? "")) continue;
    if (await cancelBooking(db, b.id, "reconcile:absente_de_la_source", nowSql)) {
      report.disappeared += 1;
      await audit(db, "cron", "beds24.reconcile.disappeared", `booking:${b.id}`, {
        reference: b.reference, externalUid: b.externalUid, checkin: b.checkin, checkout: b.checkout,
      });
    }
  }

  // 5. Ce que la source affirme et que nous n'avons PAS pu refléter : on nomme
  //    l'occupant du créneau. S'il s'agit d'une réservation directe, c'est une
  //    double vente à arbitrer par un humain — on alerte, on n'annule rien.
  await raiseConflictAlerts(db, remote, roomToUnit, report, { today, nowSql, propertyId });

  report.divergences =
    report.imported + report.updated + report.relocated + report.cancelled +
    report.reactivated + report.disappeared;

  await saveReport(db, report);
  await audit(db, "cron", "beds24.reconcile", `property:${propertyId}`, report);
  return report;
}

/** Pour chaque résa que la source annonce active et que notre base ne reflète
 *  pas correctement, identifie ce qui occupe le créneau. */
async function raiseConflictAlerts(
  db: D1Database,
  remote: Beds24Booking[],
  roomToUnit: Map<number, number>,
  report: ReconcileReport,
  ctx: { today: IsoDate; nowSql: string; propertyId: number },
): Promise<void> {
  const ACTIVE = new Set(["new", "confirmed", "request"]);
  for (const b of remote) {
    if (!ACTIVE.has(b.status)) continue;
    const unitId = roomToUnit.get(b.roomId);
    if (!unitId || b.departure <= ctx.today || b.arrival >= b.departure) continue;

    const local = await getBookingByExternalUid(db, `beds24:${b.id}`);
    const reflected =
      local != null && local.status !== "cancelled" &&
      local.unitId === unitId && local.checkin === b.arrival && local.checkout === b.departure;
    if (reflected) continue;

    const blockers = await blockingBookings(db, unitId, b.arrival, b.departure, ctx.nowSql, local?.id);
    const direct = blockers.filter((x) => x.source === "direct" || x.source === "manual");
    if (direct.length > 0) {
      for (const d of direct) {
        report.alerts.push(
          `Double réservation à trancher : le séjour ${d.reference} (réservé en direct, du ${d.checkin} au ${d.checkout}) occupe les dates qu'un canal externe annonce vendues (${b.arrival} → ${b.departure}). Rien n'a été annulé.`,
        );
      }
      await audit(db, "cron", "beds24.reconcile.conflict_direct", `property:${ctx.propertyId}`, {
        externalUid: `beds24:${b.id}`, unitId, arrival: b.arrival, departure: b.departure,
        direct: direct.map((d) => ({ id: d.id, reference: d.reference, source: d.source })),
      });
    } else if (blockers.length > 0) {
      report.alerts.push(
        `Le canal externe annonce le séjour beds24:${b.id} (${b.arrival} → ${b.departure}) mais le créneau est déjà occupé par ${blockers.map((x) => x.reference).join(", ")}.`,
      );
    }
  }
}

async function saveReport(db: D1Database, report: ReconcileReport): Promise<void> {
  try {
    await setSetting(db, reconcileReportKey(report.propertyId), JSON.stringify(report));
  } catch {
    // Le compte-rendu est un confort d'affichage : son échec d'écriture ne doit
    // pas faire passer une réconciliation réussie pour un échec.
  }
}
