// Issue #35 — remises visibles et disponibilité factuelle.
//
// Le vrai risque de cette issue n'est pas technique, il est réglementaire :
// une remise annoncée que le devis n'applique pas, ou un chiffre de rareté que
// le calendrier contredit, sont des pratiques commerciales trompeuses. Les
// tests ci-dessous portent donc autant sur la VÉRACITÉ que sur le rendu :
//  · la remise affichée correspond à celle que calcule réellement computeQuote ;
//  · le compte de week-ends libres correspond aux réservations réelles ;
//  · aucune formulation d'urgence n'entre dans les textes produits.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, dayOfWeek, todayInZone } from "../src/core/dates";
import { computeQuote, type Promotion } from "../src/core/pricing";
import {
  NON_CUMUL_NOTE,
  publicPromotions,
  twoMonthWindowEnd,
  weekendAvailability,
  weekendFridays,
} from "../src/services/offers";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: 1,
  kind: "long_stay",
  code: null,
  label: "Long séjour ≥ 7 nuits",
  discountPct: 10,
  discountCents: null,
  threshold: 7,
  validFrom: null,
  validUntil: null,
  maxUses: null,
  uses: 0,
  active: true,
  ...over,
});

describe("remises annoncées", () => {
  const today = "2026-08-10";

  it("formule chaque type de remise en une phrase autonome", () => {
    const out = publicPromotions(
      [
        promo({ id: 1, kind: "long_stay", threshold: 7, discountPct: 10 }),
        promo({ id: 2, kind: "early_bird", threshold: 90, discountPct: 5 }),
        promo({ id: 3, kind: "last_minute", threshold: 7, discountPct: 10 }),
      ],
      today,
    );
    expect(out.map((p) => p.label)).toEqual([
      "À partir de 7 nuits : -10 %",
      "En réservant au moins 90 jours à l'avance : -5 %",
      "Pour une arrivée dans les 7 jours : -10 %",
    ]);
  });

  it("annonce aussi les remises en euros", () => {
    const [only] = publicPromotions([promo({ discountPct: null, discountCents: 4500 })], today);
    expect(only?.label).toBe("À partir de 7 nuits : -45,00 €");
  });

  it("n'expose JAMAIS les codes promo (ils sont privés)", () => {
    const out = publicPromotions([promo({ kind: "code", code: "AUTOMNE", threshold: null })], today);
    expect(out).toEqual([]);
  });

  it("écarte les remises inactives, hors fenêtre de validité ou à zéro", () => {
    expect(publicPromotions([promo({ active: false })], today)).toEqual([]);
    expect(publicPromotions([promo({ validFrom: "2026-09-01" })], today)).toEqual([]);
    expect(publicPromotions([promo({ validUntil: "2026-08-09" })], today)).toEqual([]);
    expect(publicPromotions([promo({ discountPct: 0, discountCents: null })], today)).toEqual([]);
  });

  it("l'affichage correspond EXACTEMENT à ce que le devis applique", () => {
    // Le point critique de l'issue : si le libellé promet une remise que le
    // moteur n'accorde pas, on annonce un prix qu'on ne pratique pas.
    const p = promo({ kind: "long_stay", threshold: 7, discountPct: 10 });
    const [shown] = publicPromotions([p], today);
    expect(shown).toBeDefined();

    const base = {
      unit: { id: 1, name: "Test", compositePricing: "own" as const, cleaningFeeCents: 0, components: [] },
      adults: 2,
      children: 0,
      today,
      seasons: [],
      rateRules: [
        { id: 1, unitId: 1, seasonId: null, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 1, checkinDays: null },
      ],
      promotions: [p],
      optionsSelected: [],
      settings: {
        depositPct: 30, balanceDueDays: 30,
        touristTaxCentsPerPersonNight: 0, touristTaxIncludeChildren: false, cautionCents: 0,
      },
    };
    // au seuil annoncé (7 nuits) : la remise tombe, avec le libellé du devis
    const atThreshold = computeQuote({ ...base, checkin: "2026-09-01", checkout: "2026-09-08" });
    expect(atThreshold.autoDiscountApplied).toBe(shown!.quoteLabel);
    expect(atThreshold.discountCents).toBe(7000); // 10 % de 7 × 100 €
    // juste en dessous : aucune remise — l'annonce ne promettait rien d'autre
    const below = computeQuote({ ...base, checkin: "2026-09-01", checkout: "2026-09-07" });
    expect(below.autoDiscountApplied).toBeNull();
    expect(below.discountCents).toBe(0);
  });

  it("les remises automatiques ignorent maxUses, comme le moteur", () => {
    // Le moteur ne contrôle maxUses que sur les codes promo. Afficher moins
    // que ce que le devis accorde serait aussi faux qu'afficher plus.
    const out = publicPromotions([promo({ maxUses: 1, uses: 99 })], today);
    expect(out).toHaveLength(1);
  });
});

describe("disponibilité factuelle", () => {
  const today = "2026-08-10"; // un lundi
  const links: never[] = [];
  const now = "2026-08-10 09:00:00";
  const facts = (bookings: Parameters<typeof weekendAvailability>[0]["bookings"]) =>
    weekendAvailability({ today, unitIds: [1, 2], links, bookings, now, horizonDays: 200 });

  it("un week-end = les nuits de vendredi et samedi", () => {
    const fridays = weekendFridays("2026-08-10", "2026-09-01");
    expect(fridays).toEqual(["2026-08-14", "2026-08-21", "2026-08-28"]);
    for (const f of fridays) expect(dayOfWeek(f)).toBe(5);
  });

  it("la fenêtre couvre le mois en cours et le suivant", () => {
    expect(twoMonthWindowEnd("2026-08-10")).toBe("2026-10-01");
    expect(twoMonthWindowEnd("2026-11-05")).toBe("2027-01-01"); // passage d'année
    expect(twoMonthWindowEnd("2026-12-31")).toBe("2027-02-01");
  });

  it("compte les week-ends réellement libres, avec leur dénominateur", () => {
    const all = facts([]);
    // 14, 21, 28 août puis 4, 11, 18, 25 septembre
    expect(all.weekendsTotal).toBe(7);
    expect(all.weekendsFree).toBe(7);
    expect(all.sentence).toBe("Les 7 week-ends d'août et septembre sont encore libres.");

    // deux week-ends pris sur les deux unités : le compte doit baisser d'autant
    const busy = facts([
      { unitId: 1, checkin: "2026-08-14", checkout: "2026-08-16", status: "confirmed" },
      { unitId: 2, checkin: "2026-08-14", checkout: "2026-08-16", status: "confirmed" },
      { unitId: 1, checkin: "2026-09-04", checkout: "2026-09-06", status: "confirmed" },
      { unitId: 2, checkin: "2026-09-04", checkout: "2026-09-06", status: "confirmed" },
    ]);
    expect(busy.weekendsFree).toBe(5);
    expect(busy.sentence).toBe("5 week-ends encore libres sur les 7 d'août et septembre.");
  });

  it("un week-end reste libre tant qu'UN hébergement l'est", () => {
    const partial = facts([{ unitId: 1, checkin: "2026-08-14", checkout: "2026-08-16", status: "confirmed" }]);
    expect(partial.weekendsFree).toBe(7);
  });

  it("les options de paiement en cours comptent comme occupées", () => {
    // C'est ce que montre le calendrier public au même instant : la phrase ne
    // doit pas prétendre libre ce que le visiteur voit complet.
    const held = facts([
      { unitId: 1, checkin: "2026-08-14", checkout: "2026-08-16", status: "pending", holdExpiresAt: "2026-08-10 09:30:00" },
      { unitId: 2, checkin: "2026-08-14", checkout: "2026-08-16", status: "pending", holdExpiresAt: "2026-08-10 09:30:00" },
    ]);
    expect(held.weekendsFree).toBe(6);
    // une option déjà expirée ne bloque plus rien
    const expired = facts([
      { unitId: 1, checkin: "2026-08-14", checkout: "2026-08-16", status: "pending", holdExpiresAt: "2026-08-10 08:00:00" },
      { unitId: 2, checkin: "2026-08-14", checkout: "2026-08-16", status: "pending", holdExpiresAt: "2026-08-10 08:00:00" },
    ]);
    expect(expired.weekendsFree).toBe(7);
  });

  it("tout complet : le prochain week-end libre est annoncé, pas inventé", () => {
    const bookings = weekendFridays("2026-08-10", "2026-10-01").flatMap((f) => [
      { unitId: 1, checkin: f, checkout: addDays(f, 2), status: "confirmed" as const },
      { unitId: 2, checkin: f, checkout: addDays(f, 2), status: "confirmed" as const },
    ]);
    const full = facts(bookings);
    expect(full.weekendsFree).toBe(0);
    expect(full.nextFreeWeekend).toBe("2026-10-02");
    expect(full.sentence).toBe(
      "Aucun week-end libre en août et septembre. Prochain week-end disponible : à partir du vendredi 2 octobre.",
    );
  });

  it("aucune formulation d'urgence ou de rareté fabriquée", () => {
    // Exigence explicite du propriétaire (et pratiques commerciales) : pas de
    // « plus que », pas de « dépêchez-vous », pas de « dernières places ».
    const interdits = /plus que|dépêch|vite|dernier|dernière|urgent|il ne reste|hâtez|profitez|attention/i;
    const cas = [
      facts([]),
      facts([{ unitId: 1, checkin: "2026-08-14", checkout: "2026-08-16", status: "confirmed" }]),
      facts([
        { unitId: 1, checkin: "2026-08-14", checkout: "2026-08-16", status: "confirmed" },
        { unitId: 2, checkin: "2026-08-14", checkout: "2026-08-16", status: "confirmed" },
      ]),
    ];
    for (const c of cas) expect(c.sentence).not.toMatch(interdits);
  });
});

describe("route publique /api/public/offers", () => {
  let t: TestDb;
  let db: D1Database;
  let env: Env;
  const router = new Router();
  registerPublicRoutes(router);

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
    await db.prepare("DELETE FROM bookings").run();
  });

  const get = async (path: string) => {
    const res = await router.handle(new Request(`http://test.local${path}`), env);
    return { status: res!.status, data: (await res!.json()) as Record<string, unknown> };
  };

  it("expose les remises du seed et une phrase de disponibilité", async () => {
    const { status, data } = await get("/api/public/offers?property=pre-more");
    expect(status).toBe(200);
    const promos = data.promotions as { kind: string; label: string }[];
    expect(promos.map((p) => p.kind).sort()).toEqual(["early_bird", "last_minute", "long_stay"]);
    // le seed en a trois : la mention de non-cumul est due
    expect(data.nonCumulNote).toBe(NON_CUMUL_NOTE);
    const avail = data.availability as { sentence: string; weekendsTotal: number };
    expect(avail.sentence.length).toBeGreaterThan(0);
    expect(avail.weekendsTotal).toBeGreaterThan(0);
  });

  it("recalcule à chaque appel : une réservation fait baisser le compte", async () => {
    const before = ((await get("/api/public/offers?property=pre-more")).data.availability as { weekendsFree: number })
      .weekendsFree;
    // on occupe le premier vendredi de la fenêtre sur les DEUX maisons
    const today = todayInZone();
    let friday = today;
    while (dayOfWeek(friday) !== 5) friday = addDays(friday, 1);
    for (const unitId of [1, 2]) {
      await db
        .prepare(
          "INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, source, reference, total_cents, deposit_cents) VALUES (?1, ?2, ?3, 2, 0, 'confirmed', 'direct', ?4, 0, 0)",
        )
        .bind(unitId, friday, addDays(friday, 2), `TST-${unitId}`)
        .run();
    }
    const after = ((await get("/api/public/offers?property=pre-more")).data.availability as { weekendsFree: number })
      .weekendsFree;
    expect(after).toBe(before - 1);
  });

  it("404 sur un domaine inconnu", async () => {
    expect((await get("/api/public/offers?property=inexistant")).status).toBe(404);
  });
});

describe("tunnel : prix barré honnête", () => {
  const JS = read("public/book/book.js");
  const HTML = read("public/book/index.html");
  const CSS = read("public/book/book.css");

  it("l'encart des offres existe et n'est révélé qu'une fois rempli", () => {
    expect(/<section id="offersCard"[^>]*hidden/.test(HTML)).toBe(true);
    expect(JS).toMatch(/renderOffers/);
  });

  it("le prix barré vaut total + remise, et n'apparaît que si une remise s'applique", () => {
    expect(JS).toMatch(/function strikeThrough\(totalCents, discountCents\)/);
    expect(JS).toMatch(/if \(!\(discountCents > 0\)\) return ""/);
    expect(JS).toMatch(/eur\(totalCents \+ discountCents\)/);
    expect(CSS).toMatch(/\.was\{text-decoration:line-through/);
  });

  it("le prix barré est branché sur les résultats ET sur le total du devis", () => {
    expect(JS).toMatch(/strikeThrough\(u\.quote\.totalCents, u\.quote\.discountCents\)/);
    expect(JS).toMatch(/strikeThrough\(quote\.totalCents, quote\.discountCents\)/);
  });
});
