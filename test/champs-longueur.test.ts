// Nuit du 17/10/2026 — les champs libres du formulaire public ont un plafond.
// Avant : un nom de 5 000 caractères créait la réservation (201), gelait les
// dates et gonflait la mise en page du PDF et des mails.
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
const TODAY = todayInZone();

async function post(path: string, body: unknown) {
  const res = await router.handle(
    new Request(`http://test.local${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}
const resa = (guest: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  unitId: 1,
  checkin: addDays(TODAY, 40),
  checkout: addDays(TODAY, 42),
  adults: 2,
  children: 0,
  guest: { lastName: "Martin", email: "alice.martin@example.com", ...guest },
  cgvAccepted: true,
  ...extra,
});

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = { DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false" } as Env;
  await db.prepare("UPDATE rate_rules SET min_nights = 1, checkin_days = NULL").run();
  await db.prepare("DELETE FROM rate_overrides").run();
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests", "messages"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("plafonds des champs libres", () => {
  it.each([
    ["nom", { lastName: "x".repeat(121) }, {}],
    ["prénom", { firstName: "x".repeat(121) }, {}],
    ["téléphone", { phone: "1".repeat(41) }, {}],
    ["adresse", { address: "x".repeat(301) }, {}],
    ["pays", { country: "x".repeat(81) }, {}],
    ["e-mail", { email: `${"a".repeat(250)}@example.com` }, {}],
    ["remarques", {}, { notes: "x".repeat(2001) }],
  ])("réservation : %s trop long → 400, rien d'écrit", async (_n, guest, extra) => {
    const r = await post("/api/public/bookings", resa(guest, extra));
    expect(r.status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>())?.n).toBe(0);
  });

  it("réservation : les valeurs à la limite passent", async () => {
    const r = await post(
      "/api/public/bookings",
      resa({ lastName: "x".repeat(120), phone: "1".repeat(40), address: "x".repeat(300), country: "x".repeat(80) }, { notes: "x".repeat(2000) }),
    );
    expect(r.status).toBe(201);
  });

  it("contact : nom trop long → 400", async () => {
    const r = await post("/api/public/contact", { property: "pre-more", name: "x".repeat(121), email: "lea@example.com", message: "Bonjour, une question" });
    expect(r.status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())?.n).toBe(0);
  });
});
