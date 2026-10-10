// Issue #36 — délai de réservation, entonnoir de conversion, journal des
// recherches.
//
// Deux exigences de l'issue guident ces tests :
//  · « Un test vérifie le calcul du délai moyen de réservation » ;
//  · « Aucune donnée identifiante dans search_log ». La seconde se teste sur le
//    SCHÉMA lui-même, pas sur les valeurs : une colonne absente ne peut pas se
//    remplir par accident, alors qu'une colonne présente finit toujours par
//    l'être.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { computeFunnel, computeLeadTime, summarizeSearches, type LeadTimeBooking } from "../src/core/stats";
import { countDirectBookings, countSearchStages, listSearchLog, logSearch } from "../src/services/search-log";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
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
    ADMIN_TOKEN: ADMIN,
  } as Env;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["search_log", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------
// Délai de réservation
// ---------------------------------------------------------------------------

describe("délai de réservation", () => {
  const booking = (bookedOn: string, checkin: string, unitId = 1): LeadTimeBooking => ({
    unitId,
    unitName: `Unité ${unitId}`,
    checkin,
    bookedOn,
  });

  it("calcule le délai moyen (exigence explicite de l'issue)", () => {
    const stats = computeLeadTime(2026, [
      booking("2026-01-01", "2026-01-31"), //  30 jours
      booking("2026-01-01", "2026-03-02"), //  60 jours
      booking("2026-05-01", "2026-08-09"), // 100 jours
    ]);
    expect(stats.count).toBe(3);
    expect(stats.avgDays).toBe(63.3); // (30 + 60 + 100) / 3
    expect(stats.medianDays).toBe(60);
  });

  it("la médiane résiste à une réservation posée très en avance", () => {
    // Le piège de l'indicateur : une seule résa à deux ans décale la moyenne
    // d'un mois et ferait croire à une clientèle très prévoyante.
    const stats = computeLeadTime(2026, [
      booking("2026-06-01", "2026-06-11"), //  10 j
      booking("2026-06-01", "2026-06-15"), //  14 j
      booking("2026-06-01", "2026-06-21"), //  20 j
      booking("2024-07-01", "2026-07-01"), // 730 j
    ]);
    expect(stats.avgDays).toBe(193.5);
    expect(stats.medianDays).toBe(17); // (14 + 20) / 2 — insensible à l'extrême
  });

  it("ventile par mois d'arrivée et par hébergement", () => {
    const stats = computeLeadTime(2026, [
      booking("2026-01-01", "2026-07-11", 1), // juillet, 191 j
      booking("2026-06-01", "2026-07-11", 2), // juillet,  40 j
      booking("2026-08-01", "2026-08-21", 1), // août,     20 j
    ]);
    const juillet = stats.byMonth.find((m) => m.key === 7)!;
    expect(juillet.count).toBe(2);
    expect(juillet.avgDays).toBe(115.5);
    const aout = stats.byMonth.find((m) => m.key === 8)!;
    expect(aout.count).toBe(1);
    // les mois sans réservation restent présents, à zéro, pour un affichage stable
    expect(stats.byMonth).toHaveLength(12);
    expect(stats.byUnit.map((u) => [u.key, u.count])).toEqual([[1, 2], [2, 1]]);
  });

  it("écarte les délais négatifs des réservations importées", () => {
    // Une résa rapatriée d'un canal porte la date de son import, pas celle de
    // sa vente : la compter tirerait l'indicateur vers « ils réservent au
    // dernier moment », exactement le sens qui trompe.
    const stats = computeLeadTime(2026, [
      booking("2026-03-01", "2026-03-31"), // 30 j
      booking("2026-05-01", "2026-04-01"), // -30 j, import
    ]);
    expect(stats.count).toBe(1);
    expect(stats.avgDays).toBe(30);
  });

  it("ne compte que les arrivées de l'année demandée", () => {
    const stats = computeLeadTime(2026, [booking("2026-12-01", "2027-01-05")]);
    expect(stats.count).toBe(0);
    expect(stats.avgDays).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Entonnoir
// ---------------------------------------------------------------------------

describe("entonnoir de conversion", () => {
  it("calcule les taux de passage et le total", () => {
    const f = computeFunnel({ searches: 200, quotes: 100, started: 20, confirmed: 15 });
    expect(f.steps.map((s) => s.fromPreviousPct)).toEqual([null, 50, 20, 75]);
    expect(f.overallPct).toBe(7.5);
  });

  it("désigne l'étape qui perd le plus de monde", () => {
    const f = computeFunnel({ searches: 200, quotes: 100, started: 20, confirmed: 15 });
    // 100 perdus entre recherches et devis, 80 entre devis et réservations
    expect(f.biggestDropKey).toBe("quotes");
  });

  it("un journal vide donne « pas de donnée », jamais 0 %", () => {
    // Afficher 0 % ferait chercher une panne de conversion là où la mesure
    // vient seulement de démarrer.
    const f = computeFunnel({ searches: 0, quotes: 0, started: 0, confirmed: 0 });
    expect(f.overallPct).toBeNull();
    expect(f.steps.every((s) => s.ofFirstPct === null)).toBe(true);
    expect(f.steps[1]?.fromPreviousPct).toBeNull();
    expect(f.biggestDropKey).toBeNull();
  });

  it("ne compte que les réservations directes", async () => {
    const year = Number(todayInZone().slice(0, 4));
    for (const [ref, source, status] of [
      ["DIR-1", "direct", "confirmed"],
      ["DIR-2", "direct", "pending"],
      ["OTA-1", "ical", "confirmed"],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, source, reference,
                                 total_cents, deposit_cents) VALUES (1, ?1, ?2, 2, 0, ?3, ?4, ?5, 0, 0)`,
        )
        .bind(addDays(todayInZone(), 30), addDays(todayInZone(), 33), status, source, ref)
        .run();
    }
    // Une résa venue d'un canal n'a jamais traversé le tunnel : la compter
    // fabriquerait un taux de conversion supérieur à la réalité.
    expect(await countDirectBookings(db, { propertyId: 1, year })).toEqual({ started: 2, confirmed: 1 });
  });
});

// ---------------------------------------------------------------------------
// Journal des recherches
// ---------------------------------------------------------------------------

describe("journal des recherches — protection des données", () => {
  const migration = readFileSync(
    fileURLToPath(new URL("../migrations/0013_search_log.sql", import.meta.url)),
    "utf8",
  );

  it("le schéma ne comporte AUCUNE colonne identifiante", async () => {
    const { results } = await db.prepare("PRAGMA table_info(search_log)").all();
    const columns = (results as { name: string }[]).map((c) => c.name).sort();
    expect(columns).toEqual([
      "adults", "checkin", "checkout", "children", "created_at", "found",
      "id", "nights", "property_id", "results", "stage", "unit_id",
    ]);
    // une colonne absente ne peut pas se remplir par accident
    for (const interdit of ["ip", "email", "session", "user_agent", "guest_id", "fingerprint", "name"]) {
      expect(columns).not.toContain(interdit);
    }
  });

  it("aucune référence vers la table des clients", () => {
    expect(migration).not.toMatch(/REFERENCES\s+guests/i);
  });

  it("les index utiles existent", async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'search_log'")
      .all();
    const names = (results as { name: string }[]).map((i) => i.name);
    expect(names).toContain("idx_search_log_created");
    expect(names).toContain("idx_search_log_empty");
    expect(names).toContain("idx_search_log_property");
  });
});

describe("journal des recherches — synthèse", () => {
  const entry = (checkin: string, checkout: string, found: boolean, adults = 2, children = 0) => ({
    checkin, checkout, nights: 3, adults, children, found,
  });

  it("regroupe les recherches infructueuses par dates, les plus fréquentes d'abord", () => {
    const s = summarizeSearches([
      entry("2026-08-14", "2026-08-17", false),
      entry("2026-08-14", "2026-08-17", false, 6, 3),
      entry("2026-08-14", "2026-08-17", false),
      entry("2026-12-24", "2026-12-27", false),
      entry("2026-09-04", "2026-09-07", true),
    ]);
    expect(s.total).toBe(5);
    expect(s.empty).toBe(4);
    expect(s.emptyPct).toBe(80);
    expect(s.topEmpty[0]).toEqual({
      checkin: "2026-08-14", checkout: "2026-08-17", nights: 3, count: 3, maxPersons: 9,
    });
    expect(s.topEmpty[1]?.checkin).toBe("2026-12-24");
  });

  it("un journal vide ne produit pas de division par zéro", () => {
    expect(summarizeSearches([])).toEqual({ total: 0, empty: 0, emptyPct: 0, topEmpty: [] });
  });
});

describe("journal des recherches — enregistrement", () => {
  it("une recherche publique est journalisée, sans rien d'identifiant", async () => {
    const checkin = addDays(todayInZone(), 150);
    const checkout = addDays(checkin, 3);
    const res = await router.handle(
      new Request(
        `http://test.local/api/public/availability?property=pre-more&checkin=${checkin}&checkout=${checkout}&adults=4`,
      ),
      env,
    );
    expect(res?.status).toBe(200);

    // Le journal se filtre sur la date de la RECHERCHE, pas sur celle du séjour.
    const rows = await listSearchLog(db, { propertyId: 1, year: Number(todayInZone().slice(0, 4)) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkin, checkout, nights: 3, adults: 4, children: 0, found: true });
  });

  it("une recherche sans réponse est marquée comme telle", async () => {
    // capacité volontairement hors d'atteinte : aucun hébergement réservable
    const checkin = addDays(todayInZone(), 151);
    await router.handle(
      new Request(
        `http://test.local/api/public/availability?property=pre-more&checkin=${checkin}&checkout=${addDays(checkin, 3)}&adults=25`,
      ),
      env,
    );
    const rows = await listSearchLog(db, { propertyId: 1, year: Number(todayInZone().slice(0, 4)) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.found).toBe(false);
  });

  it("un devis affiché est la deuxième étape de l'entonnoir", async () => {
    const checkin = addDays(todayInZone(), 152);
    await router.handle(
      new Request("http://test.local/api/public/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unitId: 1, checkin, checkout: addDays(checkin, 7), adults: 2, children: 0 }),
      }),
      env,
    );
    expect(await countSearchStages(db, { propertyId: 1, year: Number(todayInZone().slice(0, 4)) })).toEqual({
      searches: 0,
      quotes: 1,
    });
  });

  it("une écriture impossible ne casse jamais la recherche mesurée", async () => {
    // Mesurer ne doit pas pouvoir casser ce qui est mesuré : on force l'échec
    // de l'INSERT avec une étape que la contrainte CHECK refuse. Une contrainte
    // CHECK est toujours appliquée, là où les clés étrangères dépendent d'un
    // PRAGMA qui pourrait être désactivé.
    await expect(
      logSearch(db, undefined, {
        propertyId: 1,
        stage: "inconnu" as "search",
        checkin: "2026-08-14",
        checkout: "2026-08-17",
        adults: 2,
        children: 0,
        results: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route back-office
// ---------------------------------------------------------------------------

describe("route /api/admin/stats", () => {
  it("expose les trois nouveaux indicateurs", async () => {
    const year = Number(todayInZone().slice(0, 4));
    const res = await router.handle(
      new Request(`http://test.local/api/admin/stats?property=1&year=${year}`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
      env,
    );
    expect(res?.status).toBe(200);
    const data = (await res!.json()) as Record<string, Record<string, unknown>>;
    expect(data.current).toBeDefined(); // l'existant n'a pas bougé
    expect(data.leadTime).toHaveProperty("avgDays");
    expect(data.leadTime).toHaveProperty("medianDays");
    expect((data.leadTime!.byMonth as unknown[]).length).toBe(12);
    expect((data.funnel!.steps as { key: string }[]).map((s) => s.key)).toEqual([
      "searches", "quotes", "started", "confirmed",
    ]);
    expect(data.searches).toHaveProperty("topEmpty");
  });

  it("l'écran Chiffres du back-office affiche les trois lectures", () => {
    const app = readFileSync(fileURLToPath(new URL("../app/src/pages/settings/Stats.tsx", import.meta.url)), "utf8");
    expect(app).toMatch(/q\.data\?\.leadTime && q\.data\.funnel && q\.data\.searches/);
    expect(app).toMatch(/À quelle avance on réserve/);
    expect(app).toMatch(/biggestDropKey/);
    expect(app).toMatch(/Dates cherchées sans réponse/);
    // la promesse RGPD est écrite à l'écran, là où le propriétaire la lit
    expect(app).toMatch(/Aucune donnée identifiante/);
  });
});
