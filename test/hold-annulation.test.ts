// Annulation par le client de sa réservation en attente (hold) — bug du
// 24/10/2026 : après « Payer et réserver », le créneau restait bloqué jusqu'à
// expiration et le site n'offrait aucune sortie.
//
// Vérifié ici : dates libres tout de suite pour un autre visiteur, cookie
// effacé, idempotence, refus si payé, refus sans le bon cookie (jamais par
// référence), un seul hold actif par navigateur, plafond par IP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

const CHECKIN = addDays(todayInZone(), 140);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "Camille", lastName: "Martin", email: "camille.martin@example.test", phone: "+32 470 11 22 33" };

interface Call {
  status: number;
  data: Record<string, unknown>;
  cookie: string | null;
  setCookie: string | null;
}

async function call(method: string, path: string, body?: unknown, cookie?: string | null, ip?: string): Promise<Call> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  if (ip) headers["cf-connecting-ip"] = ip;
  const res = await router.handle(
    new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
  );
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    data: (await res.json()) as Record<string, unknown>,
    cookie: setCookie ? (setCookie.split(";")[0] as string) : null,
    setCookie,
  };
}

const bookingBody = (over: Record<string, unknown> = {}) => ({
  unitId: 1, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0,
  paymentMode: "deposit", guest: GUEST, cgvAccepted: true, ...over,
});

const availability = (cookie?: string | null) =>
  call("GET", `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=4`, undefined, cookie);
const unit1Libre = (d: Record<string, unknown>) =>
  (d.units as { unitId: number; available: boolean }[]).find((u) => u.unitId === 1)!.available;

const statusOf = async (ref: unknown) =>
  db.prepare("SELECT status, cancel_reason FROM bookings WHERE reference = ?1").bind(ref).first<{ status: string; cancel_reason: string | null }>();

async function poserHold(over: Record<string, unknown> = {}): Promise<Call> {
  const res = await call("POST", "/api/public/bookings", bookingBody(over));
  expect(res.status).toBe(201);
  expect(res.cookie).toBeTruthy();
  return res;
}

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false", ADMIN_TOKEN: "test:token-de-signature",
  } as Env;
});
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("POST /api/public/hold/cancel", () => {
  it("libère les dates tout de suite pour un autre visiteur, efface le cookie, audite", async () => {
    const hold = await poserHold();
    expect(unit1Libre((await availability()).data)).toBe(false);

    const res = await call("POST", "/api/public/hold/cancel", {}, hold.cookie);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, cancelled: true });
    expect(res.setCookie).toContain("Max-Age=0");

    expect(unit1Libre((await availability()).data)).toBe(true);
    expect(await statusOf(hold.data.reference)).toEqual({ status: "cancelled", cancel_reason: "hold_cancelled" });
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").first<{ n: number }>();
    expect(pending?.n).toBe(0);
    const log = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'booking.hold.cancelled_by_guest'").first<{ n: number }>();
    expect(log?.n).toBe(1);
  });

  it("est idempotente : une seconde annulation réussit sans rien changer ni auditer deux fois", async () => {
    const hold = await poserHold();
    await call("POST", "/api/public/hold/cancel", {}, hold.cookie);
    const encore = await call("POST", "/api/public/hold/cancel", {}, hold.cookie);
    expect(encore.status).toBe(200);
    expect(encore.data).toMatchObject({ ok: true, cancelled: false });
    const log = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'booking.hold.cancelled_by_guest'").first<{ n: number }>();
    expect(log?.n).toBe(1);
  });

  it("refuse une réservation déjà payée et la laisse intacte", async () => {
    const hold = await poserHold();
    await db.prepare("UPDATE payments SET status = 'succeeded'").run();
    const res = await call("POST", "/api/public/hold/cancel", {}, hold.cookie);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("hold_paid");
    expect((await statusOf(hold.data.reference))?.status).toBe("pending");
    expect(res.setCookie).toBeNull();
  });

  it("n'agit jamais sans le bon cookie : ni cookie, ni cookie forgé, ni référence en paramètre", async () => {
    const hold = await poserHold();
    const sans = await call("POST", "/api/public/hold/cancel", { reference: hold.data.reference });
    expect(sans.data).toMatchObject({ ok: true, cancelled: false });
    const forge = await call("POST", "/api/public/hold/cancel", { reference: hold.data.reference }, `gp_hold=${hold.data.reference}.faux`);
    expect(forge.data).toMatchObject({ ok: true, cancelled: false });
    expect((await statusOf(hold.data.reference))?.status).toBe("pending");
    expect(unit1Libre((await availability()).data)).toBe(false);
  });

  it("plafonne les essais par IP", async () => {
    const hold = await poserHold();
    let dernier = 200;
    for (let i = 0; i < 25; i++) {
      dernier = (await call("POST", "/api/public/hold/cancel", {}, hold.cookie, "203.0.113.9")).status;
      if (dernier === 429) break;
    }
    expect(dernier).toBe(429);
    const autreIp = await call("POST", "/api/public/hold/cancel", {}, hold.cookie, "203.0.113.10");
    expect(autreIp.status).toBe(200);
  });
});

describe("GET /api/public/hold", () => {
  it("rend l'email du client pour rouvrir le paiement", async () => {
    const hold = await poserHold();
    const { data } = await call("GET", "/api/public/hold?property=pre-more", undefined, hold.cookie);
    expect((data.hold as Record<string, unknown>).guestEmail).toBe(GUEST.email);
  });
});

describe("nouvelle réservation avec un hold existant", () => {
  it("libère l'ancien (sessions soldées) : un seul hold actif pour le navigateur", async () => {
    const hold = await poserHold();
    const res = await call(
      "POST", "/api/public/bookings",
      bookingBody({ checkin: addDays(CHECKIN, 20), checkout: addDays(CHECKIN, 27) }), hold.cookie,
    );
    expect(res.status).toBe(201);
    expect(await statusOf(hold.data.reference)).toEqual({ status: "cancelled", cancel_reason: "hold_replaced" });
    const actifs = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'").first<{ n: number }>();
    expect(actifs?.n).toBe(1);
    const sessions = await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("un nouveau séjour refusé (validation) ne coûte pas son créneau au client", async () => {
    const hold = await poserHold();
    const res = await call(
      "POST", "/api/public/bookings",
      bookingBody({ checkin: addDays(CHECKIN, 27), checkout: addDays(CHECKIN, 20) }), hold.cookie, // départ avant l'arrivée
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await statusOf(hold.data.reference))?.status).toBe("pending");
    const sessions = await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("ne remplace pas un hold déjà payé", async () => {
    const hold = await poserHold();
    await db.prepare("UPDATE payments SET status = 'succeeded'").run();
    const res = await call(
      "POST", "/api/public/bookings",
      bookingBody({ checkin: addDays(CHECKIN, 20), checkout: addDays(CHECKIN, 27) }), hold.cookie,
    );
    expect(res.status).toBe(409);
    expect((await statusOf(hold.data.reference))?.status).toBe("pending");
  });
});
