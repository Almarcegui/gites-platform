// Page Merci (17/10/2026) : adresse de la confirmation affichée masquée, renvoi
// de la confirmation (mail + PDF) à une autre adresse, réservation sans e-mail.
// Garde-fous : jamais la seule référence, réservation confirmée, trois renvois
// au plus, journal d'audit et email_log. Données fictives (example.*), aucun
// réseau.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { isDeliverableEmail, maskEmail } from "../src/core/mask-email";
import { localizePublicResponse } from "../src/core/public-i18n";
import { merciUrl } from "../src/services/booking-flow";
import { merciToken, verifyMerciToken } from "../src/services/merci-token";

const router = new Router();
registerPublicRoutes(router);

const CHECKIN = addDays(todayInZone(), 150);
const CHECKOUT = addDays(CHECKIN, 7);

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: "jeton-admin-de-test" };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["confirmation_claims", "payments", "email_log", "audit_log", "bookings", "guests"]) await t.db.prepare(`DELETE FROM ${table}`).run();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, e: Env = env) {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, e);
  if (!res) throw new Error(`route non matchée : ${path}`);
  const out = await localizePublicResponse(req, res);
  const text = await out.text();
  return { status: out.status, text, data: JSON.parse(text) as Record<string, any> };
}

async function createBooking(email = "claire.dubois@example.be", shift = 0) {
  const created = await call("POST", "/api/public/bookings", {
    unitId: 2, checkin: addDays(CHECKIN, shift), checkout: addDays(CHECKOUT, shift), adults: 2, children: 0, paymentMode: "deposit",
    guest: { firstName: "Claire", lastName: "Dubois", email, phone: "+32 470 00 00 09" },
    cgvAccepted: true,
  });
  expect(created.status).toBe(201);
  const row = await t.db.prepare("SELECT id, reference FROM bookings WHERE reference = ?1").bind(created.data.reference).first<{ id: number; reference: string }>();
  return { id: row!.id, reference: row!.reference, email, checkoutUrl: created.data.checkoutUrl as string };
}

/** Réservation payée par le simulateur : rend aussi l'URL de la page Merci. */
async function bookAndPay(email?: string) {
  const b = await createBooking(email);
  const session = new URL(b.checkoutUrl).searchParams.get("session")!;
  const paid = await call("POST", "/api/public/dev-pay/confirm", { session });
  expect(paid.status).toBe(200);
  const merci = new URL(paid.data.redirect as string);
  return { ...b, merci, k: merci.searchParams.get("k")! };
}

const api = (ref: string) => `/api/public/bookings/${encodeURIComponent(ref)}/confirmation-email`;
const mails = async (bookingId: number) =>
  (await t.db.prepare("SELECT * FROM email_log WHERE booking_id = ?1 AND kind = 'confirmation' ORDER BY id").bind(bookingId).all<Record<string, any>>()).results;
const audits = async (bookingId: number) =>
  (await t.db.prepare("SELECT * FROM audit_log WHERE entity = ?1 AND action = 'email.confirmation_resent_public' ORDER BY id").bind(`booking:${bookingId}`).all<Record<string, any>>()).results;
const guestEmail = async (bookingId: number) =>
  (await t.db.prepare("SELECT g.email FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.id = ?1").bind(bookingId).first<{ email: string | null }>())?.email ?? null;

describe("adresse acceptée pour un renvoi", () => {
  it("refuse ce que le transport refuserait", () => {
    for (const ok of ["claire@example.be", "c.d+gites@sous.example.co.uk", "o'neil@example.ie"]) expect(isDeliverableEmail(ok), ok).toBe(true);
    for (const ko of ["a@example.com.", "a@-example.com", "a@example..com", "x<y@example.com", "a b@example.com", ".a@example.com", "a.@example.com", "a@example", "a@example.c0m", "@example.com", `${"a".repeat(65)}@example.com`, "a@exa_mple.com"]) {
      expect(isDeliverableEmail(ko), ko).toBe(false);
    }
  });
});

describe("adresse masquée", () => {
  it("garde la première lettre et le domaine", () => {
    expect(maskEmail("claire.dubois@example.be")).toBe("c•••@example.be");
    expect(maskEmail("j@gmail.com")).toBe("j•••@gmail.com");
    expect(maskEmail("  pieter@example.nl ")).toBe("p•••@example.nl");
    expect(maskEmail("pas-une-adresse")).toBe("•••");
    expect(maskEmail("")).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});

describe("jeton de la page Merci", () => {
  it("l'URL de retour du paiement porte référence, e-mail et jeton ; le jeton est propre à la réservation", async () => {
    const b = await bookAndPay();
    expect(b.merci.pathname).toBe("/book/merci.html");
    expect(b.merci.searchParams.get("ref")).toBe(b.reference);
    expect(b.merci.searchParams.get("email")).toBe(b.email);
    expect(b.k).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await verifyMerciToken(env, { id: b.id, reference: b.reference }, b.k)).toBe(true);
    expect(await verifyMerciToken(env, { id: b.id + 1, reference: b.reference }, b.k)).toBe(false);
    expect(await verifyMerciToken(env, { id: b.id, reference: b.reference }, b.k.slice(0, 31))).toBe(false);
    expect(await verifyMerciToken(env, { id: b.id, reference: b.reference }, null)).toBe(false);
  });

  it("l'URL de retour Stripe (successUrl) porte aussi le jeton", async () => {
    const b = await createBooking();
    const url = new URL(await merciUrl(env, { id: b.id, reference: b.reference, guestEmail: b.email }));
    expect(url.searchParams.get("k")).toBe(await merciToken(env, b));
    expect(url.searchParams.has("lang")).toBe(false);
    const nl = new URL(await merciUrl(env, { id: b.id, reference: b.reference, guestEmail: b.email, guestLang: "nl" }));
    expect(nl.searchParams.get("lang")).toBe("nl");
  });

  it("sans ADMIN_TOKEN : pas de jeton (fail-closed), le couple référence + e-mail reste", async () => {
    const off: Env = { ...env, ADMIN_TOKEN: undefined };
    expect(await merciToken(off, { id: 1, reference: "PM-2026-001" })).toBeNull();
    expect(await verifyMerciToken(off, { id: 1, reference: "PM-2026-001" }, "x".repeat(32))).toBe(false);
    expect(new URL(await merciUrl(off, { id: 1, reference: "PM-2026-001", guestEmail: "a@example.be" })).searchParams.has("k")).toBe(false);
  });
});

describe("GET : à quelle adresse part la confirmation", () => {
  it("la seule référence, ou un jeton faux : 404", async () => {
    const b = await bookAndPay();
    expect((await call("GET", api(b.reference))).status).toBe(404);
    expect((await call("GET", `${api(b.reference)}?k=${"A".repeat(32)}`)).status).toBe(404);
    expect((await call("GET", `${api(b.reference)}?email=autre@example.be`)).status).toBe(404);
    expect((await call("GET", `${api("PM-2099-999")}?k=${b.k}`)).status).toBe(404);
  });

  it("par e-mail ou par jeton : adresse masquée, jamais en clair ; renvoi proposé avec le jeton seulement", async () => {
    const b = await bookAndPay();
    for (const [qs, canResend] of [[`email=${encodeURIComponent(b.email)}`, false], [`k=${b.k}`, true]] as const) {
      const r = await call("GET", `${api(b.reference)}?${qs}`);
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({
        reference: b.reference, status: "confirmed", hasEmail: true, canResend,
        recipient: "c•••@example.be", lastSent: { to: "c•••@example.be", failed: false }, resendsLeft: 3,
      });
      expect(r.text).not.toContain("claire.dubois");
    }
  });
});

describe("POST : renvoyer la confirmation à une autre adresse", () => {
  it("part à la nouvelle adresse avec le PDF, au journal ; la fiche client n'est pas modifiée", async () => {
    const b = await bookAndPay("claire.dubois@exmaple.be"); // faute de frappe dans le domaine
    const r = await call("POST", api(b.reference), { k: b.k, to: "claire.dubois@example.be" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, lastSent: { to: "c•••@example.be", failed: false }, resendsLeft: 2, hasEmail: true, recipient: "c•••@exmaple.be" });
    expect(r.text).not.toContain("claire.dubois");

    const log = await mails(b.id);
    expect(log).toHaveLength(2); // la confirmation d'origine + le renvoi
    expect(log[1]).toMatchObject({ to_email: "claire.dubois@example.be", status: "stub" });
    expect(log[1]!.subject).toContain(`[${b.reference}]`);
    expect(JSON.parse(log[1]!.attachments)).toEqual([{ filename: `Confirmation-${b.reference}.pdf`, bytes: expect.any(Number) }]);
    // Le lien du voucher dans le mail reste celui de la fiche : il continue d'ouvrir la réservation.
    expect(log[1]!.body_text).toContain(`email=${encodeURIComponent("claire.dubois@exmaple.be")}`);

    const a = await audits(b.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.actor).toBe("public");
    expect(JSON.parse(a[0]!.detail)).toEqual({ to: "claire.dubois@example.be", adresseFiche: "claire.dubois@exmaple.be", ficheCompletee: false });
    expect(await guestEmail(b.id)).toBe("claire.dubois@exmaple.be");
  });

  it("autorisé par le jeton seul (sans e-mail dans la requête)", async () => {
    const b = await bookAndPay();
    const r = await call("POST", api(b.reference), { k: b.k, to: "claire@example.org" });
    expect(r.status).toBe(200);
    expect((await mails(b.id)).at(-1)!.to_email).toBe("claire@example.org");
  });

  it("refusé : seule référence, jeton faux, adresse invalide, réservation non confirmée", async () => {
    const b = await bookAndPay();
    expect((await call("POST", api(b.reference), { to: "x@example.org" })).status).toBe(404);
    expect((await call("POST", api(b.reference), { k: "A".repeat(32), to: "x@example.org" })).status).toBe(404);
    // Le couple référence + e-mail ne suffit pas pour renvoyer : il faut le jeton.
    expect((await call("POST", api(b.reference), { email: b.email, to: "x@example.org" })).status).toBe(404);
    expect((await call("POST", api(b.reference), { k: b.k, to: "pas-une-adresse" })).status).toBe(400);
    expect((await call("POST", api(b.reference), { k: b.k, to: `${"a".repeat(250)}@example.org` })).status).toBe(400);
    expect((await call("POST", api(b.reference), { k: b.k, to: "a@example..org" })).status).toBe(400);
    const pending = await createBooking("pending@example.be", 20);
    const r = await call("POST", api(pending.reference), { k: await merciToken(env, pending), to: "x@example.org" });
    expect(r.status).toBe(409);
    expect(await mails(pending.id)).toHaveLength(0);
    expect(await audits(b.id)).toHaveLength(0);
  });

  it("trois renvois au plus par réservation, même en rafale", async () => {
    const b = await bookAndPay();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call("POST", api(b.reference), { k: b.k, to: `essai${i}@example.org` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    const refused = results.filter((r) => r.status === 429);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.data.code).toBe("resend_limit");
    expect(await audits(b.id)).toHaveLength(3);
    expect(await mails(b.id)).toHaveLength(4); // 1 d'origine + 3 renvois
    const info = await call("GET", `${api(b.reference)}?k=${b.k}`);
    expect(info.data.resendsLeft).toBe(0);
  });

  it("message d'erreur en néerlandais quand la page le demande", async () => {
    const b = await bookAndPay();
    const pending = await createBooking("pending@example.be", 20);
    const r = await call("POST", api(pending.reference), { k: await merciToken(env, pending), to: "x@example.org" }, { "x-gites-lang": "nl" });
    expect(r.data.error).toBe("de bevestiging wordt pas verstuurd zodra de reservering bevestigd is");
    for (let i = 0; i < 3; i += 1) await call("POST", api(b.reference), { k: b.k, to: `n${i}@example.org` });
    const limit = await call("POST", api(b.reference), { k: b.k, to: "n9@example.org" }, { "x-gites-lang": "nl" });
    expect(limit.status).toBe(429);
    expect(limit.data.error).toMatch(/^maximaal aantal keer opnieuw verzonden/);
  });
});

describe("échecs : rien n'est annoncé comme envoyé, le quota n'est pas consommé", () => {
  it("transport en échec : 502, ligne d'historique marquée en échec, quota intact", async () => {
    const b = await bookAndPay();
    const failing: Env = { ...env, EMAILS_ENABLED: "true", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "r@example.be", SMTP_SEND: async () => { throw new Error("SMTP 550 boîte inconnue"); } };
    const r = await call("POST", api(b.reference), { k: b.k, to: "claire@example.org" }, {}, failing);
    expect(r.status).toBe(502);
    expect(r.data).toMatchObject({ lastSent: { failed: true }, resendsLeft: 3 });
    expect(await audits(b.id)).toHaveLength(0);
    const failed = await t.db.prepare("SELECT detail FROM audit_log WHERE action = 'email.confirmation_resent_public_failed'").all<{ detail: string }>();
    expect(failed.results).toHaveLength(1);
    expect((await mails(b.id)).at(-1)).toMatchObject({ to_email: "claire@example.org", status: "failed" });
  });

  it("réservation sans fiche client : refusée avant le quota", async () => {
    const b = await bookAndPay();
    await t.db.prepare("UPDATE bookings SET guest_id = NULL WHERE id = ?1").bind(b.id).run();
    const r = await call("POST", api(b.reference), { k: b.k, to: "claire@example.org" });
    expect(r.status).toBe(409);
    expect(await audits(b.id)).toHaveLength(0);
  });

  it("réservation annulée : pas de renvoi, et sendConfirmation refuse aussi une adresse explicite", async () => {
    const b = await bookAndPay();
    await t.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(b.id).run();
    expect((await call("POST", api(b.reference), { k: b.k, to: "claire@example.org" })).status).toBe(409);
    const { sendConfirmation } = await import("../src/services/booking-flow");
    expect(await sendConfirmation(t.db, env, b.id, { to: "claire@example.org" })).toBe(false);
    expect(await audits(b.id)).toHaveLength(0);
  });
});

describe("réservation sans e-mail", () => {
  it("le jeton suffit : la page propose une adresse, la fiche est complétée, la confirmation part", async () => {
    const b = await bookAndPay();
    await t.db.prepare("UPDATE guests SET email = NULL WHERE id = (SELECT guest_id FROM bookings WHERE id = ?1)").bind(b.id).run();
    const before = await call("GET", `${api(b.reference)}?k=${b.k}`);
    expect(before.status).toBe(200);
    expect(before.data).toMatchObject({ hasEmail: false, recipient: null, resendsLeft: 3 });

    const r = await call("POST", api(b.reference), { k: b.k, to: "claire@example.org" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ hasEmail: true, recipient: "c•••@example.org", lastSent: { to: "c•••@example.org" } });
    expect(await guestEmail(b.id)).toBe("claire@example.org");
    expect(JSON.parse((await audits(b.id))[0]!.detail)).toMatchObject({ adresseFiche: null, ficheCompletee: true });
    const log = await mails(b.id);
    expect(log.at(-1)!.to_email).toBe("claire@example.org");
    // Le voucher du mail s'ouvre avec la nouvelle adresse, et la page voucher l'accepte.
    expect(log.at(-1)!.body_text).toContain(`email=${encodeURIComponent("claire@example.org")}`);
    expect((await call("GET", `/api/public/bookings/${b.reference}?email=claire@example.org`)).status).toBe(200);
  });
});
