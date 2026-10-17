// Nuit du 17/10/2026 — le simulateur de paiement ne doit jamais confirmer une
// réservation sur un site en https.
//
// Constat : Le Moulin de Braives n'a pas de clés Stripe (docs/paiements-stripe.md,
// « à créer »). En production, une réservation du Moulin tombait donc sur
// /book/dev-pay.html, dont le bouton « Payer » confirme la réservation sans
// encaisser un centime. Garde : sur PUBLIC_BASE_URL en https, une propriété sans
// clés Stripe refuse la réservation (503, avant toute écriture) et le simulateur
// répond 404. ALLOW_STUB_PAYMENTS=true le rouvre explicitement.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { localizePublicResponse } from "../src/core/public-i18n";
import { PAYMENT_UNAVAILABLE_MESSAGE, publicPaymentUnavailable, stubPaymentsAllowed } from "../src/services/stripe-config";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
const TODAY = todayInZone();

const envWith = (extra: Partial<Env>): Env =>
  ({ DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ...extra }) as Env;

async function post(env: Env, path: string, body: unknown) {
  const res = await router.handle(
    new Request(`http://test.local${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

const reservation = () => ({
  unitId: 1,
  checkin: addDays(TODAY, 30),
  checkout: addDays(TODAY, 32),
  adults: 2,
  children: 0,
  guest: { lastName: "Martin", email: "alice.martin@example.com" },
  cgvAccepted: true,
});

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  await db.prepare("UPDATE rate_rules SET min_nights = 1, checkin_days = NULL").run();
  await db.prepare("DELETE FROM rate_overrides").run();
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("simulateur de paiement fermé en https", () => {
  it("stubPaymentsAllowed : ouvert en http, fermé en https, rouvert par ALLOW_STUB_PAYMENTS", () => {
    expect(stubPaymentsAllowed(envWith({}))).toBe(true);
    expect(stubPaymentsAllowed(envWith({ PUBLIC_BASE_URL: "http://127.0.0.1:8788" }))).toBe(true);
    expect(stubPaymentsAllowed(envWith({ PUBLIC_BASE_URL: "https://exemple.test" }))).toBe(false);
    expect(stubPaymentsAllowed(envWith({ PUBLIC_BASE_URL: "https://exemple.test", ALLOW_STUB_PAYMENTS: "true" }))).toBe(true);
    expect(stubPaymentsAllowed(envWith({ PUBLIC_BASE_URL: "https://exemple.test", ALLOW_STUB_PAYMENTS: "oui" }))).toBe(false);
  });

  it("en https sans clés Stripe : la réservation est refusée (503) et rien n'est écrit", async () => {
    const r = await post(envWith({ PUBLIC_BASE_URL: "https://exemple.test" }), "/api/public/bookings", reservation());
    expect(r.status).toBe(503);
    expect(r.data.code).toBe("payment_unavailable");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>())?.n).toBe(0);
  });

  it("en https avec une clé Stripe de repli : la garde laisse passer (aucun appel réseau ici)", async () => {
    const env = envWith({ PUBLIC_BASE_URL: "https://exemple.test", STRIPE_SECRET_KEY: "sk_test_x" });
    expect(await publicPaymentUnavailable(db, env, 1)).toBe(false);
    expect(await publicPaymentUnavailable(db, envWith({ PUBLIC_BASE_URL: "https://exemple.test" }), 1)).toBe(true);
    expect(await publicPaymentUnavailable(db, envWith({}), 1)).toBe(false);
  });

  it("en http (développement) : le simulateur reste disponible", async () => {
    const r = await post(envWith({}), "/api/public/bookings", reservation());
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.data)).toContain("dev-pay.html");
  });

  it("ALLOW_STUB_PAYMENTS=true rouvre le simulateur en https", async () => {
    const r = await post(envWith({ PUBLIC_BASE_URL: "https://exemple.test", ALLOW_STUB_PAYMENTS: "true" }), "/api/public/bookings", reservation());
    expect(r.status).toBe(201);
  });

  it("le simulateur refuse de confirmer un paiement en https", async () => {
    const dev = await post(envWith({}), "/api/public/bookings", reservation());
    expect(dev.status).toBe(201);
    const session = String(
      (await db.prepare("SELECT stripe_session_id AS s FROM payments ORDER BY id DESC LIMIT 1").first<{ s: string }>())?.s ?? "",
    );
    expect(session.startsWith("stub_")).toBe(true);
    const prod = await post(envWith({ PUBLIC_BASE_URL: "https://exemple.test" }), "/api/public/dev-pay/confirm", { session });
    expect(prod.status).toBe(404);
    const statut = await db.prepare("SELECT status FROM bookings ORDER BY id DESC LIMIT 1").first<{ status: string }>();
    expect(statut?.status).toBe("pending");
  });

  it("le message est traduit en néerlandais", async () => {
    const res = new Response(
      JSON.stringify({ error: PAYMENT_UNAVAILABLE_MESSAGE }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    const req = new Request("http://test.local/api/public/bookings", { headers: { "x-gites-lang": "nl" } });
    const nl = (await (await localizePublicResponse(req, res)).json()) as { error: string };
    expect(nl.error).toMatch(/^Online betalen/);
  });
});
