// Synchro Beds24 : le regroupement de jours en plages compactes et la
// construction du push (mapping D1 réel + liaison reflétée dans numAvail).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { applyChannelBookings, buildCalendarPush, compactSpans } from "../src/services/beds24-sync";
import { createBookingAtomic } from "../src/db/repo";
import { addDays, todayInZone } from "../src/core/dates";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.dispose(); });

describe("compactSpans", () => {
  it("regroupe les jours consécutifs identiques, coupe au changement", () => {
    const spans = compactSpans([
      { date: "2026-08-01", numAvail: 1, price1: 240, minStay: 2 },
      { date: "2026-08-02", numAvail: 1, price1: 240, minStay: 2 },
      { date: "2026-08-03", numAvail: 1, price1: 260, minStay: 2 },
      { date: "2026-08-04", numAvail: 0, price1: 260, minStay: 2 },
      { date: "2026-08-06", numAvail: 0, price1: 260, minStay: 2 }, // trou → nouvelle plage
    ]);
    expect(spans).toEqual([
      { from: "2026-08-01", to: "2026-08-02", numAvail: 1, price1: 240, minStay: 2 },
      { from: "2026-08-03", to: "2026-08-03", numAvail: 1, price1: 260, minStay: 2 },
      { from: "2026-08-04", to: "2026-08-04", numAvail: 0, price1: 260, minStay: 2 },
      { from: "2026-08-06", to: "2026-08-06", numAvail: 0, price1: 260, minStay: 2 },
    ]);
  });
});

describe("buildCalendarPush", () => {
  it("mappe Scieur+Scierie (pas le Domaine), prix en euros, liaison Domaine → rooms fermées", async () => {
    const from = addDays(todayInZone(), 200);
    // résa du Domaine entier → les DEUX rooms Beds24 doivent passer numAvail 0
    const created = await createBookingAtomic(t.db, {
      unitId: 3, checkin: addDays(from, 2), checkout: addDays(from, 4),
      adults: 12, children: 0, status: "confirmed", source: "manual",
      totalCents: 100000, depositCents: 0, balanceDueDate: null,
    });
    expect(created.ok).toBe(true);

    const rooms = await buildCalendarPush(t.db, 1, from, 7);
    expect(rooms.map((r) => r.roomId).sort()).toEqual([711713, 711714]);
    for (const room of rooms) {
      const days = new Map<string, { numAvail: number; price1?: number }>();
      for (const s of room.calendar) {
        for (let d = s.from; d <= s.to; d = addDays(d, 1)) days.set(d, { numAvail: s.numAvail, price1: s.price1 });
      }
      // les 2 nuits du Domaine sont fermées sur chaque room physique
      expect(days.get(addDays(from, 2))?.numAvail).toBe(0);
      expect(days.get(addDays(from, 3))?.numAvail).toBe(0);
      // hors résa : ouvert, prix en euros (pas en centimes)
      expect(days.get(from)?.numAvail).toBe(1);
      expect(days.get(from)?.price1).toBeGreaterThan(50);
      expect(days.get(from)?.price1).toBeLessThan(2000);
    }
  });
});

describe("applyChannelBookings (synchro entrante)", () => {
  const ROOM_TO_UNIT = new Map([[711713, 1], [711714, 2]]);
  const base = (over: Record<string, unknown> = {}) => ({
    id: 900001, roomId: 711714, status: "confirmed",
    arrival: addDays(todayInZone(), 300), departure: addDays(todayInZone(), 303),
    numAdult: 4, numChild: 1, firstName: "Anna", lastName: "Jansen",
    email: "anna.jansen@example.nl", phone: "+31 6 12 34 56 78",
    price: 620.5, channel: "airbnb",
    ...over,
  });

  it("importe une résa Airbnb avec client, montant et label ; idempotent", async () => {
    const r1 = await applyChannelBookings(t.db, [base()], ROOM_TO_UNIT);
    expect(r1).toMatchObject({ imported: 1, updated: 0, cancelled: 0, conflicts: [] });
    const row = await t.db
      .prepare("SELECT unit_id, status, source, channel_label, external_uid, total_cents, adults, children FROM bookings WHERE external_uid = 'beds24:900001'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      unit_id: 2, status: "confirmed", source: "ical", channel_label: "Airbnb",
      external_uid: "beds24:900001", total_cents: 62050, adults: 4, children: 1,
    });
    const guest = await t.db
      .prepare("SELECT last_name, phone FROM guests WHERE lower(email) = 'anna.jansen@example.nl'")
      .first<Record<string, unknown>>();
    expect(guest?.last_name).toBe("Jansen");
    // rejouer le même pull ne crée rien de plus
    const r2 = await applyChannelBookings(t.db, [base()], ROOM_TO_UNIT);
    expect(r2).toMatchObject({ imported: 0, updated: 0, cancelled: 0 });
  });

  it("déplace la résa quand les dates changent côté canal", async () => {
    const moved = base({ arrival: addDays(todayInZone(), 305), departure: addDays(todayInZone(), 308) });
    const r = await applyChannelBookings(t.db, [moved], ROOM_TO_UNIT);
    expect(r).toMatchObject({ imported: 0, updated: 1 });
    const row = await t.db
      .prepare("SELECT checkin FROM bookings WHERE external_uid = 'beds24:900001'")
      .first<{ checkin: string }>();
    expect(row?.checkin).toBe(addDays(todayInZone(), 305));
  });

  it("annulation côté canal → résa locale annulée et créneau libéré", async () => {
    const r = await applyChannelBookings(t.db, [base({ status: "cancelled" })], ROOM_TO_UNIT);
    expect(r).toMatchObject({ cancelled: 1 });
    const row = await t.db
      .prepare("SELECT status FROM bookings WHERE external_uid = 'beds24:900001'")
      .first<{ status: string }>();
    expect(row?.status).toBe("cancelled");
  });

  it("conflit : le créneau est déjà pris chez nous → refus + signalement", async () => {
    const from = addDays(todayInZone(), 320);
    const local = await createBookingAtomic(t.db, {
      unitId: 2, checkin: from, checkout: addDays(from, 3), adults: 2, children: 0,
      status: "confirmed", source: "direct", totalCents: 50000, depositCents: 0, balanceDueDate: null,
    });
    expect(local.ok).toBe(true);
    const r = await applyChannelBookings(t.db, [base({ id: 900002, arrival: from, departure: addDays(from, 2) })], ROOM_TO_UNIT);
    expect(r.imported).toBe(0);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toContain("beds24:900002");
  });

  it("room inconnue ou dates invalides → ignorées proprement", async () => {
    const r = await applyChannelBookings(
      t.db,
      [base({ id: 900003, roomId: 999999 }), base({ id: 900004, arrival: "pas-une-date" })],
      ROOM_TO_UNIT,
    );
    expect(r).toMatchObject({ imported: 0, skipped: 2 });
  });
});

// Issue #18 — une résa canal annulée puis RÉACTIVÉE repartait sur une création
// avec le même external_uid : violation d'unicité → exception → tout le
// rapatriement du domaine échouait, à chaque passage, indéfiniment.
describe("réactivation d'une résa canal annulée (#18)", () => {
  const ROOM_TO_UNIT = new Map([[711713, 1], [711714, 2]]);
  const FROM = addDays(todayInZone(), 400);
  const resa = (over: Record<string, unknown> = {}) => ({
    id: 900101, roomId: 711713, status: "confirmed",
    arrival: FROM, departure: addDays(FROM, 3),
    numAdult: 2, numChild: 0, lastName: "Reactivé", email: "reactive@example.com",
    price: 300, channel: "booking",
    ...over,
  });

  it("créée → annulée → réactivée : aucune exception, la résa est de nouveau active", async () => {
    expect(await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT)).toMatchObject({ imported: 1 });
    expect(await applyChannelBookings(t.db, [resa({ status: "cancelled" })], ROOM_TO_UNIT)).toMatchObject({ cancelled: 1 });

    const r = await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);
    expect(r.conflicts).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.reactivated).toBe(1);

    const row = await t.db
      .prepare("SELECT status, checkin, cancelled_at, cancel_reason FROM bookings WHERE external_uid = 'beds24:900101'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "confirmed", checkin: FROM, cancelled_at: null, cancel_reason: null });
    // et surtout : une seule ligne, pas de doublon créé
    const n = await t.db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE external_uid = 'beds24:900101'")
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("réactivation impossible (créneau repris entre-temps) → alerte, pas d'exception", async () => {
    // on annule de nouveau, puis on vend le créneau en direct
    await applyChannelBookings(t.db, [resa({ status: "cancelled" })], ROOM_TO_UNIT);
    const local = await createBookingAtomic(t.db, {
      unitId: 1, checkin: FROM, checkout: addDays(FROM, 2), adults: 2, children: 0,
      status: "confirmed", source: "direct", totalCents: 40000, depositCents: 0, balanceDueDate: null,
    });
    expect(local.ok).toBe(true);

    const r = await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT);
    expect(r.reactivated).toBe(0);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toContain("réactivation");
    const row = await t.db
      .prepare("SELECT status FROM bookings WHERE external_uid = 'beds24:900101'")
      .first<{ status: string }>();
    expect(row?.status).toBe("cancelled"); // rien n'a été forcé
    // l'alerte est journalisée (visible dans le journal d'audit)
    const alert = await t.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'beds24.reactivate.conflict'")
      .first<{ n: number }>();
    expect(alert?.n).toBeGreaterThan(0);
  });

  it("une réservation en erreur n'interrompt pas le traitement des suivantes", async () => {
    const start = addDays(todayInZone(), 430);
    // room 711715 mappée sur une unité inexistante → l'INSERT lève
    const map = new Map([...ROOM_TO_UNIT, [711715, 4242]]);
    const r = await applyChannelBookings(
      t.db,
      [
        resa({ id: 900201, roomId: 711715, arrival: start, departure: addDays(start, 2) }),
        resa({ id: 900202, roomId: 711714, arrival: start, departure: addDays(start, 2) }),
      ],
      map,
    );
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("beds24:900201");
    expect(r.imported).toBe(1); // la suivante est bien passée
    const row = await t.db
      .prepare("SELECT status FROM bookings WHERE external_uid = 'beds24:900202'")
      .first<{ status: string }>();
    expect(row?.status).toBe("confirmed");
  });
});

// Issue #19 — la comparaison ne portait que sur les DATES : une résa déplacée
// d'une maison à l'autre côté canal restait chez nous sur l'ancienne, et les
// DEUX calendriers devenaient faux sans le moindre signalement.
describe("changement de logement côté canal (#19)", () => {
  const ROOM_TO_UNIT = new Map([[711713, 1], [711714, 2]]);
  const FROM = addDays(todayInZone(), 250);
  const resa = (over: Record<string, unknown> = {}) => ({
    id: 900301, roomId: 711713, status: "confirmed",
    arrival: FROM, departure: addDays(FROM, 3),
    numAdult: 3, numChild: 0, lastName: "Déplacé", email: "deplace@example.com",
    price: 400, channel: "booking",
    ...over,
  });

  it("la résa suit le logement, et les DEUX calendriers sont corrects ensuite", async () => {
    expect(await applyChannelBookings(t.db, [resa()], ROOM_TO_UNIT)).toMatchObject({ imported: 1 });

    // le canal la bascule sur l'autre maison, mêmes dates
    const r = await applyChannelBookings(t.db, [resa({ roomId: 711714 })], ROOM_TO_UNIT);
    expect(r).toMatchObject({ relocated: 1, imported: 0, updated: 0, conflicts: [] });

    const row = await t.db
      .prepare("SELECT unit_id, checkin, checkout FROM bookings WHERE external_uid = 'beds24:900301'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ unit_id: 2, checkin: FROM, checkout: addDays(FROM, 3) });

    // Le cœur du bug : l'ANCIEN logement doit être rouvert à la vente et le
    // NOUVEAU fermé. Vérifié sur ce qu'on pousse réellement aux canaux.
    const rooms = await buildCalendarPush(t.db, 1, FROM, 3);
    const dayOf = (roomId: number) => {
      const room = rooms.find((x) => x.roomId === roomId)!;
      const span = room.calendar.find((s) => s.from <= FROM && s.to >= FROM)!;
      return span.numAvail;
    };
    expect(dayOf(711713)).toBe(1); // La Maison du Scieur : libérée
    expect(dayOf(711714)).toBe(0); // La Scierie : occupée

    // rejouer le même état ne bouge plus rien
    const again = await applyChannelBookings(t.db, [resa({ roomId: 711714 })], ROOM_TO_UNIT);
    expect(again).toMatchObject({ relocated: 0, updated: 0, imported: 0 });
  });

  it("destination déjà occupée → aucun déplacement forcé, conflit signalé", async () => {
    const start = addDays(todayInZone(), 260);
    // résa canal sur le Scieur…
    expect(await applyChannelBookings(t.db, [resa({ id: 900302, arrival: start, departure: addDays(start, 3) })], ROOM_TO_UNIT))
      .toMatchObject({ imported: 1 });
    // …et une résa directe qui occupe déjà La Scierie sur ces dates
    const direct = await createBookingAtomic(t.db, {
      unitId: 2, checkin: start, checkout: addDays(start, 3), adults: 2, children: 0,
      status: "confirmed", source: "direct", totalCents: 40000, depositCents: 0, balanceDueDate: null,
    });
    expect(direct.ok).toBe(true);

    const r = await applyChannelBookings(
      t.db,
      [resa({ id: 900302, roomId: 711714, arrival: start, departure: addDays(start, 3) })],
      ROOM_TO_UNIT,
    );
    expect(r.relocated).toBe(0);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toContain("changement de logement");
    const row = await t.db
      .prepare("SELECT unit_id FROM bookings WHERE external_uid = 'beds24:900302'")
      .first<{ unit_id: number }>();
    expect(row?.unit_id).toBe(1); // rien n'a été forcé
  });
});

// Issue #19 — `updateSettings(beds24_last_pull)` s'exécutait inconditionnellement :
// une résa refusée pour conflit sortait de la fenêtre `modifiedFrom` au pull
// suivant et n'était PLUS JAMAIS réessayée. L'écart devenait définitif.
describe("curseur de pull retenu tant qu'un conflit n'est pas résolu (#19)", () => {
  const CURSEUR_INITIAL = "2026-01-01 00:00:00";
  const readCursor = async () =>
    (await t.db
      .prepare("SELECT value FROM settings WHERE property_id = 1 AND key = 'beds24_last_pull'")
      .first<{ value: string }>())?.value ?? null;

  /** Stub réseau Beds24 : jeton + liste de réservations au choix. */
  function stubBeds24(bookings: unknown[]): () => void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.beds24.com")) {
        if (url.includes("/authentication/token")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
        return new Response(JSON.stringify({ data: bookings }), { status: 200 });
      }
      return real(input as RequestInfo, init);
    }) as typeof fetch;
    return () => { globalThis.fetch = real; };
  }

  const env = () => ({ DB: t.db, BEDS24_REFRESH_TOKEN: "refresh_test" }) as Env;

  it("conflit → le curseur reste en place ; lot propre → il avance et le blocage se lève", async () => {
    const { pullBeds24Bookings, cursorBlockedKey } = await import("../src/services/beds24-sync");
    const { updateSettings } = await import("../src/db/repo");
    const { getSetting } = await import("../src/services/settings");
    const now = new Date();
    const start = addDays(todayInZone(), 270);

    // le créneau est déjà vendu en direct sur La Scierie
    const direct = await createBookingAtomic(t.db, {
      unitId: 2, checkin: start, checkout: addDays(start, 4), adults: 2, children: 0,
      status: "confirmed", source: "direct", totalCents: 50000, depositCents: 0, balanceDueDate: null,
    });
    expect(direct.ok).toBe(true);

    await updateSettings(t.db, 1, { beds24_last_pull: CURSEUR_INITIAL });
    const conflictual = [{
      id: 900401, roomId: 711714, status: "confirmed",
      arrival: start, departure: addDays(start, 2), numAdult: 2, lastName: "Conflit", channel: "airbnb",
    }];

    let restore = stubBeds24(conflictual);
    try {
      const r = await pullBeds24Bookings(t.db, env(), 1, 344555, now);
      expect(r.conflicts.length).toBe(1);
      // LE point de l'issue : le curseur n'a pas bougé → la résa repassera.
      expect(await readCursor()).toBe(CURSEUR_INITIAL);
      expect(await getSetting(t.db, cursorBlockedKey(1))).toContain("since");
    } finally {
      restore();
    }

    // le canal annule la résa litigieuse : plus de conflit, le lot passe
    restore = stubBeds24([{ ...conflictual[0], status: "cancelled" }]);
    try {
      const r = await pullBeds24Bookings(t.db, env(), 1, 344555, now);
      expect(r.conflicts).toEqual([]);
      expect(await readCursor()).not.toBe(CURSEUR_INITIAL);
      expect(await getSetting(t.db, cursorBlockedKey(1))).toBe("");
    } finally {
      restore();
    }

    // le blocage levé est tracé, et la retenue l'avait été à son déclenchement
    const held = await t.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('beds24.cursor.held', 'beds24.cursor.resumed')")
      .first<{ n: number }>();
    expect(held?.n).toBe(2);
  });
});

describe("push temps réel (câblage bout en bout)", () => {
  it("une résa publique déclenche un POST /inventory/rooms/calendar vers Beds24", async () => {
    const { Router } = await import("../src/api/router");
    const { registerPublicRoutes } = await import("../src/api/public");
    const router = new Router();
    registerPublicRoutes(router);

    const beds24Calls: { url: string; method: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.beds24.com")) {
        beds24Calls.push({ url, method: init?.method ?? "GET" });
        if (url.includes("/authentication/token")) {
          // Latence délibérée : le push doit être attendu explicitement, jamais
          // gagné à la course contre la fin du handler (cf. drain ci-dessous).
          await new Promise((r) => setTimeout(r, 5));
          return new Response(JSON.stringify({ token: "tok_test" }), { status: 200 });
        }
        return new Response(JSON.stringify([{ success: true }]), { status: 200 });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      const env = {
        DB: t.db, ASSETS: undefined as unknown as Fetcher,
        PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false",
        BEDS24_REFRESH_TOKEN: "refresh_test",
        // hors https, les écritures Beds24 sont bloquées (garde-fou dev/prod)
        BEDS24_WRITE_ENABLED: "true",
      } as Env;
      const from = addDays(todayInZone(), 340);
      const req = new Request("http://test.local/api/public/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unitId: 1, checkin: from, checkout: addDays(from, 7), adults: 4, children: 0,
          paymentMode: "deposit", cgvAccepted: true,
          guest: { firstName: "Push", lastName: "Réel", email: "push.reel@example.com", phone: "+32 470 99 88 77" },
        }),
      });
      // Le push est différé via ctx.waitUntil : en production le runtime
      // Workers draine ces promesses APRÈS avoir renvoyé la réponse. Sans ctx,
      // la route lançait le push sans l'attendre et le test pariait sur une
      // course (≈8 allers-retours D1 + 2 fetch côté push contre ≈4 côté
      // handler) — perdue sur un runner plus lent, et la promesse survivait à
      // la restauration de globalThis.fetch. On fournit donc un ctx qui
      // collecte, et on draine explicitement avant d'affirmer.
      const deferred: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => { deferred.push(p); },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;

      const res = await router.handle(req, env, ctx);
      expect(res?.status).toBe(201);
      expect(deferred.length).toBeGreaterThan(0); // le push a bien été programmé
      await Promise.all(deferred);

      const push = beds24Calls.find((c) => c.url.includes("/inventory/rooms/calendar") && c.method === "POST");
      expect(push).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
