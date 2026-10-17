// Réglages du domaine et des biens : un champ vidé au clavier arrive en chaîne vide
// ou en 0 ; il ne doit ni passer pour « arrhes à 0 % » ou « option qui expire tout
// de suite », ni laisser un bien sans nom ou sans capacité. Données inventées.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";

const router = new Router();
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN = "test-admin-token";

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN };
});
afterAll(async () => {
  await t.dispose();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, any> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` };
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}
const put = (settings: Record<string, unknown>) => call("PUT", "/api/admin/settings?property=1", { settings });

describe("PUT /api/admin/settings : valeurs refusées, rien n'est écrit", () => {
  it.each([
    ["arrhes vidées", { deposit_pct: "" }],
    ["arrhes à 150 %", { deposit_pct: 150 }],
    ["arrhes négatives", { deposit_pct: -10 }],
    ["durée d'option vidée", { hold_minutes: "" }],
    ["durée d'option en lettres", { hold_minutes: "abc" }],
    ["durée d'option de 0 minute", { hold_minutes: 0 }],
    ["solde négatif", { balance_due_days: -1 }],
    ["taxe de séjour vidée", { tourist_tax_cents_per_person_night: "" }],
    ["heure d'arrivée absurde", { checkin_time: "25:99" }],
    ["heure de départ vidée", { checkout_time: "" }],
  ])("%s → 400", async (_nom, settings) => {
    const before = (await call("GET", "/api/admin/settings?property=1")).data.settings;
    const r = await put(settings);
    expect(r.status).toBe(400);
    expect(typeof r.data.error).toBe("string");
    const after = (await call("GET", "/api/admin/settings?property=1")).data.settings;
    expect(after).toEqual(before);
  });

  it("des valeurs saines passent (y compris sous forme de chaîne)", async () => {
    const r = await put({ deposit_pct: 30, hold_minutes: "4320", balance_due_days: 30, checkin_time: "16:00", checkout_time: "10:00", tourist_tax_cents_per_person_night: 0 });
    expect(r.status).toBe(200);
    expect(r.data.settings.holdMinutes).toBe(4320);
    expect(r.data.settings.depositPct).toBe(30);
  });
});

describe("PATCH /api/admin/units/:id : un bien garde un nom, une capacité, un ménage positif", () => {
  it.each([
    ["nom vidé", { name: "  " }],
    ["capacité 0", { capacityBase: 0, capacityMax: 0 }],
    ["maximum sous le nombre habituel", { capacityBase: 9, capacityMax: 3 }],
    ["capacité décimale", { capacityMax: 4.5 }],
    ["ménage négatif", { cleaningFeeCents: -500 }],
  ])("%s → 400", async (_nom, body) => {
    const before = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    const r = await call("PATCH", `/api/admin/units/${before.id}`, body);
    expect(r.status).toBe(400);
    const after = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    expect(after).toEqual(before);
  });

  it("une modification saine passe, le nom est rogné", async () => {
    const u = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    const r = await call("PATCH", `/api/admin/units/${u.id}`, { name: ` ${u.name} `, capacityMax: u.capacityMax + 1, cleaningFeeCents: 0 });
    expect(r.status).toBe(200);
    const after = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    expect(after.name).toBe(u.name);
    expect(after.capacityMax).toBe(u.capacityMax + 1);
  });
});
