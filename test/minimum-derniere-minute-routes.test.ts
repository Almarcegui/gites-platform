// Minimum de dernière minute par les routes (décision du 23/10/2026) : PATCH
// des paliers, devis et calendrier publics d'accord aux seuils, back-office au
// minimum du jour, réservation existante plus courte que le nouveau minimum.
//
// Les règles du seed sont ramenées à 6 nuits avec paliers 28:3 et 14:2 sur la
// Maison du Scieur, sans jour d'arrivée imposé ni délai minimum : seul le
// minimum de nuits peut refuser un séjour, quel que soit le jour d'exécution.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const TODAY = todayInZone();
const PALIERS = [{ days: 28, minNights: 3 }, { days: 14, minNights: 2 }];

let t: TestDb;
let db: D1Database;
let env: Env;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(
    new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
  );
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

type Q = { ok: boolean; errors: string[]; warnings: string[]; minNights: number };
const stay = (inDays: number, nights: number) => ({
  unitId: 1, checkin: addDays(TODAY, inDays), checkout: addDays(TODAY, inDays + nights), adults: 2, children: 0,
});
const rulesOfUnit1 = async () =>
  ((await call("GET", "/api/admin/rate-rules?property=1")).data.rules as { id: number; unitId: number; minNightsRelax?: unknown }[])
    .filter((r) => r.unitId === 1);

async function poserMinimum(minNights: number, relax: unknown) {
  for (const r of await rulesOfUnit1()) {
    expect((await call("PATCH", `/api/admin/rate-rules/${r.id}`, { minNights, minNightsRelax: relax })).status).toBe(200);
  }
}

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
  await db.prepare("UPDATE rate_rules SET min_nights = 1, checkin_days = NULL").run();
  await db.prepare("DELETE FROM rate_overrides").run();
  await db.prepare("UPDATE promotions SET active = 0").run();
  await call("PUT", "/api/admin/settings?property=1", { settings: { min_lead_days: 0 } });
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await poserMinimum(6, PALIERS);
});

describe("API admin des paliers", () => {
  it("se lisent, et un PATCH sans le champ les garde", async () => {
    const [r] = await rulesOfUnit1();
    expect(r!.minNightsRelax).toEqual(PALIERS);
    expect((await call("PATCH", `/api/admin/rate-rules/${r!.id}`, { holidayPct: 0 })).status).toBe(200);
    expect((await rulesOfUnit1())[0]!.minNightsRelax).toEqual(PALIERS);
  });

  it("refuse une valeur illisible, un booléen, un palier en double ; null les retire", async () => {
    const [r] = await rulesOfUnit1();
    for (const bad of [[{ days: true, minNights: 2 }], [{ days: 14, minNights: 0 }], [{ days: 14, minNights: 2 }, { days: 14, minNights: 3 }], "28:3"]) {
      expect((await call("PATCH", `/api/admin/rate-rules/${r!.id}`, { minNightsRelax: bad })).status).toBe(400);
    }
    expect((await rulesOfUnit1())[0]!.minNightsRelax).toEqual(PALIERS);
    expect((await call("PATCH", `/api/admin/rate-rules/${r!.id}`, { minNightsRelax: null })).status).toBe(200);
    expect((await rulesOfUnit1())[0]!.minNightsRelax ?? null).toBeNull();
  });
});

describe("devis public et calendriers d'accord aux seuils", () => {
  it.each([
    [10, 2], [14, 2], [15, 3], [28, 3], [29, 6], [45, 6],
  ])("arrivée à J+%i : minimum %i", async (inDays, expected) => {
    const court = (await call("POST", "/api/public/quote", stay(inDays, expected - 1 || 1))).data.quote as Q;
    const juste = (await call("POST", "/api/public/quote", stay(inDays, expected))).data.quote as Q;
    if (expected > 1) expect(court.errors).toContain("min_nights");
    expect(juste.errors).not.toContain("min_nights");
    expect(juste.minNights).toBe(expected);

    const date = addDays(TODAY, inDays);
    const pub = await call("GET", `/api/public/calendar?property=pre-more&month=${date.slice(0, 7)}`);
    const pubDay = (pub.data.units as { unitId: number; days: { date: string; minNights: number | null }[] }[])
      .find((u) => u.unitId === 1)!.days.find((d) => d.date === date);
    expect(pubDay?.minNights).toBe(expected);

    const adm = await call("GET", `/api/admin/rate-calendar?unit=1&from=${date}&to=${addDays(date, 1)}`);
    const admDay = (adm.data.days as { date: string; minNights: number | null }[]).find((d) => d.date === date);
    expect(admDay?.minNights).toBe(expected);
  });
});

describe("réservation existante plus courte que le nouveau minimum", () => {
  it("reste modifiable aux mêmes dates (avertissement), mais ne se déplace pas sous le minimum", async () => {
    await poserMinimum(1, null);
    const created = await call("POST", "/api/admin/bookings", { ...stay(45, 2), guest: { lastName: "Martin" } });
    expect(created.status).toBe(201);
    const id = (created.data.booking as { id: number }).id;
    await poserMinimum(6, PALIERS);

    const plus = await call("PATCH", `/api/admin/bookings/${id}`, { adults: 3 });
    expect(plus.status).toBe(200);
    expect((plus.data.quote as Q).warnings).toContain("min_nights");

    const s = stay(50, 2);
    const moved = await call("PATCH", `/api/admin/bookings/${id}`, { checkin: s.checkin, checkout: s.checkout });
    expect(moved.status).toBe(409);
  });
});
