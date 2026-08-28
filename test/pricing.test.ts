// Tests du moteur de tarification. Chaque montant attendu est calculé à la
// main dans le commentaire du test — jamais recopié depuis la sortie du code.
import { describe, expect, it } from "vitest";
import {
  computeQuote,
  rateCalendar,
  type OptionDef,
  type PricingSettings,
  type Promotion,
  type QuoteRequest,
  type RateOverride,
  type RateRule,
  type Season,
  type UnitPricingInfo,
} from "../src/core/pricing";
import { addDays } from "../src/core/dates";

// --- Fixtures : miroir du seed Pré Moré -------------------------------------
const SEASONS: Season[] = [
  { id: 1, name: "Haute — juillet-août 2026", dateStart: "2026-07-01", dateEnd: "2026-08-31", priority: 10 },
  { id: 2, name: "Fêtes 2026", dateStart: "2026-12-18", dateEnd: "2027-01-03", priority: 20 },
];

const RULES: RateRule[] = [
  // La Maison du Scieur (unité 1)
  { id: 11, unitId: 1, seasonId: null, priceWeekCents: 18000, priceWeekendCents: 22000, holidayPct: 15, minNights: 2, checkinDays: null },
  { id: 12, unitId: 1, seasonId: 1, priceWeekCents: 24000, priceWeekendCents: 28000, holidayPct: 15, minNights: 7, checkinDays: null },
  // La Scierie (unité 2)
  { id: 21, unitId: 2, seasonId: null, priceWeekCents: 12000, priceWeekendCents: 15000, holidayPct: 15, minNights: 2, checkinDays: null },
  { id: 22, unitId: 2, seasonId: 1, priceWeekCents: 16000, priceWeekendCents: 18000, holidayPct: 15, minNights: 7, checkinDays: null },
];

const PROMOS: Promotion[] = [
  { id: 1, kind: "long_stay", code: null, label: "Long séjour ≥ 7 nuits", discountPct: 10, discountCents: null, threshold: 7, validFrom: null, validUntil: null, maxUses: null, uses: 0, active: true },
  { id: 2, kind: "early_bird", code: null, label: "Early bird ≥ 90 jours", discountPct: 5, discountCents: null, threshold: 90, validFrom: null, validUntil: null, maxUses: null, uses: 0, active: true },
  { id: 3, kind: "last_minute", code: null, label: "Last minute ≤ 7 jours", discountPct: 10, discountCents: null, threshold: 7, validFrom: null, validUntil: null, maxUses: null, uses: 0, active: true },
  { id: 4, kind: "code", code: "REDU10", label: "Code REDU10", discountPct: 10, discountCents: null, threshold: null, validFrom: null, validUntil: null, maxUses: null, uses: 0, active: true },
  { id: 5, kind: "code", code: "MOINS50", label: "Code MOINS50", discountPct: null, discountCents: 5000, threshold: null, validFrom: null, validUntil: null, maxUses: null, uses: 0, active: true },
  { id: 6, kind: "code", code: "OLD", label: "Code expiré", discountPct: 10, discountCents: null, threshold: null, validFrom: null, validUntil: "2025-12-31", maxUses: null, uses: 0, active: true },
  { id: 7, kind: "code", code: "FULL", label: "Code épuisé", discountPct: 10, discountCents: null, threshold: null, validFrom: null, validUntil: null, maxUses: 5, uses: 5, active: true },
];

const SETTINGS: PricingSettings = {
  depositPct: 30,
  balanceDueDays: 30,
  touristTaxCentsPerPersonNight: 100,
  touristTaxIncludeChildren: true,
  cautionCents: 30000,
};

// Fixtures avec ménage à 0 : les totaux historiques restent valables ;
// les frais de ménage ont leurs tests dédiés plus bas.
const SCIERIE: UnitPricingInfo = { id: 2, name: "La Scierie", compositePricing: "own", cleaningFeeCents: 0, components: [] };
const DOMAINE: UnitPricingInfo = {
  id: 3, name: "Le Domaine entier", compositePricing: "sum", cleaningFeeCents: 0,
  components: [
    { id: 1, name: "La Maison du Scieur", cleaningFeeCents: 0 },
    { id: 2, name: "La Scierie", cleaningFeeCents: 0 },
  ],
};

function baseRequest(over: Partial<QuoteRequest>): QuoteRequest {
  return {
    unit: SCIERIE,
    checkin: "2026-03-02",
    checkout: "2026-03-06",
    adults: 4,
    children: 0,
    today: "2026-01-15",
    seasons: SEASONS,
    rateRules: RULES,
    promotions: PROMOS,
    promoCode: null,
    optionsSelected: [],
    settings: SETTINGS,
    ...over,
  };
}

/** Invariant fondamental : la somme des lignes du devis = le total. */
function expectLinesSumToTotal(q: ReturnType<typeof computeQuote>) {
  expect(q.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(q.totalCents);
}

// -----------------------------------------------------------------------------

describe("arrhes propres à l'hébergement (issue #75)", () => {
  // Même séjour que le premier test ci-dessous : 4 nuits de semaine à 120 €,
  // taxe 4 pers. × 4 nuits × 1 € → total 496 €. Seul le pourcentage change.
  const stay = { checkin: "2026-03-02" as const, checkout: "2026-03-06" as const, adults: 4 };

  it("30 % et 50 % sur le même séjour donnent deux devis distincts", () => {
    const q30 = computeQuote(baseRequest({ ...stay, unit: { ...SCIERIE, depositPct: 30 } }));
    const q50 = computeQuote(baseRequest({ ...stay, unit: { ...SCIERIE, depositPct: 50 } }));

    expect(q30.totalCents).toBe(49600);
    expect(q50.totalCents).toBe(49600);

    // 30 % de 496 € = 148,80 € ; 50 % de 496 € = 248 €.
    expect(q30.depositCents).toBe(14880);
    expect(q50.depositCents).toBe(24800);
    expect(q30.balanceCents).toBe(34720);
    expect(q50.balanceCents).toBe(24800);
    expect(q30.depositPct).toBe(30);
    expect(q50.depositPct).toBe(50);
  });

  it("unité sans valeur : repli sur le pourcentage du domaine", () => {
    // SETTINGS.depositPct = 30. null et absence de clé se comportent pareil.
    const nul = computeQuote(baseRequest({ ...stay, unit: { ...SCIERIE, depositPct: null } }));
    const absent = computeQuote(baseRequest({ ...stay, unit: SCIERIE }));

    expect(nul.depositPct).toBe(30);
    expect(absent.depositPct).toBe(30);
    expect(nul.depositCents).toBe(14880);
    expect(absent.depositCents).toBe(14880);
  });

  it("le pourcentage de l'unité prime sur celui du domaine, y compris à 0", () => {
    // 0 est une valeur, pas une absence : réserver sans rien payer reste
    // possible si le propriétaire le règle ainsi.
    const q = computeQuote(baseRequest({ ...stay, unit: { ...SCIERIE, depositPct: 0 } }));
    expect(q.depositPct).toBe(0);
    expect(q.depositCents).toBe(0);
    expect(q.balanceCents).toBe(49600);
    expect(q.balanceDueDate).toBe("2026-01-31");
  });

  it("100 % sur l'unité force le paiement intégral, comme sur le domaine", () => {
    const q = computeQuote(baseRequest({ ...stay, unit: { ...SCIERIE, depositPct: 100 } }));
    expect(q.depositCents).toBe(q.totalCents);
    expect(q.balanceCents).toBe(0);
    expect(q.balanceDueDate).toBeNull();
  });

  it("le repli reste en place quand le séjour est trop proche pour un solde", () => {
    // today >= J-30 → paiement intégral quel que soit le pourcentage.
    const q = computeQuote(baseRequest({ ...stay, today: "2026-02-20", unit: { ...SCIERIE, depositPct: 50 } }));
    expect(q.depositCents).toBe(q.totalCents);
    expect(q.depositPct).toBe(50);
    expect(q.balanceDueDate).toBeNull();
  });
});

describe("nuits semaine / weekend", () => {
  it("4 nuits de semaine en basse saison (lun 02/03 → ven 06/03)", () => {
    // 4 × 120 € = 480 € ; taxe 4 pers. × 4 n × 1 € = 16 € ; total 496 €.
    // Acompte 30 % = 148,80 € ; solde 347,20 € dû le 31/01 (J-30).
    const q = computeQuote(baseRequest({}));
    expect(q.ok).toBe(true);
    expect(q.nights).toBe(4);
    expect(q.accommodationCents).toBe(48000);
    expect(q.taxCents).toBe(1600);
    expect(q.totalCents).toBe(49600);
    expect(q.depositCents).toBe(14880);
    expect(q.balanceCents).toBe(34720);
    expect(q.balanceDueDate).toBe("2026-01-31");
    expect(q.autoDiscountApplied).toBeNull();
    expectLinesSumToTotal(q);
  });

  it("2 nuits weekend (ven 06/03 → dim 08/03) au prix weekend", () => {
    // 2 × 150 € = 300 € ; taxe 2 pers. × 2 n = 4 € → 304 €.
    const q = computeQuote(baseRequest({ checkin: "2026-03-06", checkout: "2026-03-08", adults: 2 }));
    expect(q.ok).toBe(true);
    expect(q.accommodationCents).toBe(30000);
    expect(q.totalCents).toBe(30400);
    expectLinesSumToTotal(q);
  });
});

describe("saisons, fériés et ponts", () => {
  it("semaine complète en haute saison autour du 21 juillet + long séjour", () => {
    // Séjour sam 18/07 → sam 25/07/2026 (7 nuits), La Scierie, saison haute.
    // Nuits WE : 18 et 24 (2 × 180 €) ; nuits semaine : 19-23 (5 × 160 €).
    // Base = 360 + 800 = 1 160 €.
    // Nuits majorées (21/07 mardi férié + pont du lundi 20) : 19, 20, 21
    // → 3 × 15 % de 160 € = 72 €. Hébergement = 1 232 €.
    // Long séjour (7 nuits ≥ 7) : −10 % = −123,20 € (bat l'early bird −5 %).
    // Sauna 35 € ; taxe 6 pers. × 7 n = 42 €.
    // Total = 1 232 − 123,20 + 35 + 42 = 1 185,80 €.
    // Acompte 30 % = 355,74 € ; solde 830,06 € dû le 18/06.
    const sauna: OptionDef = { id: 1, name: "Sauna", pricingMode: "per_stay", priceCents: 3500, maxQty: 1, unitLabel: "séjour" };
    const q = computeQuote(baseRequest({
      checkin: "2026-07-18", checkout: "2026-07-25",
      adults: 6, today: "2026-04-01",
      optionsSelected: [{ option: sauna, qty: 1 }],
    }));
    expect(q.ok).toBe(true);
    expect(q.accommodationCents).toBe(123200);
    expect(q.discountCents).toBe(12320);
    expect(q.autoDiscountApplied).toBe("Long séjour ≥ 7 nuits");
    expect(q.optionsCents).toBe(3500);
    expect(q.taxCents).toBe(4200);
    expect(q.totalCents).toBe(118580);
    expect(q.depositCents).toBe(35574);
    expect(q.balanceCents).toBe(83006);
    expect(q.balanceDueDate).toBe("2026-06-18");
    expectLinesSumToTotal(q);
  });

  it("min. nuits de la saison d'arrivée : 2 nuits refusées en haute saison (min 7)", () => {
    const q = computeQuote(baseRequest({ checkin: "2026-07-18", checkout: "2026-07-20", today: "2026-04-01" }));
    expect(q.ok).toBe(false);
    expect(q.errors).toContain("min_nights");
    expect(q.minNights).toBe(7);
  });

  it("saison sans règle propre (Fêtes) : retombe sur le tarif de base + majoration férié", () => {
    // Nuits 24/12 (jeu, semaine 120 €, majorée +18 €) et 25/12 (ven, WE 150 €, majorée +22,50 €).
    // Hébergement = 270 + 40,50 = 310,50 € ; taxe 4×2 = 8 € ; total 318,50 €.
    const q = computeQuote(baseRequest({ checkin: "2026-12-24", checkout: "2026-12-26", today: "2026-11-20" }));
    expect(q.ok).toBe(true);
    expect(q.accommodationCents).toBe(31050);
    expect(q.totalCents).toBe(31850);
    const labels = q.lines.map((l) => l.label).join(" | ");
    expect(labels).toContain("tarif de base");
    expectLinesSumToTotal(q);
  });
});

describe("remises automatiques (la meilleure seule)", () => {
  it("early bird ≥ 90 jours : −5 %", () => {
    // 4 nuits semaine = 480 € ; réservé le 01/11/2025 pour le 02/03/2026 (121 j).
    // −5 % = −24 € ; taxe 16 € ; total 472 €.
    const q = computeQuote(baseRequest({ today: "2025-11-01" }));
    expect(q.discountCents).toBe(2400);
    expect(q.autoDiscountApplied).toBe("Early bird ≥ 90 jours");
    expect(q.totalCents).toBe(47200);
    expectLinesSumToTotal(q);
  });

  it("last minute ≤ 7 jours : −10 %", () => {
    // Réservé le 27/02 pour le 02/03 (3 jours) : −48 € sur 480 €.
    const q = computeQuote(baseRequest({ today: "2026-02-27" }));
    expect(q.discountCents).toBe(4800);
    expect(q.autoDiscountApplied).toBe("Last minute ≤ 7 jours");
    // À 3 jours de l'arrivée (< J-30), le paiement total est exigé.
    expect(q.depositCents).toBe(q.totalCents);
    expect(q.balanceCents).toBe(0);
    expect(q.balanceDueDate).toBeNull();
    expectLinesSumToTotal(q);
  });

  it("long séjour et early bird éligibles ensemble → une seule remise (la meilleure)", () => {
    // 7 nuits 02/03 → 09/03 : 5 sem. (02,03,04,05,08) + 2 WE (06,07)
    // = 600 + 300 = 900 €. Réservé le 01/11/2025 (121 j → early éligible).
    // Long séjour −10 % (90 €) > early −5 % (45 €) → une seule ligne discount.
    const q = computeQuote(baseRequest({ checkout: "2026-03-09", today: "2025-11-01" }));
    expect(q.accommodationCents).toBe(90000);
    expect(q.discountCents).toBe(9000);
    expect(q.autoDiscountApplied).toBe("Long séjour ≥ 7 nuits");
    expect(q.lines.filter((l) => l.kind === "discount")).toHaveLength(1);
    expectLinesSumToTotal(q);
  });
});

describe("codes promo", () => {
  it("s'ajoute APRÈS la remise automatique", () => {
    // 7 nuits = 900 € ; long séjour −90 € → 810 € ; REDU10 −10 % de 810 = −81 €.
    // Taxe 4 pers. × 7 n = 28 €. Total = 900 − 90 − 81 + 28 = 757 €.
    const q = computeQuote(baseRequest({ checkout: "2026-03-09", promoCode: "redu10" }));
    expect(q.discountCents).toBe(9000 + 8100);
    expect(q.promoApplied).toBe("REDU10");
    expect(q.totalCents).toBe(75700);
    expectLinesSumToTotal(q);
  });

  it("montant fixe, plafonné à l'hébergement", () => {
    // 4 nuits = 480 € ; MOINS50 = −50 € ; taxe 16 € → 446 €.
    const q = computeQuote(baseRequest({ promoCode: "MOINS50" }));
    expect(q.discountCents).toBe(5000);
    expect(q.totalCents).toBe(44600);
    expectLinesSumToTotal(q);
  });

  it("code expiré, épuisé ou inconnu → warning promo_invalid, devis calculé sans le code", () => {
    for (const code of ["OLD", "FULL", "NEXISTEPAS"]) {
      const q = computeQuote(baseRequest({ promoCode: code }));
      expect(q.ok).toBe(true);
      expect(q.warnings).toContain("promo_invalid");
      expect(q.promoApplied).toBeNull();
      expect(q.totalCents).toBe(49600); // même total que sans code
    }
  });
});

describe("options", () => {
  const perPerson: OptionDef = { id: 10, name: "Linge de maison", pricingMode: "per_person", priceCents: 800, maxQty: null, unitLabel: "pers." };
  const perQty: OptionDef = { id: 11, name: "Bois de chauffage", pricingMode: "per_unit_qty", priceCents: 1500, maxQty: 10, unitLabel: "stère" };
  const perNight: OptionDef = { id: 12, name: "Chauffage piscine", pricingMode: "per_night", priceCents: 1000, maxQty: null, unitLabel: "nuit" };
  const perPersonNight: OptionDef = { id: 13, name: "Petit-déjeuner", pricingMode: "per_person_night", priceCents: 500, maxQty: null, unitLabel: "pers./nuit" };

  it("calcule chaque mode de tarification", () => {
    // Weekend 2 nuits (300 €), 2 adultes + 2 enfants (4 pers.).
    // Linge 8 € × 4 = 32 € ; bois 3 stères = 45 € ; chauffage 10 € × 2 n = 20 € ;
    // petit-déj 5 € × 4 × 2 = 40 €. Options = 137 €. Taxe 4 × 2 = 8 €. Total 445 €.
    const q = computeQuote(baseRequest({
      checkin: "2026-03-06", checkout: "2026-03-08", adults: 2, children: 2,
      optionsSelected: [
        { option: perPerson, qty: 1 },
        { option: perQty, qty: 3 },
        { option: perNight, qty: 1 },
        { option: perPersonNight, qty: 1 },
      ],
    }));
    expect(q.optionsCents).toBe(3200 + 4500 + 2000 + 4000);
    expect(q.totalCents).toBe(30000 + 13700 + 800);
    expectLinesSumToTotal(q);
  });

  it("borne la quantité au max_qty", () => {
    const q = computeQuote(baseRequest({
      checkin: "2026-03-06", checkout: "2026-03-08", adults: 2,
      optionsSelected: [{ option: perQty, qty: 15 }], // max 10
    }));
    expect(q.optionsCents).toBe(15000);
  });

  it("qty 0 → option ignorée", () => {
    const q = computeQuote(baseRequest({ optionsSelected: [{ option: perPerson, qty: 0 }] }));
    expect(q.optionsCents).toBe(0);
  });
});

describe("taxe de séjour", () => {
  it("exclut les enfants quand le réglage le demande", () => {
    // 2 adultes + 3 enfants, 4 nuits : taxe sur 2 pers. = 8 €.
    const q = computeQuote(baseRequest({
      adults: 2, children: 3,
      settings: { ...SETTINGS, touristTaxIncludeChildren: false },
    }));
    expect(q.taxCents).toBe(800);
  });
});

describe("unité composite (Domaine entier)", () => {
  it("mode 'sum' : somme des deux maisons, chacune avec SES règles", () => {
    // Weekend 2 nuits basse saison : Scieur 2 × 220 € + Scierie 2 × 150 € = 740 €.
    // 17 adultes : taxe 17 × 2 = 34 €. Total 774 €.
    const q = computeQuote(baseRequest({
      unit: DOMAINE, checkin: "2026-03-06", checkout: "2026-03-08", adults: 17,
    }));
    expect(q.ok).toBe(true);
    expect(q.accommodationCents).toBe(74000);
    expect(q.totalCents).toBe(77400);
    const labels = q.lines.map((l) => l.label).join(" | ");
    expect(labels).toContain("La Maison du Scieur");
    expect(labels).toContain("La Scierie");
    expectLinesSumToTotal(q);
  });

  it("mode 'sum' : le min. nuits le plus exigeant des composantes s'applique", () => {
    const q = computeQuote(baseRequest({
      unit: DOMAINE, checkin: "2026-07-18", checkout: "2026-07-20", adults: 17, today: "2026-04-01",
    }));
    expect(q.ok).toBe(false);
    expect(q.errors).toContain("min_nights");
    expect(q.minNights).toBe(7);
  });

  it("mode 'own' : l'unité composite utilise sa propre grille", () => {
    const own: UnitPricingInfo = { ...DOMAINE, compositePricing: "own" };
    const rules: RateRule[] = [
      ...RULES,
      { id: 31, unitId: 3, seasonId: null, priceWeekCents: 50000, priceWeekendCents: 60000, holidayPct: 0, minNights: 2, checkinDays: null },
    ];
    const q = computeQuote(baseRequest({
      unit: own, rateRules: rules, checkin: "2026-03-06", checkout: "2026-03-08", adults: 17,
    }));
    expect(q.accommodationCents).toBe(120000);
    expectLinesSumToTotal(q);
  });
});

describe("frais de ménage (fixes par séjour, relevés du site réel)", () => {
  it("s'ajoutent au devis SANS être remisés", () => {
    // 7 nuits 02→09/03 : hébergement 900 € ; long séjour −10 % = −90 €
    // (calculé sur l'hébergement seul) ; ménage 90 € ; taxe 4×7 = 28 €.
    // Total = 900 − 90 + 90 + 28 = 928 €.
    const scierie = { ...SCIERIE, cleaningFeeCents: 9000 };
    const q = computeQuote(baseRequest({ unit: scierie, checkout: "2026-03-09" }));
    expect(q.cleaningFeeCents).toBe(9000);
    expect(q.discountCents).toBe(9000);
    expect(q.totalCents).toBe(92800);
    expect(q.lines.find((l) => l.kind === "fee")?.label).toContain("ménage");
    expectLinesSumToTotal(q);
  });

  it("composite « somme » : ménage = somme des composantes (120 € + 90 €)", () => {
    // Weekend 2 nuits basse saison : 740 € + ménage 210 € + taxe 17×2 = 34 € → 984 €.
    const domaine: UnitPricingInfo = {
      ...DOMAINE,
      components: [
        { id: 1, name: "La Maison du Scieur", cleaningFeeCents: 12000 },
        { id: 2, name: "La Scierie", cleaningFeeCents: 9000 },
      ],
    };
    const q = computeQuote(baseRequest({ unit: domaine, checkin: "2026-03-06", checkout: "2026-03-08", adults: 17 }));
    expect(q.cleaningFeeCents).toBe(21000);
    expect(q.totalCents).toBe(74000 + 21000 + 3400);
    expectLinesSumToTotal(q);
  });

  it("l'acompte se calcule sur le total ménage compris", () => {
    const scierie = { ...SCIERIE, cleaningFeeCents: 9000 };
    const q = computeQuote(baseRequest({ unit: scierie }));
    // 4 nuits semaine 480 € + ménage 90 € + taxe 16 € = 586 € ; acompte 30 % = 175,80 €.
    expect(q.totalCents).toBe(58600);
    expect(q.depositCents).toBe(17580);
  });
});

describe("rateCalendar (calendrier des tarifs par jour)", () => {
  it("prix, saison et min nuits jour par jour, à cheval sur un changement de saison", () => {
    // 29-30/06 : tarif de base (lun 120 €, mar 120 €, min 2) ;
    // 01-02/07 : Haute (mer 160 €, jeu 160 €, min 7).
    const days = rateCalendar(SCIERIE, "2026-06-29", "2026-07-03", SEASONS, RULES);
    expect(days).toHaveLength(4);
    expect(days[0]).toMatchObject({ date: "2026-06-29", priceCents: 12000, seasonName: null, minNights: 2, weekend: false });
    expect(days[2]).toMatchObject({ date: "2026-07-01", priceCents: 16000, minNights: 7 });
    expect(days[2]?.seasonName).toContain("Haute");
  });

  it("applique la majoration férié/pont (20-21/07 : +15 %)", () => {
    const days = rateCalendar(SCIERIE, "2026-07-20", "2026-07-22", SEASONS, RULES);
    expect(days[0]).toMatchObject({ date: "2026-07-20", priceCents: 18400, holidayRated: true }); // pont lundi
    expect(days[1]).toMatchObject({ date: "2026-07-21", priceCents: 18400, holidayRated: true }); // férié mardi
  });

  it("composite « somme » : addition des composantes ; unité sans règle → null", () => {
    const days = rateCalendar(DOMAINE, "2026-03-06", "2026-03-08", SEASONS, RULES);
    expect(days[0]?.priceCents).toBe(22000 + 15000); // vendredi = nuits weekend
    const ghost = rateCalendar(
      { id: 99, name: "X", compositePricing: "own", cleaningFeeCents: 0, components: [] },
      "2026-03-06", "2026-03-07", SEASONS, RULES,
    );
    expect(ghost[0]?.priceCents).toBeNull();
    expect(ghost[0]?.minNights).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Surcharges par jour (issue #23 — migration 0014)
// -----------------------------------------------------------------------------

describe("surcharges par jour (rate_overrides)", () => {
  it("priorité surcharge > saison > tarif de base sur un devis de plusieurs nuits", () => {
    // La Scierie, lun 02/03 → ven 06/03 (4 nuits de semaine, tarif de base 120 €).
    // Surcharge de 200 € sur le mardi 03/03 et le mercredi 04/03.
    // Hébergement = 120 + 200 + 200 + 120 = 640 € ; taxe 4 pers. × 4 n = 16 €.
    const q = computeQuote(
      baseRequest({
        rateOverrides: [
          { unitId: 2, date: "2026-03-03", priceCents: 20000, minNights: null },
          { unitId: 2, date: "2026-03-04", priceCents: 20000, minNights: null },
        ],
      }),
    );
    expect(q.ok).toBe(true);
    expect(q.accommodationCents).toBe(64000);
    expect(q.totalCents).toBe(65600);
    // Les nuits surchargées sortent du groupe de leur saison : le devis le dit.
    const manuelle = q.lines.find((l) => l.label.includes("prix fixé à la main"));
    expect(manuelle?.amountCents).toBe(40000);
    expectLinesSumToTotal(q);
  });

  it("une surcharge de saison prime la règle de saison, pas seulement le tarif de base", () => {
    // Sam 18/07 → dim 19/07 en Haute saison : nuit weekend à 180 €.
    // Surcharge à 250 € → 250 € et non 180 €.
    const q = computeQuote(
      baseRequest({
        checkin: "2026-07-18", checkout: "2026-07-19", adults: 2,
        rateRules: RULES.map((r) => (r.id === 22 ? { ...r, minNights: 1 } : r)),
        rateOverrides: [{ unitId: 2, date: "2026-07-18", priceCents: 25000, minNights: null }],
      }),
    );
    expect(q.ok).toBe(true);
    expect(q.accommodationCents).toBe(25000);
  });

  it("la surcharge est un PRIX FINAL ABSOLU : ni weekend ni majoration fériés dessus (spec § 3)", () => {
    // Mar 21/07/2026 = fête nationale, majorée de 15 % : 160 → 184 € sans surcharge.
    // Avec une surcharge à 200 €, on facture 200 € — pas 230 €.
    const sansSurcharge = rateCalendar(SCIERIE, "2026-07-21", "2026-07-22", SEASONS, RULES);
    expect(sansSurcharge[0]).toMatchObject({ priceCents: 18400, holidayRated: true, source: "saison" });

    const avec = rateCalendar(SCIERIE, "2026-07-21", "2026-07-22", SEASONS, RULES, [
      { unitId: 2, date: "2026-07-21", priceCents: 20000, minNights: null },
    ]);
    expect(avec[0]).toMatchObject({
      priceCents: 20000,
      source: "override",
      holidayRated: false,
      fallbackPriceCents: 18400, // ce qu'affiche « Sans cette valeur : 184 € »
      overridePriceCents: 20000,
    });

    // Idem sur une nuit de weekend : 180 € weekend → 200 €, pas 200 + supplément.
    const we = rateCalendar(SCIERIE, "2026-07-18", "2026-07-19", SEASONS, RULES, [
      { unitId: 2, date: "2026-07-18", priceCents: 20000, minNights: null },
    ]);
    expect(we[0]).toMatchObject({ priceCents: 20000, weekend: true, fallbackPriceCents: 18000 });
  });

  it("un minimum de nuits posé sur le jour d'arrivée est appliqué", () => {
    // Tarif de base : min 2 nuits. Surcharge min 5 sur le lundi 02/03 (arrivée)
    // → un séjour de 4 nuits est refusé, 5 nuits passe.
    const over = [{ unitId: 2, date: "2026-03-02", priceCents: null, minNights: 5 }];
    const court = computeQuote(baseRequest({ rateOverrides: over }));
    expect(court.ok).toBe(false);
    expect(court.errors).toContain("min_nights");
    expect(court.minNights).toBe(5);

    const long = computeQuote(baseRequest({ checkout: "2026-03-07", rateOverrides: over }));
    expect(long.ok).toBe(true);
    expect(long.minNights).toBe(5);
  });

  it("un minimum de nuits posé sur une nuit ENJAMBÉE ne bloque pas le séjour (spec § 4)", () => {
    // Surcharge min 5 sur le mercredi 04/03, arrivée le lundi 02/03 : le moteur
    // ne lit le min-nuits que de la nuit d'arrivée → séjour de 4 nuits accepté.
    const q = computeQuote(
      baseRequest({ rateOverrides: [{ unitId: 2, date: "2026-03-04", priceCents: null, minNights: 5 }] }),
    );
    expect(q.ok).toBe(true);
    expect(q.minNights).toBe(2);
  });

  it("une surcharge de min-nuits seule ne touche pas au prix", () => {
    const days = rateCalendar(SCIERIE, "2026-03-02", "2026-03-03", SEASONS, RULES, [
      { unitId: 2, date: "2026-03-02", priceCents: null, minNights: 4 },
    ]);
    expect(days[0]).toMatchObject({
      priceCents: 12000,       // inchangé : le prix vient toujours du tarif de base
      source: "base",
      minNights: 4,
      minNightsSource: "override",
      overridePriceCents: null,
      overrideMinNights: 4,
    });
  });

  it("retirer la surcharge fait revenir la saison, jamais un 0 fantôme", () => {
    const days = rateCalendar(SCIERIE, "2026-07-01", "2026-07-02", SEASONS, RULES, []);
    expect(days[0]).toMatchObject({ priceCents: 16000, source: "saison", overridePriceCents: null });
  });

  it("une surcharge couvre un jour SANS aucune règle tarifaire", () => {
    const orpheline: UnitPricingInfo = { id: 99, name: "Sans règle", compositePricing: "own", cleaningFeeCents: 0, components: [] };
    const days = rateCalendar(orpheline, "2026-03-02", "2026-03-04", SEASONS, RULES, [
      { unitId: 99, date: "2026-03-02", priceCents: 9000, minNights: 3 },
    ]);
    expect(days[0]).toMatchObject({ priceCents: 9000, source: "override", minNights: 3, fallbackPriceCents: null });
    expect(days[1]?.priceCents).toBeNull(); // le jour suivant reste non couvert
  });

  it("composite « somme » : la surcharge d'une composante remonte dans le total", () => {
    // Ven 06/03 : Scieur 220 € + Scierie 150 € = 370 €. Surcharge Scierie à 100 €
    // → 320 €, et la provenance du jour passe à « override » pour la coloration.
    const days = rateCalendar(DOMAINE, "2026-03-06", "2026-03-07", SEASONS, RULES, [
      { unitId: 2, date: "2026-03-06", priceCents: 10000, minNights: null },
    ]);
    expect(days[0]).toMatchObject({ priceCents: 32000, source: "override", fallbackPriceCents: 37000 });
  });

  it("les surcharges d'une autre unité n'ont aucun effet", () => {
    const days = rateCalendar(SCIERIE, "2026-03-02", "2026-03-03", SEASONS, RULES, [
      { unitId: 1, date: "2026-03-02", priceCents: 99900, minNights: null },
    ]);
    expect(days[0]).toMatchObject({ priceCents: 12000, source: "base" });
  });
});

describe("garde-fous", () => {
  it("dates invalides", () => {
    const q = computeQuote(baseRequest({ checkin: "2026-03-06", checkout: "2026-03-06" }));
    expect(q.ok).toBe(false);
    expect(q.errors).toContain("invalid_dates");
  });

  it("unité sans aucune règle tarifaire → no_rate", () => {
    const q = computeQuote(
      baseRequest({ unit: { id: 99, name: "Fantôme", compositePricing: "own", cleaningFeeCents: 0, components: [] } }),
    );
    expect(q.ok).toBe(false);
    expect(q.errors).toContain("no_rate");
  });

  it("jour d'arrivée restreint (arrivées le vendredi/samedi uniquement)", () => {
    const rules: RateRule[] = [
      { id: 41, unitId: 2, seasonId: null, priceWeekCents: 12000, priceWeekendCents: 15000, holidayPct: 0, minNights: 2, checkinDays: [5, 6] },
    ];
    const lundi = computeQuote(baseRequest({ rateRules: rules })); // 02/03 = lundi
    expect(lundi.ok).toBe(false);
    expect(lundi.errors).toContain("checkin_day");
    expect(lundi.checkinDays).toEqual([5, 6]);
    const vendredi = computeQuote(baseRequest({ rateRules: rules, checkin: "2026-03-06", checkout: "2026-03-08" }));
    expect(vendredi.ok).toBe(true);
  });

  it("composite 'sum' : deux composantes aux jours d'arrivée INCOMPATIBLES ne laissent aucune arrivée", () => {
    // Le piège : l'intersection est vide. La traiter comme « aucune contrainte »
    // rouvrirait le séjour n'importe quel jour — un surbooking de règle.
    const rules: RateRule[] = [
      { id: 51, unitId: 1, seasonId: null, priceWeekCents: 18000, priceWeekendCents: 22000, holidayPct: 0, minNights: 1, checkinDays: [6] },
      { id: 52, unitId: 2, seasonId: null, priceWeekCents: 12000, priceWeekendCents: 15000, holidayPct: 0, minNights: 1, checkinDays: [5] },
    ];
    for (const checkin of ["2026-03-06", "2026-03-07", "2026-03-09"]) {
      const q = computeQuote(baseRequest({ unit: DOMAINE, rateRules: rules, checkin, checkout: addDays(checkin, 2), adults: 17 }));
      expect(q.ok).toBe(false);
      expect(q.errors).toContain("checkin_day");
      expect(q.checkinDays).toEqual([]);
    }
  });
});

// --- Prix à la nuit affiché au client (issue #47-2) --------------------------
describe("libellé client des nuits d'hébergement (#47)", () => {
  const nuitsOf = (q: ReturnType<typeof computeQuote>) => q.lines.filter((l) => l.kind === "accommodation");

  it("le libellé technique reste au moteur, le libellé client perd l'origine du prix", () => {
    // 02/03 → 06/03 : 4 nuits de semaine au tarif de base de La Scierie (120 €).
    const q = computeQuote(baseRequest({}));
    const [nuits] = nuitsOf(q);
    expect(nuits.label).toBe("4 nuits semaine · tarif de base");
    expect(nuits.publicLabel).toBe("4 nuits semaine");
    expect(nuits.unitPriceCents).toBe(12000);
    expect(nuits.unitPriceCents! * 4).toBe(nuits.amountCents);
  });

  it("deux surcharges de montants DIFFÉRENTS ne produisent jamais un prix moyen", () => {
    // Même libellé (« prix fixé à la main »), même type de jour : les deux nuits
    // tombent dans le même groupe. 90 € + 110 € = 200 € ; la moyenne serait
    // 100 €, un tarif qu'aucune des deux nuits n'a jamais valu.
    const overrides: RateOverride[] = [
      { unitId: 2, date: "2026-03-02", priceCents: 9000, minNights: null },
      { unitId: 2, date: "2026-03-03", priceCents: 11000, minNights: null },
    ];
    const q = computeQuote(baseRequest({ checkin: "2026-03-02", checkout: "2026-03-04", rateOverrides: overrides }));
    expect(q.ok).toBe(true);
    const [nuits] = nuitsOf(q);
    expect(nuits.amountCents).toBe(20000);
    expect(nuits.publicLabel).toBe("2 nuits semaine");
    expect(nuits.unitPriceCents).toBeUndefined();
  });

  it("deux surcharges au MÊME montant donnent bien le prix de la nuit", () => {
    const overrides: RateOverride[] = [
      { unitId: 2, date: "2026-03-02", priceCents: 10000, minNights: null },
      { unitId: 2, date: "2026-03-03", priceCents: 10000, minNights: null },
    ];
    const q = computeQuote(baseRequest({ checkin: "2026-03-02", checkout: "2026-03-04", rateOverrides: overrides }));
    const [nuits] = nuitsOf(q);
    expect(nuits.unitPriceCents).toBe(10000);
  });
});
