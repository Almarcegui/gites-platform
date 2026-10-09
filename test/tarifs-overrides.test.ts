// Tarifs — surcharges par jour, garde-fous de prix et prix conseillé, contre
// une vraie base D1 (issues #23, #31, #50).
//
// Les montants exacts du moteur sont couverts par pricing.test.ts ; ici on
// vérifie ce que le SERVEUR accepte, refuse, écrit et renvoie.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { buildCalendarPush } from "../src/services/beds24-sync";
import { addDays, todayInZone } from "../src/core/dates";
import { zeroUnitRules } from "./helpers/rate-rules";

const router = new Router();
registerAdminRoutes(router);

let t: TestDb;
let env: Env;

// Jeton de secours au format « identifiant:motdepasse » — c'est ce format
// qui permet à la garde de savoir QUI agit, et donc de tracer l'auteur des
// modifications de tarifs (issue #54).
const ADMIN_USER = "julie";
const ADMIN = `${ADMIN_USER}:motdepasse-test`;
const SCIERIE = 2;   // La Scierie — tarif de base 120 € semaine / 150 € weekend
const DOMAINE = 3;   // Le Domaine entier — composite en mode « somme »

// Fenêtre de travail très en avant, pour ne dépendre d'aucune saison du seed
// (haute saison = juillet-août) ni de la date d'exécution.
const LUNDI = "2027-03-01"; // 1er mars 2027 est un lundi
const dj = (n: number): string => addDays(LUNDI, n);

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  await t.db.prepare("DELETE FROM rate_overrides").run();
  await t.db.prepare("UPDATE units SET price_min_cents = NULL, price_max_cents = NULL").run();
  await t.db.prepare("DELETE FROM app_settings WHERE key = 'pricing.channel_markups'").run();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

interface CalendarDay {
  date: string;
  priceCents: number | null;
  source: string | null;
  minNights: number | null;
  minNightsSource: string | null;
  fallbackPriceCents: number | null;
  overridePriceCents: number | null;
  overrideMinNights: number | null;
}

async function calendarDays(unitId: number, from: string, toExclusive: string): Promise<Map<string, CalendarDay>> {
  const { data } = await call("GET", `/api/admin/rate-calendar?unit=${unitId}&from=${from}&to=${toExclusive}`);
  const days = (data.days ?? []) as CalendarDay[];
  return new Map(days.map((d) => [d.date, d]));
}

/** Id de la règle « tarif de base » (season_id NULL) d'une unité. */
async function baseRuleId(unitId: number): Promise<number> {
  const row = await t.db
    .prepare("SELECT id FROM rate_rules WHERE unit_id = ?1 AND season_id IS NULL")
    .bind(unitId)
    .first<{ id: number }>();
  return row!.id;
}

// ---------------------------------------------------------------------------
// Issue #50 — borne basse serveur
// ---------------------------------------------------------------------------

describe("issue #50 — un tarif à 0 € n'est jamais publiable", () => {
  it("le PATCH d'une règle tarifaire refuse 0 € avec un message explicite", async () => {
    const id = await baseRuleId(SCIERIE);
    const res = await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekCents: 0 });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("strictement positif");

    // et rien n'a bougé en base : le trou se ferme AVANT l'écriture
    const row = await t.db.prepare("SELECT price_week_cents FROM rate_rules WHERE id = ?1").bind(id).first<{ price_week_cents: number }>();
    expect(row?.price_week_cents).toBe(12000);
  });

  it("le PATCH refuse aussi un champ vidé (chaîne vide) et une valeur négative", async () => {
    const id = await baseRuleId(SCIERIE);
    expect((await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekCents: "" })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekCents: -5000 })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekendCents: 0 })).status).toBe(400);
  });

  it("le PATCH accepte une valeur normale (la borne ne bloque pas le travail)", async () => {
    const id = await baseRuleId(SCIERIE);
    const res = await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekCents: 13000 });
    expect(res.status).toBe(200);
    const row = await t.db.prepare("SELECT price_week_cents FROM rate_rules WHERE id = ?1").bind(id).first<{ price_week_cents: number }>();
    expect(row?.price_week_cents).toBe(13000);
    await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekCents: 12000 }); // remise en état
  });

  it("le POST d'une règle refuse 0 € (la règle existante n'a pas changé)", async () => {
    const res = await call("POST", "/api/admin/rate-rules", { unitId: SCIERIE, seasonId: 2, priceWeekCents: 0 });
    expect(res.status).toBe(400);
  });

  it("une surcharge de jour à 0 € est refusée elle aussi", async () => {
    const res = await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(2), priceCents: 0,
    });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("strictement positif");
    const { results } = await t.db.prepare("SELECT * FROM rate_overrides").all();
    expect(results).toHaveLength(0);
  });

  it("un prix nul en base ne part pas vers le connecteur externe", async () => {
    // Règle héritée du temps où le POST tolérait 0 : elle contourne l'API.
    // TOUTES les règles de l'unité passent à 0, pas seulement la règle de
    // base : la fenêtre « J+300 » tombe tôt ou tard dans une saison du seed
    // (le 09/10/2026, J+300 = août 2027, haute saison), dont la règle propre
    // donnerait un prix et ferait échouer le test selon le jour où il tourne.
    const restore = await zeroUnitRules(t.db, 1);
    try {
      const from = addDays(todayInZone(), 300);
      const rooms = await buildCalendarPush(t.db, 1, from, 3);
      const scieur = rooms.find((r) => r.unitName.includes("Scieur"));
      expect(scieur).toBeDefined();
      for (const span of scieur!.calendar) expect(span.price1).toBeUndefined();
    } finally {
      await restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #31 — plancher et plafond par hébergement
// ---------------------------------------------------------------------------

describe("issue #31 — garde-fous de prix par hébergement", () => {
  it("pose un plancher et un plafond, puis refuse les prix hors bornes", async () => {
    expect((await call("PATCH", `/api/admin/units/${SCIERIE}`, { priceMinCents: 8000, priceMaxCents: 40000 })).status).toBe(200);

    const sousPlancher = await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 5000,
    });
    expect(sousPlancher.status).toBe(400);
    expect(String(sousPlancher.data.error)).toContain("plancher");

    const surPlafond = await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 90000,
    });
    expect(surPlafond.status).toBe(400);
    expect(String(surPlafond.data.error)).toContain("plafond");

    // dans les bornes : accepté
    expect((await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 24000,
    })).status).toBe(200);
  });

  it("les bornes s'appliquent aussi aux règles de saison, pas seulement aux surcharges", async () => {
    await call("PATCH", `/api/admin/units/${SCIERIE}`, { priceMinCents: 10000, priceMaxCents: 30000 });
    const id = await baseRuleId(SCIERIE);
    const res = await call("PATCH", `/api/admin/rate-rules/${id}`, { priceWeekCents: 95000 });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("plafond");
  });

  it("un plancher supérieur au plafond est refusé", async () => {
    const res = await call("PATCH", `/api/admin/units/${SCIERIE}`, { priceMinCents: 50000, priceMaxCents: 10000 });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("plafond");
  });

  it("les bornes se retirent en les passant à null", async () => {
    await call("PATCH", `/api/admin/units/${SCIERIE}`, { priceMinCents: 10000, priceMaxCents: 30000 });
    await call("PATCH", `/api/admin/units/${SCIERIE}`, { priceMinCents: null, priceMaxCents: null });
    const { data } = await call("GET", `/api/admin/rate-calendar?unit=${SCIERIE}&from=${dj(0)}&to=${dj(1)}`);
    expect((data.unit as Record<string, unknown>).priceMinCents).toBeNull();
    // et un prix qui était hors bornes repasse
    expect((await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 90000,
    })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Issue #23 — surcharges par jour
// ---------------------------------------------------------------------------

describe("issue #23 — poser et retirer des surcharges sur une plage", () => {
  it("pose un prix sur une plage et le calendrier renvoie valeur ET provenance", async () => {
    const res = await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(2), priceCents: 24000, minNights: 3,
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ days: 3, written: 3, cleared: 0 });

    const days = await calendarDays(SCIERIE, dj(0), dj(4));
    expect(days.get(dj(0))).toMatchObject({
      priceCents: 24000,
      source: "override",
      minNights: 3,
      minNightsSource: "override",
      fallbackPriceCents: 12000, // le lundi vaut 120 € sans la surcharge
      overridePriceCents: 24000,
      overrideMinNights: 3,
    });
    expect(days.get(dj(2))?.source).toBe("override");
    // hors plage : rien n'a bougé
    expect(days.get(dj(3))).toMatchObject({ priceCents: 12000, source: "base", overridePriceCents: null });
  });

  it("filtre par jours de semaine : « je sélectionne trois week-ends et je pose 240 € »", async () => {
    // 3 semaines à partir du lundi 01/03/2027 : vendredis et samedis seulement.
    const res = await call("PATCH", "/api/admin/rate-overrides", {
      unitId: SCIERIE, from: dj(0), to: dj(20), weekdays: [5, 6], priceCents: 24000,
    });
    expect(res.status).toBe(200);
    expect(res.data.days).toBe(6); // 3 vendredis + 3 samedis

    const days = await calendarDays(SCIERIE, dj(0), dj(21));
    expect(days.get(dj(4))?.source).toBe("override"); // vendredi 05/03
    expect(days.get(dj(5))?.source).toBe("override"); // samedi 06/03
    expect(days.get(dj(6))?.source).toBe("base");     // dimanche 07/03 : intact
    expect(days.get(dj(3))?.source).toBe("base");     // jeudi 04/03 : intact
  });

  it("retirer le prix fait revenir la saison, sans laisser de 0 fantôme", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(2), priceCents: 24000 });
    const res = await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(2), priceCents: null });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ written: 0, cleared: 3 });

    const days = await calendarDays(SCIERIE, dj(0), dj(3));
    expect(days.get(dj(0))).toMatchObject({ priceCents: 12000, source: "base" });
    // aucune ligne résiduelle, et surtout aucune ligne à 0
    const { results } = await t.db.prepare("SELECT * FROM rate_overrides").all();
    expect(results).toHaveLength(0);
  });

  it("le DELETE de plage nettoie et sert de bouton « Annuler »", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(9), priceCents: 24000 });
    const res = await call("DELETE", `/api/admin/rate-overrides?unit=${SCIERIE}&from=${dj(0)}&to=${dj(9)}`);
    expect(res.status).toBe(200);
    expect(res.data.removed).toBe(10);
    const days = await calendarDays(SCIERIE, dj(0), dj(3));
    expect(days.get(dj(0))?.source).toBe("base");
  });

  it("retirer le prix garde la ligne quand un minimum de nuits y reste posé", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 24000, minNights: 4 });
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: null });

    const days = await calendarDays(SCIERIE, dj(0), dj(1));
    expect(days.get(dj(0))).toMatchObject({
      priceCents: 12000,          // le prix revient au tarif de base
      source: "base",
      minNights: 4,               // le minimum de nuits, lui, reste posé
      minNightsSource: "override",
    });
  });

  it("un champ absent ne touche pas à l'autre", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 24000 });
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(0), minNights: 5 });
    const days = await calendarDays(SCIERIE, dj(0), dj(1));
    expect(days.get(dj(0))).toMatchObject({ priceCents: 24000, minNights: 5 });
  });

  it("la lecture brute des surcharges d'une plage ne renvoie que ce qui est posé à la main", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(1), to: dj(2), priceCents: 24000 });
    const { status, data } = await call("GET", `/api/admin/rate-overrides?unit=${SCIERIE}&from=${dj(0)}&to=${dj(5)}`);
    expect(status).toBe(200);
    expect(data.overrides).toEqual([
      { unitId: SCIERIE, date: dj(1), priceCents: 24000, minNights: null },
      { unitId: SCIERIE, date: dj(2), priceCents: 24000, minNights: null },
    ]);
  });

  it("un bien composite en mode somme refuse la surcharge, avec la sortie à proposer", async () => {
    const res = await call("PATCH", "/api/admin/rate-overrides", {
      unitId: DOMAINE, from: dj(0), to: dj(0), priceCents: 40000,
    });
    expect(res.status).toBe(409);
    expect(String(res.data.error)).toContain("tarif propre");

    // et son calendrier se déclare non éditable
    const { data } = await call("GET", `/api/admin/rate-calendar?unit=${DOMAINE}&from=${dj(0)}&to=${dj(1)}`);
    expect((data.unit as Record<string, unknown>).editable).toBe(false);
  });

  it("refuse les plages incohérentes ou démesurées", async () => {
    expect((await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(5), to: dj(0), priceCents: 24000 })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: "pas-une-date", to: dj(0), priceCents: 24000 })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(400), priceCents: 24000 })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(2) })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(2), minNights: 0 })).status).toBe(400);
  });

  it("le devis admin facture la surcharge, pas le tarif de saison", async () => {
    const sans = await call("POST", "/api/admin/quote", {
      unitId: SCIERIE, checkin: dj(0), checkout: dj(3), adults: 2, children: 0,
    });
    const avant = ((sans.data.quote as Record<string, unknown>).accommodationCents ?? 0) as number;
    expect(avant).toBe(36000); // 3 nuits de semaine à 120 €

    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(1), to: dj(1), priceCents: 24000 });
    const avec = await call("POST", "/api/admin/quote", {
      unitId: SCIERIE, checkin: dj(0), checkout: dj(3), adults: 2, children: 0,
    });
    // 120 + 240 + 120 = 480 €
    expect((avec.data.quote as Record<string, unknown>).accommodationCents).toBe(48000);
  });

  it("une surcharge remonte dans le prix poussé vers le connecteur externe", async () => {
    const from = addDays(todayInZone(), 250);
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from, to: from, priceCents: 31900 });
    const rooms = await buildCalendarPush(t.db, 1, from, 3);
    const scierie = rooms.find((r) => r.unitName.includes("Scierie"));
    expect(scierie).toBeDefined();
    const jour = scierie!.calendar.find((s) => s.from <= from && from <= s.to);
    expect(jour?.price1).toBe(319); // en euros, surcharge comprise
  });
});

// ---------------------------------------------------------------------------
// Vue multi-biens (spec UX § 9)
// ---------------------------------------------------------------------------

describe("calendrier tarifaire multi-biens", () => {
  it("renvoie tous les biens d'un domaine en une requête", async () => {
    const { status, data } = await call("GET", `/api/admin/rate-calendar?property=1&from=${dj(0)}&to=${dj(3)}`);
    expect(status).toBe(200);
    const units = data.units as { unit: { id: number; editable: boolean }; days: CalendarDay[] }[];
    expect(units.map((u) => u.unit.id).sort()).toEqual([1, 2, 3]);
    expect(units.every((u) => u.days.length === 3)).toBe(true);
    expect(units.find((u) => u.unit.id === DOMAINE)?.unit.editable).toBe(false);
  });

  it("accepte une liste d'unités et y reflète les surcharges", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(0), priceCents: 24000 });
    const { data } = await call("GET", `/api/admin/rate-calendar?units=${SCIERIE},1&from=${dj(0)}&to=${dj(2)}`);
    const units = data.units as { unit: { id: number }; days: CalendarDay[] }[];
    expect(units.map((u) => u.unit.id).sort()).toEqual([1, 2]);
    const scierie = units.find((u) => u.unit.id === SCIERIE)!;
    expect(scierie.days[0]).toMatchObject({ priceCents: 24000, source: "override" });
    // le Domaine, en somme, voit la surcharge de sa composante
    const { data: dom } = await call("GET", `/api/admin/rate-calendar?unit=${DOMAINE}&from=${dj(0)}&to=${dj(1)}`);
    expect((dom.days as CalendarDay[])[0]).toMatchObject({ priceCents: 24000 + 18000, source: "override" });
  });
});

// ---------------------------------------------------------------------------
// Prix conseillé par plateforme (issue #31)
// ---------------------------------------------------------------------------

describe("prix conseillé par plateforme", () => {
  it("expose des majorations par défaut et la formule employée", async () => {
    const { status, data } = await call("GET", "/api/admin/channel-markups");
    expect(status).toBe(200);
    const channels = data.channels as { channel: string; markupPct: number }[];
    expect(channels.map((c) => c.channel)).toContain("airbnb");
    expect(String(data.formula)).toContain("prix direct");
  });

  it("calcule le prix conseillé d'un prix isolé, sans magie", async () => {
    await call("PUT", "/api/admin/channel-markups", {
      channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 18 }],
    });
    const { data } = await call("GET", "/api/admin/suggested-prices?priceCents=16000");
    // 160 € × 1,18 = 188,80 €
    expect((data.channels as { suggestedCents: number }[])[0]?.suggestedCents).toBe(18880);
  });

  it("calcule jour par jour sur une plage, surcharges comprises", async () => {
    await call("PUT", "/api/admin/channel-markups", {
      channels: [{ channel: "booking", label: "Booking.com", markupPct: 15 }],
    });
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(1), to: dj(1), priceCents: 20000 });
    const { data } = await call("GET", `/api/admin/suggested-prices?unit=${SCIERIE}&from=${dj(0)}&to=${dj(1)}`);
    const days = data.days as { date: string; directCents: number; channels: { suggestedCents: number }[] }[];
    expect(days[0]).toMatchObject({ directCents: 12000 });      // 120 € → 138 €
    expect(days[0]?.channels[0]?.suggestedCents).toBe(13800);
    expect(days[1]).toMatchObject({ directCents: 20000 });      // surcharge 200 € → 230 €
    expect(days[1]?.channels[0]?.suggestedCents).toBe(23000);
  });

  it("refuse une majoration aberrante plutôt que de la stocker", async () => {
    expect((await call("PUT", "/api/admin/channel-markups", {
      channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 400 }],
    })).status).toBe(400);
    expect((await call("PUT", "/api/admin/channel-markups", { channels: "airbnb" })).status).toBe(400);
    // la configuration précédente n'a pas été écrasée
    const { data } = await call("GET", "/api/admin/channel-markups");
    expect((data.channels as { markupPct: number }[]).every((c) => c.markupPct <= 100)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Trace d'auteur (#54)
// ---------------------------------------------------------------------------
//
// `audit_log.actor` dit par quel CANAL l'écriture est passée ('admin', 'cron',
// 'stripe') — c'est une valeur fermée, pas une identité. L'auteur réel voyage
// donc dans `detail.par`, mécanisme déjà posé pour les comptes du back-office
// et lu par la fiche réservation (`historyWho`). À trois gestionnaires sur la
// même grille, « qui a changé ce prix ? » doit avoir une réponse.
describe("trace d'auteur sur les écritures de tarifs (#54)", () => {
  /** Dernière entrée du journal pour une action donnée. */
  async function lastAudit(action: string): Promise<{ actor: string; par?: string }> {
    const row = await t.db
      .prepare("SELECT actor, detail FROM audit_log WHERE action = ?1 ORDER BY id DESC LIMIT 1")
      .bind(action)
      .first<{ actor: string; detail: string | null }>();
    if (!row) throw new Error(`aucune entrée d'audit pour ${action}`);
    return { actor: row.actor, par: row.detail ? (JSON.parse(row.detail) as { par?: string }).par : undefined };
  }

  it("une surcharge de prix porte le nom de qui l'a posée", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(2), priceCents: 24000 });
    const entry = await lastAudit("rate.override");
    expect(entry.par).toBe(ADMIN_USER);
    // Le canal reste 'admin' : on ajoute une information, on n'en détourne pas une.
    expect(entry.actor).toBe("admin");
  });

  it("le retrait d'une surcharge aussi — c'est le geste qu'on cherche à expliquer six mois plus tard", async () => {
    await call("PATCH", "/api/admin/rate-overrides", { unitId: SCIERIE, from: dj(0), to: dj(2), priceCents: 24000 });
    await call("DELETE", `/api/admin/rate-overrides?unit=${SCIERIE}&from=${dj(0)}&to=${dj(2)}`);
    expect((await lastAudit("rate.override_clear")).par).toBe(ADMIN_USER);
  });

  it("une règle tarifaire modifiée garde son auteur ET les valeurs modifiées", async () => {
    const { data } = await call("GET", "/api/admin/rate-rules?property=1");
    const ruleId = (data.rules as { id: number }[])[0]?.id;
    expect(ruleId).toBeGreaterThan(0);
    expect((await call("PATCH", `/api/admin/rate-rules/${ruleId}`, { priceWeekCents: 13000 })).status).toBe(200);
    const row = await t.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'rate.update' ORDER BY id DESC LIMIT 1")
      .first<{ detail: string }>();
    const detail = JSON.parse(row?.detail ?? "{}") as { par?: string; priceWeekCents?: number };
    expect(detail.par).toBe(ADMIN_USER);
    expect(detail.priceWeekCents).toBe(13000); // l'ajout de `par` n'écrase pas le corps
  });

  it("une majoration de canal est tracée elle aussi", async () => {
    await call("PUT", "/api/admin/channel-markups", {
      channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 12 }],
    });
    expect((await lastAudit("pricing.channel_markups")).par).toBe(ADMIN_USER);
  });

  it("un corps de requête ne peut PAS usurper l'auteur — `par` est écrit en dernier", async () => {
    // Sans cette précaution, un `{ "par": "..." }` glissé dans la charge utile
    // écrasait l'identité posée par la garde : le journal d'audit devenait
    // déclaratif, donc sans valeur de preuve.
    const { data } = await call("GET", "/api/admin/rate-rules?property=1");
    const ruleId = (data.rules as { id: number }[])[0]?.id;
    await call("PATCH", `/api/admin/rate-rules/${ruleId}`, { priceWeekCents: 13500, par: "quelqu-un-d-autre" });
    expect((await lastAudit("rate.update")).par).toBe(ADMIN_USER);
  });

  it("une saison créée porte aussi son auteur — le calendrier tarifaire entier est tracé", async () => {
    expect(
      (await call("POST", "/api/admin/seasons?property=1", {
        name: "Test trace", dateStart: "2027-05-01", dateEnd: "2027-05-15",
      })).status,
    ).toBe(201);
    expect((await lastAudit("season.create")).par).toBe(ADMIN_USER);
  });

  it("un jeton de secours sans identifiant retombe sur « admin » — pas de faux nom dans le journal", async () => {
    const anonyme: Env = { ...env, ADMIN_TOKEN: "jeton-nu-historique" };
    const req = new Request("http://test.local/api/admin/rate-overrides", {
      method: "PATCH",
      headers: { authorization: "Bearer jeton-nu-historique", "content-type": "application/json" },
      body: JSON.stringify({ unitId: SCIERIE, from: dj(4), to: dj(4), priceCents: 24000 }),
    });
    const res = await router.handle(req, anonyme);
    expect(res?.status).toBe(200);
    expect((await lastAudit("rate.override")).par).toBe("admin");
  });
});
