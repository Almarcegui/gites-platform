// Chiffres : les mois sont dits dans la langue de l'écran (ils étaient écrits en
// français quoi que l'on choisisse).
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate } from "../../i18n";
import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  activate("fr");
});

const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, occupiedNights: 3, capacityNights: 30, occupancyPct: 10, revenueCents: 30000 }));
const year = (y: number) => ({ year: y, months, occupancyPct: 10, revenueCents: 360000, adrCents: 10000, avgStayNights: 3, bookingsCount: 4, soldNights: 36, perUnit: [] });
const stats = {
  current: year(2026),
  previous: year(2025),
  leadTime: { count: 4, avgDays: 20, medianDays: 18, byMonth: [{ key: 3, label: "mars", count: 2, avgDays: 12, medianDays: 12 }, { key: 7, label: "juil.", count: 2, avgDays: 30, medianDays: 30 }], byUnit: [] },
  funnel: { steps: [{ key: "searches", label: "Recherches", count: 10, fromPreviousPct: null }, { key: "confirmed", label: "Réservations confirmées", count: 1, fromPreviousPct: 10 }], biggestDropKey: "confirmed" },
  searches: { topEmpty: [] },
};
const handler = [(c: { path: string }) => (c.path === "/stats" ? { body: stats } : undefined)];

describe("chiffres en néerlandais", () => {
  it("mois en néerlandais", async () => {
    activate("nl");
    renderApp("/reglages/chiffres", handler);
    expect(await screen.findAllByText("okt.")).not.toHaveLength(0);
    expect(screen.queryAllByText("févr.")).toHaveLength(0);
    expect(screen.queryAllByText("janv.")).toHaveLength(0);
  });

  it("en français : inchangé", async () => {
    renderApp("/reglages/chiffres", handler);
    expect((await screen.findAllByText("févr.")).length).toBeGreaterThan(0);
  });
});
