// Historique des échanges d'un client : fiche client, filtres, contenu d'un mail,
// libellés en français simple, lien depuis la fiche d'une réservation.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

const GUEST = { id: 3, email: "oudewaeter@example.com", firstName: "Gwenola", lastName: "Oudewaeter", phone: null, address: null, country: null, lang: "fr", notes: null, createdAt: "2026-09-01 10:00:00", bookingsCount: 1, totalSpentCents: 201000 };

const item = (o: Record<string, unknown>) => ({ source: "mail", direction: "out", kind: "confirmation", channel: null, canal: null, subject: "", bodyText: "", status: "sent", errorDetail: null, at: "2026-10-01 10:00:00", bookingId: 7, address: GUEST.email, attachments: [], ...o });
const HISTORY = {
  guest: { id: 3, name: "Gwenola Oudewaeter", email: GUEST.email },
  stays: [{ bookingId: 7, reference: "PM-2026-007", unitName: "La Maison du Scieur", checkin: "2026-10-23", checkout: "2026-10-30", status: "confirmed" }],
  items: [
    item({ key: "mail:3", kind: "stay_j7", subject: "[PM-2026-007] Infos d'arrivée", status: "stub", at: "2026-10-16 08:00:00", bodyText: "Voici le code de la boîte à clés." }),
    item({ key: "msg:9", source: "message", direction: "in", kind: "message", channel: "beds24", canal: "Airbnb", subject: "Arrivée tardive", status: null, at: "2026-10-05 18:00:00", address: "airbnb", bodyText: "Nous arriverons vers 20 h." }),
    item({ key: "mail:2", kind: "payment_failed", subject: "[PM-2026-007] Paiement non abouti", status: "failed", errorDetail: "carte refusée", at: "2026-10-02 09:00:00" }),
    item({ key: "mail:1", kind: "confirmation", subject: "[PM-2026-007] Confirmation", at: "2026-10-01 10:00:00" }),
    item({ key: "msg:4", source: "message", direction: "in", kind: "message", channel: "form", subject: "Le sauna ?", status: null, at: "2026-09-02 10:00:00", bookingId: null, address: GUEST.email, bodyText: "Le sauna est-il ouvert ?" }),
  ],
};
const handlers = [
  (c: { path: string; method: string }) => (c.path === "/guests" && c.method === "GET" ? { body: { guests: [GUEST] } } : undefined),
  (c: { path: string; method: string }) => (c.path === "/guests/3" && c.method === "GET" ? { body: { guest: GUEST, bookings: [{ ...BOOKING, unitName: "La Maison du Scieur" }] } } : undefined),
  (c: { path: string; method: string }) => (c.path === "/guests/3/history" ? { body: HISTORY } : undefined),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("historique des mails d'un client", () => {
  it("un clic sur un client montre ses échanges par séjour, avec des libellés en français simple", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/clients", handlers);
    await user.click(await screen.findByRole("button", { name: "Gwenola Oudewaeter" }));
    const hx = await screen.findByRole("region", { name: "Échanges avec ce client" });
    expect(within(hx).getByText("La Maison du Scieur")).toBeInTheDocument();
    expect(within(hx).getByText("Hors séjour")).toBeInTheDocument();
    expect(within(hx).getByText("Infos d'arrivée (J-7)")).toBeInTheDocument();
    expect(within(hx).getByText("Paiement non abouti")).toBeInTheDocument();
    expect(within(hx).getByText("préparé, non envoyé (envoi coupé)")).toBeInTheDocument();
    expect(within(hx).getByText("Message reçu de Airbnb")).toBeInTheDocument();
    expect(within(hx).getByText("Message écrit sur le site")).toBeInTheDocument();
    expect(within(hx).getByText("pas parti")).toBeInTheDocument();
  });

  it("les filtres Tous / Envoyés / Reçus comptent et trient", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/clients", handlers);
    await user.click(await screen.findByRole("button", { name: "Gwenola Oudewaeter" }));
    const hx = await screen.findByRole("region", { name: "Échanges avec ce client" });
    expect(within(hx).getByRole("button", { name: "Tous (5)" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(hx).getByRole("button", { name: "Reçus (2)" }));
    expect(within(hx).queryByText("Infos d'arrivée (J-7)")).toBeNull();
    expect(within(hx).getByText("Message reçu de Airbnb")).toBeInTheDocument();
    await user.click(within(hx).getByRole("button", { name: "Envoyés (3)" }));
    expect(within(hx).queryByText("Message reçu de Airbnb")).toBeNull();
    expect(within(hx).queryByText("Hors séjour")).toBeNull();
    expect(within(hx).getByText("Confirmation de réservation")).toBeInTheDocument();
  });

  it("un clic sur un mail en ouvre le contenu, et la raison d'un échec", async () => {
    const user = userEvent.setup();
    renderApp("/reglages/clients", handlers);
    await user.click(await screen.findByRole("button", { name: "Gwenola Oudewaeter" }));
    const hx = await screen.findByRole("region", { name: "Échanges avec ce client" });
    expect(within(hx).queryByText("Voici le code de la boîte à clés.")).toBeNull();
    await user.click(within(hx).getByRole("button", { name: /Infos d'arrivée \(J-7\)/ }));
    expect(within(hx).getByText("Voici le code de la boîte à clés.")).toBeInTheDocument();
    await user.click(within(hx).getByRole("button", { name: /Paiement non abouti/ }));
    expect(within(hx).getByText(/carte refusée/)).toBeInTheDocument();
  });

  it("la fiche d'une réservation mène à l'historique de son client", async () => {
    const user = userEvent.setup();
    renderApp("/calendrier?resa=7", handlers);
    await user.click(await screen.findByRole("button", { name: /Tous les mails et messages de ce client/ }));
    expect(await screen.findByRole("region", { name: "Échanges avec ce client" })).toBeInTheDocument();
    expect(screen.getByText("Clients", { selector: "h1" })).toBeInTheDocument();
  });
});
