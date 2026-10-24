// Réglages › Le domaine : signature des messages (texte, HTML, case), aperçu isolé,
// adresses de l'équipe et de la famille (réglage global).
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNITS } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { setWide } from "../../test/setup";

const PROPERTY = { id: 1, slug: "pre-more", name: "Les Gîtes du Pré Moré", address: "Hameau", commune: "Daverdisse", contactEmail: "a@example.com", contactPhone: "0470 00 00 01", beds24PropertyId: null };
const SETTINGS = { depositPct: 30, balanceDueDays: 30, holdMinutes: 30, touristTaxCentsPerPersonNight: 0, touristTaxIncludeChildren: true, cautionCents: 0, checkinTime: "16:00", checkoutTime: "10:00", cgvText: "Article 1", allowDeposit: true, allowFullPayment: true, autoReplyEnabled: false, autoReplyText: "", emailForwardTo: "", stayEmailsEnabled: false, reviewUrl: "", arrivalInfoText: "", signatureText: "", signatureHtml: "", signatureOnReplies: false };
const FULL_UNITS = UNITS.map((u) => ({ ...u, description: "", photoUrl: null, beds24RoomId: null, priceMinCents: null, priceMaxCents: null, depositPct: null }));
const handler = (c: { path: string; method: string }) => (c.path === "/settings" && c.method === "GET" ? { body: { property: PROPERTY, settings: SETTINGS, units: FULL_UNITS } } : undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
  setWide(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("signature des messages", () => {
  it("les trois champs partent avec le seul Enregistrer ; l'aperçu est un cadre sans aucun droit (pas de script)", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/domaine", [handler]);
    const txt = await screen.findByLabelText("Signature (texte)");
    await user.type(txt, "Jean-Philippe");
    const html = screen.getByLabelText(/Signature \(HTML\)/);
    await user.click(html);
    await user.paste('<table><tr><td><img src="/img/signature-pre-more.jpg"></td></tr></table><script>alert(1)</script>');
    await user.click(screen.getByRole("switch", { name: "Ajouter la signature aux réponses et messages" }));
    const frame = (await screen.findByTitle("Aperçu de la signature")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe(""); // aucune permission : pas de script, pas de formulaire, pas de navigation
    expect(frame.getAttribute("srcdoc")).toContain("signature-pre-more.jpg");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/settings")).toBeTruthy());
    const body = calls.find((c) => c.method === "PUT" && c.path === "/settings")!.body as { settings: Record<string, unknown> };
    expect(body.settings).toMatchObject({ signature_text: "Jean-Philippe", signature_on_replies: true });
    expect(String(body.settings.signature_html)).toContain("<table>");
  });
});

describe("adresses de l'équipe et de la famille", () => {
  it("enregistrées à part (réglage global), une adresse par ligne", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/reglages/domaine", [handler, (c) => (c.path === "/mailbox" ? { body: { configured: true, supported: true, note: null, address: "x@gmail.com", teamAddresses: ["famille@example.com"] } } : undefined)]);
    const box = (await screen.findByLabelText("Adresses de l'équipe et de la famille")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("famille@example.com"));
    await user.type(box, "{Enter}j.decartier@example.com");
    await user.click(screen.getByRole("button", { name: "Enregistrer les adresses" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/mailbox/team")?.body).toEqual({ addresses: "famille@example.com\nj.decartier@example.com" }));
  });
});
