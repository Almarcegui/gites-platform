// Audit de sécurité du 17/10/2026 : frein aux essais de connexion en série,
// jeton Cloudflare Access vérifié, plafond du formulaire de contact par
// adresse, CSP bloquante de l'écran d'administration. (Le serveur Node — méthodes inconnues, en-têtes « cf-… »
// venus du visiteur — est vérifié par node/smoke-test.mjs.)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes, MAX_CONTACTS_PER_IP_HOUR } from "../src/api/public";
import { registerAdminRoutes, LOGIN_MAX_FAILURES_PER_IP, LOGIN_MAX_FAILURES_PER_USER, LOGIN_MAX_FAILURES_PER_USER_IP } from "../src/api/admin";
import { purgeAuditIps } from "../src/services/admin-auth";
import { verifyCfAccessJwt } from "../src/services/cf-access";
import { installFakeAccess, type FakeAccess } from "./helpers/cf-access";
import { cspHeaderFor, withStandardHeaders } from "../src/services/http-headers";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: "secours:mdp-secours",
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["audit_log", "messages", "email_log"]) await t.db.prepare(`DELETE FROM ${table}`).run();
});

async function post(path: string, body: unknown, ip?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip) headers["cf-connecting-ip"] = ip;
  const res = await router.handle(new Request(`http://test.local${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("connexion : frein aux essais en série", () => {
  it("bloque un couple identifiant + adresse après trop d'échecs, même avec le bon mot de passe ensuite", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_USER_IP; i++) {
      expect((await post("/api/admin/login", { user: "secours", password: `faux-${i}` }, "10.0.0.1")).status).toBe(401);
    }
    const blocked = await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "10.0.0.1");
    expect(blocked.status).toBe(429);
    expect(blocked.data.code).toBe("login_throttled");
    // Le propriétaire, depuis chez lui, n'est pas verrouillé par l'attaquant.
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "10.9.9.9")).status).toBe(200);
    // Un autre identifiant depuis la même adresse passe encore (plafond d'adresse plus large).
    expect((await post("/api/admin/login", { user: "julien", password: "premore-2026" }, "10.0.0.1")).status).toBe(200);
    // L'essai refusé n'est pas gardé au journal : il ne grossit pas sous l'attaque.
    const failed = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed'").first<{ n: number }>();
    expect(failed?.n).toBe(LOGIN_MAX_FAILURES_PER_USER_IP);
    for (let i = 0; i < 5; i++) await post("/api/admin/login", { user: "secours", password: "x" }, "10.0.0.1");
    const after = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed'").first<{ n: number }>();
    expect(after?.n).toBe(LOGIN_MAX_FAILURES_PER_USER_IP);
    const ok = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.ok'").first<{ n: number }>();
    expect(ok?.n).toBe(2);
  });

  it("bloque une adresse qui essaie des identifiants en série", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i++) {
      expect((await post("/api/admin/login", { user: `inconnu${i}`, password: "x" }, "203.0.113.7")).status).toBe(401);
    }
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "203.0.113.7")).status).toBe(429);
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "198.51.100.1")).status).toBe(200);
  });

  it("borne une attaque répartie sur beaucoup d'adresses", async () => {
    // On simule les échecs déjà inscrits plutôt que d'en jouer cent.
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_USER; i++) {
      await t.db.prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES ('admin', 'login.failed', 'user:secours', ?1)").bind(JSON.stringify({ ip: `10.2.${i >> 8}.${i & 255}` })).run();
    }
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "10.3.3.3")).status).toBe(429);
  });

  it("une rafale parallèle ne passe pas sous le compteur", async () => {
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post("/api/admin/login", { user: "secours", password: `rafale-${i}` }, "10.4.4.4")),
    );
    const tried = burst.filter((r) => r.status === 401).length;
    expect(tried).toBeLessThanOrEqual(LOGIN_MAX_FAILURES_PER_USER_IP);
    expect(burst.filter((r) => r.status === 429).length).toBe(40 - tried);
  });

  it("quelques fautes de frappe ne bloquent pas", async () => {
    for (let i = 0; i < 3; i++) await post("/api/admin/login", { user: "secours", password: "faute" }, "10.1.1.1");
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "10.1.1.1")).status).toBe(200);
  });

  it("les adresses IP des journaux s'effacent après 30 jours", async () => {
    await t.db.prepare("INSERT INTO audit_log (actor, action, entity, detail, created_at) VALUES ('admin', 'login.failed', 'user:x', ?1, datetime('now', '-31 days'))").bind(JSON.stringify({ ip: "10.5.5.5" })).run();
    await t.db.prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES ('admin', 'login.failed', 'user:y', ?1)").bind(JSON.stringify({ ip: "10.6.6.6" })).run();
    await purgeAuditIps(t.db);
    const rows = (await t.db.prepare("SELECT entity, detail FROM audit_log ORDER BY entity").all<{ entity: string; detail: string }>()).results;
    expect(rows).toEqual([{ entity: "user:x", detail: "{}" }, { entity: "user:y", detail: JSON.stringify({ ip: "10.6.6.6" }) }]);
  });
});

describe("Cloudflare Access : seul un jeton authentique ouvre la porte", () => {
  let access: FakeAccess;
  beforeAll(async () => {
    access = await installFakeAccess();
  });
  afterAll(() => access.restore());

  it("vérifie signature, émetteur, audience et expiration", async () => {
    expect(await verifyCfAccessJwt(access.env, await access.token())).toBe("julien@example.com");
    expect(await verifyCfAccessJwt(access.env, "jwt-factice")).toBeNull();
    expect(await verifyCfAccessJwt(access.env, await access.token({}, { sign: access.otherKey }))).toBeNull();
    expect(await verifyCfAccessJwt(access.env, await access.token({ aud: ["autre-application"] }))).toBeNull();
    expect(await verifyCfAccessJwt(access.env, await access.token({ iss: "https://intrus.cloudflareaccess.com" }))).toBeNull();
    expect(await verifyCfAccessJwt(access.env, await access.token({ exp: Math.floor(Date.now() / 1000) - 3600 }))).toBeNull();
    expect(await verifyCfAccessJwt(access.env, await access.token({}, { kid: "cle-inconnue" }))).toBeNull();
    // Jeton « alg: none » : refusé.
    const [, payload] = (await access.token()).split(".");
    expect(await verifyCfAccessJwt(access.env, `${btoa('{"alg":"none"}').replace(/=+$/, "")}.${payload}.`)).toBeNull();
  });

  it("sans configuration, l'en-tête est ignoré", async () => {
    expect(await verifyCfAccessJwt({}, await access.token())).toBeNull();
    expect(await verifyCfAccessJwt({ CF_ACCESS_TEAM_DOMAIN: access.env.CF_ACCESS_TEAM_DOMAIN }, await access.token())).toBeNull();
  });

  it("la garde refuse un en-tête inventé et accepte un vrai jeton", async () => {
    const nu = { ...env, ADMIN_TOKEN: undefined, ...access.env } as Env;
    const get = async (jwt: string) =>
      (await router.handle(new Request("http://test.local/api/admin/users", { headers: { "cf-access-jwt-assertion": jwt } }), nu))!.status;
    expect(await get("x")).toBe(401);
    expect(await get(await access.token())).toBe(200);
  });
});

describe("formulaire de contact : plafond par adresse", () => {
  const question = (n: number) => ({ property: "pre-more", name: "Visiteur", email: `v${n}@example.com`, message: "Bonjour, est-ce libre ?" });

  it("refuse au-delà du plafond horaire, depuis la même adresse seulement", async () => {
    for (let i = 0; i < MAX_CONTACTS_PER_IP_HOUR; i++) {
      expect((await post("/api/public/contact", question(i), "192.0.2.10")).status).toBe(201);
    }
    const refused = await post("/api/public/contact", question(99), "192.0.2.10");
    expect(refused.status).toBe(429);
    expect(refused.data.code).toBe("too_many_messages");
    // Rien n'a été écrit ni envoyé pour le message refusé.
    const msgs = await t.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = 'form'").first<{ n: number }>();
    expect(msgs?.n).toBe(MAX_CONTACTS_PER_IP_HOUR);
    const acks = await t.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE to_email = 'v99@example.com'").first<{ n: number }>();
    expect(acks?.n).toBe(0);
    // Une autre adresse passe.
    expect((await post("/api/public/contact", question(100), "192.0.2.11")).status).toBe(201);
    // Les refus ne laissent pas de trace qui s'accumule.
    for (let i = 0; i < 5; i++) await post("/api/public/contact", question(200 + i), "192.0.2.10");
    const traces = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE json_extract(detail, '$.ip') = '192.0.2.10'").first<{ n: number }>();
    expect(traces?.n).toBe(MAX_CONTACTS_PER_IP_HOUR);
  });

  it("une rafale parallèle ne dépasse pas le plafond", async () => {
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => post("/api/public/contact", question(300 + i), "192.0.2.20")));
    expect(burst.filter((r) => r.status === 201).length).toBeLessThanOrEqual(MAX_CONTACTS_PER_IP_HOUR);
    const msgs = await t.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = 'form'").first<{ n: number }>();
    expect(msgs?.n).toBeLessThanOrEqual(MAX_CONTACTS_PER_IP_HOUR);
  });
});

describe("CSP de l'écran d'administration", () => {
  it("bloquante sous /admin/, sans script en ligne ni origine tierce", () => {
    const h = cspHeaderFor("/admin/");
    const csp = h["content-security-policy"]!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy-report-only"]).toBeUndefined();
  });

  it("le site public reste en observation", () => {
    const h = cspHeaderFor("/book/");
    expect(h["content-security-policy"]).toBeUndefined();
    expect(h["content-security-policy-report-only"]).toContain("js.stripe.com");
    expect(cspHeaderFor("/administration-bidon")["content-security-policy"]).toBeUndefined();
  });

  it("le Worker pose la politique bloquante sur /admin/", () => {
    const res = withStandardHeaders(new Response("<html></html>", { headers: { "content-type": "text/html" } }), new URL("https://test.local/admin/"));
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
});
