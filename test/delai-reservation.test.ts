// Demandes des testeurs du 17/10/2026 (migration 0037).
//
//  n° 15 : délai minimum de réservation par domaine (`min_lead_days`). Le site
//  public le fait respecter CÔTÉ SERVEUR (devis, recherche, calendrier,
//  création) ; le back-office passe outre avec un avertissement. À 0, rien ne
//  change, au caractère près.
//  n° 15 bis : une remise « séjour long » dès 5 nuits sur le site direct.
//  n° 9 : trois modèles de réponse FR et NL, migration rejouable.
//
// Les règles tarifaires du seed (minimum de nuits, jours d'arrivée) sont
// neutralisées pour ce fichier : sinon un séjour à J+2 serait refusé pour une
// autre raison selon la saison où tombe le jour d'exécution.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { computeQuote, firstBookableDate, normalizeLeadDays } from "../src/core/pricing";
import { localizePublicResponse } from "../src/core/public-i18n";
import { weekendAvailability } from "../src/services/offers";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const TODAY = todayInZone();

let t: TestDb;
let db: D1Database;
let env: Env;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(
    new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
  );
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

const setLead = async (days: number) => {
  const r = await call("PUT", "/api/admin/settings?property=1", { settings: { min_lead_days: days } });
  expect(r.status).toBe(200);
};

const stay = (inDays: number, nights = 2) => ({
  unitId: 1,
  checkin: addDays(TODAY, inDays),
  checkout: addDays(TODAY, inDays + nights),
  adults: 2,
  children: 0,
});

const GUEST = { firstName: "Alice", lastName: "Martin", email: "alice.martin@example.com", phone: "+32 470 00 00 01" };

type Q = { ok: boolean; errors: string[]; warnings: string[]; minLeadDays?: number };

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
  await db.prepare("UPDATE rate_rules SET min_nights = 1, checkin_days = NULL").run();
  await db.prepare("DELETE FROM rate_overrides").run();
  // Les remises automatiques du seed ne doivent pas brouiller les montants.
  await db.prepare("UPDATE promotions SET active = 0").run();
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await setLead(0);
});

describe("délai minimum de réservation — fonctions pures", () => {
  it("normalise la valeur : entier de 0 à 365, le reste vaut 0", () => {
    expect(normalizeLeadDays(5)).toBe(5);
    expect(normalizeLeadDays("5")).toBe(5);
    expect(normalizeLeadDays("abc")).toBe(0);
    expect(normalizeLeadDays(-3)).toBe(0);
    expect(normalizeLeadDays(2.5)).toBe(0);
    expect(normalizeLeadDays(400)).toBe(0);
    expect(firstBookableDate("2026-10-17", 5)).toBe("2026-10-22");
  });

  it("borne : J+5 passe, J+4 est refusé avec un délai de 5 jours", () => {
    const base = {
      unit: { id: 1, name: "A", compositePricing: "own" as const, cleaningFeeCents: 0, components: [] },
      adults: 2,
      children: 0,
      today: "2026-10-17",
      seasons: [],
      rateRules: [{ id: 1, unitId: 1, seasonId: null, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 1, checkinDays: null }],
      promotions: [],
      optionsSelected: [],
      settings: { depositPct: 30, balanceDueDays: 30, touristTaxCentsPerPersonNight: 0, touristTaxIncludeChildren: true, cautionCents: 0, minLeadDays: 5 },
    };
    expect(computeQuote({ ...base, checkin: "2026-10-22", checkout: "2026-10-24" }).ok).toBe(true);
    const q = computeQuote({ ...base, checkin: "2026-10-21", checkout: "2026-10-23" });
    expect(q.ok).toBe(false);
    expect(q.errors).toEqual(["lead_time"]);
    expect(q.minLeadDays).toBe(5);
    // Back-office : avertissement, pas refus.
    const admin = computeQuote({ ...base, checkin: "2026-10-21", checkout: "2026-10-23", bypassLeadTime: true });
    expect(admin.ok).toBe(true);
    expect(admin.warnings).toContain("lead_time");
  });

  it("à 0, le devis est identique à l'octet près (aucun champ en plus)", () => {
    const base = {
      unit: { id: 1, name: "A", compositePricing: "own" as const, cleaningFeeCents: 0, components: [] },
      checkin: "2026-10-18",
      checkout: "2026-10-20",
      adults: 2,
      children: 0,
      today: "2026-10-17",
      seasons: [],
      rateRules: [{ id: 1, unitId: 1, seasonId: null, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 1, checkinDays: null }],
      promotions: [],
      optionsSelected: [],
      settings: { depositPct: 30, balanceDueDays: 30, touristTaxCentsPerPersonNight: 0, touristTaxIncludeChildren: true, cautionCents: 0 },
    };
    const sans = computeQuote(base);
    const zero = computeQuote({ ...base, settings: { ...base.settings, minLeadDays: 0 } });
    expect(JSON.stringify(zero)).toBe(JSON.stringify(sans));
    expect("minLeadDays" in zero).toBe(false);
  });

  it("un week-end trop proche n'est pas annoncé libre", () => {
    const facts = (bookableFrom?: string) =>
      weekendAvailability({ today: "2026-10-12", unitIds: [1], links: [], bookings: [], now: "2026-10-12 10:00:00", bookableFrom });
    // Lundi 12/10 : premier vendredi le 16/10. Avec 5 jours de délai, l'arrivée
    // la plus proche est le 17/10 → le week-end du 16/10 n'est plus libre.
    expect(facts().nextFreeWeekend).toBe("2026-10-16");
    expect(facts("2026-10-17").nextFreeWeekend).toBe("2026-10-23");
    // Le week-end exclu sort aussi du dénominateur : il n'est pas « pris ».
    expect(facts("2026-10-17").weekendsTotal).toBe(facts().weekendsTotal - 1);
    expect(facts("2026-10-17").weekendsFree).toBe(facts("2026-10-17").weekendsTotal);
  });
});

describe("délai minimum de réservation — réglage du domaine", () => {
  it("se lit et s'écrit par Réglages, refuse une valeur absurde", async () => {
    await setLead(5);
    const r = await call("GET", "/api/admin/settings?property=1");
    expect((r.data.settings as { minLeadDays: number }).minLeadDays).toBe(5);
    for (const bad of [-1, 2.5, 366, "abc"]) {
      const res = await call("PUT", "/api/admin/settings?property=1", { settings: { min_lead_days: bad } });
      expect(res.status).toBe(400);
    }
    // Le domaine 2 n'est pas touché : réglage par domaine.
    const other = await call("GET", "/api/admin/settings?property=2");
    expect((other.data.settings as { minLeadDays: number }).minLeadDays).toBe(0);
  });
});

describe("délai minimum de réservation — site public (serveur)", () => {
  it("à 0 (valeur du déploiement) : une arrivée le lendemain reste possible", async () => {
    const r = await call("POST", "/api/public/quote", stay(1));
    expect(r.status).toBe(200);
    expect((r.data.quote as Q).ok).toBe(true);
  });

  it("devis : refusé en deçà du délai, accepté à la borne", async () => {
    await setLead(5);
    const tooSoon = await call("POST", "/api/public/quote", stay(4));
    const q = tooSoon.data.quote as Q;
    expect(q.ok).toBe(false);
    expect(q.errors).toContain("lead_time");
    expect(q.minLeadDays).toBe(5);
    const ok = await call("POST", "/api/public/quote", stay(5));
    expect((ok.data.quote as Q).ok).toBe(true);
  });

  it("création : 409 lead_time, aucune réservation ni client créés", async () => {
    await setLead(5);
    const r = await call("POST", "/api/public/bookings", { ...stay(2), guest: GUEST, cgvAccepted: true });
    expect(r.status).toBe(409);
    expect(r.data.code).toBe("lead_time");
    expect(r.data.minLeadDays).toBe(5);
    expect(String(r.data.error)).toContain("au plus tard 5 jours avant");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>();
    expect(n?.n).toBe(0);
    // Témoin : au-delà du délai, la même demande passe.
    const ok = await call("POST", "/api/public/bookings", { ...stay(6), guest: GUEST, cgvAccepted: true });
    expect(ok.status).toBe(201);
  });

  it("le message de refus existe en néerlandais", async () => {
    await setLead(5);
    const r = await call("POST", "/api/public/bookings", { ...stay(2), guest: GUEST, cgvAccepted: true });
    const req = new Request("http://test.local/api/public/bookings", { headers: { "x-gites-lang": "nl" } });
    const res = await localizePublicResponse(req, new Response(JSON.stringify(r.data), { status: 409, headers: { "content-type": "application/json" } }));
    const nl = (await res.json()) as { error: string };
    expect(nl.error).toBe("Online reserveren kan tot 5 dagen voor de aankomst. Neem contact met ons op: wij bekijken wat mogelijk is.");
  });

  it("un délai d'un jour se dit au singulier, en FR comme en NL", async () => {
    await setLead(1);
    const r = await call("POST", "/api/public/bookings", { ...stay(0), guest: GUEST, cgvAccepted: true });
    expect(r.status).toBe(409);
    expect(String(r.data.error)).toContain("au plus tard 1 jour avant");
    const req = new Request("http://test.local/api/public/bookings", { headers: { "x-gites-lang": "nl" } });
    const res = await localizePublicResponse(req, new Response(JSON.stringify(r.data), { status: 409, headers: { "content-type": "application/json" } }));
    expect(((await res.json()) as { error: string }).error).toContain("tot 1 dag voor");
  });

  it("recherche : l'hébergement sort non réservable, aucune suggestion trop proche", async () => {
    await setLead(5);
    const s = stay(1);
    const r = await call("GET", `/api/public/availability?property=pre-more&checkin=${s.checkin}&checkout=${s.checkout}&adults=2`);
    const u = (r.data.units as { unitId: number; quote: Q | null; suggestions: { checkin: string }[] }[]).find((x) => x.unitId === 1)!;
    expect(u.quote?.ok).toBe(false);
    expect(u.quote?.errors).toContain("lead_time");
    for (const sug of u.suggestions) expect(sug.checkin >= addDays(TODAY, 5)).toBe(true);
  });

  it("calendrier : les jours en deçà du délai ne sont pas réservables (ni « complet »)", async () => {
    await setLead(5);
    const r = await call("GET", `/api/public/calendar?property=pre-more&month=${TODAY.slice(0, 7)}`);
    expect(r.data.minLeadDays).toBe(5);
    expect(r.data.bookableFrom).toBe(addDays(TODAY, 5));
    const days = (r.data.units as { days: { date: string; past: boolean; available: boolean }[] }[])[0]!.days;
    for (const d of days) {
      if (d.date < addDays(TODAY, 5)) {
        expect(d.past).toBe(true);
        expect(d.available).toBe(false);
      }
    }
  });
});

describe("délai minimum de réservation — back-office", () => {
  it("devis admin : vendable, avec l'avertissement lead_time", async () => {
    await setLead(5);
    const r = await call("POST", "/api/admin/quote", stay(2));
    const q = r.data.quote as Q;
    expect(q.ok).toBe(true);
    expect(q.warnings).toContain("lead_time");
  });

  it("vente manuelle : créée malgré le délai, avertissement rendu et tracé", async () => {
    await setLead(5);
    const r = await call("POST", "/api/admin/bookings", { ...stay(2), guest: { lastName: "Martin", email: "alice.martin@example.com" } });
    expect(r.status).toBe(201);
    expect(r.data.warnings).toContain("lead_time");
    const a = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'booking.create_manual'")
      .first<{ detail: string }>();
    expect(JSON.parse(a!.detail)).toMatchObject({ leadTimeOverridden: true, minLeadDays: 5 });
  });
});

describe("délai minimum de réservation — modification d'une réservation", () => {
  it("déplacer une réservation vers une arrivée trop proche : permis, avertissement rendu et tracé", async () => {
    const created = await call("POST", "/api/admin/bookings", { ...stay(30), guest: { lastName: "Martin" } });
    expect(created.status).toBe(201);
    const id = (created.data.booking as { id: number }).id;
    await setLead(5);
    const s = stay(2);
    const r = await call("PATCH", `/api/admin/bookings/${id}`, { checkin: s.checkin, checkout: s.checkout });
    expect(r.status).toBe(200);
    expect((r.data.quote as Q).warnings).toContain("lead_time");
    const a = await db.prepare("SELECT detail FROM audit_log WHERE action = 'booking.modify'").first<{ detail: string }>();
    expect(JSON.parse(a!.detail)).toMatchObject({ leadTimeOverridden: true, minLeadDays: 5 });
  });
});

describe("remise séjour long dès 5 nuits (site direct)", () => {
  it("le seuil se règle à 5 nuits et s'applique à 5 nuits, pas à 4", async () => {
    const created = await call("POST", "/api/admin/promotions?property=1", {
      kind: "long_stay", label: "Séjour de 5 nuits", discountPct: 10, threshold: 5, active: true,
    });
    expect(created.status).toBe(201);
    const five = (await call("POST", "/api/public/quote", stay(40, 5))).data.quote as { ok: boolean; autoDiscountApplied: string | null };
    const four = (await call("POST", "/api/public/quote", stay(40, 4))).data.quote as { ok: boolean; autoDiscountApplied: string | null };
    expect(five.ok).toBe(true);
    expect(five.autoDiscountApplied).toBe("Séjour de 5 nuits");
    expect(four.autoDiscountApplied).toBeNull();
    await db.prepare("UPDATE promotions SET active = 0").run();
  });
});

describe("migration 0037 — rejouable, n'écrase rien", () => {
  const statements = () => {
    const path = fileURLToPath(new URL("../migrations/0037_delai_reservation_modeles.sql", import.meta.url));
    return readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const NOMS = ["Confirmation de réservation", "Bevestiging van de reservering", "Annulation", "Annulering", "Revenez nous voir", "Kom ons nog eens bezoeken"];

  it("pose les six modèles et le réglage à 0 pour chaque domaine", async () => {
    const { results } = await db.prepare("SELECT name, lang, body FROM message_templates").all<{ name: string; lang: string; body: string }>();
    for (const n of NOMS) expect(results.filter((r) => r.name === n)).toHaveLength(1);
    expect(results.find((r) => r.name === "Annulering")?.lang).toBe("nl");
    // Variables du format de la 0023 uniquement.
    const known = new Set(["prenom", "bien", "arrivee", "solde", "heure_arrivee", "heure_depart", "signature"]);
    for (const r of results.filter((x) => NOMS.includes(x.name))) {
      for (const m of r.body.matchAll(/\{([a-z_]+)\}/g)) expect(known.has(m[1]!)).toBe(true);
      expect(r.body).not.toMatch(/claude|anthropic/i);
    }
    const s = await db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'min_lead_days' AND value = '0'").first<{ n: number }>();
    const p = await db.prepare("SELECT COUNT(*) AS n FROM properties").first<{ n: number }>();
    expect(s?.n).toBe(p?.n);
  });

  it("rejouée : aucun doublon, un modèle retouché et un délai réglé restent intacts", async () => {
    await db.prepare("UPDATE message_templates SET body = 'Texte retouché par le propriétaire' WHERE name = 'Annulation'").run();
    await setLead(5);
    const before = await db.prepare("SELECT COUNT(*) AS n FROM message_templates").first<{ n: number }>();
    for (const st of statements()) await db.prepare(st).run();
    const after = await db.prepare("SELECT COUNT(*) AS n FROM message_templates").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const a = await db.prepare("SELECT body FROM message_templates WHERE name = 'Annulation'").first<{ body: string }>();
    expect(a?.body).toBe("Texte retouché par le propriétaire");
    const lead = await db.prepare("SELECT value FROM settings WHERE property_id = 1 AND key = 'min_lead_days'").first<{ value: string }>();
    expect(lead?.value).toBe("5");
  });
});

describe("jours d'arrivée (demande n° 10, préparation) — PATCH des règles", () => {
  it("[1,2,3,4,5] interdit samedi et dimanche, et un PATCH de prix seul ne l'efface pas", async () => {
    const rules = (await call("GET", "/api/admin/rate-rules?property=1")).data.rules as { id: number; unitId: number }[];
    const rule = rules.find((r) => r.unitId === 1)!;
    expect((await call("PATCH", `/api/admin/rate-rules/${rule.id}`, { checkinDays: [1, 2, 3, 4, 5] })).status).toBe(200);
    const row = await db.prepare("SELECT checkin_days FROM rate_rules WHERE id = ?1").bind(rule.id).first<{ checkin_days: string }>();
    expect(row?.checkin_days).toBe("1,2,3,4,5");
    // PATCH des seuls prix : les jours d'arrivée restent.
    expect((await call("PATCH", `/api/admin/rate-rules/${rule.id}`, { holidayPct: 0 })).status).toBe(200);
    const after = await db.prepare("SELECT checkin_days FROM rate_rules WHERE id = ?1").bind(rule.id).first<{ checkin_days: string | null }>();
    expect(after?.checkin_days).toBe("1,2,3,4,5");
    // null explicite : la contrainte est levée.
    await call("PATCH", `/api/admin/rate-rules/${rule.id}`, { checkinDays: null });
    const cleared = await db.prepare("SELECT checkin_days FROM rate_rules WHERE id = ?1").bind(rule.id).first<{ checkin_days: string | null }>();
    expect(cleared?.checkin_days).toBeNull();
  });
});
