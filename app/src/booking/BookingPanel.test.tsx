// Fiche réservation : chaque action dit « C'est fait » ou l'erreur en clair ;
// la boîte d'annulation demande un motif et ne se ferme pas d'elle-même.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setWide } from "../test/setup";
import { renderApp } from "../test/render";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fiche réservation", () => {
  it("montre le téléphone cliquable et les trois actions du solde", async () => {
    renderApp("/calendrier?resa=7");
    expect(await screen.findByRole("heading", { name: "Gwenola Oudewaeter" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /\+32 470 00 01 05/ })).toHaveAttribute("href", "tel:+32470000105");
    expect(screen.getByRole("button", { name: /Encaisser le solde/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Envoyer un rappel/ })).toBeInTheDocument();
    expect(screen.getByText(/En retard de 17 jours/)).toBeInTheDocument();
  });

  it("« Envoyer un rappel » se verrouille puis dit « C'est fait »", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/calendrier?resa=7");
    await user.click(await screen.findByRole("button", { name: /Envoyer un rappel/ }));
    expect(await screen.findByRole("button", { name: /C'est fait/ })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/bookings/7/balance-reminder")).toBe(true);
  });

  it("un refus du serveur s'affiche en clair dans la fiche", async () => {
    const user = userEvent.setup();
    renderApp("/calendrier?resa=7", [(c) => (c.path === "/bookings/7/balance-reminder" ? { status: 400, body: { error: "pas d'email client sur cette réservation" } } : undefined)]);
    await user.click(await screen.findByRole("button", { name: /Envoyer un rappel/ }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("Pas d'email client sur cette réservation."))).toBe(true);
    expect(screen.getByRole("button", { name: /Envoyer un rappel/ })).toBeEnabled();
  });

  it("annuler : motif obligatoire, la boîte reste ouverte tant que rien n'est fait", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/calendrier?resa=7");
    await user.click(await screen.findByRole("button", { name: /^Plus$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Annuler la réservation" }));
    const box = await screen.findByRole("dialog", { name: /Annuler la réservation PM-2026-007/ });
    const go = within(box).getByRole("button", { name: "Annuler la réservation" });
    expect(go).toBeDisabled();
    await user.type(within(box).getByLabelText(/Motif/), "Client malade");
    await user.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === "/bookings/7/cancel")?.body).toEqual({ reason: "Client malade" }));
  });

  it("encaisser : le montant proposé est le solde, la boîte envoie le paiement", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/calendrier?resa=7");
    await user.click(await screen.findByRole("button", { name: /Encaisser le solde/ }));
    const box = await screen.findByRole("dialog", { name: /Encaisser un paiement/ });
    await user.click(within(box).getByRole("button", { name: /Noter 1\s005\s€ reçus/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "/bookings/7/payments")?.body).toMatchObject({ amountCents: 100500, method: "transfer", kind: "balance" }));
  });
});
