// Journal « ce qui a été fait » : les connexions, paiements et remboursements se
// lisent en clair, dans la langue de l'écran, au lieu du code de l'action (« login ok »).
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate } from "../../i18n";
import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

beforeEach(() => setWide(true));
afterEach(() => {
  vi.unstubAllGlobals();
  activate("fr");
});

const entries = [
  { id: 3, actor: "admin", action: "refund.exceptional", entity: "booking:5", detail: null, createdAt: "2026-10-17 21:30:00" },
  { id: 2, actor: "admin", action: "payment.received", entity: "booking:5", detail: null, createdAt: "2026-10-17 21:20:00" },
  { id: 1, actor: "admin", action: "login.ok", entity: "user:pilote", detail: null, createdAt: "2026-10-17 21:10:00" },
];
const handler = [(c: { path: string }) => (c.path === "/audit" ? { body: { entries } } : undefined)];

describe("journal d'audit", () => {
  it("en français : libellés lisibles, plus de « login ok »", async () => {
    renderApp("/reglages/journaux", handler);
    expect(await screen.findByText("connexion réussie")).toBeInTheDocument();
    expect(screen.getByText("paiement reçu")).toBeInTheDocument();
    expect(screen.getByText("remboursement exceptionnel")).toBeInTheDocument();
    expect(screen.queryByText("login ok")).toBeNull();
  });

  it("en néerlandais", async () => {
    activate("nl");
    renderApp("/reglages/journaux", handler);
    expect(await screen.findByText("aanmelding gelukt")).toBeInTheDocument();
    expect(screen.getByText("betaling ontvangen")).toBeInTheDocument();
  });
});
