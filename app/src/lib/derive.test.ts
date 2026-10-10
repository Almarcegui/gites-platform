import { describe, expect, it } from "vitest";

import type { DayRate, PlanningBooking } from "../api/types";
import { barColumns, barKind, cleaningTasks, daySentence, priceRuns, tapDay, EMPTY_SELECTION } from "./derive";

const pb = (o: Partial<PlanningBooking>): PlanningBooking => ({
  id: 1, reference: "PM-1", unitId: 1, checkin: "2026-10-10", checkout: "2026-10-12", status: "confirmed", source: "direct",
  channelLabel: null, guestName: "X", persons: 2, isComposite: false, paidState: "soldée", balanceCents: 0, ...o,
});

describe("barKind", () => {
  it("donne les quatre états de la maquette A", () => {
    expect(barKind(pb({ status: "pending" }))).toBe("option");
    expect(barKind(pb({ source: "ical", channelLabel: "Booking", balanceCents: 0 }))).toBe("plat");
    expect(barKind(pb({ balanceCents: 20500 }))).toBe("solde");
    expect(barKind(pb({}))).toBe("soldee");
  });
});

describe("barColumns", () => {
  it("place l'arrivée et le départ au milieu des jours", () => {
    expect(barColumns("2026-10-08", 31, "2026-10-10", "2026-10-12")).toEqual({ from: 7, to: 11, flatL: false, flatR: false });
  });
  it("coupe à plat ce qui déborde de la fenêtre", () => {
    expect(barColumns("2026-10-08", 3, "2026-10-01", "2026-10-20")).toEqual({ from: 2, to: 8, flatL: true, flatR: true });
    expect(barColumns("2026-10-08", 3, "2026-10-01", "2026-10-08")).toBeNull();
  });
});

describe("priceRuns", () => {
  const d = (date: string, p: number | null): DayRate => ({ date, priceCents: p, source: "base", minNights: 2, weekend: false, holidayRated: false, fallbackPriceCents: null, overridePriceCents: null, overrideMinNights: null });
  it("+10 % arrondi aux 5 € et regroupé en plages de même prix", () => {
    const runs = priceRuns([d("2026-10-19", 18000), d("2026-10-20", 18000), d("2026-10-21", 22000), d("2026-10-22", null)], { kind: "pct", pct: 10 });
    expect(runs).toEqual([
      { from: "2026-10-19", to: "2026-10-20", priceCents: 20000 },
      { from: "2026-10-21", to: "2026-10-21", priceCents: 24000 },
    ]);
  });
  it("un prix fixe couvre toute la plage", () => {
    expect(priceRuns([d("2026-10-19", 18000), d("2026-10-20", 22000)], { kind: "set", cents: 25000 })).toEqual([{ from: "2026-10-19", to: "2026-10-20", priceCents: 25000 }]);
  });
});

describe("tapDay (premier jour puis jour de départ)", () => {
  const ctx = { today: "2026-10-10", unitName: "La Scierie", label: (x: string) => x, taken: (_u: number, n: string) => n === "2026-10-16" };
  it("refuse un jour passé", () => {
    expect(tapDay(EMPTY_SELECTION, 2, "2026-10-09", ctx).ok).toBe(false);
  });
  it("choisit puis termine une plage", () => {
    const a = tapDay(EMPTY_SELECTION, 2, "2026-10-13", ctx);
    expect(a.ok && a.selection).toEqual({ unitId: 2, first: "2026-10-13", departure: null });
    const b = tapDay(a.selection, 2, "2026-10-15", ctx);
    expect(b.ok && b.selection).toEqual({ unitId: 2, first: "2026-10-13", departure: "2026-10-15" });
  });
  it("le jour de départ peut être pris, pas une nuit au milieu", () => {
    const a = tapDay(EMPTY_SELECTION, 2, "2026-10-14", ctx);
    expect(tapDay(a.selection, 2, "2026-10-16", ctx).ok).toBe(true);
    const c = tapDay(a.selection, 2, "2026-10-18", ctx);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain("2026-10-16");
  });
});

describe("cleaningTasks", () => {
  it("un ménage par départ, serré si quelqu'un arrive le jour même", () => {
    const tasks = cleaningTasks(
      [{
        propertyId: 1,
        bookings: [pb({ id: 1, unitId: 2, checkin: "2026-10-07", checkout: "2026-10-10", persons: 6 }), pb({ id: 2, unitId: 2, checkin: "2026-10-10", checkout: "2026-10-12", persons: 4 })],
        links: [],
        unitNames: new Map([[2, "La Scierie"]]),
        checkinTime: "16:00",
        checkoutTime: "10:00",
      }],
      "2026-10-10",
      7,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ unitName: "La Scierie", date: "2026-10-10", tight: true, next: { persons: 4, checkin: "2026-10-10" } });
    expect(tasks[1]).toMatchObject({ date: "2026-10-12", next: null, tight: false });
  });
});

describe("daySentence", () => {
  it("dit la journée comme la maquette B", () => {
    expect(daySentence(2, 1)).toBe("Un départ et deux arrivées.");
    expect(daySentence(0, 0)).toBe("Ni arrivée ni départ aujourd'hui.");
    expect(daySentence(1, 0)).toBe("Une arrivée.");
  });
});
