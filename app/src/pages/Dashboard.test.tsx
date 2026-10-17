// Alertes d'Aujourd'hui : l'échéance d'une option est dite à l'heure de Belgique
// (la base garde l'UTC) et sans le suffixe « UTC ».
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../test/render";
import { setWide } from "../test/setup";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("alertes : option en cours", () => {
  it("expire le mardi 20 octobre à 23 h 10 (21:10 UTC), sans « UTC »", async () => {
    renderApp("/", [
      (c) =>
        c.path === "/overview"
          ? {
              body: {
                property: { id: 1, name: "Les Gîtes du Pré Moré" },
                today: "2026-10-10",
                kpis: { balanceDueTotalCents: 0, balanceDueCount: 0 },
                alerts: { overdueBalances: [], activeHolds: [{ id: 9, reference: "PM-2026-009", unitName: "La Scierie", holdExpiresAt: "2026-10-20 21:10:00" }], newEmails: 0 },
              },
            }
          : undefined,
    ]);
    const row = await screen.findByText(/PM-2026-009, La Scierie/);
    expect(row.textContent).toContain("expire le mardi 20 octobre à 23 h 10");
    expect(row.textContent).not.toContain("UTC");
  });
});
