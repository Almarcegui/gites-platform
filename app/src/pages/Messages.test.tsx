// Messages (24/10/2026) : liste compacte (une ligne fine par fil, ni objet ni aperçu),
// onglets Réservations / Autres avec compteurs, lien « Ouvrir Gmail », liens du message
// (ouverture seulement si l'expéditeur est attesté), objet avec référence, rattacher / détacher.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../api/types";
import { replySubject } from "../messages/subject";
import { threadKey } from "../messages/threads";
import { renderApp } from "../test/render";
import { setWide } from "../test/setup";

const base = (o: Partial<Message> & { id: number }): Message => ({
  propertyId: 1, direction: "in", channel: "email", canal: null, fromEmail: `c${o.id}@example.com`, fromName: `Client ${o.id}`, toEmail: "gites@example.com",
  subject: `Objet secret ${o.id}`, bodyText: "Bonjour", bookingId: null, bookingReference: null, guestId: null, status: "nouveau",
  receivedAt: "2026-10-10 07:00:00", attachments: [], ...o,
});

const MAILBOX = { configured: true, supported: true, note: null, address: "jphde.cartier@gmail.com", teamAddresses: [] };

/** Faux serveur de la liste : un fil par ligne (clé réservation, client, adresse), par section, paginé comme le vrai. */
function threadsOf(messages: Message[], q: Record<string, string>) {
  const section = q.section === "autres" ? "autres" : "resa";
  const pendingOnly = q.status !== "all";
  const before = q.before ? Number(q.before) : Infinity;
  const limit = Number(q.limit ?? 50);
  const mk = (m: Message) => threadKey(m);
  const groups = new Map<string, Message[]>();
  for (const m of [...messages].sort((a, b) => b.id - a.id)) {
    if ((m.bookingId != null) !== (section === "resa")) continue;
    if (pendingOnly && m.status !== "nouveau") continue;
    groups.set(mk(m), [...(groups.get(mk(m)) ?? []), m]);
  }
  const all = [...groups.entries()].map(([key, ms]) => ({ key, last: ms[0]!, pending: ms.filter((x) => x.status === "nouveau").length, count: ms.length, booked: key.startsWith("b:") }));
  const page = all.filter((r) => r.last.id < before);
  const pend = (booked: boolean) => new Set(messages.filter((m) => m.status === "nouveau" && (m.bookingId != null) === booked).map(mk)).size;
  return { threads: page.slice(0, limit), more: page.length > limit, counts: { resa: pend(true), autres: pend(false) }, origins: [{ channel: "email", canal: null, n: all.length, pending: all.length }] };
}

function handlers(messages: Message[], extra: Parameters<typeof renderApp>[1] = []) {
  return [
    ...extra,
    (c: { path: string; query: Record<string, string> }) => (c.path === "/mailbox" ? { body: MAILBOX } : undefined),
    (c: { path: string; query: Record<string, string> }) => (c.path === "/messages/threads" ? { body: threadsOf(messages, c.query) } : undefined),
    (c: { path: string }) => {
      const m = /^\/messages\/(\d+)\/thread$/.exec(c.path);
      const found = m ? messages.find((x) => x.id === Number(m[1])) : undefined;
      return found ? { body: { message: found, thread: [found] } } : undefined;
    },
  ] as Parameters<typeof renderApp>[1];
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

describe("clé d'un fil", () => {
  it("même règle que le serveur : réservation, sinon client, sinon adresse (minuscules)", () => {
    expect(threadKey(base({ id: 1, bookingId: 5 }))).toBe("b:5");
    expect(threadKey(base({ id: 2, guestId: 9 }))).toBe("g:9");
    expect(threadKey(base({ id: 3, fromEmail: "No-Reply@Google.com" }))).toBe("e:no-reply@google.com");
  });
});

describe("liste compacte", () => {
  it("une ligne fine par fil : nom, référence, origine, date, point ; pas d'objet affiché (title au survol)", async () => {
    const msgs = [
      base({ id: 1, bookingId: 5, bookingReference: "PM-2026-005", fromName: "Marie Lambert" }),
      base({ id: 2, fromName: "Google", fromEmail: "no-reply@google.com", status: "traité", receivedAt: "2026-10-07 07:00:00" }),
    ];
    renderApp("/messages", handlers(msgs));
    const row = (await screen.findByText("Marie Lambert", { selector: ".nm" })).closest("button")!;
    expect(row.className).toContain("conv");
    expect(within(row).getByText("PM-2026-005")).toBeInTheDocument();
    expect(within(row).getByText("Mail")).toBeInTheDocument(); // origine en abréviation
    expect(within(row).getByRole("img", { name: "À répondre" })).toBeInTheDocument();
    expect(row).toHaveAttribute("title", "Objet secret 1");
    // ni objet ni aperçu dans la ligne
    expect(within(row).queryByText(/Objet secret/)).toBeNull();
    const list = row.closest(".conv-scroll") as HTMLElement;
    expect(within(list).queryByText(/Bonjour|Objet secret/)).toBeNull();
    expect(row.querySelector("p")).toBeNull();
  });

  it("onglets Réservations / Autres avec leurs compteurs « à répondre » ; les fils Autres n'apparaissent pas dans Réservations", async () => {
    const user = userEvent.setup();
    const msgs = [
      base({ id: 1, bookingId: 5, bookingReference: "PM-2026-005", fromName: "Marie Lambert" }),
      base({ id: 2, bookingId: 6, bookingReference: "PM-2026-006", fromName: "Paul Durand" }),
      base({ id: 3, fromName: "Google", fromEmail: "no-reply@google.com" }),
      base({ id: 4, fromName: "Drive", fromEmail: "drive@google.com", status: "traité" }),
    ];
    renderApp("/messages", handlers(msgs));
    const tabResa = await screen.findByRole("tab", { name: "Réservations, 2 à répondre" });
    const tabAutres = screen.getByRole("tab", { name: "Autres, 1 à répondre" });
    expect(tabResa).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Marie Lambert", { selector: ".nm" })).toBeInTheDocument();
    expect(screen.queryByText("Google", { selector: ".nm" })).toBeNull();
    await user.click(tabAutres);
    expect(await screen.findByText("Google", { selector: ".nm" })).toBeInTheDocument();
    expect(screen.queryByText("Marie Lambert", { selector: ".nm" })).toBeNull();
    // « Tous » montre aussi le fil traité de la section
    await user.click(screen.getByRole("button", { name: "Tous" }));
    expect(await screen.findByText("Drive", { selector: ".nm" })).toBeInTheDocument();
  });

  it("250 fils de plusieurs messages : 50 par page, « Charger plus » jusqu'au bout, un seul onglet ne pousse pas l'autre", async () => {
    const user = userEvent.setup();
    const msgs: Message[] = [];
    for (let i = 1; i <= 250; i += 1) {
      for (let k = 0; k < 3; k += 1) msgs.push(base({ id: i * 10 + k, bookingId: i, bookingReference: `PM-2026-${String(i).padStart(3, "0")}`, fromName: `Client ${i}` }));
    }
    for (let i = 1; i <= 30; i += 1) msgs.push(base({ id: 5000 + i, fromEmail: `g${i}@google.com`, fromName: `Google ${i}` }));
    const { container } = renderApp("/messages", handlers(msgs));
    await waitFor(() => expect(container.querySelectorAll(".conv-scroll .conv")).toHaveLength(50));
    expect(screen.getByRole("tab", { name: "Réservations, 250 à répondre" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Autres, 30 à répondre" })).toBeInTheDocument();
    for (let n = 100; n <= 250; n += 50) {
      await user.click(await screen.findByRole("button", { name: "Charger plus" }));
      await waitFor(() => expect(container.querySelectorAll(".conv-scroll .conv")).toHaveLength(n));
    }
    expect(screen.queryByRole("button", { name: "Charger plus" })).toBeNull();
    // une ligne par fil, jamais une par message ; les « Autres » ne sont pas dans les réservations
    expect(container.querySelectorAll(".conv-scroll .conv .nm")).toHaveLength(250);
    expect(screen.queryByText("Google 1", { selector: ".nm" })).toBeNull();
    expect(container.querySelectorAll(".msgs > .conv")).toHaveLength(0);
  }, 30_000); // rendu de centaines de lignes : plus de 5 s sur la machine de la CI

  it("lien « Ouvrir Gmail » : un seul, discret, vers la boîte, nouvel onglet sûr ; pas de lien par mail", async () => {
    renderApp("/messages", handlers([base({ id: 1, bodyText: "voir https://drive.google.com/x" })]));
    const link = await screen.findByRole("link", { name: /Ouvrir Gmail/ });
    expect(link).toHaveAttribute("href", "https://mail.google.com/mail/u/?authuser=jphde.cartier%40gmail.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByRole("link", { name: /Gmail/ })).toHaveLength(1);
  });

  it("pas d'adresse de boîte : pas de lien Gmail", async () => {
    renderApp("/messages", handlers([base({ id: 1 })], [(c) => (c.path === "/mailbox" ? { body: { ...MAILBOX, address: null } } : undefined)]));
    await screen.findAllByRole("tab");
    expect(screen.queryByRole("link", { name: /Gmail/ })).toBeNull();
  });
});

describe("fil : liens, objet, rattachement", () => {
  const msg = base({ id: 1, bookingId: 5, bookingReference: "PM-2026-005", fromName: "Marie Lambert", subject: "Question sauna", bodyText: "Voir lien (https://drive.google.com/file/d/1/view)" });
  const link = { url: "https://drive.google.com/file/d/1/view", host: "drive.google.com" };
  const thread = (open: boolean, extra: Partial<Message> = {}) => [
    (c: { path: string; method: string }) =>
      c.path === "/messages/1/thread" ? { body: { message: msg, thread: [{ ...msg, links: [{ ...link, openable: open }], linksOpenable: open, ...extra }] } } : undefined,
  ];

  it("liens du message : domaine en gras, adresse en petit, Copier ; Ouvrir seulement si attesté, avec confirmation du domaine", async () => {
    const user = userEvent.setup();
    renderApp("/messages", handlers([msg], thread(true)));
    const group = await screen.findByRole("group", { name: "Liens du message" });
    expect(within(group).getByText("drive.google.com", { selector: "b" })).toBeInTheDocument();
    expect(within(group).getByText(link.url, { selector: "small" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Copier" })).toBeInTheDocument();
    // aucun lien cliquable avant confirmation
    expect(within(group).queryByRole("link")).toBeNull();
    await user.click(within(group).getByRole("button", { name: "Ouvrir" }));
    const dlg = within(group).getByRole("alertdialog");
    expect(dlg).toHaveTextContent("drive.google.com");
    const go = within(dlg).getByRole("link", { name: /Ouvrir drive.google.com/ });
    expect(go).toHaveAttribute("href", link.url);
    expect(go).toHaveAttribute("rel", "noopener noreferrer");
    expect(go).toHaveAttribute("target", "_blank");
  });

  it("expéditeur non attesté : jamais de bouton Ouvrir, la raison est dite", async () => {
    renderApp("/messages", handlers([msg], thread(false)));
    const group = await screen.findByRole("group", { name: "Liens du message" });
    expect(within(group).queryByRole("button", { name: "Ouvrir" })).toBeNull();
    expect(within(group).getByRole("button", { name: "Copier" })).toBeInTheDocument();
    expect(group).toHaveTextContent("Gmail n'atteste pas l'expéditeur");
  });

  it("objet prérempli « [PM-…] Re: … » et envoyé tel quel (modifiable)", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/messages", handlers([msg], thread(true)));
    const objet = (await screen.findByLabelText("Objet")) as HTMLInputElement;
    expect(objet.value).toBe("[PM-2026-005] Re: Question sauna");
    await user.clear(objet);
    await user.type(objet, "Re: Votre sauna");
    await user.type(screen.getByLabelText("Votre réponse"), "Oui, chauffé.");
    await user.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/messages/1/reply")?.body).toMatchObject({ body: "Oui, chauffé.", subject: "Re: Votre sauna" }));
  });

  it("référence déjà dans l'objet : pas de doublon ; sans réservation : pas de crochets", async () => {
    const withRef = base({ id: 1, bookingId: 5, bookingReference: "PM-2026-005", subject: "Re: [PM-2026-005] Séjour" });
    renderApp("/messages", handlers([withRef], [(c) => (c.path === "/messages/1/thread" ? { body: { message: withRef, thread: [withRef] } } : undefined)]));
    expect(((await screen.findByLabelText("Objet")) as HTMLInputElement).value).toBe("Re: [PM-2026-005] Séjour");
  });

  it("Détacher : PATCH bookingId null sur le fil", async () => {
    const user = userEvent.setup();
    const { calls } = renderApp("/messages", handlers([msg], thread(true)));
    await user.click(await screen.findByRole("button", { name: "Détacher" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path === "/messages/1")?.body).toEqual({ bookingId: null }));
  });

  it("Rattacher : recherche par référence ou nom, puis PATCH bookingId", async () => {
    const user = userEvent.setup();
    const free = base({ id: 1, fromName: "Inconnu", subject: "Salut" });
    const { calls } = renderApp("/messages", handlers([free], [
      (c) => (c.path === "/messages/1/thread" ? { body: { message: free, thread: [free] } } : undefined),
      (c) => (c.path === "/bookings" && c.query.search ? { body: { bookings: [{ id: 7, reference: "PM-2026-007", guestName: "Gwenola Oudewaeter", unitName: "La Scierie", checkin: "2026-10-23", checkout: "2026-10-30" }] } } : undefined),
    ]));
    await user.click(await screen.findByRole("tab", { name: /Autres/ }));
    await user.click(await screen.findByRole("button", { name: "Rattacher à une réservation" }));
    await user.type(screen.getByLabelText("Réservation à rattacher"), "Oude");
    await user.click(await screen.findByRole("button", { name: /PM-2026-007/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path === "/messages/1")?.body).toEqual({ bookingId: 7 }));
    expect(calls.some((c) => c.path === "/bookings" && c.query.search === "Oude")).toBe(true);
  });
});

describe("objet et redirecteurs", () => {
  it("objet : référence bornée et insensible à la casse, vide → « Votre réservation », jamais le nom du client", () => {
    expect(replySubject("Re: PM-2026-0123 x", "PM-2026-012")).toBe("[PM-2026-012] Re: PM-2026-0123 x");
    expect(replySubject("[pm-2026-012] Re: x", "PM-2026-012")).toBe("[pm-2026-012] Re: x");
    expect(replySubject("  ", "PM-2026-012")).toBe("[PM-2026-012] Votre réservation");
    expect(replySubject("Re: [QU-2026-0042] Question de Marie Lambert — Les Gîtes", null)).toBe("Re: [QU-2026-0042] Question — Les Gîtes");
  });

  it("un lien qui passe par un redirecteur montre la cible réelle, « via … », et n'a pas de bouton Ouvrir", async () => {
    const msg = base({ id: 1, bookingId: 5, bookingReference: "PM-2026-005", bodyText: "lien" });
    const withLink = { ...msg, linksOpenable: true, links: [{ url: "https://www.google.com/url?q=https://evil.test/x", host: "evil.test", via: "www.google.com", openable: false }] };
    renderApp("/messages", handlers([msg], [(c) => (c.path === "/messages/1/thread" ? { body: { message: withLink, thread: [withLink] } } : undefined)]));
    const group = await screen.findByRole("group", { name: "Liens du message" });
    expect(within(group).getByText("evil.test", { selector: "b" })).toBeInTheDocument();
    expect(within(group).getByText("via www.google.com")).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "Ouvrir" })).toBeNull();
  });
});
