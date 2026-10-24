import { describe, it, expect } from "vitest";
import { proposedDays, priceDays, datedLabel, parseWeekendDays, type DatedPricing } from "../src/core/option-days";

// Octobre 2026 : jeu 22, ven 23, sam 24, dim 25, lun 26, mar 27, mer 28.
const sauna: DatedPricing = { priceCents: 12000, weekendPriceCents: 18000, weekendDays: null, consecutivePct: 70 };
const bain: DatedPricing = { priceCents: 5000, weekendPriceCents: null, weekendDays: null, consecutivePct: null };
const times = { checkoutTime: "10:00", checkoutTimeSunday: "18:00" };

describe("jours proposés", () => {
  it("jeudi → dimanche : jeu ven sam dim", () => {
    expect(proposedDays("2026-10-22", "2026-10-25", times)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  });
  it("jeudi → samedi : jeu ven", () => {
    expect(proposedDays("2026-10-22", "2026-10-24", times)).toEqual(["2026-10-22", "2026-10-23"]);
  });
  it("sans horaire du dimanche, le jour du départ n'est pas proposé", () => {
    expect(proposedDays("2026-10-22", "2026-10-25", { checkoutTime: "10:00" })).toEqual(["2026-10-22", "2026-10-23", "2026-10-24"]);
  });
  it("départ général tardif (16 h) sans horaire du dimanche : le dimanche est proposé", () => {
    expect(proposedDays("2026-10-22", "2026-10-25", { checkoutTime: "16:00" })).toHaveLength(4);
  });
  it("dimanche à 12 h : pas proposé ; à 14 h : proposé", () => {
    expect(proposedDays("2026-10-22", "2026-10-25", { checkoutTime: "10:00", checkoutTimeSunday: "12:00" })).toHaveLength(3);
    expect(proposedDays("2026-10-22", "2026-10-25", { checkoutTime: "10:00", checkoutTimeSunday: "14:00" })).toHaveLength(4);
  });
  it("départ un samedi tardif : jamais le jour du départ", () => {
    expect(proposedDays("2026-10-22", "2026-10-24", { checkoutTime: "18:00" })).toEqual(["2026-10-22", "2026-10-23"]);
  });
});

describe("jours week-end vides", () => {
  it("aucun jour coché : pas de prix week-end, tous les jours au prix de la semaine", () => {
    expect(parseWeekendDays("")).toEqual([]);
    expect(parseWeekendDays(null)).toBeNull();
    const p = { ...sauna, weekendDays: parseWeekendDays("") };
    expect(priceDays(p, ["2026-10-24"])[0].amountCents).toBe(12000);
  });
});

describe("prix des jours", () => {
  it("un jour de semaine et un jour de week-end", () => {
    expect(priceDays(sauna, ["2026-10-22"])[0].amountCents).toBe(12000);
    expect(priceDays(sauna, ["2026-10-24"])[0].amountCents).toBe(18000);
  });
  it("suite de 2 jours : le second à 70 %", () => {
    expect(priceDays(sauna, ["2026-10-24", "2026-10-25"]).map((d) => d.amountCents)).toEqual([18000, 12600]);
  });
  it("suite de 3 jours : chaque jour suivant à 70 %", () => {
    expect(priceDays(sauna, ["2026-10-22", "2026-10-23", "2026-10-24"]).map((d) => d.amountCents)).toEqual([12000, 12600, 12600]);
  });
  it("jours non consécutifs : plein tarif", () => {
    expect(priceDays(sauna, ["2026-10-22", "2026-10-24"]).map((d) => d.amountCents)).toEqual([12000, 18000]);
  });
  it("ordre d'entrée et doublons sans effet", () => {
    expect(priceDays(sauna, ["2026-10-25", "2026-10-24", "2026-10-24"]).map((d) => d.amountCents)).toEqual([18000, 12600]);
  });
  it("bain chaud : 50 € par jour, aucune remise", () => {
    expect(priceDays(bain, ["2026-10-24", "2026-10-25"]).map((d) => d.amountCents)).toEqual([5000, 5000]);
  });
  it("jours week-end réglables", () => {
    const p = { ...sauna, weekendDays: parseWeekendDays("6") };
    expect(priceDays(p, ["2026-10-23", "2026-10-31"]).map((d) => d.amountCents)).toEqual([12000, 18000]);
  });
});

describe("libellé", () => {
  it("une ligne lisible", () => {
    expect(datedLabel("Sauna", priceDays(sauna, ["2026-10-24", "2026-10-25"]))).toBe("Sauna — sam 24/10 (180 €), dim 25/10 (126 €)");
  });
});
