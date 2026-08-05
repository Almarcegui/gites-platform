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
      // sans ctx : le trigger await inline → le POST Beds24 doit être parti au retour
      const res = await router.handle(req, env);
      expect(res?.status).toBe(201);
      const push = beds24Calls.find((c) => c.url.includes("/inventory/rooms/calendar") && c.method === "POST");
      expect(push).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
