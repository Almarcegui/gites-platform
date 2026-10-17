// Audit de sécurité du 17/10/2026 : frein aux essais de connexion en série,
// plafond du formulaire de contact par adresse, CSP bloquante de l'écran
// d'administration. (Le serveur Node — méthodes inconnues, en-têtes « cf-… »
// venus du visiteur — est vérifié par node/smoke-test.mjs.)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes, MAX_CONTACTS_PER_IP_HOUR } from "../src/api/public";
import { registerAdminRoutes, LOGIN_MAX_FAILURES_PER_IP, LOGIN_MAX_FAILURES_PER_USER } from "../src/api/admin";
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
  it("bloque un identifiant après trop d'échecs, même avec le bon mot de passe ensuite", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_USER; i++) {
      expect((await post("/api/admin/login", { user: "secours", password: `faux-${i}` }, `10.0.0.${i + 1}`)).status).toBe(401);
    }
    const blocked = await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "10.9.9.9");
    expect(blocked.status).toBe(429);
    expect(blocked.data.code).toBe("login_throttled");
    // Un autre identifiant n'est pas touché.
    expect((await post("/api/admin/login", { user: "julien", password: "premore-2026" }, "10.9.9.9")).status).toBe(200);
    const trace = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.throttled'").first<{ n: number }>();
    expect(trace?.n).toBe(1);
  });

  it("bloque une adresse qui essaie des identifiants en série", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i++) {
      expect((await post("/api/admin/login", { user: `inconnu${i}`, password: "x" }, "203.0.113.7")).status).toBe(401);
    }
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "203.0.113.7")).status).toBe(429);
    // Depuis une autre adresse, le compte reste ouvert.
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "198.51.100.1")).status).toBe(200);
  });

  it("quelques fautes de frappe ne bloquent pas", async () => {
    for (let i = 0; i < 3; i++) await post("/api/admin/login", { user: "secours", password: "faute" }, "10.1.1.1");
    expect((await post("/api/admin/login", { user: "secours", password: "mdp-secours" }, "10.1.1.1")).status).toBe(200);
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
