// Écrans du lot 1 : thème clair par défaut, panneaux latéraux (saisie
// protégée), un seul « Enregistrer » par page, code Beds24, comptes.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNITS } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

const PROPERTY = { id: 1, slug: "pre-more", name: "Les Gîtes du Pré Moré", address: "Hameau", commune: "Daverdisse", contactEmail: "a@example.com", contactPhone: "0470 00 00 01", beds24PropertyId: null };
const SETTINGS = { depositPct: 30, balanceDueDays: 30, holdMinutes: 30, touristTaxCentsPerPersonNight: 0, touristTaxIncludeChildren: true, cautionCents: 0, checkinTime: "16:00", checkoutTime: "10:00", cgvText: "Article 1", allowDeposit: true, allowFullPayment: true, autoReplyEnabled: false, autoReplyText: "", emailForwardTo: "" };
const FULL_UNITS = UNITS.map((u) => ({ ...u, description: "", photoUrl: null, beds24RoomId: null, priceMinCents: null, priceMaxCents: null, depositPct: null }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("thème", () => {
  it("s'ouvre en clair même si l'appareil est en sombre, et retient le choix", async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: q.includes("dark") || q.includes("min-width: 900px"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })) as unknown as typeof window.matchMedia;
    const user = userEvent.setup();
    renderApp("/reglages");
    await screen.findByRole("heading", { name: "Réglages" });
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
    await user.click(screen.getByRole("button", { name: /Sombre/ }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "dark"));
    expect(localStorage.getItem("gp2_theme")).toBe("dark");
  });
});

describe("prix et saisons", () => {
  const seasons = [
    { id: 1, name: "Été", dateStart: "2027-07-01", dateEnd: "2027-08-31", priority: 9 },
    { id: 2, name: "Fête du village", dateStart: "2027-07-14", dateEnd: "2027-07-16", priority: 1 },
  ];
  const rules = [{ id: 11, unitId: 2, seasonId: null, priceWeekCents: 12000, priceWeekendCents: 15000, holidayPct: 15, minNights: 2, checkinDays: null }];
  const handlers = [(c: { path: string; method: string }) => (c.path === "/seasons" && c.method === "GET" ? { body: { seasons } } : c.path === "/rate-rules" && c.method === "GET" ? { body: { rules } } : c.path === "/seasons" && c.method === "POST" ? { status: 201, body: { id: 3 } } : undefined)];

  it("dit en clair quand la plus longue saison l'emporte et range selon la règle", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/tarifs", handlers);
    expect(await screen.findByText(/Été passe devant Fête du village/)).toBeInTheDocument();
    expect(screen.queryByText(/priorité/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ranger selon la règle" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/seasons/2")).toBe(true));
    const p2 = calls.find((c) => c.path === "/seasons/2")!.body as { priority: number };
    const p1 = (calls.find((c) => c.path === "/seasons/1")?.body as { priority: number } | undefined)?.priority ?? 9;
    expect(p2.priority).toBeGreaterThan(p1);
  });

  it("prix de base : panneau latéral, saisie gardée au clic à côté, PATCH à l'enregistrement", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/tarifs", handlers);
    await user.click(await screen.findByRole("tab", { name: "Prix de base" }));
    await user.click(screen.getByText("La Scierie").closest("button")!);
    const panel = await screen.findByRole("dialog");
    const we = within(panel).getByLabelText(/Nuit du week-end/);
    await user.clear(we);
    await user.type(we, "160");
    // la croix demande avant de perdre la saisie
    await user.click(within(panel).getByRole("button", { name: "Fermer" }));
    expect(await screen.findByRole("dialog", { name: "Fermer sans enregistrer ?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuer la saisie" }));
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path === "/rate-rules/11")?.body).toMatchObject({ priceWeekendCents: 16000, priceWeekCents: 12000 }));
  });
});

describe("le domaine et les biens", () => {
  it("un seul Enregistrer, qui n'envoie que ce qui a changé", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/domaine", [(c) => (c.path === "/settings" && c.method === "GET" ? { body: { property: PROPERTY, settings: SETTINGS, units: FULL_UNITS } } : undefined)]);
    const phone = await screen.findByLabelText("Téléphone");
    expect(screen.queryByText("Modifications non enregistrées.")).toBeNull();
    await user.clear(phone);
    await user.type(phone, "0470 99");
    expect(await screen.findByText("Modifications non enregistrées.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path === "/properties/1")?.body).toMatchObject({ contactPhone: "0470 99" }));
    expect(calls.some((c) => c.method === "PUT" && c.path === "/settings")).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.path.startsWith("/units/"))).toBe(false);
  });
});

describe("plateformes", () => {
  const overview = { configured: false, webhookUrl: null, property: { id: 1, name: "x", beds24PropertyId: null }, units: [], channelBookings: [], lastPull: null, events: [], conflicts: [{ id: 5, source: "beds24", kind: "x", status: "open", unitId: 1, unitName: "La Maison du Scieur", checkin: "2026-11-01", checkout: "2026-11-03", bookingReference: null, channelLabel: "Airbnb", label: "Dates prises sur Airbnb", firstSeenAt: "2026-10-01 10:00:00", lastSeenAt: "2026-10-09 10:00:00", ignoreReason: null }] };
  const markups = { channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 18 }], examples: [{ channel: "airbnb", label: "Airbnb", markupPct: 18, suggestedCents: 23600 }], formula: "", maxPct: 50, pushChannel: null, pushMarkupPct: 0, example: { directCents: 20000, pushedCents: 20000 } };
  const h = (c: { path: string; method: string }) => (c.path === "/channels/overview" ? { body: overview } : c.path === "/channel-markups" && c.method === "GET" ? { body: markups } : c.path === "/beds24/invite-code" ? { status: 502, body: { error: "code d'invitation refusé par Beds24" } } : undefined);

  it("le code d'invitation part tel quel ; un refus est dit en clair", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/plateformes", [h]);
    expect(await screen.findByRole("heading", { name: "Liaison coupée" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Code d'invitation Beds24"), "  ABCDEF123  ");
    await user.click(screen.getByRole("button", { name: "Rétablir la liaison" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/beds24/invite-code")?.body).toEqual({ code: "ABCDEF123" }));
    expect((await screen.findAllByRole("alert")).some((a) => /Le code n'a pas été accepté/.test(a.textContent ?? ""))).toBe(true);
  });

  it("mettre un désaccord de côté demande un motif", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/plateformes", [h]);
    await user.click((await screen.findByText("La Maison du Scieur")).closest("button")!);
    await user.click(await screen.findByRole("button", { name: "Mettre de côté" }));
    const box = await screen.findByRole("dialog", { name: /Mettre ce désaccord de côté/ });
    const go = within(box).getByRole("button", { name: "Mettre de côté" });
    expect(go).toBeDisabled();
    await user.type(within(box).getByLabelText("Motif"), "Doublon déjà réglé");
    await user.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === "/sync-conflicts/5")?.body).toEqual({ status: "ignored", reason: "Doublon déjà réglé" }));
  });
});

describe("comptes", () => {
  it("créer un accès montre le mot de passe une fois", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/comptes", [(c) => (c.path === "/users" && c.method === "GET" ? { body: { users: [{ id: 1, username: "pilote", active: 1, created_at: "2026-10-01 10:00:00", last_login_at: null, sessions: 1 }] } } : c.path === "/users" && c.method === "POST" ? { body: { ok: true, id: 2, username: "papa", password: "pomme-table-lune-42" } } : undefined)]);
    await user.click(await screen.findByRole("button", { name: "Donner un accès" }));
    await user.type(await screen.findByLabelText("Identifiant"), "Papa");
    await user.click(screen.getByRole("button", { name: "Créer le compte" }));
    expect(await screen.findByText("pomme-table-lune-42")).toBeInTheDocument();
  });
});
