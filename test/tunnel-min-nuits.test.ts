// Issue #66 — le tunnel dit la règle et propose une sortie.
//
// Le minimum de nuits et les jours d'arrivée imposés existaient dans le moteur
// de devis et nulle part ailleurs : un séjour trop court sortait « indisponible »
// sans explication (impasse n° 5 du parcours au clic du 10/08). Ces tests
// vérifient le contrat côté API — la règle est lisible dans le calendrier, et
// une demande impossible revient avec des dates qui, elles, fonctionnent.
//
// Les saisons sont créées ICI, relatives à la date d'exécution : le seed
// s'arrête en 2027, un test calé sur « juillet 2027 » deviendrait rouge tout
// seul le jour venu.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, dayOfWeek, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

const TODAY = todayInZone();
/** Fenêtre « haute saison » de test : 100 → 160 jours dans le futur. */
const SAISON_DEBUT = addDays(TODAY, 100);
const SAISON_FIN = addDays(TODAY, 160);
const SEASON_ID = 900;
/** Arrivée au cœur de la saison, un jour quelconque. */
const CHECKIN = addDays(TODAY, 120);

async function call(path: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await router.handle(new Request(`http://test.local${path}`), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

interface UnitResult {
  unitId: number;
  name: string;
  available: boolean;
  quote: { ok: boolean; errors: string[]; minNights: number; checkinDays: number[] | null } | null;
  suggestions: { checkin: string; checkout: string; nights: number; totalCents: number }[];
}

const search = async (checkin: string, checkout: string): Promise<UnitResult[]> => {
  const { status, data } = await call(
    `/api/public/availability?property=pre-more&checkin=${checkin}&checkout=${checkout}&adults=4`,
  );
  expect(status).toBe(200);
  return data.units as UnitResult[];
};

/** La Maison du Scieur (unité 1 du seed) — hébergement simple, pas composite. */
const scieur = (units: UnitResult[]): UnitResult => units.find((u) => u.unitId === 1) as UnitResult;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: "test:token",
  } as Env;
});
afterAll(async () => {
  await t.dispose();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM bookings").run();
  await db.prepare("DELETE FROM rate_rules WHERE season_id = ?1").bind(SEASON_ID).run();
  await db.prepare("DELETE FROM seasons WHERE id = ?1").bind(SEASON_ID).run();
});

/** Pose une saison de test sur les deux maisons du Pré Moré. */
async function poseSaison(minNights: number, checkinDays: string | null): Promise<void> {
  await db
    .prepare("INSERT INTO seasons (id, property_id, name, date_start, date_end, priority) VALUES (?1, 1, ?2, ?3, ?4, 99)")
    .bind(SEASON_ID, "Haute saison de test", SAISON_DEBUT, SAISON_FIN)
    .run();
  for (const unitId of [1, 2]) {
    await db
      .prepare(
        `INSERT INTO rate_rules (unit_id, season_id, price_week_cents, price_weekend_cents, holiday_pct, min_nights, checkin_days)
         VALUES (?1, ?2, 24000, 28000, 0, ?3, ?4)`,
      )
      .bind(unitId, SEASON_ID, minNights, checkinDays)
      .run();
  }
}

describe("minimum de nuits visible et contourné (#66)", () => {
  it("recherche de 3 nuits en haute saison : message explicite ET suggestions cliquables", async () => {
    await poseSaison(7, null);
    const units = await search(CHECKIN, addDays(CHECKIN, 3));
    const u = scieur(units);

    // 1. le refus est motivé — l'hébergement est LIBRE, c'est la durée qui pèche
    expect(u.available).toBe(true);
    expect(u.quote?.ok).toBe(false);
    expect(u.quote?.errors).toContain("min_nights");
    expect(u.quote?.minNights).toBe(7);

    // 2. le refus s'accompagne de dates qui, elles, fonctionnent
    expect(u.suggestions.length).toBeGreaterThan(0);
    expect(u.suggestions.length).toBeLessThanOrEqual(2);
    for (const s of u.suggestions) {
      expect(s.nights).toBeGreaterThanOrEqual(7);
      expect(s.totalCents).toBeGreaterThan(0);
    }
  });

  it("chaque suggestion est réellement réservable : le devis la valide", async () => {
    await poseSaison(7, null);
    const units = await search(CHECKIN, addDays(CHECKIN, 3));
    const [suggestion] = scieur(units).suggestions;
    expect(suggestion).toBeDefined();

    const rerun = await search(suggestion!.checkin, suggestion!.checkout);
    const u = scieur(rerun);
    expect(u.available).toBe(true);
    expect(u.quote?.ok).toBe(true);
  });

  it("une nuit déjà réservée ne se retrouve jamais dans une suggestion", async () => {
    await poseSaison(7, null);
    // Séjour ferme sur la Maison du Scieur, juste après les dates demandées.
    await db
      .prepare(
        `INSERT INTO bookings (reference, unit_id, checkin, checkout, adults, children, status, source, total_cents, deposit_cents)
         VALUES ('PM-TEST-001', 1, ?1, ?2, 2, 0, 'confirmed', 'manual', 100000, 0)`,
      )
      .bind(addDays(CHECKIN, 2), addDays(CHECKIN, 12))
      .run();
    const u = scieur(await search(CHECKIN, addDays(CHECKIN, 3)));
    for (const s of u.suggestions) {
      // aucune suggestion ne chevauche le séjour ferme
      expect(s.checkin >= addDays(CHECKIN, 12) || s.checkout <= addDays(CHECKIN, 2)).toBe(true);
    }
  });

  it("aucune suggestion ne dépasse l'horizon de réservation (2 ans)", async () => {
    // Saison de test posée au bord de l'horizon : une suggestion proposée
    // au-delà serait refusée par parseStay au clic — donc rouvrirait l'impasse.
    const bord = addDays(TODAY, 726);
    await db
      .prepare("INSERT INTO seasons (id, property_id, name, date_start, date_end, priority) VALUES (?1, 1, 'Bord horizon', ?2, ?3, 99)")
      .bind(SEASON_ID, addDays(TODAY, 700), addDays(TODAY, 760))
      .run();
    for (const unitId of [1, 2]) {
      await db
        .prepare(
          `INSERT INTO rate_rules (unit_id, season_id, price_week_cents, price_weekend_cents, holiday_pct, min_nights, checkin_days)
           VALUES (?1, ?2, 24000, 28000, 0, 7, NULL)`,
        )
        .bind(unitId, SEASON_ID)
        .run();
    }
    const u = scieur(await search(bord, addDays(bord, 3)));
    const horizon = addDays(TODAY, 730);
    expect(u.suggestions.length).toBeGreaterThan(0); // sinon le test ne prouve rien
    for (const s of u.suggestions) {
      expect(s.checkin <= horizon).toBe(true);
      expect(s.checkout <= horizon).toBe(true);
    }
  });

  it("un séjour conforme ne déclenche aucune suggestion (rien à corriger)", async () => {
    await poseSaison(7, null);
    const u = scieur(await search(CHECKIN, addDays(CHECKIN, 7)));
    expect(u.quote?.ok).toBe(true);
    expect(u.suggestions).toEqual([]);
  });
});

describe("jours d'arrivée imposés, enfin visibles (#66)", () => {
  it("le devis nomme les jours autorisés et la recherche propose une arrivée valide", async () => {
    await poseSaison(7, "6"); // samedi uniquement
    // On part d'un jour d'arrivée volontairement interdit.
    const checkin = dayOfWeek(CHECKIN) === 6 ? addDays(CHECKIN, 1) : CHECKIN;
    const u = scieur(await search(checkin, addDays(checkin, 7)));

    expect(u.quote?.errors).toContain("checkin_day");
    expect(u.quote?.checkinDays).toEqual([6]);
    expect(u.suggestions.length).toBeGreaterThan(0);
    for (const s of u.suggestions) expect(dayOfWeek(s.checkin)).toBe(6);
  });

  it("le calendrier public porte le minimum de nuits ET les jours d'arrivée, jour par jour", async () => {
    await poseSaison(7, "6");
    const { status, data } = await call(`/api/public/calendar?property=pre-more&month=${SAISON_DEBUT.slice(0, 7)}`);
    expect(status).toBe(200);
    const unit = (data.units as { unitId: number; days: { date: string; minNights: number | null; checkinDays: number[] | null }[] }[])
      .find((u) => u.unitId === 1);
    const jour = unit?.days.find((d) => d.date === addDays(SAISON_DEBUT, 5));
    expect(jour?.minNights).toBe(7);
    expect(jour?.checkinDays).toEqual([6]);
  });
});

describe("le tunnel affiche la règle avant la sélection (#66)", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  const JS = read("public/book/book.js");
  const HTML = read("public/book/index.html");

  it("le calendrier écrit le minimum de nuits dans la case et résume la règle par période", () => {
    expect(JS).toMatch(/class="mn">min \$\{d\.minNights\} n/);
    expect(HTML).toMatch(/id="calRules"/);
    expect(JS).toMatch(/nuits minimum/);
  });

  it("un refus ne se résume plus à « indisponible » et propose des dates en un clic", () => {
    expect(JS).not.toMatch(/"Indisponible à ces dates"/);
    expect(JS).toMatch(/function unavailableReason/);
    expect(JS).toMatch(/nuits minimum à ces dates/);
    expect(JS).toMatch(/Arrivée possible uniquement/);
    expect(JS).toMatch(/sugg-b/);
    expect(JS).toMatch(/function applySuggestion/);
  });
});
