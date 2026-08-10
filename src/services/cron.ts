// Tâches planifiées (cron */15 min) :
//  1. expiration des holds périmés (filet de sécurité — la dispo n'en dépend pas)
//  2. import des flux iCal actifs
//  3. rappels de solde à l'échéance (une seule fois par résa, mode stub par défaut)
//  4. push Beds24 des calendriers mappés (dispo + prix — inactif sans token)

import { sqlNow, todayInZone } from "../core/dates";
import {
  audit,
  expireStaleHolds,
  getProperty,
  hasEmailOfKind,
  listBookings,
  listFeeds,
  listProperties,
} from "../db/repo";
import { beds24Configured } from "./beds24";
import { purgeExpiredSessions } from "./admin-auth";
import { pullBeds24Bookings, pushCalendars } from "./beds24-sync";
import { runDailyDigest } from "./digest";
import { buildBalanceReminderEmail, queueEmail } from "./email";
import { CRON_HEARTBEAT_KEY } from "./health";
import { syncFeed } from "./ical";
import { runDailyReconcile } from "./reconcile";
import { setSetting } from "./settings";

export async function runScheduled(env: Env, now: Date = new Date(), fetcher: typeof fetch = fetch): Promise<void> {
  const db = env.DB;
  const nowSql = sqlNow(now);

  // 0. Battement de cœur, EN TÊTE et pas en fin de traitement : il atteste que
  //    le cron s'est déclenché, pas qu'il est allé au bout. Un import iCal qui
  //    échoue doit rester un incident visible dans le journal, pas se déguiser
  //    en « le traitement planifié ne tourne plus » (issue #21).
  //    Écrit dans app_settings et NON dans audit_log : le cron y verse déjà
  //    ~96 lignes par jour, ce qui noie les vraies anomalies.
  try {
    await setSetting(db, CRON_HEARTBEAT_KEY, nowSql);
  } catch (e) {
    await audit(db, "cron", "heartbeat.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 1. Holds périmés — enveloppé comme les autres étapes : une panne ici
  //    (verrou D1, erreur SQL) interrompait tout le cron, donc les flux iCal,
  //    les rappels de solde et le push Beds24, sans la moindre trace.
  try {
    const expired = await expireStaleHolds(db, nowSql);
    if (expired > 0) {
      await audit(db, "cron", "holds.expired", undefined, { count: expired });
    }
  } catch (e) {
    await audit(db, "cron", "holds.expire.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 1 bis. Sessions du back-office expirées — simple ménage.
  try {
    await purgeExpiredSessions(db);
  } catch (e) {
    await audit(db, "cron", "sessions.purge.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 2. Flux iCal
  const feeds = await listFeeds(db, true);
  for (const feed of feeds) {
    try {
      await syncFeed(db, feed, fetcher, now);
    } catch (e) {
      await audit(db, "cron", "ical.sync.error", `feed:${feed.id}`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3. Rappels de solde : résas confirmées, solde impayé, échéance atteinte,
  //    arrivée pas encore passée — un seul rappel par réservation.
  const today = todayInZone(now);
  const confirmed = await listBookings(db, { status: "confirmed", from: today, limit: 500 });
  for (const b of confirmed) {
    const balance = b.totalCents - b.paidCents;
    if (balance <= 0 || !b.balanceDueDate || b.balanceDueDate > today) continue;
    if (!b.guestEmail) continue;
    if (await hasEmailOfKind(db, b.id, "balance_reminder")) continue;
    const property = await getProperty(db, b.propertyId ?? -1);
    if (!property) continue;
    const email = buildBalanceReminderEmail(b, property);
    await queueEmail(db, env, {
      bookingId: b.id,
      to: b.guestEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      kind: "balance_reminder",
    });
    await audit(db, "cron", "email.balance_reminder", `booking:${b.id}`);
  }

  // 4. Beds24 (inactif sans BEDS24_REFRESH_TOKEN) : d'abord rapatrier les résas
  //    des canaux (pull), PUIS pousser les calendriers à jour (push) — l'état
  //    poussé intègre ainsi les résas qui viennent d'arriver.
  if (await beds24Configured(env)) {
    const properties = await listProperties(db);
    for (const p of properties) {
      if (p.beds24PropertyId == null) continue;
      try {
        await pullBeds24Bookings(db, env, p.id, p.beds24PropertyId, now);
      } catch (e) {
        await audit(db, "cron", "beds24.pull.error", `property:${p.id}`, { error: e instanceof Error ? e.message : String(e) });
      }
      try {
        const { pushed } = await pushCalendars(db, env, p.id);
        await audit(db, "cron", "beds24.push", `property:${p.id}`, { rooms: pushed.length });
      } catch (e) {
        await audit(db, "cron", "beds24.push.error", `property:${p.id}`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // 4 bis. Rapatriement COMPLET des canaux externes, une fois par jour au tick
  //    du matin (issue #19) : le pull incrémental ci-dessus ne voit ni les
  //    modifications antérieures à son curseur, ni ce qui a disparu de la
  //    source. La fonction se saute toute seule hors créneau et hors jour.
  try {
    await runDailyReconcile(env, now);
  } catch (e) {
    await audit(db, "cron", "beds24.reconcile.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }

  // 5. Résumé quotidien au propriétaire (7 h, fuseau de Bruxelles). En DERNIER
  //    et sous try/catch : le résumé décrit l'état du système, il ne doit pas
  //    pouvoir empêcher le système de fonctionner. Il se saute tout seul hors
  //    du créneau et ne part qu'une fois par jour.
  try {
    await runDailyDigest(env, now);
  } catch (e) {
    await audit(db, "cron", "digest.error", undefined, { error: e instanceof Error ? e.message : String(e) });
  }
}
