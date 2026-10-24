// Gestion de la messagerie (24/10/2026) : signature (texte, HTML, multipart, nettoyage),
// objet avec référence, rattachement manuel d'un fil, adresses de l'équipe, liens des mails
// et règle d'ouverture, séparation Réservations / Autres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { createBookingAtomic, insertInboundMessage, upsertGuest } from "../src/db/repo";
import { absolutizeImages, composeOutgoing, sanitizeSignatureHtml, textToHtml } from "../src/core/signature";
import { extractLinks } from "../src/core/links";
import { replySubject } from "../src/services/email";
import { MAILBOX_STATE_KEY, pullMailbox } from "../src/services/mailbox";
import { buildMessage } from "../node/smtp.mjs";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN = "test-admin-token";
type Sent = { to: string; subject: string; text: string; html?: string; inReplyTo?: string | null; references?: string | null };
const sent: Sent[] = [];

const SIG_HTML = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td><img src="/img/signature-pre-more.jpg" width="96" height="96" alt="Les Gîtes" style="display:block"></td><td><div style="font:600 17px Georgia">Jean-Philippe</div><a href="https://exemple.test/reserver/" style="color:#2F5D3F">Réserver en ligne</a></td></tr></table>`;
const SIG_TXT = "Jean-Philippe de Cartier d'Yves\nLes Gîtes du Pré Moré";

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "https://gites.test",
    EMAILS_ENABLED: "true", ADMIN_TOKEN: ADMIN,
    SMTP_HOST: "smtp.test", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "Les Gîtes <lesgitesdupremore@gmail.com>",
    IMAP_USER: "lesgitesdupremore@gmail.com",
    SMTP_SEND: async (mail) => {
      sent.push(mail as Sent);
      return { id: `<sortant-${sent.length}@gites.test>` };
    },
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  sent.length = 0;
  for (const table of ["messages", "payments", "email_log", "audit_log", "bookings", "guests", "settings"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
  await t.db.prepare("DELETE FROM app_settings WHERE key LIKE 'mailbox%' OR key LIKE 'messagerie%'").run();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

const CHECKIN = addDays(todayInZone(), 90);
async function makeBooking(email = "marie@example.com", name = "Lambert", offset = 0) {
  const guestId = await upsertGuest(t.db, { email, lastName: name });
  const created = await createBookingAtomic(t.db, {
    unitId: 2, checkin: addDays(CHECKIN, offset), checkout: addDays(CHECKIN, offset + 4), adults: 2, children: 0, status: "confirmed", source: "manual", guestId,
  });
  if (!created.ok) throw new Error("réservation non créée");
  const row = await t.db.prepare("SELECT reference FROM bookings WHERE id = ?1").bind(created.id).first<{ reference: string }>();
  return { id: created.id, guestId, reference: row!.reference };
}

let uid = 0;
function inbound(extra: Partial<Parameters<typeof insertInboundMessage>[1]> = {}) {
  uid += 1;
  return insertInboundMessage(t.db, {
    propertyId: 1, messageId: `<m${uid}@client.test>`, channel: "email", fromEmail: "marie@example.com", fromName: "Marie",
    toEmail: "lesgitesdupremore@gmail.com", subject: "Question", bodyText: "Bonjour", ...extra,
  });
}

async function pullOne(raw: string): Promise<void> {
  const box = async () => ({ uidValidity: 1, mails: [{ uid: (uid += 1), raw, size: raw.length, truncated: false }], more: false, highestUid: uid });
  await t.db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(MAILBOX_STATE_KEY).run();
  await pullMailbox({ ...env, IMAP_PASSWORD: "x", IMAP_FETCH: box } as Env, new Date());
}

async function setSig(on = true, html = SIG_HTML, text = SIG_TXT) {
  const r = await call("PUT", "/api/admin/settings?property=1", {
    settings: { signature_text: text, signature_html: html, signature_on_replies: on },
  });
  expect(r.status).toBe(200);
  return r;
}

describe("nettoyage de la signature HTML", () => {
  it("retire script, onerror, javascript:, iframe, form, style url() ; garde table, img, a, style", () => {
    const dirty = `<script>alert(1)</script><iframe src="https://x.test"></iframe><form action="/x"><input name="a"></form>` +
      `<p onclick="x()" style="color:red;background:url(javascript:alert(1))">Salut</p>` +
      `<a href="javascript:alert(1)">piège</a><a href=" JaVaScRiPt:alert(2)">piège 2</a><a href="data:text/html,x">d</a>` +
      `<img src="x" onerror="alert(1)"><img src="javascript:alert(3)"><img src="https://ok.test/a.png" onload="x()" alt="ok">` +
      `<a href="https://ok.test/p" onmouseover="x()">lien</a><a href="mailto:a@b.test">m</a><a href="tel:+32498440883">t</a>` +
      `<table><tr><td style="padding:0">cell</td></tr></table><b>gras</b><svg><script>1</script></svg><!-- commentaire -->`;
    const out = sanitizeSignatureHtml(dirty);
    expect(out).not.toMatch(/script|onerror|onclick|onload|onmouseover|javascript|iframe|<form|<input|url\(|alert|svg|commentaire/i);
    expect(out).toContain("<table>");
    expect(out).toContain('style="padding:0"');
    expect(out).toContain('<img src="https://ok.test/a.png" alt="ok">');
    expect(out).toContain('href="https://ok.test/p"');
    expect(out).toContain('href="mailto:a@b.test"');
    expect(out).toContain('href="tel:+32498440883"');
    expect(out).toContain("<b>gras</b>");
    expect(out).toContain("piège");
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("garde le modèle de départ (table, image du site, lien) tel quel", () => {
    const out = sanitizeSignatureHtml(SIG_HTML);
    expect(out).toContain('src="/img/signature-pre-more.jpg"');
    expect(out).toContain('href="https://exemple.test/reserver/"');
    expect(out).toContain("font:600 17px Georgia");
  });

  it("une image en chemin relatif devient une URL absolue du site", () => {
    expect(absolutizeImages(sanitizeSignatureHtml(SIG_HTML), "https://gites.test/")).toContain('src="https://gites.test/img/signature-pre-more.jpg"');
    expect(absolutizeImages('<img src="//evil.test/x.png">', "https://gites.test")).toBe('<img src="//evil.test/x.png">');
  });
});

describe("signature : assemblage et envoi", () => {
  it("texte : corps + « -- » + signature ; HTML : corps échappé en paragraphes + signature", () => {
    const sig = { signatureText: SIG_TXT, signatureHtml: SIG_HTML, signatureOnReplies: true };
    const c = composeOutgoing("Bonjour <b>Marie</b> & merci,\nà bientôt\n\nSeconde ligne", sig, "https://gites.test");
    expect(c.text).toBe(`Bonjour <b>Marie</b> & merci,\nà bientôt\n\nSeconde ligne\n\n-- \n${SIG_TXT}`);
    expect(c.html).toContain("Bonjour &lt;b&gt;Marie&lt;/b&gt; &amp; merci,<br>à bientôt");
    expect(c.html).toContain("<p style=\"margin:0 0 1em 0\">Seconde ligne</p>");
    expect(c.html).toContain('src="https://gites.test/img/signature-pre-more.jpg"');
    expect(textToHtml("a\nb")).toBe('<p style="margin:0 0 1em 0">a<br>b</p>');
  });

  it("case décochée, ou signature vide : rien n'est ajouté ; texte seul sans HTML : pas de multipart", () => {
    expect(composeOutgoing("Salut", { signatureText: SIG_TXT, signatureHtml: SIG_HTML, signatureOnReplies: false })).toEqual({ text: "Salut" });
    expect(composeOutgoing("Salut", { signatureText: "", signatureHtml: "", signatureOnReplies: true })).toEqual({ text: "Salut" });
    expect(composeOutgoing("Salut", { signatureText: "JP", signatureHtml: "", signatureOnReplies: true })).toEqual({ text: "Salut\n\n-- \nJP" });
  });

  it("jamais deux fois : un modèle qui porte déjà la signature texte n'est pas doublé", () => {
    const sig = { signatureText: SIG_TXT, signatureHtml: SIG_HTML, signatureOnReplies: true };
    expect(composeOutgoing(`Bien à vous,\n${SIG_TXT}`, sig)).toEqual({ text: `Bien à vous,\n${SIG_TXT}` });
  });

  it("multipart/alternative correct : deux parties, quoted-printable, lignes ≤ 76, image absolue, accents intacts", () => {
    const sig = { signatureText: SIG_TXT, signatureHtml: SIG_HTML, signatureOnReplies: true };
    const long = "Un très long paragraphe accentué, héhé, à répéter pour dépasser largement la limite de soixante-seize caractères par ligne. ".repeat(4);
    const c = composeOutgoing(long, sig, "https://gites.test");
    const raw = buildMessage({ from: "Les Gîtes <a@gites.test>", to: "m@example.com", subject: "Re: x", text: c.text, html: c.html, messageId: "<id@gites.test>" });
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="(=_alt_[0-9a-f]+)"/);
    const [head, ...rest] = raw.split("\r\n\r\n");
    expect(head).toContain("MIME-Version: 1.0");
    const body = rest.join("\r\n\r\n");
    expect(body).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body).toContain("Content-Type: text/html; charset=UTF-8");
    expect(body.indexOf("text/plain")).toBeLessThan(body.indexOf("text/html"));
    expect(body).toContain("Content-Transfer-Encoding: quoted-printable");
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    // décodage QP de la partie HTML
    const htmlPart = body.split("text/html; charset=UTF-8")[1]!.split(/\r\n--=_alt_/)[0]!;
    const decoded = Buffer.from(htmlPart.replace(/^\s*Content-Transfer-Encoding: quoted-printable\r\n\r\n/, "").replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
    expect(decoded).toContain("https://gites.test/img/signature-pre-more.jpg");
    expect(decoded).toContain("héhé");
  });

  it("réponse depuis Messages : signature texte + HTML envoyées, corps stocké sans signature", async () => {
    await setSig();
    const id = (await inbound())!;
    const res = await call("POST", `/api/admin/messages/${id}/reply`, { body: "Oui, avec plaisir." });
    expect(res.data.delivery).toBe("sent");
    expect(sent[0]!.text).toBe(`Oui, avec plaisir.\n\n-- \n${SIG_TXT}`);
    expect(sent[0]!.html).toContain("https://gites.test/img/signature-pre-more.jpg");
    expect(sent[0]!.html).toContain("Oui, avec plaisir.");
    const out = await t.db.prepare("SELECT body_text FROM messages WHERE direction = 'out'").first<{ body_text: string }>();
    expect(out!.body_text).toBe("Oui, avec plaisir.");
  });

  it("message depuis une réservation : signature ajoutée aussi ; sans la case, rien", async () => {
    const b = await makeBooking();
    await setSig(true);
    await call("POST", `/api/admin/bookings/${b.id}/messages`, { body: "Arrivée dès 16 h." });
    expect(sent[0]!.text).toContain(`-- \n${SIG_TXT}`);
    expect(sent[0]!.html).toBeDefined();
    await setSig(false);
    await call("POST", `/api/admin/bookings/${b.id}/messages`, { body: "Autre message." });
    expect(sent[1]!.text).toBe("Autre message.");
    expect(sent[1]!.html).toBeUndefined();
  });

  it("l'enregistrement nettoie la signature HTML ; les réglages la rendent nettoyée", async () => {
    const r = await call("PUT", "/api/admin/settings?property=1", {
      settings: { signature_html: `<div onclick="x()">Hop<script>alert(1)</script></div><a href="javascript:x">l</a>`, signature_text: "JP" },
    });
    const s = r.data.settings as { signatureHtml: string; signatureText: string; signatureOnReplies: boolean };
    expect(s.signatureHtml).toBe("<div>Hop</div>l");
    expect(s.signatureText).toBe("JP");
    expect(s.signatureOnReplies).toBe(false);
  });

  it("la variable {signature} d'un mail automatique prend la signature texte si elle est remplie", async () => {
    const { buildCancellationEmail } = await import("../src/services/email");
    const { getBooking, getProperty } = await import("../src/db/repo");
    const b = await makeBooking();
    const booking = (await getBooking(t.db, b.id))!;
    const property = (await getProperty(t.db, 1))!;
    const plan = { par: "locataire" as const, keptCents: 0, refundCents: 0, indemnityCents: 0 };
    const withSig = buildCancellationEmail(booking, property, plan, "Merci.\n{signature}", "Jean-Philippe\nPré Moré");
    expect(withSig.bodyText).toContain("Merci.\nJean-Philippe\nPré Moré");
    const without = buildCancellationEmail(booking, property, plan, "Merci.\n{signature}", "");
    expect(without.bodyText).toContain(`Merci.\n${property.name}`);
  });
});

describe("objet des réponses", () => {
  it("la référence est ajoutée en tête une seule fois, sans nom de client", () => {
    expect(replySubject("Re: Question", "PM-2026-012")).toBe("[PM-2026-012] Re: Question");
    expect(replySubject("Re: [PM-2026-012] Question", "PM-2026-012")).toBe("Re: [PM-2026-012] Question");
    expect(replySubject("Re: Question", null)).toBe("Re: Question");
    expect(replySubject("Bonjour\r\nBcc: x@y.test", "PM-2026-012")).toBe("[PM-2026-012] Bonjour Bcc: x@y.test");
  });

  it("route : objet édité, référence ajoutée d'office si rattaché, pas si sans réservation", async () => {
    const b = await makeBooking();
    const linked = (await inbound({ bookingId: b.id, guestId: b.guestId, subject: "Question sauna" }))!;
    await call("POST", `/api/admin/messages/${linked}/reply`, { body: "Oui.", subject: "Re: Sauna chauffé" });
    expect(sent[0]!.subject).toBe(`[${b.reference}] Re: Sauna chauffé`);
    const free = (await inbound({ fromEmail: "inconnu@autre.test", subject: "Salut" }))!;
    await call("POST", `/api/admin/messages/${free}/reply`, { body: "Oui." });
    expect(sent[1]!.subject).toBe("Re: Salut");
    // objet vide : retombe sur Re: + objet d'origine
    const again = (await inbound({ bookingId: b.id, guestId: b.guestId, subject: `Votre séjour ${b.reference}` }))!;
    await call("POST", `/api/admin/messages/${again}/reply`, { body: "Merci.", subject: "  " });
    expect(sent[2]!.subject).toBe(`Re: Votre séjour ${b.reference}`);
  });
});

describe("rattacher / détacher un fil", () => {
  it("détache le fil entier (entrants et sortants), audit, et l'adresse du client n'est plus rattachée ensuite", async () => {
    const b = await makeBooking();
    const m1 = (await inbound({ bookingId: b.id, guestId: b.guestId }))!;
    await call("POST", `/api/admin/messages/${m1}/reply`, { body: "Réponse." }); // sortant, message-id <sortant-1@gites.test>
    const m2 = (await inbound({ bookingId: b.id, guestId: b.guestId, subject: "Suite" }))!;
    const r = await call("PATCH", `/api/admin/messages/${m2}`, { bookingId: null });
    expect(r.status).toBe(200);
    expect(r.data.messages).toBe(3);
    const rows = await t.db.prepare("SELECT booking_id, guest_id, link_manual FROM messages").all<{ booking_id: number | null; guest_id: number | null; link_manual: number }>();
    expect(rows.results.every((x) => x.booking_id === null && x.guest_id === null && x.link_manual === 1)).toBe(true);
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'message.detach'").first<{ n: number }>())!.n).toBe(1);
    // la relève suivante, de la même adresse (client connu), ne rattache pas automatiquement
    await pullOne(["From: Marie <marie@example.com>", "To: lesgitesdupremore@gmail.com", "Subject: Encore une question", "Message-ID: <apres@client.test>", "", "Bonjour"].join("\r\n"));
    const after = await t.db.prepare("SELECT booking_id FROM messages WHERE message_id = '<apres@client.test>'").first<{ booking_id: number | null }>();
    expect(after!.booking_id).toBeNull();
  });

  it("rattache à une réservation (fil entier) ; le choix prime sur l'automatique à la relève suivante", async () => {
    const mine = await makeBooking("marie@example.com", "Lambert");
    const other = await makeBooking("paul@example.com", "Durand", 30);
    const m1 = (await inbound({ fromEmail: "inconnu@autre.test", fromName: "Inconnu" }))!;
    const r = await call("PATCH", `/api/admin/messages/${m1}`, { bookingId: other.id });
    expect(r.status).toBe(200);
    const row = await t.db.prepare("SELECT booking_id, guest_id, link_manual FROM messages WHERE id = ?1").bind(m1).first<{ booking_id: number; guest_id: number; link_manual: number }>();
    expect(row).toEqual({ booking_id: other.id, guest_id: other.guestId, link_manual: 1 });
    // une réponse du même expéditeur reste sur la réservation choisie
    await pullOne(["From: Inconnu <inconnu@autre.test>", "To: lesgitesdupremore@gmail.com", "Subject: Suite", "Message-ID: <s1@autre.test>", "", "Merci"].join("\r\n"));
    // même quand le client écrit « de l'adresse de quelqu'un d'autre » dans le même fil
    await pullOne(["From: Marie <marie@example.com>", "To: lesgitesdupremore@gmail.com", "Subject: Re: Question", "Message-ID: <s2@client.test>", "In-Reply-To: <s1@autre.test>", "", "Je confirme"].join("\r\n"));
    const rows = await t.db.prepare("SELECT message_id, booking_id FROM messages WHERE message_id IN ('<s1@autre.test>', '<s2@client.test>') ORDER BY message_id").all<{ booking_id: number }>();
    expect(rows.results.map((x) => x.booking_id)).toEqual([other.id, other.id]);
    expect(mine.id).not.toBe(other.id);
  });

  it("réservation inconnue : 404 ; message de canal (Beds24) : refusé", async () => {
    const m1 = (await inbound())!;
    expect((await call("PATCH", `/api/admin/messages/${m1}`, { bookingId: 99999 })).status).toBe(404);
    await t.db.prepare("UPDATE messages SET channel = 'beds24' WHERE id = ?1").bind(m1).run();
    expect((await call("PATCH", `/api/admin/messages/${m1}`, { bookingId: null })).status).toBe(400);
  });

  it("status seul : le comportement d'avant (traité / à répondre) est intact", async () => {
    const m1 = (await inbound())!;
    await call("PATCH", `/api/admin/messages/${m1}`, { status: "traité" });
    expect((await t.db.prepare("SELECT status FROM messages WHERE id = ?1").bind(m1).first<{ status: string }>())!.status).toBe("traité");
  });
});

describe("adresses de l'équipe et de la famille", () => {
  it("un mail d'une de ces adresses n'est pas rattaché par son expéditeur, mais l'est par référence", async () => {
    const b = await makeBooking("jdc@example.com", "Famille");
    await call("PUT", "/api/admin/mailbox/team", { addresses: "JDC@example.com\n\n autre@famille.test ;jdc@example.com" });
    const got = await call("GET", "/api/admin/mailbox");
    expect(got.data.teamAddresses).toEqual(["jdc@example.com", "autre@famille.test"]);
    // le client « jdc » a bien une réservation : sans le réglage, l'adresse la rattacherait
    await pullOne(["From: JDC <jdc@example.com>", "To: lesgitesdupremore@gmail.com", "Subject: Transfert d'un mail", "Message-ID: <fam1@x.test>", "", "voir ci-dessous"].join("\r\n"));
    expect((await t.db.prepare("SELECT booking_id FROM messages WHERE message_id = '<fam1@x.test>'").first<{ booking_id: number | null }>())!.booking_id).toBeNull();
    await pullOne(["From: JDC <jdc@example.com>", "To: lesgitesdupremore@gmail.com", `Subject: Pour ${b.reference}`, "Message-ID: <fam2@x.test>", "", "dossier"].join("\r\n"));
    expect((await t.db.prepare("SELECT booking_id FROM messages WHERE message_id = '<fam2@x.test>'").first<{ booking_id: number | null }>())!.booking_id).toBe(b.id);
  });

  it("défaut vide : l'adresse du client rattache comme avant", async () => {
    const b = await makeBooking("jdc@example.com", "Famille");
    expect(((await call("GET", "/api/admin/mailbox")).data.teamAddresses as string[])).toEqual([]);
    await pullOne(["From: JDC <jdc@example.com>", "To: lesgitesdupremore@gmail.com", "Subject: Question", "Message-ID: <fam3@x.test>", "", "bonjour"].join("\r\n"));
    expect((await t.db.prepare("SELECT booking_id FROM messages WHERE message_id = '<fam3@x.test>'").first<{ booking_id: number | null }>())!.booking_id).toBe(b.id);
  });

  it("GET /mailbox donne l'adresse de la boîte (IMAP_USER)", async () => {
    expect((await call("GET", "/api/admin/mailbox")).data.address).toBe("lesgitesdupremore@gmail.com");
  });
});

describe("liens des mails", () => {
  it("extraction : http(s) seulement, dédoublonnés, 20 au plus, ponctuation et parenthèses retirées", () => {
    const text = "Voir lien (https://drive.google.com/file/d/1/view?usp=sharing). Et https://drive.google.com/file/d/1/view?usp=sharing, ftp://x.test/a, javascript:alert(1), " +
      "http://exemple.test/a_(b). https://user@evil.test/x";
    const links = extractLinks(text);
    expect(links.map((l) => l.url)).toEqual([
      "https://drive.google.com/file/d/1/view?usp=sharing",
      "http://exemple.test/a_(b)",
      "https://user@evil.test/x",
    ]);
    expect(links[0]!.host).toBe("drive.google.com");
    expect(links[2]!.openable).toBe(false); // identifiant caché devant le domaine
    const many = Array.from({ length: 30 }, (_, i) => `https://site${i}.test/p`).join(" ");
    expect(extractLinks(many)).toHaveLength(20);
    expect(extractLinks("rien ici")).toEqual([]);
  });

  it("ouverture : seulement si Gmail atteste l'expéditeur ET le message n'est pas usurpé", async () => {
    const body = "Document : https://drive.google.com/file/d/1/view";
    const authId = (await inbound({ bodyText: body, senderAuth: true }))!;
    const noAuthId = (await inbound({ bodyText: body, senderAuth: false, fromEmail: "x@autre.test" }))!;
    const spoofId = (await inbound({ bodyText: body, senderAuth: true, spoofed: true, fromEmail: "lesgitesdupremore@gmail.com" }))!;
    type L = { links: { url: string; host: string; openable: boolean }[]; linksOpenable: boolean };
    const get = async (id: number) => (await call("GET", `/api/admin/messages/${id}/thread`)).data.message as L;
    const a = await get(authId);
    expect(a.links).toEqual([{ url: "https://drive.google.com/file/d/1/view", host: "drive.google.com", openable: true }]);
    expect(a.linksOpenable).toBe(true);
    const n = await get(noAuthId);
    expect(n.links[0]!.openable).toBe(false);
    expect(n.linksOpenable).toBe(false);
    const s = await get(spoofId);
    expect(s.links[0]!.openable).toBe(false);
  });

  it("la relève enregistre l'attestation Gmail (dmarc=pass) ; sans en-tête, non attesté", async () => {
    await pullOne(["Authentication-Results: mx.google.com; dkim=pass header.i=@google.com; dmarc=pass header.from=google.com", "From: Drive <no-reply@google.com>", "To: lesgitesdupremore@gmail.com", "Subject: Partage", "Message-ID: <d1@google.com>", "", "https://drive.google.com/x"].join("\r\n"));
    await pullOne(["From: Quelqu'un <q@autre.test>", "To: lesgitesdupremore@gmail.com", "Subject: Partage", "Message-ID: <d2@autre.test>", "", "https://drive.google.com/y"].join("\r\n"));
    const rows = await t.db.prepare("SELECT message_id, sender_auth FROM messages ORDER BY id").all<{ sender_auth: number }>();
    expect(rows.results.map((r) => r.sender_auth)).toEqual([1, 0]);
  });
});

describe("Réservations / Autres", () => {
  it("les messages non rattachés restent hors de la réservation et du voucher du client", async () => {
    const b = await makeBooking();
    await inbound({ bookingId: b.id, guestId: b.guestId, subject: "Question séjour" });
    const other = (await inbound({ fromEmail: "no-reply@google.com", fromName: "Google", subject: "Alerte de sécurité", bodyText: "x" }))!;
    const list = (await call("GET", "/api/admin/messages")).data.messages as { id: number; bookingId: number | null }[];
    expect(list.filter((m) => m.bookingId === null).map((m) => m.id)).toEqual([other]);
    const fiche = (await call("GET", `/api/admin/messages?booking=${b.id}`)).data.messages as { subject: string }[];
    expect(fiche.map((m) => m.subject)).toEqual(["Question séjour"]);
    // détacher le fil de la réservation le sort aussi du voucher
    const pub = async () => {
      const res = await router.handle(new Request(`http://test.local/api/public/bookings/${b.reference}/messages?email=marie%40example.com`), env);
      return ((await res!.json()) as { messages: unknown[] }).messages.length;
    };
    expect(await pub()).toBe(1);
    const mid = (await t.db.prepare("SELECT id FROM messages WHERE subject = 'Question séjour'").first<{ id: number }>())!.id;
    await call("PATCH", `/api/admin/messages/${mid}`, { bookingId: null });
    expect(await pub()).toBe(0);
  });

  it("le fil « sans réservation » ne mélange pas les messages rattachés de la même adresse", async () => {
    const b = await makeBooking();
    await inbound({ bookingId: b.id, guestId: b.guestId, subject: "Dans la résa" });
    const free = (await inbound({ guestId: null, subject: "Hors résa" }))!;
    const thread = (await call("GET", `/api/admin/messages/${free}/thread`)).data.thread as { subject: string }[];
    expect(thread.map((m) => m.subject)).toEqual(["Hors résa"]);
  });
});
