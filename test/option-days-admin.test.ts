// Réglages d'une option « à la date » par l'API d'administration (la configuration de la prod).
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

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` };
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: await res.json() };
}
const find = async (id: number) => ((await call("GET", "/api/admin/options?property=1")).data.options as any[]).find((o) => o.id === id);

describe("options à la date : réglages", () => {
  it("création puis réglage Sauna / Bain chaud, champs vidés et conservés", async () => {
    const sauna = (await call("POST", "/api/admin/options?property=1", { name: "Sauna test", pricingMode: "per_stay", priceCents: 18000 })).data.id;
    expect(await find(sauna)).toMatchObject({ perDate: false, weekendPriceCents: null, consecutivePct: null });

    const body = { perDate: true, priceCents: 12000, weekendPriceCents: 18000, weekendDays: [5, 6, 0], consecutivePct: 70 };
    expect((await call("PATCH", `/api/admin/options/${sauna}`, body)).status).toBe(200);
    expect(await find(sauna)).toMatchObject({ perDate: true, priceCents: 12000, weekendPriceCents: 18000, weekendDays: [5, 6, 0], consecutivePct: 70 });

    // un PATCH qui ne parle pas des champs ne les touche pas
    await call("PATCH", `/api/admin/options/${sauna}`, { name: "Sauna test 2" });
    expect(await find(sauna)).toMatchObject({ name: "Sauna test 2", perDate: true, weekendPriceCents: 18000, consecutivePct: 70 });

    // vider : prix week-end et remise à null
    await call("PATCH", `/api/admin/options/${sauna}`, { weekendPriceCents: null, consecutivePct: "", weekendDays: "6" });
    expect(await find(sauna)).toMatchObject({ weekendPriceCents: null, consecutivePct: null, weekendDays: [6] });

    // le bain chaud : seulement « à la date » et le prix par jour
    const bain = (await call("POST", "/api/admin/options?property=1", { name: "Bain test", priceCents: 5000, perDate: true })).data.id;
    expect(await find(bain)).toMatchObject({ perDate: true, priceCents: 5000, weekendPriceCents: null, consecutivePct: null });
  });

  it("vente et modification au back-office : mêmes contrôles, jours relus, annulation qui libère", async () => {
    const db = t.db;
    await db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'checkout_time', '10:00')").run();
    await db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'checkout_time_sunday', '18:00')").run();
    const sauna = (await call("POST", "/api/admin/options?property=1", { name: "Sauna vente", priceCents: 12000, perDate: true, weekendPriceCents: 18000, consecutivePct: 70 })).data.id;
    const sale = (unitId: number, days: string[]) => call("POST", "/api/admin/bookings", {
      unitId, checkin: "2026-10-22", checkout: "2026-10-25", adults: 2, guest: { lastName: "Testeur" },
      options: [{ id: sauna, qty: 1, days }],
    });

    const a = await sale(1, ["2026-10-24"]);
    expect(a.status).toBe(201);
    // même jour dans l'autre maison : refusé
    const clash = await sale(2, ["2026-10-24"]);
    expect(clash.status).toBe(409);
    expect(JSON.stringify(clash.data)).toContain("option_day_taken");
    // un autre jour passe
    const b = await sale(2, ["2026-10-23"]);
    expect(b.status).toBe(201);

    // la fiche relit les jours : une modification sans options reconduit les jours
    const idA = a.data.id ?? a.data.booking?.id;
    const keep = await call("PATCH", `/api/admin/bookings/${idA}`, { adults: 3 });
    expect(keep.status).toBe(200);
    let claims = (await db.prepare("SELECT date FROM option_days WHERE booking_id = ?1").bind(idA).all()).results.map((r: any) => r.date);
    expect(claims).toEqual(["2026-10-24"]);

    // changer les jours : le jour de l'autre réservation est refusé, un jour libre passe
    const bad = await call("PATCH", `/api/admin/bookings/${idA}`, { options: [{ id: sauna, qty: 1, days: ["2026-10-23"] }] });
    expect(bad.status).toBe(409);
    const ok = await call("PATCH", `/api/admin/bookings/${idA}`, { options: [{ id: sauna, qty: 1, days: ["2026-10-24", "2026-10-25"] }] });
    expect(ok.status).toBe(200);
    claims = (await db.prepare("SELECT date FROM option_days WHERE booking_id = ? ORDER BY date").bind(idA).all()).results.map((r: any) => r.date);
    expect(claims).toEqual(["2026-10-24", "2026-10-25"]);

    // « optionDays » : ne change que les jours (la fiche), le reste est reconduit
    expect((await call("PATCH", `/api/admin/bookings/${idA}`, { optionDays: [{ id: sauna, days: ["2026-10-25"] }] })).status).toBe(200);
    claims = (await db.prepare("SELECT date FROM option_days WHERE booking_id = ?").bind(idA).all()).results.map((r: any) => r.date);
    expect(claims).toEqual(["2026-10-25"]);

    // disponibilité côté fiche : ses propres jours restent libres, ceux des autres sont pris
    const av = await call("GET", `/api/admin/option-days?unitId=1&checkin=2026-10-22&checkout=2026-10-25&bookingId=${idA}`);
    const mine = (av.data.options as any[]).find((o) => o.id === sauna).days;
    expect(mine.map((d: any) => d.date)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(mine.find((d: any) => d.date === "2026-10-25").taken).toBe(false);
    expect(mine.find((d: any) => d.date === "2026-10-23").taken).toBe(true);
    const other = await call("GET", "/api/admin/option-days?unitId=1&checkin=2026-10-22&checkout=2026-10-25");
    expect((other.data.options as any[]).find((o) => o.id === sauna).days.find((d: any) => d.date === "2026-10-25").taken).toBe(true);

    // l'annulation libère
    expect((await call("POST", `/api/admin/bookings/${idA}/cancel`, {})).status).toBe(200);
    expect((await sale(1, ["2026-10-24"])).status).toBe(201);
  });

  it("une réservation d'avant la fonctionnalité garde sa ligne Sauna au recalcul (figée, montant et libellé identiques)", async () => {
    const db = t.db;
    const old = (await call("POST", "/api/admin/options?property=1", { name: "Sauna ancien", pricingMode: "per_stay", priceCents: 18000 })).data.id;
    const sold = await call("POST", "/api/admin/bookings", {
      unitId: 3, checkin: "2026-12-04", checkout: "2026-12-06", adults: 2, guest: { lastName: "Ancien" }, options: [{ id: old, qty: 1 }],
    });
    expect(sold.status).toBe(201);
    const id = sold.data.id ?? sold.data.booking?.id;
    const lineOf = async () => JSON.parse((await db.prepare("SELECT options_json FROM bookings WHERE id = ?1").bind(id).first<{ options_json: string }>())!.options_json);
    const before = await lineOf();
    expect(before).toHaveLength(1);
    // l'option devient « à la date » après la vente
    await call("PATCH", `/api/admin/options/${old}`, { perDate: true, priceCents: 12000 });
    const res = await call("PATCH", `/api/admin/bookings/${id}`, { adults: 3 });
    expect(res.status).toBe(200);
    const after = await lineOf();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ label: before[0].label, amountCents: before[0].amountCents });
    const claims = (await db.prepare("SELECT 1 FROM option_days WHERE booking_id = ?1").bind(id).all()).results;
    expect(claims).toHaveLength(0);
    // y poser des jours remplace la ligne figée
    const set = await call("PATCH", `/api/admin/bookings/${id}`, { optionDays: [{ id: old, days: ["2026-12-04"] }] });
    expect(set.status).toBe(200);
    const done = await lineOf();
    expect(done[0].days).toEqual(["2026-12-04"]);
  });
});
