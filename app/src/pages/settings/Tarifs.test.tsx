// Prix et saisons : la phrase d'un prix dit les jours d'arrivée dans la langue de
// l'écran (« ven., sam. » / « vr, za »), sans point doublé en fin de phrase.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const rules = [{ id: 11, unitId: 2, seasonId: null, priceWeekCents: 12000, priceWeekendCents: 15000, holidayPct: 15, minNights: 2, checkinDays: [5, 6] }];
const handlers = [(c: { path: string; method: string }) => (c.path === "/seasons" && c.method === "GET" ? { body: { seasons: [] } } : c.path === "/rate-rules" && c.method === "GET" ? { body: { rules } } : undefined)];

describe("prix de base : jours d'arrivée", () => {
  it("en français : « arrivée le ven., sam. » avec un seul point", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderApp("/reglages/tarifs", handlers);
    await user.click(await screen.findByRole("tab", { name: "Prix de base" }).catch(() => screen.findByText("Prix de base", { selector: "button, [role=tab]" })));
    expect(await screen.findByText(/arrivée le ven\., sam\.$/)).toBeInTheDocument();
  });

  it("en néerlandais : jours néerlandais, pas « ven. » ni « sam. »", async () => {
    activate("nl");
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderApp("/reglages/tarifs", handlers);
    await user.click(await screen.findByText("Basisprijs", { selector: "button, [role=tab]" }));
    const line = await screen.findByText(/vr, za/);
    expect(line.textContent).not.toMatch(/ven\.|sam\./);
  });
});
