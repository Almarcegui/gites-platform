import { describe, expect, it } from "vitest";

import { overrideRuns, prioritiesToFix, wantedPriorities, wrongOverlaps } from "./seasons";

const S = (id: number, dateStart: string, dateEnd: string, priority: number) => ({ id, name: `s${id}`, dateStart, dateEnd, priority });

describe("saisons en langage simple", () => {
  it("la plus courte reçoit la priorité la plus haute", () => {
    const want = wantedPriorities([S(1, "2027-07-01", "2027-08-31", 5), S(2, "2027-07-14", "2027-07-21", 1)]);
    expect(want.get(2)!).toBeGreaterThan(want.get(1)!);
  });

  it("signale un chevauchement où la plus longue l'emporte, et dit quoi corriger", () => {
    const seasons = [S(1, "2027-07-01", "2027-08-31", 5), S(2, "2027-07-14", "2027-07-21", 1)];
    expect(wrongOverlaps(seasons).map((w) => [w.longer.id, w.shorter.id])).toEqual([[1, 2]]);
    const fix = prioritiesToFix(seasons);
    expect(fix.find((f) => f.id === 2)!.priority).toBeGreaterThan(fix.find((f) => f.id === 1)?.priority ?? 0);
    expect(wrongOverlaps(seasons.map((s) => ({ ...s, priority: wantedPriorities(seasons).get(s.id)! })))).toEqual([]);
  });

  it("regroupe les jours fixés à la main en plages", () => {
    const d = (date: string, p: number | null, m: number | null = null) => ({ date, priceCents: p ?? 100, source: "x", minNights: 2, weekend: false, holidayRated: false, fallbackPriceCents: 9000, overridePriceCents: p, overrideMinNights: m });
    const runs = overrideRuns(1, [d("2026-10-01", 15000), d("2026-10-02", 15000), d("2026-10-03", null), d("2026-10-04", 15000), d("2026-10-05", 16000)]);
    expect(runs.map((r) => [r.from, r.to, r.priceCents])).toEqual([
      ["2026-10-01", "2026-10-02", 15000],
      ["2026-10-04", "2026-10-04", 15000],
      ["2026-10-05", "2026-10-05", 16000],
    ]);
  });
});
