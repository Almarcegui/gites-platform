// Minimum de nuits de dernière minute (décision du 23/10/2026) : 6 nuits en
// vacances, 3 nuits à 28 jours ou moins de l'arrivée, 2 nuits à 14 jours ou moins.
import { describe, expect, it } from "vitest";
import {
  computeQuote,
  rateCalendar,
  relaxedMinNights,
  type PricingSettings,
  type QuoteRequest,
  type RateRule,
  type Season,
  type UnitPricingInfo,
} from "../src/core/pricing";
import { formatMinNightsRelax, parseMinNightsRelax } from "../src/db/repo";

const ETE: Season[] = [{ id: 1, name: "Été 2027", dateStart: "2027-07-03", dateEnd: "2027-08-15", priority: 15 }];
const PALIERS = [{ days: 28, minNights: 3 }, { days: 14, minNights: 2 }];
const RULES: RateRule[] = [
  { id: 1, unitId: 2, seasonId: null, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 2, checkinDays: null },
  { id: 2, unitId: 2, seasonId: 1, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 6, checkinDays: null, minNightsRelax: PALIERS },
];
const SCIERIE: UnitPricingInfo = { id: 2, name: "La Scierie", compositePricing: "own", cleaningFeeCents: 0, components: [] };
const SETTINGS: PricingSettings = {
  depositPct: 30, balanceDueDays: 30, touristTaxCentsPerPersonNight: 0, touristTaxIncludeChildren: false, cautionCents: 0,
};

function devis(today: string, checkin: string, checkout: string, rules = RULES) {
  const req: QuoteRequest = {
    unit: SCIERIE, checkin, checkout, adults: 2, children: 0, today,
    seasons: ETE, rateRules: rules, promotions: [], optionsSelected: [], settings: SETTINGS,
  };
  return computeQuote(req);
}

describe("relaxedMinNights", () => {
  it("garde le minimum de la règle loin de l'arrivée, descend par paliers, jamais sous 1", () => {
    expect(relaxedMinNights(6, PALIERS, 29)).toBe(6);
    expect(relaxedMinNights(6, PALIERS, 28)).toBe(3);
    expect(relaxedMinNights(6, PALIERS, 15)).toBe(3);
    expect(relaxedMinNights(6, PALIERS, 14)).toBe(2);
    expect(relaxedMinNights(6, PALIERS, 0)).toBe(2);
    expect(relaxedMinNights(2, PALIERS, 20)).toBe(2); // un palier ne relève jamais un minimum
    expect(relaxedMinNights(6, [{ days: 10, minNights: 0 }], 5)).toBe(1);
    expect(relaxedMinNights(6, null, 5)).toBe(6);
    expect(relaxedMinNights(6, PALIERS, null)).toBe(6); // sans date du jour : minimum de la règle
  });
});

describe("devis avec paliers", () => {
  // Arrivée lundi 5/7/2027 pour 2 nuits.
  it("à 2 mois : 6 nuits exigées", () => {
    const q = devis("2027-05-05", "2027-07-05", "2027-07-07");
    expect(q.errors).toContain("min_nights");
    expect(q.minNights).toBe(6);
  });
  it("à 20 jours : 3 nuits exigées, 3 nuits acceptées", () => {
    expect(devis("2027-06-15", "2027-07-05", "2027-07-07").minNights).toBe(3);
    expect(devis("2027-06-15", "2027-07-05", "2027-07-08").errors).not.toContain("min_nights");
  });
  it("à 10 jours : le week-end passe", () => {
    const q = devis("2027-06-25", "2027-07-05", "2027-07-07");
    expect(q.errors).not.toContain("min_nights");
    expect(q.minNights).toBe(2);
  });
  it("une surcharge du jour reste prioritaire sur les paliers", () => {
    const req: QuoteRequest = {
      unit: SCIERIE, checkin: "2027-07-05", checkout: "2027-07-07", adults: 2, children: 0, today: "2027-06-25",
      seasons: ETE, rateRules: RULES, rateOverrides: [{ unitId: 2, date: "2027-07-05", priceCents: null, minNights: 7 }],
      promotions: [], optionsSelected: [], settings: SETTINGS,
    };
    expect(computeQuote(req).minNights).toBe(7);
  });
});

describe("rateCalendar avec paliers", () => {
  it("avec la date du jour, chaque jour porte son minimum effectif ; sans elle, celui de la règle", () => {
    const avec = rateCalendar(SCIERIE, "2027-07-05", "2027-08-10", ETE, RULES, [], "2027-06-25");
    expect(avec.find((d) => d.date === "2027-07-05")?.minNights).toBe(2); // J-10
    expect(avec.find((d) => d.date === "2027-07-15")?.minNights).toBe(3); // J-20
    expect(avec.find((d) => d.date === "2027-08-09")?.minNights).toBe(6); // J-45
    const sans = rateCalendar(SCIERIE, "2027-07-05", "2027-07-06", ETE, RULES);
    expect(sans[0]?.minNights).toBe(6);
  });
});

describe("stockage des paliers", () => {
  it("aller-retour « 28:3,14:2 », valeurs illisibles écartées", () => {
    expect(formatMinNightsRelax(PALIERS)).toBe("28:3,14:2");
    expect(parseMinNightsRelax("28:3,14:2")).toEqual(PALIERS);
    expect(parseMinNightsRelax("28:3,x:2,14")).toEqual([{ days: 28, minNights: 3 }]);
    expect(parseMinNightsRelax("")).toBeNull();
    expect(formatMinNightsRelax([])).toBeNull();
  });
});

describe("le plus haut minimum des nuits du séjour (décision du 24/10/2026)", () => {
  // Saison krokus 2027 : nuits du vendredi 5/2 au samedi 13/2 à 4 nuits ; avant, 2.
  const KROKUS: Season[] = [{ id: 7, name: "Krokus 2027", dateStart: "2027-02-05", dateEnd: "2027-02-13", priority: 17 }];
  const R: RateRule[] = [
    { id: 1, unitId: 2, seasonId: null, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 2, checkinDays: null },
    { id: 2, unitId: 2, seasonId: 7, priceWeekCents: 10000, priceWeekendCents: 10000, holidayPct: 0, minNights: 4, checkinDays: null, minNightsRelax: [{ days: 14, minNights: 2 }] },
  ];
  const q = (today: string, checkin: string, checkout: string) =>
    computeQuote({ unit: SCIERIE, checkin, checkout, adults: 2, children: 0, today, seasons: KROKUS, rateRules: R, promotions: [], optionsSelected: [], settings: SETTINGS });

  it("jeudi 4 → dimanche 7/2 : 3 nuits refusées, le séjour touche des nuits à 4", () => {
    const r = q("2026-11-01", "2027-02-04", "2027-02-07");
    expect(r.errors).toContain("min_nights");
    expect(r.minNights).toBe(4);
    expect(q("2026-11-01", "2027-02-04", "2027-02-08").errors).not.toContain("min_nights");
  });
  it("lundi 1 → mercredi 3/2 : hors période, 2 nuits passent", () => {
    expect(q("2026-11-01", "2027-02-01", "2027-02-03").errors).not.toContain("min_nights");
  });
  it("chaque nuit garde son relâchement : à J-13 des nuits de période, 3 nuits passent", () => {
    // le 23/01, les nuits des 5-6/02 sont à 13-14 jours : déjà à 2 nuits
    expect(q("2027-01-23", "2027-02-04", "2027-02-07").errors).not.toContain("min_nights");
  });
});
