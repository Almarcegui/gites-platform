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
});
