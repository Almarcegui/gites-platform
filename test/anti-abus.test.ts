// Issue #6 — anti-abus du formulaire public de réservation.
//
// Le hold de 30 min est posé AVANT tout paiement : sans plafond, un script qui
// boucle sur les combinaisons hébergement × dates gèle tout le calendrier de
// vente directe. On plafonne donc les holds en attente et la cadence de
// création, par email ET par IP appelante.
//
// (Le second volet de l'issue #6 — la vérification Turnstile — vit dans
// test/turnstile.test.ts : il est optionnel et éteint sans clés, ces
// plafonds-ci sont inconditionnels.)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { MAX_ACTIVE_HOLDS, MAX_BOOKINGS_PER_HOUR, registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
  } as Env;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** Réservation publique sur la Maison du Scieur, dates décalées de `offset`. */
async function book(opts: { email: string; ip: string; offset: number }): Promise<Response> {
  const checkin = addDays(todayInZone(), opts.offset);
  const req = new Request("http://test.local/api/public/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": opts.ip },
    body: JSON.stringify({
      unitId: 1,
      checkin,
      checkout: addDays(checkin, 2),
      adults: 2,
      children: 0,
      paymentMode: "deposit",
      cgvAccepted: true,
      guest: { firstName: "Test", lastName: "Abus", email: opts.email, phone: "+32 470 00 00 00" },
    }),
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error("route /api/public/bookings introuvable");
  return res;
}

describe("plafond de holds en attente (#6)", () => {
  it(`refuse en 429 le hold n°${MAX_ACTIVE_HOLDS + 1} du même email, avec trace au journal`, async () => {
    for (let i = 0; i < MAX_ACTIVE_HOLDS; i++) {
      const res = await book({ email: "boucle@example.com", ip: "203.0.113.10", offset: 500 + i * 5 });
      expect(res.status).toBe(201);
    }
    const refused = await book({ email: "boucle@example.com", ip: "203.0.113.10", offset: 520 });
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: string; code?: string };
    expect(body.code).toBe("too_many_holds");
    expect(body.error).toMatch(/en attente/i);

    // le refus est journalisé (audit_log) — sans ça, une attaque reste invisible
    const logged = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'booking.rate_limited'")
      .first<{ n: number }>();
    expect(logged?.n).toBe(1);
    // et aucune 4ᵉ résa n'a été créée
    const created = await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>();
    expect(created?.n).toBe(MAX_ACTIVE_HOLDS);
  });

  it("le plafond joue par IP même quand l'attaquant change d'email à chaque appel", async () => {
    for (let i = 0; i < MAX_ACTIVE_HOLDS; i++) {
      const res = await book({ email: `jetable${i}@example.com`, ip: "203.0.113.20", offset: 540 + i * 5 });
      expect(res.status).toBe(201);
    }
    const refused = await book({ email: "jetable-suivant@example.com", ip: "203.0.113.20", offset: 560 });
    expect(refused.status).toBe(429);
  });

  it("un autre visiteur (autre email, autre IP) n'est jamais pénalisé", async () => {
    for (let i = 0; i < MAX_ACTIVE_HOLDS; i++) {
      expect((await book({ email: "boucle@example.com", ip: "203.0.113.30", offset: 570 + i * 5 })).status).toBe(201);
    }
    const legit = await book({ email: "vrai.client@example.com", ip: "198.51.100.7", offset: 590 });
    expect(legit.status).toBe(201);
  });

  it("plafond horaire : une rafale est refusée même si les holds précédents sont soldés", async () => {
    for (let i = 0; i < MAX_BOOKINGS_PER_HOUR; i++) {
      const res = await book({ email: "rafale@example.com", ip: "203.0.113.40", offset: 600 });
      expect(res.status).toBe(201);
      // on solde immédiatement : aucun hold actif ne subsiste, seule la cadence compte
      await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE status = 'pending'").run();
    }
    const refused = await book({ email: "rafale@example.com", ip: "203.0.113.40", offset: 600 });
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { code?: string };
    expect(body.code).toBe("too_many_bookings");
  });

  it("une IP absente (appel hors Cloudflare) ne fait pas s'effondrer le contrôle email", async () => {
    for (let i = 0; i < MAX_ACTIVE_HOLDS; i++) {
      const checkin = addDays(todayInZone(), 620 + i * 5);
      const req = new Request("http://test.local/api/public/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" }, // pas de cf-connecting-ip
        body: JSON.stringify({
          unitId: 1, checkin, checkout: addDays(checkin, 2), adults: 2, children: 0,
          paymentMode: "deposit", cgvAccepted: true,
          guest: { firstName: "Sans", lastName: "IP", email: "SansIP@Example.com", phone: "+32 470 00 00 00" },
        }),
      });
      expect((await router.handle(req, env))?.status).toBe(201);
    }
    // même email en casse différente → toujours plafonné
    const refused = await book({ email: "sansip@example.com", ip: "203.0.113.50", offset: 640 });
    expect(refused.status).toBe(429);
  });
});
