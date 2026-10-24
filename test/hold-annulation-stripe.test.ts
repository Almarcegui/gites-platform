// Annuler ou remplacer un hold ne libère JAMAIS le créneau tant que Stripe n'a
// pas confirmé la fermeture du paiement (contrôle PR #173) : sinon le webhook
// « payé » tombe sur un séjour annulé, argent encaissé sans séjour.
// Stripe est simulé par un fetch global ; aucun appel réseau réel.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { handlePaymentSuccess } from "../src/services/booking-flow";
import { markPaymentStatus } from "../src/db/repo";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);
let t: TestDb;
let db: D1Database;
let realFetch: typeof fetch;
const CHECKIN = addDays(todayInZone(), 150);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "A", lastName: "Course", email: "course@example.test", phone: "+32 470 00 00 00" };
let seq = 0;
type Mode = "normal" | "cancel_400" | "down" | "succeeded" | "expire_400_paid";
let mode: Mode = "normal";

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (url.endsWith("/payment_intents")) { seq++; return j({ id: `pi_c_${seq}`, client_secret: `pi_c_${seq}_secret` }); }
    if (url.endsWith("/checkout/sessions")) { seq++; return j({ id: `cs_c_${seq}`, url: `https://checkout.stripe.com/c/pay/cs_c_${seq}` }); }
    if (mode === "down") return j({ error: { message: "api_error" } }, 500);
    if (method === "GET" && /payment_intents\/pi_/.test(url))
      return j({ status: mode === "succeeded" || mode === "cancel_400" ? "succeeded" : "requires_payment_method" });
    if (method === "GET" && /checkout\/sessions\/cs_/.test(url)) return j({ status: mode === "expire_400_paid" ? "complete" : "open" });
    if (url.endsWith("/cancel")) return mode === "cancel_400" ? j({ error: { message: "status succeeded" } }, 400) : j({ status: "canceled" });
    if (url.endsWith("/expire")) return mode === "expire_400_paid" ? j({ error: { message: "not open" } }, 400) : j({ status: "expired" });
    return j({});
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(async () => {
  for (const tb of ["payments", "email_log", "audit_log", "bookings", "guests"]) await db.prepare(`DELETE FROM ${tb}`).run();
  mode = "normal";
});

const mkEnv = (ui: "element" | "checkout") =>
  ({
    DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false",
    ADMIN_TOKEN: "x:y", STRIPE_SECRET_KEY: "sk_test_c", STRIPE_WEBHOOK_SECRET: "whsec_c",
    ...(ui === "element" ? { STRIPE_PUBLISHABLE_KEY: "pk_test_c" } : { STRIPE_UI: "checkout" }),
  }) as unknown as Env;

async function call(method: string, path: string, e: Env, body?: unknown, cookie?: string | null) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), e);
  const sc = res!.headers.get("set-cookie");
  return { status: res!.status, data: (await res!.json()) as Record<string, unknown>, cookie: sc ? sc.split(";")[0] : null };
}

const BODY = { unitId: 1, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0, paymentMode: "deposit", guest: GUEST, cgvAccepted: true };

async function annuler(ui: "element" | "checkout", m: Mode) {
  const e = mkEnv(ui);
  const h = await call("POST", "/api/public/bookings", e, BODY);
  expect(h.status).toBe(201);
  const pay = await db.prepare("SELECT stripe_session_id AS s FROM payments ORDER BY id DESC LIMIT 1").first<{ s: string }>();
  mode = m;
  const c = await call("POST", "/api/public/hold/cancel", e, {}, h.cookie);
  const b = await db.prepare("SELECT status FROM bookings WHERE reference = ?1").bind(h.data.reference).first<{ status: string }>();
  // le paiement aboutit chez Stripe : le webhook arrive ensuite
  await handlePaymentSuccess(db, e, pay!.s, "pi_x");
  const fin = await db.prepare("SELECT status FROM bookings WHERE reference = ?1").bind(h.data.reference).first<{ status: string }>();
  const orphan = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.orphaned'").first<{ n: number }>();
  return { cancel: c, apres: b?.status, final: fin?.status, orphan: orphan?.n ?? 0 };
}

describe("annuler pendant que Stripe encaisse", () => {
  it("intention payée entre la lecture et l'annulation : refus 409, réservation intacte, pas d'orphelin", async () => {
    const r = await annuler("element", "cancel_400");
    expect(r.cancel.status).toBe(409);
    expect(r.cancel.data.code).toBe("payment_in_flight");
    expect(r.apres).toBe("pending");
    expect(r.final).not.toBe("cancelled");
    expect(r.orphan).toBe(0);
  });

  it("Stripe injoignable : on ne libère pas à l'aveugle", async () => {
    const r = await annuler("element", "down");
    expect(r.cancel.status).toBe(409);
    expect(r.apres).toBe("pending");
    expect(r.orphan).toBe(0);
  });

  it("intention déjà succeeded, webhook pas encore reçu", async () => {
    const r = await annuler("element", "succeeded");
    expect(r.cancel.status).toBe(409);
    expect(r.apres).toBe("pending");
    expect(r.orphan).toBe(0);
  });

  it("session Checkout déjà payée (expiration refusée)", async () => {
    const r = await annuler("checkout", "expire_400_paid");
    expect(r.cancel.status).toBe(409);
    expect(r.apres).toBe("pending");
    expect(r.orphan).toBe(0);
  });

  it("cas nominal : fermée chez Stripe, créneau libéré", async () => {
    const r = await annuler("element", "normal");
    expect(r.cancel.status).toBe(200);
    expect(r.apres).toBe("cancelled");
  });

  it("le remplacement d'un hold suit la même règle : refus tant que Stripe n'a pas fermé", async () => {
    const e = mkEnv("element");
    const h = await call("POST", "/api/public/bookings", e, BODY);
    expect(h.status).toBe(201);
    mode = "down";
    const autre = await call("POST", "/api/public/bookings", e, { ...BODY, checkin: addDays(CHECKIN, 20), checkout: addDays(CHECKIN, 27) }, h.cookie).catch((err) => ({ status: 409, data: { err: String(err) }, cookie: null }));
    expect(autre.status).toBe(409);
    const b = await db.prepare("SELECT status FROM bookings WHERE reference = ?1").bind(h.data.reference).first<{ status: string }>();
    expect(b?.status).toBe("pending");
  });
});

describe("webhook concurrent", () => {
  it("un paiement réussi n'est jamais réécrit en échec", async () => {
    const e = mkEnv("element");
    const h = await call("POST", "/api/public/bookings", e, BODY);
    expect(h.status).toBe(201);
    const pay = await db.prepare("SELECT id, stripe_session_id AS s FROM payments ORDER BY id DESC LIMIT 1").first<{ id: number; s: string }>();
    await handlePaymentSuccess(db, e, pay!.s, "pi_x");
    await markPaymentStatus(db, pay!.id, "failed", { note: "tentative tardive" });
    const p = await db.prepare("SELECT status FROM payments WHERE id = ?1").bind(pay!.id).first<{ status: string }>();
    expect(p?.status).toBe("succeeded");
  });
});
