// Écrans du lot 3 : promotions Airbnb et prix par plateforme (Réglages ›
// Plateformes › Promotions), carte « Avis » d'Aujourd'hui.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";
import type { Call } from "../../test/fakeApi";

const PROMO = { weeklyPct: 10, biweeklyPct: 0, monthlyPct: 0, earlyBirdDays: null, earlyBirdPct: 0, lastMinuteDays: null, lastMinutePct: 0, nonRefundablePct: 0 };
const preview = (stayCents: number, nights: number, weekly: number) => {
  const airbnbCents = Math.round(stayCents * 1.18);
  const lengthPct = nights >= 7 ? weekly : 0;
  return { stayCents, nights, markupPct: 18, airbnbCents, lengthPct, withLengthCents: Math.round(airbnbCents * (1 - lengthPct / 100)), nonRefundableCents: null, earlyBirdCents: null, lastMinuteCents: null };
};
const state = (writes: boolean, promotions = PROMO, sentSame = false) => ({
  propertyId: 1, promotions, earlyBirdDays: [28, 30, 60, 90], markupPct: 18, markupSource: "prix dérivé Airbnb",
  preview: preview(140_000, 7, promotions.weeklyPct),
  beds24: { configured: true, writesAllowed: writes, reason: null, linked: true, rooms: 2 },
  lastSent: sentSame ? { at: "2026-10-09 10:00:00", by: "julien" } : null, sentSame,
});
const linking = (enabled: boolean, writes = true) => ({
  enabled, lines: [{ channel: "airbnb", label: "Airbnb", beds24Channel: "airbnb", markupPct: 18, multiplier: 1.18, priceId: 2, exampleCents: 11800 }, { channel: "booking", label: "Booking.com", beds24Channel: "booking", markupPct: 18, multiplier: 1.18, priceId: 3, exampleCents: 11800 }],
  unlinked: [], exampleDirectCents: 10000, pushChannel: null, pushPct: 0, upToDate: enabled, sentAt: enabled ? "2026-10-09 10:00:00" : null,
  beds24: { configured: true, writesAllowed: writes, reason: null, linked: 1 },
});

function handlers(opts: { writes: boolean; linked?: boolean }) {
  let promo = PROMO;
  let linkOn = opts.linked ?? false;
  return [
    (c: Call) => {
      if (c.path === "/channels/airbnb-promotions" && c.method === "GET") return { body: state(opts.writes, promo) };
      if (c.path === "/channels/airbnb-promotions" && c.method === "PUT") {
        promo = (c.body as { promotions: typeof PROMO }).promotions;
        return { body: state(opts.writes, promo) };
      }
      if (c.path === "/channels/airbnb-promotions/preview") {
        const b = c.body as { promotions: typeof PROMO; stayCents: number; nights: number };
        return { body: preview(b.stayCents, b.nights, b.promotions.weeklyPct) };
      }
      if (c.path === "/channels/airbnb-promotions/send") return { body: state(opts.writes, promo, true) };
      if (c.path === "/channels/price-linking" && c.method === "GET") return { body: linking(linkOn, opts.writes) };
      if (c.path === "/channels/price-linking" && c.method === "POST") {
        linkOn = (c.body as { enabled: boolean }).enabled;
        return { body: linking(linkOn, opts.writes) };
      }
      return undefined;
    },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("promotions Airbnb et prix par plateforme", () => {
  it("aperçu chiffré : 7 nuits à 1 400 € partent à 1 486,80 € sur Airbnb, et suivent la saisie", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/plateformes/prix", handlers({ writes: true }));
    expect(await screen.findByTestId("apercu")).toHaveTextContent("Un séjour de 7 nuits à 1 400 € part à 1 486,80 € sur Airbnb");
    const weekly = screen.getByLabelText("7 nuits et plus");
    await user.clear(weekly);
    await user.type(weekly, "20");
    await waitFor(() => expect(screen.getByTestId("apercu")).toHaveTextContent("part à 1 321,60 €"));
  });

  it("enregistrer puis envoyer à Airbnb, avec confirmation", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/plateformes/prix", handlers({ writes: true }));
    const weekly = await screen.findByLabelText("7 nuits et plus");
    expect(screen.getByRole("button", { name: "Envoyer à Airbnb" })).toBeEnabled();
    await user.clear(weekly);
    await user.type(weekly, "15");
    // une saisie non enregistrée ne part pas
    expect(screen.getByRole("button", { name: "Envoyer à Airbnb" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Enregistrer les promotions" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/channels/airbnb-promotions")).toBe(true));
    expect((calls.find((c) => c.method === "PUT")!.body as { promotions: typeof PROMO }).promotions.weeklyPct).toBe(15);
    await user.click(await screen.findByRole("button", { name: "Envoyer à Airbnb" }));
    await user.click(await screen.findByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/channels/airbnb-promotions/send")).toBe(true));
  });

  it("écritures fermées : les boutons d'envoi sont grisés et l'écran dit pourquoi", async () => {
    renderApp("/reglages/plateformes/prix", handlers({ writes: false }));
    expect(await screen.findByRole("button", { name: "Envoyer à Airbnb" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Donner à chaque plateforme son prix" })).toBeDisabled();
    expect(screen.getAllByText(/Ce serveur n'envoie rien à Beds24/).length).toBeGreaterThan(0);
  });

  it("prix par plateforme : tableau prix du site × 1,18, activation confirmée", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/plateformes/prix", handlers({ writes: true }));
    expect(await screen.findAllByText("prix du site × 1,18 (+ 18 %)")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Donner à chaque plateforme son prix" }));
    await user.click(await screen.findByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/channels/price-linking" && (c.body as { enabled: boolean }).enabled)).toBe(true));
    expect(await screen.findByText("En place : chaque plateforme a son propre prix.")).toBeInTheDocument();
  });

  it("l'écran Plateformes mène aux promotions", async () => {
    renderApp("/reglages/plateformes", [
      ...handlers({ writes: true, linked: true }),
      (c: Call) => (c.path === "/channels/overview" ? { body: { configured: true, lastPull: null, property: { id: 1, beds24PropertyId: 344555 }, units: [], channelBookings: [], conflicts: [], events: [], webhookUrl: null } } : c.path === "/channel-markups" ? { body: { channels: [], examples: [], formula: "", maxPct: 50, pushChannel: null, pushMarkupPct: 0, example: { directCents: 20000, pushedCents: 20000 } } } : undefined),
    ]);
    expect(await screen.findByRole("link", { name: "Régler les promotions et les prix par plateforme" })).toBeInTheDocument();
    expect(await screen.findByText(/Prix par plateforme en place/)).toBeInTheDocument();
  });
});

describe("carte « Avis » d'Aujourd'hui", () => {
  const reviews = {
    count: 3, average: 4.2, byChannel: [{ channel: "airbnb", count: 2, average: 4 }, { channel: "booking", count: 1, average: 4.5 }],
    latest: [{ id: 1, channel: "booking", rating: 4.5, rawScore: 9, rawScale: 10, reviewerName: "Pieter", headline: "Rustig en mooi", body: null, negative: null, replied: false, submittedAt: "2026-10-07 09:00:00", unitName: null }],
    low: [{ id: 2, channel: "airbnb", rating: 3, rawScore: 3, rawScale: 5, reviewerName: null, headline: null, body: "Un peu froid le soir.", negative: null, replied: false, submittedAt: "2026-10-05 10:00:00", unitName: "La Scierie" }],
    replyUrl: "https://beds24.com/control3.php", lowScore: 4,
  };
  const h = [(c: Call) => (c.path === "/reviews" ? { body: reviews } : undefined)];

  it("à l'ordinateur : note moyenne, dernier avis, alerte sous 4, lien vers Beds24", async () => {
    renderApp("/", h);
    expect(await screen.findByText("4,2 / 5")).toBeInTheDocument();
    expect(screen.getByText(/1 avis sous 4 sans réponse/)).toBeInTheDocument();
    expect(screen.getByText(/Rustig en mooi/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Répondre dans Beds24" })).toHaveAttribute("href", "https://beds24.com/control3.php");
  });

  it("au téléphone : la carte montre l'avis à traiter", async () => {
    setWide(false);
    renderApp("/", h);
    expect(await screen.findByText("4,2 / 5 sur 3 avis")).toBeInTheDocument();
    expect(screen.getByText("Un avis sous 4 attend une réponse.")).toBeInTheDocument();
    expect(screen.getByText(/Un peu froid le soir/)).toBeInTheDocument();
  });

  it("aucun avis relevé : rien ne s'affiche", async () => {
    renderApp("/", [(c: Call) => (c.path === "/reviews" ? { body: { ...reviews, count: 0, latest: [], low: [], byChannel: [], average: null } } : undefined)]);
    await screen.findByLabelText("La journée");
    expect(screen.queryByText(/Répondre dans Beds24/)).toBeNull();
  });
});

describe("aide « Comment ça marche »", () => {
  it("s'ouvre depuis Réglages et couvre les sept points, en vouvoiement", async () => {
    const user = userEvent.setup();
    renderApp("/reglages");
    await user.click(await screen.findByRole("link", { name: /Comment ça marche/ }));
    expect(await screen.findByRole("heading", { name: "Comment ça marche", level: 1 })).toBeInTheDocument();
    for (const h of ["Une journée type", "Le calendrier", "Vendre par téléphone", "Le ménage", "Les messages", "Ce qui se fait tout seul", "Qui appeler"]) {
      expect(screen.getByRole("heading", { name: h, level: 2 })).toBeInTheDocument();
    }
    // vouvoiement : aucune forme en « tu »
    const text = [...document.querySelectorAll(".help-part")].map((e) => e.textContent).join(" ");
    expect(text).toMatch(/\bvous\b/);
    expect(text).not.toMatch(/\b(tu|ton|ta|tes)\b/i);
    // chaque partie illustrée montre une capture de l'écran réel
    const imgs = screen.getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(expect.arrayContaining([expect.stringMatching(/aide\/aujourdhui\.png$/), expect.stringMatching(/aide\/calendrier\.png$/)]));
  });
});
