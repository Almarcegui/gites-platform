// Vente manuelle : le délai minimum de réservation du site public n'est pas
// bloquant au téléphone, mais l'écran doit le dire (le devis renvoie
// warnings: ['lead_time'] et minLeadDays).
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate } from "../i18n";
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
  activate("fr");
});

const quote = (warnings: string[], minLeadDays?: number) => ({
  unit: { id: 1, name: "La Maison du Scieur" },
  quote: {
    ok: true, errors: [], warnings, nights: 2, minNights: 2, checkinDays: null, ...(minLeadDays ? { minLeadDays } : {}),
    lines: [{ kind: "accommodation", label: "2 nuits", amountCents: 36000 }],
    totalCents: 36000, depositCents: 18000, depositPct: 50, balanceCents: 18000, balanceDueDate: "2026-10-12",
  },
  availability: { available: true, conflicts: [] },
});

const FR = { vente: "Nouvelle vente", bien: "Bien", prix: "Voir le prix", total: "Total" };
const NL = { vente: "Nieuwe verkoop", bien: "Woning", prix: "De prijs bekijken", total: "Totaal" };

async function toPriceStep(warnings: string[], minLeadDays?: number, w = FR) {
  const user = userEvent.setup({ advanceTimers: () => {} });
  renderApp("/calendrier", [(c) => (c.path === "/quote" ? { body: quote(warnings, minLeadDays) } : undefined)]);
  await user.click(await screen.findByRole("button", { name: w.vente }));
  await user.click((await screen.findAllByLabelText(w.bien))[0]!);
  await user.click(await screen.findByText("La Maison du Scieur", { selector: "[role=option], [role=option] *" }));
  await user.click(screen.getByRole("button", { name: w.prix }));
  await waitFor(() => expect(screen.getByText(w.total)).toBeInTheDocument());
}

describe("vente manuelle : avertissements du devis", () => {
  it("délai minimum non tenu : l'avertissement s'affiche et la vente reste possible", async () => {
    await toPriceStep(["lead_time"], 3);
    expect(screen.getByText(/refuserait cette arrivée : il faut réserver au moins 3 jours avant/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuer" })).toBeEnabled();
  });

  it("délai d'un jour : « au plus tard la veille »", async () => {
    await toPriceStep(["lead_time"], 1);
    expect(screen.getByText(/il faut réserver au plus tard la veille/)).toBeInTheDocument();
  });

  it("en néerlandais aussi", async () => {
    activate("nl");
    await toPriceStep(["lead_time"], 3, NL);
    expect(screen.getByText(/minstens 3 dagen vooraf/)).toBeInTheDocument();
  });

  it("aucun avertissement : rien d'affiché", async () => {
    await toPriceStep([]);
    expect(screen.queryByText(/refuserait cette arrivée/)).toBeNull();
  });
});
