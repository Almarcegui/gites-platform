// Accès de service (clés d'API pour Claude et les scripts) : la garde accepte
// une clé valide, refuse une clé inconnue ou révoquée ; création et révocation
// réservées aux humains ; seule l'empreinte est stockée ; journal d'audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";

const router = new Router();
registerAdminRoutes(router);
const ADMIN = "julien:jeton-humain";
let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", ADMIN_TOKEN: `${ADMIN},sauvegarde:nuit` };
});
afterAll(async () => {
  await t.dispose();
});

async function call(method: string, path: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("clés de service", () => {
  let key = "";
  let id = 0;

  it("un humain crée une clé : affichée une fois, seule l'empreinte en base, journal", async () => {
    const r = await call("POST", "/api/admin/service-keys", ADMIN, { name: "claude-mac" });
    expect(r.status).toBe(200);
    key = String(r.data.key);
    id = (r.data.serviceKey as { id: number }).id;
    expect(key).toMatch(/^gsk_[0-9a-f]{64}$/);
    const row = await t.db.prepare("SELECT key_hash, key_hint, created_by FROM service_keys WHERE id = ?1").bind(id).first<Record<string, string>>();
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.key_hash).not.toContain(key.slice(4, 20));
    expect(row!.created_by).toBe("julien");
    const list = await call("GET", "/api/admin/service-keys", ADMIN);
    expect(JSON.stringify(list.data)).not.toContain(key);
    expect(JSON.stringify(list.data)).not.toContain(row!.key_hash);
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'service_key.create'").first<{ n: number }>())?.n).toBe(1);
  });

  it("la garde accepte la clé valide (droits admin), trace son usage", async () => {
    expect((await call("GET", "/api/admin/overview?property=1", `svc:${key}`)).status).toBe(200);
    const row = await t.db.prepare("SELECT last_used_at FROM service_keys WHERE id = ?1").bind(id).first<{ last_used_at: string | null }>();
    expect(row?.last_used_at).not.toBeNull();
  });

  it("clé inconnue ou mal formée : 401", async () => {
    expect((await call("GET", "/api/admin/overview?property=1", `svc:gsk_${"0".repeat(64)}`)).status).toBe(401);
    expect((await call("GET", "/api/admin/overview?property=1", "svc:n-importe-quoi")).status).toBe(401);
    expect((await call("GET", "/api/admin/overview?property=1", key)).status).toBe(401);
  });

  it("une clé ne crée ni ne révoque de clé ; le compte sauvegarde non plus", async () => {
    expect((await call("POST", "/api/admin/service-keys", `svc:${key}`, { name: "fille" })).status).toBe(403);
    expect((await call("POST", `/api/admin/service-keys/${id}/revoke`, `svc:${key}`)).status).toBe(403);
    expect((await call("POST", "/api/admin/service-keys", "sauvegarde:nuit", { name: "x" })).status).toBe(403);
    expect((await call("POST", "/api/admin/service-keys", "jeton-humain", { name: "nu" })).status).toBe(403);
    // ni de compte humain, qui ouvrirait ensuite une session (contre-review Codex)
    expect((await call("POST", "/api/admin/users", `svc:${key}`, { username: "pirate" })).status).toBe(403);
    expect((await call("POST", "/api/admin/users/1/reset-password", `svc:${key}`)).status).toBe(403);
    expect((await call("PATCH", "/api/admin/users/1", `svc:${key}`, { active: false })).status).toBe(403);
    expect((await call("DELETE", "/api/admin/users/1", `svc:${key}`)).status).toBe(403);
  });

  it("une session humaine crée aussi ; nom invalide ou déjà pris refusé", async () => {
    const pw = (await call("POST", "/api/admin/users", ADMIN, { username: "matthieu" })).data.password;
    const login = await call("POST", "/api/admin/login", null, { user: "matthieu", password: pw });
    const session = `session:${login.data.session}`;
    expect((await call("POST", "/api/admin/service-keys", session, { name: "script-mac" })).status).toBe(200);
    expect((await call("POST", "/api/admin/service-keys", session, { name: "claude-mac" })).status).toBe(409);
    expect((await call("POST", "/api/admin/service-keys", session, { name: "Nom Invalide!" })).status).toBe(400);
  });

  it("révoquée : la clé cesse de fonctionner tout de suite, la ligne reste", async () => {
    const r = await call("POST", `/api/admin/service-keys/${id}/revoke`, ADMIN);
    expect(r.status).toBe(200);
    expect((await call("GET", "/api/admin/overview?property=1", `svc:${key}`)).status).toBe(401);
    expect((await call("POST", `/api/admin/service-keys/${id}/revoke`, ADMIN)).status).toBe(404);
    const row = await t.db.prepare("SELECT revoked_at, revoked_by FROM service_keys WHERE id = ?1").bind(id).first<Record<string, string>>();
    expect(row).toMatchObject({ revoked_by: "julien" });
    expect(row!.revoked_at).toBeTruthy();
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'service_key.revoke'").first<{ n: number }>())?.n).toBe(1);
  });
});
