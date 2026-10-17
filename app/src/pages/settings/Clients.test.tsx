// Liste des clients : la colonne « Séjours » ne compte pas les séjours annulés
// (comme « Total des séjours », « Gîte » et « Dernier séjour »).
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

beforeEach(() => setWide(true));
afterEach(() => vi.unstubAllGlobals());

const guest = (over: object) => ({ id: 1, email: null, firstName: "Alix", lastName: "Dupont", phone: null, address: null, country: null, lang: "fr", notes: null, createdAt: "2026-09-01 10:00:00", ...over });

describe("clients : colonne Séjours", () => {
  it("un client dont l'unique réservation est annulée affiche 0 séjour", async () => {
    renderApp("/reglages/clients", [
      (c) =>
        c.path === "/guests" && c.method === "GET"
          ? { body: { guests: [guest({ id: 1, lastName: "Annulé", bookingsCount: 1, staysCount: 0, totalSpentCents: 0 }), guest({ id: 2, lastName: "Venu", bookingsCount: 3, staysCount: 2, totalSpentCents: 90000, gites: "La Scierie", lastCheckin: "2026-10-01", lastCheckout: "2026-10-04", lastBookedAt: "2026-09-02 10:00:00" })] } }
          : undefined,
    ]);
    const annule = (await screen.findByRole("button", { name: "Alix Annulé" })).closest("tr")!;
    expect(within(annule).getAllByRole("cell")[6]).toHaveTextContent("0");
    const venu = screen.getByRole("button", { name: "Alix Venu" }).closest("tr")!;
    expect(within(venu).getAllByRole("cell")[6]).toHaveTextContent("2");
  });
});
