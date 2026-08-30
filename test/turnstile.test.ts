// Issue #6, second volet — anti-robot Cloudflare Turnstile sur le formulaire
// public de réservation.
//
// Trois propriétés sont vérifiées ici, dans cet ordre d'importance :
//   1. SANS clés configurées, absolument rien ne change : aucun appel réseau,
//      aucun jeton demandé, réservation créée comme avant. C'est ce qui permet
//      au développement local et à toute la suite de tests de tourner sans
//      compte Cloudflare (CONTRIBUTING § « Comptes tiers »).
//   2. AVEC les clés, un jeton absent ou refusé bloque la réservation AVANT la
//      moindre écriture (ni client, ni créneau gelé).
//   3. Le jeton n'est JAMAIS journalisé — ni dans audit_log, ni dans la
//      réponse renvoyée au visiteur.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import {
  TURNSTILE_ACTION,
  TURNSTILE_VERIFY_URL,
  turnstileEnabled,
  turnstileSiteKey,
  verifyTurnstile,
} from "../src/services/turnstile";

const router = new Router();
registerPublicRoutes(router);

/** Jeton factice — inventé, jamais un vrai jeton Cloudflare. */
const TOKEN = "jeton-de-test-0123456789";

let t: TestDb;
let db: D1Database;

const baseEnv = (): Env =>
  ({
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
  }) as Env;

/** Env avec les DEUX clés — seul cas où la vérification s'active. */
const armedEnv = (): Env =>
  ({ ...baseEnv(), TURNSTILE_SITE_KEY: "0xSITE_TEST", TURNSTILE_SECRET_KEY: "0xSECRET_TEST" }) as Env;

interface SiteverifyCall {
  secret: string | null;
  response: string | null;
  remoteip: string | null;
}

let calls: SiteverifyCall[] = [];
let restoreFetch: (() => void) | null = null;

/** Stub réseau de siteverify. `outcome` décide de la réponse ; tout autre
 *  domaine repart vers le vrai fetch (la base D1 Miniflare en dépend). */
function stubSiteverify(outcome: "ok" | "ko" | "panne"): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === TURNSTILE_VERIFY_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      calls.push({
        secret: form.get("secret"),
        response: form.get("response"),
        remoteip: form.get("remoteip"),
      });
      if (outcome === "panne") throw new Error("réseau indisponible");
      if (outcome === "ok") return new Response(JSON.stringify({ success: true }), { status: 200 });
      return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
}

/** Stub réseau renvoyant un corps de réponse arbitraire (cas tordus). */
function stubSiteverifyRaw(body: string): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === TURNSTILE_VERIFY_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      calls.push({ secret: form.get("secret"), response: form.get("response"), remoteip: form.get("remoteip") });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
}

/** Réservation publique sur la Maison du Scieur. */
async function book(env: Env, opts: { token?: string; offset?: number } = {}): Promise<Response> {
  const checkin = addDays(todayInZone(), opts.offset ?? 300);
  const req = new Request("http://test.local/api/public/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.42" },
    body: JSON.stringify({
      unitId: 1,
      checkin,
      checkout: addDays(checkin, 3),
      adults: 2,
      children: 0,
      paymentMode: "deposit",
      cgvAccepted: true,
      guest: { firstName: "Test", lastName: "Turnstile", email: "robot@example.com", phone: "+32 470 00 00 00" },
      ...(opts.token !== undefined ? { turnstileToken: opts.token } : {}),
    }),
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error("route /api/public/bookings introuvable");
  return res;
}

const countBookings = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>())?.n ?? 0;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  calls = [];
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("activation (les deux clés vont ensemble)", () => {
  it("reste éteint tant qu'il manque une clé, et n'expose alors aucune clé publique", () => {
    expect(turnstileEnabled(baseEnv())).toBe(false);
    expect(turnstileEnabled({ ...baseEnv(), TURNSTILE_SITE_KEY: "0xSITE" } as Env)).toBe(false);
    expect(turnstileEnabled({ ...baseEnv(), TURNSTILE_SECRET_KEY: "0xSECRET" } as Env)).toBe(false);
    expect(turnstileEnabled({ ...baseEnv(), TURNSTILE_SITE_KEY: "  ", TURNSTILE_SECRET_KEY: "0xS" } as Env)).toBe(false);
    expect(turnstileSiteKey(baseEnv())).toBeNull();

    expect(turnstileEnabled(armedEnv())).toBe(true);
    expect(turnstileSiteKey(armedEnv())).toBe("0xSITE_TEST");
  });

  it("éteint, verifyTurnstile accepte tout sans le moindre appel réseau", async () => {
    stubSiteverify("ko");
    expect(await verifyTurnstile(baseEnv(), undefined, null)).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("/api/public/today expose la clé publique, et null quand la fonctionnalité est éteinte", async () => {
    const call = async (env: Env) => {
      const res = await router.handle(new Request("http://test.local/api/public/today"), env);
      return (await res!.json()) as { turnstileSiteKey: string | null };
    };
    expect((await call(baseEnv())).turnstileSiteKey).toBeNull();
    expect((await call(armedEnv())).turnstileSiteKey).toBe("0xSITE_TEST");
  });
});

describe("réservation publique, anti-robot éteint (comportement d'aujourd'hui)", () => {
  it("crée la réservation sans jeton et sans appel réseau", async () => {
    stubSiteverify("ko");
    const res = await book(baseEnv());
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
    expect(await countBookings()).toBe(1);
  });
});

describe("réservation publique, anti-robot armé", () => {
  it("refuse en 400 une requête sans jeton, sans rien écrire", async () => {
    stubSiteverify("ok");
    const res = await book(armedEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("captcha_missing");
    expect(body.error).toMatch(/anti-robot/i);
    // Aucun appel à Cloudflare : un jeton vide se refuse localement.
    expect(calls).toHaveLength(0);
    // Aucune écriture : ni réservation, ni client.
    expect(await countBookings()).toBe(0);
    const guests = await db.prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>();
    expect(guests?.n).toBe(0);
  });

  it("refuse en 400 un jeton rejeté par Cloudflare", async () => {
    stubSiteverify("ko");
    const res = await book(armedEnv(), { token: TOKEN });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("captcha_failed");
    expect(await countBookings()).toBe(0);
    // Le jeton ET le secret partent bien vers siteverify, avec l'IP appelante.
    expect(calls).toEqual([{ secret: "0xSECRET_TEST", response: TOKEN, remoteip: "203.0.113.42" }]);
  });

  it("refuse en 503 quand siteverify est injoignable — la protection ne se désarme pas toute seule", async () => {
    stubSiteverify("panne");
    const res = await book(armedEnv(), { token: TOKEN });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("captcha_unavailable");
    expect(await countBookings()).toBe(0);
  });

  it("laisse passer un jeton valide et crée la réservation", async () => {
    stubSiteverify("ok");
    const res = await book(armedEnv(), { token: TOKEN });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reference: string };
    expect(body.reference).toMatch(/^[A-Z]{2}-/);
    expect(await countBookings()).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("le jeton ne fuit nulle part", () => {
  it("n'apparaît ni dans audit_log ni dans la réponse, même sur un refus", async () => {
    stubSiteverify("ko");
    const res = await book(armedEnv(), { token: TOKEN });
    const raw = await res.text();
    expect(raw).not.toContain(TOKEN);

    const rows = await db.prepare("SELECT action, entity, detail FROM audit_log").all<{ detail: string | null }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(JSON.stringify(row)).not.toContain(TOKEN);
    }
    // Le refus est bien tracé — sans trace, une attaque resterait invisible.
    const logged = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'booking.captcha_refused'")
      .first<{ detail: string }>();
    expect(logged?.detail).toContain("captcha_failed");
    expect(logged?.detail).toContain("invalid-input-response");
  });

  it("ne journalise pas non plus le jeton quand il est accepté", async () => {
    stubSiteverify("ok");
    await book(armedEnv(), { token: TOKEN });
    const rows = await db.prepare("SELECT detail FROM audit_log").all<{ detail: string | null }>();
    for (const row of rows.results) {
      expect(String(row.detail ?? "")).not.toContain(TOKEN);
    }
  });
});

describe("verifyTurnstile — cas limites", () => {
  it("refuse un jeton scellé pour une autre action que la réservation", async () => {
    stubSiteverifyRaw(JSON.stringify({ success: true, action: "newsletter" }));
    const out = await verifyTurnstile(armedEnv(), TOKEN, null);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.codes).toEqual(["action-mismatch"]);
    }
  });

  it("accepte l'action attendue, et tolère une réponse sans action", async () => {
    stubSiteverifyRaw(JSON.stringify({ success: true, action: TURNSTILE_ACTION }));
    expect(await verifyTurnstile(armedEnv(), TOKEN, null)).toEqual({ ok: true });
    restoreFetch?.();
    stubSiteverifyRaw(JSON.stringify({ success: true }));
    expect(await verifyTurnstile(armedEnv(), TOKEN, null)).toEqual({ ok: true });
  });

  it("traite une clé secrète invalide en panne (503), pas en faute du visiteur", async () => {
    stubSiteverifyRaw(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }));
    const out = await verifyTurnstile(armedEnv(), TOKEN, null);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.code).toBe("captcha_unavailable");
    }
  });

  it("ne casse pas sur une réponse JSON `null` — 503, jamais une exception", async () => {
    stubSiteverifyRaw("null");
    const out = await verifyTurnstile(armedEnv(), TOKEN, null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(503);
  });

  it("refuse un jeton de plus de 2048 caractères sans appeler Cloudflare", async () => {
    stubSiteverify("ok");
    const out = await verifyTurnstile(armedEnv(), "x".repeat(2049), null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("captcha_missing");
    expect(calls).toHaveLength(0);
  });

  it("n'envoie pas remoteip quand l'IP est inconnue", async () => {
    stubSiteverify("ok");
    await verifyTurnstile(armedEnv(), TOKEN, null);
    expect(calls[0]?.remoteip).toBeNull();
  });
});
