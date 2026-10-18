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
    ["délai minimum vidé", { min_lead_days: "" }],
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

describe("frais généraux d'un bien : nuits incluses et supplément par nuit", () => {
  const MAUVAISES = [
    ["nuits incluses vidées", { feeIncludedNights: "" }],
    ["nuits incluses en lettres", { feeIncludedNights: "abc" }],
    ["nuits incluses négatives", { feeIncludedNights: -3 }],
    ["nuits incluses décimales", { feeIncludedNights: 12.5 }],
    ["nuits incluses booléennes", { feeIncludedNights: true }],
    ["nuits incluses en tableau", { feeIncludedNights: [3] }],
    ["nuits incluses démesurées", { feeIncludedNights: 1e300 }],
    ["nuits incluses au-delà de 365", { feeIncludedNights: 366 }],
    ["supplément vidé", { chargesExtraNightCents: "" }],
    ["supplément en lettres", { chargesExtraNightCents: "abc" }],
    ["supplément négatif", { chargesExtraNightCents: -500 }],
    ["supplément décimal", { chargesExtraNightCents: 12.5 }],
    ["supplément booléen", { chargesExtraNightCents: true }],
    ["supplément en tableau", { chargesExtraNightCents: [3] }],
    ["supplément démesuré", { chargesExtraNightCents: 1e300 }],
  ] as Array<[string, Record<string, unknown>]>;

  it.each(MAUVAISES)("PATCH : %s → 400, rien n'est écrit", async (_nom, body) => {
    const before = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    const r = await call("PATCH", `/api/admin/units/${before.id}`, body);
    expect(r.status).toBe(400);
    const after = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    expect(after).toEqual(before);
  });

  it.each(MAUVAISES)("POST : %s → 400, aucun bien créé", async (_nom, body) => {
    const before = (await call("GET", "/api/admin/units?property=1")).data.units.length;
    const r = await call("POST", "/api/admin/units", { propertyId: 1, name: "Bien de test", ...body });
    expect(r.status).toBe(400);
    expect((await call("GET", "/api/admin/units?property=1")).data.units.length).toBe(before);
  });

  it("des valeurs saines passent : 0 et 2 nuits, 0 et 2500 centimes, sous forme de nombre ou de chaîne", async () => {
    const id = (await call("GET", "/api/admin/units?property=1")).data.units[0].id;
    for (const body of [{ feeIncludedNights: 0 }, { feeIncludedNights: 2 }, { chargesExtraNightCents: 0 }, { chargesExtraNightCents: "2500", feeIncludedNights: "3" }]) {
      expect((await call("PATCH", `/api/admin/units/${id}`, body)).status).toBe(200);
    }
    const u = (await call("GET", "/api/admin/units?property=1")).data.units[0];
    expect([u.chargesExtraNightCents, u.feeIncludedNights]).toEqual([2500, 3]);
  });

  it("POST : valeurs absentes → défauts (0 centime, 2 nuits) ; valeurs saines gardées", async () => {
    const a = await call("POST", "/api/admin/units", { propertyId: 1, name: "Sans réglage" });
    expect(a.status).toBe(201);
    const b = await call("POST", "/api/admin/units", { propertyId: 1, name: "Avec réglage", chargesExtraNightCents: 2500, feeIncludedNights: 0 });
    expect(b.status).toBe(201);
    const units = (await call("GET", "/api/admin/units?property=1")).data.units as Array<Record<string, any>>;
    const ua = units.find((u) => u.id === a.data.id)!;
    const ub = units.find((u) => u.id === b.data.id)!;
    expect([ua.chargesExtraNightCents, ua.feeIncludedNights]).toEqual([0, 2]);
    expect([ub.chargesExtraNightCents, ub.feeIncludedNights]).toEqual([2500, 0]);
  });
});

describe("PATCH /api/admin/units/:id : un bien garde un nom, une capacité, un ménage positif", () => {
  it.each([
    ["nom vidé", { name: "  " }],
    ["capacité 0", { capacityBase: 0, capacityMax: 0 }],
    ["maximum sous le nombre habituel", { capacityBase: 9, capacityMax: 3 }],
    ["capacité décimale", { capacityMax: 4.5 }],
    ["ménage négatif", { cleaningFeeCents: -500 }],
    ["ménage vidé", { cleaningFeeCents: "" }],
    ["capacité vidée", { capacityMax: "" }],
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

describe("saisons, règles, remises, options : un champ vidé ou absurde est refusé", () => {
  const first = async (path: string, key: string) => (await call("GET", path)).data[key][0];

  it("saison : nom vidé et dates à l'envers refusés, la saison reste intacte", async () => {
    const before = await first("/api/admin/seasons?property=1", "seasons");
    expect((await call("PATCH", `/api/admin/seasons/${before.id}`, { name: " " })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/seasons/${before.id}`, { dateStart: "2099-01-01" })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/seasons/${before.id}`, { dateEnd: "1999-01-01" })).status).toBe(400);
    expect(await first("/api/admin/seasons?property=1", "seasons")).toEqual(before);
    expect((await call("PATCH", `/api/admin/seasons/${before.id}`, { name: ` ${before.name} ` })).status).toBe(200);
  });

  it("règle tarifaire : majoration des fériés négative ou vidée refusée", async () => {
    const before = await first("/api/admin/rate-rules?property=1", "rules");
    for (const holidayPct of [-50, "", 250, 2.5]) {
      expect((await call("PATCH", `/api/admin/rate-rules/${before.id}`, { holidayPct })).status).toBe(400);
    }
    expect(await first("/api/admin/rate-rules?property=1", "rules")).toEqual(before);
    expect((await call("PATCH", `/api/admin/rate-rules/${before.id}`, { holidayPct: 15 })).status).toBe(200);
  });

  it("remise : pourcentage vidé et seuil négatif refusés", async () => {
    const before = await first("/api/admin/promotions?property=1", "promotions");
    expect((await call("PATCH", `/api/admin/promotions/${before.id}`, { discountPct: "" })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/promotions/${before.id}`, { threshold: -4 })).status).toBe(400);
    expect(await first("/api/admin/promotions?property=1", "promotions")).toEqual(before);
    expect((await call("PATCH", `/api/admin/promotions/${before.id}`, { discountPct: before.discountPct })).status).toBe(200);
  });

  it("option : nom vidé, prix vidé ou négatif refusés", async () => {
    const before = await first("/api/admin/options?property=1", "options");
    for (const body of [{ name: "" }, { priceCents: "" }, { priceCents: "abc" }, { priceCents: -100 }]) {
      expect((await call("PATCH", `/api/admin/options/${before.id}`, body)).status).toBe(400);
    }
    expect(await first("/api/admin/options?property=1", "options")).toEqual(before);
    expect((await call("PATCH", `/api/admin/options/${before.id}`, { priceCents: before.priceCents })).status).toBe(200);
  });
});
