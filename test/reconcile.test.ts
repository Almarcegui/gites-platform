// Rapatriement COMPLET quotidien (issue #19) — un cas de réconciliation par
// test. La réconciliation raisonne sur l'état ENTIER de la base : chaque test
// part donc d'une base neuve, sinon les résas d'un test voisin se retrouvent
// « absentes de la source » et faussent tout.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { addDays, todayInZone } from "../src/core/dates";
import { createBookingAtomic } from "../src/db/repo";
import { applyChannelBookings } from "../src/services/beds24-sync";
import { resetBeds24TokenCache } from "../src/services/beds24";
import {
  RECONCILE_LAST_RUN_KEY,
  reconcileBeds24Property,
  reconcileReportKey,
  runDailyReconcile,
} from "../src/services/reconcile";
import { getSetting, setSetting } from "../src/services/settings";

let t: TestDb;
beforeEach(async () => { t = await createTestDb(); resetBeds24TokenCache(); });
afterEach(async () => { await t.dispose(); });

const ROOM_TO_UNIT = new Map([[711713, 1], [711714, 2]]);
const BEDS24_PROPERTY = 344555;

/** 6 h UTC = 8 h à Bruxelles en été : dans le créneau du rapatriement. */
const morning = () => new Date(`${todayInZone()}T06:00:00Z`);

const resa = (over: Record<string, unknown> = {}) => ({
  id: 910001, roomId: 711713, status: "confirmed",
  arrival: addDays(todayInZone(), 100), departure: addDays(todayInZone(), 103),
  numAdult: 2, numChild: 0, lastName: "Externe", email: "externe@example.com",
  price: 400, channel: "airbnb",
  ...over,
});

const env = () => ({ DB: t.db, BEDS24_REFRESH_TOKEN: "refresh_test" }) as Env;

/** Stub réseau Beds24. `bookings` = l'état complet que la source annonce ;
 *  `status` permet de simuler un refus (401/403) sur /bookings. */
function stubBeds24(bookings: unknown[], opts: { bookingsStatus?: number; tokenStatus?: number } = {}): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.beds24.com")) {
      if (url.includes("/authentication/token")) {
        return opts.tokenStatus
          ? new Response(JSON.stringify({ error: "refresh token invalide" }), { status: opts.tokenStatus })
          : new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      return opts.bookingsStatus
        ? new Response(JSON.stringify({ error: "accès refusé" }), { status: opts.bookingsStatus })
        : new Response(JSON.stringify({ data: bookings }), { status: 200 });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function reconcile(bookings: unknown[], opts?: { bookingsStatus?: number; tokenStatus?: number }) {
  const restore = stubBeds24(bookings, opts);
  try {
    return await reconcileBeds24Property(t.db, env(), 1, BEDS24_PROPERTY, morning());
  } finally {
    restore();
  }
}

const statusOf = async (uid: string) =>
  (await t.db.prepare("SELECT status FROM bookings WHERE external_uid = ?1").bind(uid).first<{ status: string }>())?.status;

const auditCount = async (action: string) =>
  (await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1").bind(action).first<{ n: number }>())?.n ?? 0;

describe("réconciliation — modification antérieure au curseur", () => {
  it("le rapatriement complet rattrape des dates que l'incrémental n'a jamais vues", async () => {
    // état local : dates « anciennes » (le pull incrémental est passé à côté,
    // la modification étant datée avant son curseur)
    await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);
    expect(await statusOf("beds24:910001")).toBe("confirmed");

    // la source, elle, annonce d'autres dates
    const corrigee = resa({ arrival: addDays(todayInZone(), 101), departure: addDays(todayInZone(), 105) });
    const r = await reconcile([corrigee]);

    expect(r).toMatchObject({ compared: 1, updated: 1, imported: 0, disappeared: 0, alerts: [] });
    expect(r.divergences).toBe(1);
    const row = await t.db
      .prepare("SELECT checkin, checkout FROM bookings WHERE external_uid = 'beds24:910001'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ checkin: addDays(todayInZone(), 101), checkout: addDays(todayInZone(), 105) });
  });

  it("un changement de logement antérieur au curseur est rattrapé aussi", async () => {
    await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);
    const r = await reconcile([resa({ roomId: 711714 })]);
    expect(r).toMatchObject({ relocated: 1, alerts: [] });
    const row = await t.db
      .prepare("SELECT unit_id FROM bookings WHERE external_uid = 'beds24:910001'")
      .first<{ unit_id: number }>();
    expect(row?.unit_id).toBe(2);
  });
});

describe("réconciliation — réservation disparue de la source", () => {
  it("une résa externe active que la source ne connaît plus est libérée", async () => {
    await applyChannelBookings(t.db, [resa(), resa({ id: 910002, roomId: 711714 })], ROOM_TO_UNIT);

    // la source n'annonce plus que la seconde
    const r = await reconcile([resa({ id: 910002, roomId: 711714 })]);
    expect(r).toMatchObject({ disappeared: 1, compared: 1 });
    expect(await statusOf("beds24:910001")).toBe("cancelled");
    expect(await statusOf("beds24:910002")).toBe("confirmed");

    const row = await t.db
      .prepare("SELECT cancel_reason FROM bookings WHERE external_uid = 'beds24:910001'")
      .first<{ cancel_reason: string }>();
    expect(row?.cancel_reason).toBe("reconcile:absente_de_la_source");
    expect(await auditCount("beds24.reconcile.disappeared")).toBe(1);
  });

  it("une résa DIRECTE n'entre jamais dans la boucle de disparition", async () => {
    const direct = await createBookingAtomic(t.db, {
      unitId: 2, checkin: addDays(todayInZone(), 120), checkout: addDays(todayInZone(), 123),
      adults: 2, children: 0, status: "confirmed", source: "direct",
      totalCents: 50000, depositCents: 0, balanceDueDate: null,
    });
    expect(direct.ok).toBe(true);

    const r = await reconcile([resa()]); // la source ignore tout du direct
    expect(r.disappeared).toBe(0);
    const row = await t.db
      .prepare("SELECT status FROM bookings WHERE id = ?1")
      .bind(direct.ok ? direct.id : 0)
      .first<{ status: string }>();
    expect(row?.status).toBe("confirmed");
  });
});

describe("réconciliation — conflit avec une réservation directe", () => {
  it("alerte d'arbitrage, et AUCUNE annulation automatique du direct", async () => {
    const from = addDays(todayInZone(), 140);
    const direct = await createBookingAtomic(t.db, {
      unitId: 2, checkin: from, checkout: addDays(from, 4), adults: 4, children: 0,
      status: "confirmed", source: "direct", totalCents: 80000, depositCents: 0, balanceDueDate: null,
    });
    expect(direct.ok).toBe(true);
    const reference = direct.ok ? direct.reference : "";

    // la source annonce le même créneau vendu sur La Scierie
    const r = await reconcile([resa({ id: 910010, roomId: 711714, arrival: from, departure: addDays(from, 2) })]);

    expect(r.imported).toBe(0);
    expect(r.alerts.length).toBe(1);
    expect(r.alerts[0]).toContain(reference);
    expect(r.alerts[0]).toContain("Rien n'a été annulé");
    expect(await auditCount("beds24.reconcile.conflict_direct")).toBe(1);

    // le direct est intact — c'est la règle absolue de cette réconciliation
    const row = await t.db
      .prepare("SELECT status, cancelled_at FROM bookings WHERE reference = ?1")
      .bind(reference)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "confirmed", cancelled_at: null });
  });
});

describe("réconciliation — garde de sanité et sources injoignables", () => {
  it("source vide alors que des séjours actifs en dépendent → RIEN n'est annulé", async () => {
    await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);

    const r = await reconcile([]);
    expect(r.suspended).toBe(true);
    expect(r.disappeared).toBe(0);
    expect(r.alerts[0]).toContain("aucune annulation appliquée");
    expect(await statusOf("beds24:910001")).toBe("confirmed");
    expect(await auditCount("beds24.reconcile.suspicious")).toBe(1);
  });

  it("Beds24 répond 401 sur les réservations → dégradation journalisée, rien ne casse", async () => {
    await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);

    const r = await reconcile([], { bookingsStatus: 401 });
    expect(r.unavailable).toContain("401");
    expect(r.errors).toEqual([]);          // ce n'est pas une panne de la plateforme
    expect(r.suspended).toBe(false);
    expect(r.disappeared).toBe(0);
    expect(r.alerts[0]).toContain("identifiants expirés");
    expect(await statusOf("beds24:910001")).toBe("confirmed"); // état local intact
    expect(await auditCount("beds24.reconcile.unauthorized")).toBe(1);
    // le compte-rendu est tout de même déposé : la carte « Santé » doit le voir
    expect(await getSetting(t.db, reconcileReportKey(1))).toContain("unavailable");
  });

  it("jeton de rafraîchissement expiré (401 sur /authentication/token) → même traitement", async () => {
    const r = await reconcile([], { tokenStatus: 401 });
    expect(r.unavailable).toBeTruthy();
    expect(await auditCount("beds24.reconcile.unauthorized")).toBe(1);
    expect(await auditCount("beds24.reconcile.error")).toBe(0);
  });

  it("panne serveur (500) → erreur journalisée, aucune annulation en masse", async () => {
    await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);
    const r = await reconcile([], { bookingsStatus: 500 });
    expect(r.errors.length).toBe(1);
    expect(r.disappeared).toBe(0);
    expect(await statusOf("beds24:910001")).toBe("confirmed");
    expect(await auditCount("beds24.reconcile.error")).toBe(1);
  });
});

describe("réconciliation — idempotence et compte-rendu", () => {
  it("rejouée deux fois de suite, la seconde passe ne change plus rien", async () => {
    const source = [resa(), resa({ id: 910002, roomId: 711714, arrival: addDays(todayInZone(), 160), departure: addDays(todayInZone(), 164) })];

    const first = await reconcile(source);
    expect(first).toMatchObject({ compared: 2, imported: 2 });
    expect(first.divergences).toBe(2);

    const second = await reconcile(source);
    expect(second).toMatchObject({
      compared: 2, imported: 0, updated: 0, relocated: 0, cancelled: 0,
      reactivated: 0, disappeared: 0, divergences: 0, alerts: [], errors: [], suspended: false,
    });

    // et la base n'a pas doublé les lignes au passage
    const n = await t.db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE external_uid LIKE 'beds24:%'")
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("le compte-rendu part dans le journal d'audit ET dans app_settings", async () => {
    await reconcile([resa()]);

    const row = await t.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'beds24.reconcile' ORDER BY id DESC LIMIT 1")
      .first<{ detail: string }>();
    expect(row?.detail).toBeTruthy();
    const detail = JSON.parse(row!.detail) as Record<string, unknown>;
    expect(detail).toMatchObject({ propertyId: 1, compared: 1, imported: 1, divergences: 1 });

    const stored = await getSetting(t.db, reconcileReportKey(1));
    expect(JSON.parse(stored!)).toMatchObject({ compared: 1, divergences: 1 });
  });

  it("les écarts non résolus remontent dans la carte « Santé du système »", async () => {
    const from = addDays(todayInZone(), 180);
    await createBookingAtomic(t.db, {
      unitId: 1, checkin: from, checkout: addDays(from, 3), adults: 2, children: 0,
      status: "confirmed", source: "direct", totalCents: 30000, depositCents: 0, balanceDueDate: null,
    });
    await reconcile([resa({ id: 910020, arrival: from, departure: addDays(from, 2) })]);
    await setSetting(t.db, RECONCILE_LAST_RUN_KEY, todayInZone());

    const { healthSignals } = await import("../src/db/repo");
    const health = await healthSignals(t.db, 1);
    expect(health.reconcileLastRun).toBe(todayInZone());
    expect(health.reconcileAlerts?.length).toBe(1);
    expect(health.reconcileAlerts?.[0]).toContain("Double réservation à trancher");
  });
});

describe("cadencement quotidien", () => {
  it("hors créneau du matin : aucun rapatriement complet", async () => {
    const restore = stubBeds24([resa()]);
    try {
      const night = new Date(`${todayInZone()}T01:00:00Z`); // 3 h à Bruxelles
      expect(await runDailyReconcile(env(), night)).toEqual([]);
      expect(await getSetting(t.db, RECONCILE_LAST_RUN_KEY)).toBeNull();
    } finally {
      restore();
    }
  });

  it("une seule fois par jour, même si le cron repasse toutes les 15 minutes", async () => {
    const restore = stubBeds24([resa()]);
    try {
      const first = await runDailyReconcile(env(), morning());
      expect(first.length).toBe(1);
      expect(first[0]).toMatchObject({ propertyId: 1, imported: 1 });
      expect(await getSetting(t.db, RECONCILE_LAST_RUN_KEY)).toBe(todayInZone());

      // les 95 passages suivants de la journée ne font rien
      expect(await runDailyReconcile(env(), new Date(`${todayInZone()}T06:15:00Z`))).toEqual([]);
      expect(await runDailyReconcile(env(), new Date(`${todayInZone()}T14:00:00Z`))).toEqual([]);
      expect(await auditCount("beds24.reconcile")).toBe(1);
    } finally {
      restore();
    }
  });

  it("sans jeton Beds24 : le rapatriement complet ne tente rien", async () => {
    const noToken = { DB: t.db } as Env;
    expect(await runDailyReconcile(noToken, morning())).toEqual([]);
    expect(await getSetting(t.db, RECONCILE_LAST_RUN_KEY)).toBeNull();
  });
});
