// Calendrier : choisir une plage dans la ligne des prix ouvre le popover ;
// « + 10 % » envoie les bonnes plages ; un refus du serveur s'affiche en clair.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

async function cell(unit: number, date: string) {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`.pc[data-unit="${unit}"][data-date="${date}"]`);
    if (!el) throw new Error("cellule absente");
    return el;
  });
}

function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.pointerDown(from, { button: 0, pointerId: 1 });
  fireEvent.pointerEnter(to, { pointerId: 1 });
  fireEvent.pointerUp(to, { pointerId: 1 });
}

describe("calendrier multi-biens", () => {
  it("une plage glissée ouvre le popover sur ces nuits", async () => {
    renderApp("/calendrier");
    drag(await cell(1, "2026-10-19"), await cell(1, "2026-10-21"));
    const pop = await screen.findByRole("dialog", { name: /Nuits du lundi 19 octobre au mercredi 21 octobre/ });
    expect(within(pop).getByText(/3 nuits, départ le jeudi 22 octobre/)).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Appliquer à 3 nuits" })).toBeEnabled();
  });

  it("+ 10 % envoie le nouveau prix arrondi et dit « C'est fait »", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/calendrier");
    drag(await cell(1, "2026-10-19"), await cell(1, "2026-10-21"));
    const pop = await screen.findByRole("dialog", { name: /Nuits du lundi 19/ });
    await user.click(within(pop).getByRole("button", { name: "+ 10 %" }));
    await user.click(within(pop).getByRole("button", { name: "Appliquer à 3 nuits" }));
    await within(pop).findByText(/C'est fait\. \+ 10 % sur 3 nuits/);
    const patch = calls.filter((c) => c.method === "PATCH" && c.path === "/rate-overrides");
    expect(patch).toHaveLength(1);
    expect(patch[0]?.body).toEqual({ unitId: 1, from: "2026-10-19", to: "2026-10-21", priceCents: 20000 });
  });

  it("un refus du serveur s'affiche en clair, le popover reste ouvert", async () => {
    const user = userEvent.setup();
    renderApp("/calendrier", [(c) => (c.method === "PATCH" ? { status: 400, body: { error: "prix hors des bornes du bien (100 € à 190 €)" } } : undefined)]);
    fireEvent.keyDown(await cell(1, "2026-10-19"), { key: "Enter" });
    const pop = await screen.findByRole("dialog", { name: /Nuit du lundi 19 octobre/ });
    await user.click(within(pop).getByRole("button", { name: "Appliquer à 1 nuits" }));
    expect(await within(pop).findByRole("alert")).toHaveTextContent("Rien n'a été changé. La Maison du Scieur : Prix hors des bornes du bien (100 € à 190 €).");
    expect(screen.getByRole("dialog", { name: /Nuit du lundi 19 octobre/ })).toBeInTheDocument();
  });

  it("bloquer demande un motif, puis envoie le blocage", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/calendrier");
    drag(await cell(2, "2026-10-13"), await cell(2, "2026-10-14"));
    const pop = await screen.findByRole("dialog", { name: /Nuits du mardi 13/ });
    await user.click(within(pop).getByRole("button", { name: "Bloquer ces nuits" }));
    const go = within(pop).getByRole("button", { name: "Bloquer 2 nuits" });
    expect(go).toBeDisabled();
    await user.type(within(pop).getByLabelText(/Pourquoi/), "Travaux");
    await user.click(go);
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/blocks")?.body).toEqual({ unitId: 2, checkin: "2026-10-13", checkout: "2026-10-15", reason: "Travaux" }));
  });
});
