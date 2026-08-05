// Rétablissement de la liaison Beds24 depuis le back-office : le code
// d'invitation est échangé (fetch stubé), le refresh token atterrit en base
// (app_settings) et les appels suivants l'utilisent — sans redéploiement.
// Fichier séparé : le stub de fetch global et le cache de token module-level
// ne doivent pas polluer les autres suites.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { resetBeds24TokenCache } from "../src/services/beds24";
import { getSetting } from "../src/services/settings";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN_HEADER = { authorization: "Bearer test-admin-token" };

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: "test-admin-token",
  };
});
afterAll(async () => {
  await t.dispose();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetBeds24TokenCache();
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", ...ADMIN_HEADER },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error("route inconnue");
  return res;
}

describe("liaison Beds24 rétablie depuis le back-office", () => {
  it("invite-code : échange stubé → refresh token en base → status connecté", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/authentication/setup")) {
        return new Response(JSON.stringify({ token: "acc-1", refreshToken: "refresh-depuis-invite" }), { status: 200 });
      }
      if (url.includes("/authentication/token")) {
        return new Response(JSON.stringify({ token: "acc-2" }), { status: 200 });
      }
      if (url.includes("/authentication/details")) {
        return new Response(JSON.stringify({ data: { account: "ok" } }), { status: 200 });
      }
      if (url.includes("/properties")) {
        return new Response(JSON.stringify({ data: [{ id: 344555, name: "Pré Moré" }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const res = await call("POST", "/api/admin/beds24/invite-code", { code: "INVITE-XYZ" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; status: { connected: boolean } };
    expect(data.ok).toBe(true);
    expect(data.status.connected).toBe(true);
    // le refresh token vit en base — pas dans un secret
    expect(await getSetting(t.db, "beds24_refresh_token")).toBe("refresh-depuis-invite");
    // et le renouvellement d'access token l'a bien utilisé
    expect(calls.some((u) => u.includes("/authentication/token"))).toBe(true);
  });

  it("code refusé par Beds24 → 502 explicite, rien n'est écrit en base", async () => {
    await t.db.prepare("DELETE FROM app_settings WHERE key = 'beds24_refresh_token'").run();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid code" }), { status: 401 }));
    const res = await call("POST", "/api/admin/beds24/invite-code", { code: "MAUVAIS" });
    expect(res.status).toBe(502);
    expect(await getSetting(t.db, "beds24_refresh_token")).toBeNull();
  });
});
