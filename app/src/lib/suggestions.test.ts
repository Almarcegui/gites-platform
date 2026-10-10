import { describe, expect, it } from "vitest";

import { buildSuggestions } from "./suggestions";

const day = (date: string, price: number, extra: Partial<{ holidayRated: boolean }> = {}) => ({ date, priceCents: price, source: "base", minNights: 2, weekend: false, holidayRated: false, fallbackPriceCents: null, overridePriceCents: null, overrideMinNights: null, ...extra });

describe("suggestions", () => {
  it("dernière minute : − 10 % jour par jour, jamais sur une nuit vendue", () => {
    const days = [day("2026-10-12", 18000), day("2026-10-13", 18000), day("2026-10-14", 18000), day("2026-10-15", 22000)];
    const s = buildSuggestions({ days, soldDates: new Set(["2026-10-13"]), bookings: [], unitId: 1, today: "2026-10-12", monthEnd: "2026-11-10" }).find((x) => x.kind === "derniere-minute")!;
    expect(s.runs).toEqual([
      { from: "2026-10-12", to: "2026-10-12", priceCents: 16200 },
      { from: "2026-10-14", to: "2026-10-14", priceCents: 16200 },
      { from: "2026-10-15", to: "2026-10-15", priceCents: 19800 },
    ]);
  });

  it("dates fortes : seuls les fériés libres bougent, pas les jours ordinaires entre eux", () => {
    const days = [day("2026-11-01", 20000, { holidayRated: true }), day("2026-11-02", 18000), day("2026-11-11", 20000, { holidayRated: true })];
    const s = buildSuggestions({ days, soldDates: new Set(["2026-11-02"]), bookings: [], unitId: 1, today: "2026-10-12", monthEnd: "2026-11-10" }).find((x) => x.kind === "dates-fortes")!;
    expect(s.runs?.map((r) => r.from)).toEqual(["2026-11-01", "2026-11-11"]);
  });
});
