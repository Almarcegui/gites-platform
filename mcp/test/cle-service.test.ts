// Clé d'accès de service (GITES_SERVICE_KEY) : à la place de GITES_ID/GITES_MDP,
// présentée en Bearer svc:<clé> sans connexion, jamais rejouée sur 401.
import { describe, expect, it } from "vitest";
import { ApiError, GitesClient, loadConfig } from "../src/client.js";

describe("clé d'accès de service", () => {
  it("loadConfig : la clé suffit, sans identifiant ni mot de passe", () => {
    const cfg = loadConfig({ GITES_URL: "https://dev1.mdcdy.be", GITES_SERVICE_KEY: "gsk_abc" });
    expect(cfg).toMatchObject({ baseUrl: "https://dev1.mdcdy.be", serviceKey: "gsk_abc" });
    expect(() => loadConfig({ GITES_URL: "https://dev1.mdcdy.be" })).toThrow(/GITES_SERVICE_KEY/);
  });

  it("chaque requête porte Bearer svc:<clé>, sans POST /login ; 401 n'est pas rejoué", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    let status = 200;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "clé de service inconnue ou révoquée" }), { status });
    }) as unknown as typeof fetch;
    const c = new GitesClient(loadConfig({ GITES_URL: "https://dev1.mdcdy.be", GITES_SERVICE_KEY: "gsk_abc" }), fetchImpl);
    expect(await c.get("/api/admin/overview?property=1")).toEqual({ ok: true });
    expect(seen).toEqual([{ url: "https://dev1.mdcdy.be/api/admin/overview?property=1", auth: "Bearer svc:gsk_abc" }]);
    status = 401;
    await expect(c.get("/api/admin/overview?property=1")).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveLength(2);
    expect(seen.some((s) => s.url.endsWith("/api/admin/login"))).toBe(false);
  });
});
