// Les échanges clients vivent dans la plateforme — sans email nécessaire :
// formulaire public → boîte Messages → réponse de l'équipe → visible sur le
// voucher du client. L'email n'est qu'une notification optionnelle (stub ici).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;

const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "Marie", lastName: "Lambert", email: "marie@example.com" };
const ADMIN = "test-admin-token";

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["messages", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const auth = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth } : auth,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function createBookingViaAdmin() {
  const sale = await call("POST", "/api/admin/bookings", {
    unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, guest: GUEST,
  });
  return sale.data.booking as { id: number; reference: string };
}

describe("formulaire public de contact (avant réservation)", () => {
  it("crée un message 'form' visible dans la boîte admin, lié au client connu", async () => {
    await createBookingViaAdmin(); // crée le client marie@example.com
    const res = await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Marie Lambert", email: "marie@example.com",
      message: "Le sauna est-il accessible en hiver ?", website: "",
    });
    expect(res.status).toBe(201);
    const inbox = await call("GET", "/api/admin/messages?property=1");
    const messages = inbox.data.messages as { channel: string; guestId: number | null; status: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channel).toBe("form");
    expect(messages[0]!.guestId).not.toBeNull();
    expect(messages[0]!.status).toBe("nouveau");
  });

  it("pot de miel et validations", async () => {
    // bot : champ caché rempli → accepté en façade, rien stocké
    const bot = await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Bot", email: "bot@spam.com", message: "spam spam spam", website: "http://spam",
    });
    expect(bot.status).toBe(200);
    expect(((await call("GET", "/api/admin/messages")).data.messages as unknown[])).toHaveLength(0);
    // validations
    expect((await call("POST", "/api/public/contact", { property: "pre-more", name: "X", email: "pas-un-email", message: "hello world" })).status).toBe(400);
    expect((await call("POST", "/api/public/contact", { property: "inconnu", name: "Marie", email: "m@x.be", message: "hello world" })).status).toBe(404);
  });
});

describe("fil de conversation du voucher (sans email)", () => {
  it("client écrit depuis son voucher → équipe répond → réponse visible côté client", async () => {
    const booking = await createBookingViaAdmin();
    const threadPath = `/api/public/bookings/${booking.reference}/messages`;

    // auth : référence + email exacts requis
    expect((await call("GET", `${threadPath}?email=autre@example.com`)).status).toBe(404);

    // 1. le client écrit depuis son voucher
    const sent = await call("POST", threadPath, { email: GUEST.email, message: "Peut-on arriver vers 20h ?" });
    expect(sent.status).toBe(201);

    // 2. l'équipe voit le message et répond DEPUIS LA PLATEFORME
    const inbox = await call("GET", "/api/admin/messages?property=1");
    const msg = (inbox.data.messages as { id: number; bookingReference: string }[])[0]!;
    expect(msg.bookingReference).toBe(booking.reference);
    const reply = await call("POST", `/api/admin/messages/${msg.id}/reply`, { body: "Oui bien sûr, à 20h — bonne route !" });
    expect(reply.status).toBe(200);
    expect(reply.data.delivery).toBe("stub"); // email non activé → notification en stub

    // 3. le client voit la réponse sur son voucher (aucun email nécessaire)
    const thread = await call("GET", `${threadPath}?email=${encodeURIComponent(GUEST.email)}`);
    const messages = thread.data.messages as { direction: string; body: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[1]!.direction).toBe("out");
    expect(messages[1]!.body).toContain("bonne route");

    // 4. le message d'origine est passé « traité », la notification est journalisée
    const after = await call("GET", "/api/admin/messages?property=1&status=nouveau");
    expect(after.data.messages as unknown[]).toHaveLength(0);
    const log = await call("GET", "/api/admin/email-log");
    expect((log.data.emails as { kind: string; status: string }[])[0]).toMatchObject({ kind: "reply", status: "stub" });
  });

  it("message proactif de l'équipe depuis la fiche résa", async () => {
    const booking = await createBookingViaAdmin();
    const res = await call("POST", `/api/admin/bookings/${booking.id}/messages`, { body: "Petit rappel : arrivée dès 16h samedi !" });
    expect(res.status).toBe(200);
    const thread = await call("GET", `/api/public/bookings/${booking.reference}/messages?email=${encodeURIComponent(GUEST.email)}`);
    const messages = thread.data.messages as { direction: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe("out");
  });

  it("le fil du voucher regroupe messages de résa ET du même client (contact form)", async () => {
    const booking = await createBookingViaAdmin();
    await call("POST", "/api/public/contact", {
      property: "pre-more", name: "Marie Lambert", email: GUEST.email, message: "Question générale avant séjour",
    });
    const thread = await call("GET", `/api/public/bookings/${booking.reference}/messages?email=${encodeURIComponent(GUEST.email)}`);
    expect((thread.data.messages as unknown[]).length).toBe(1); // le message contact est lié au guest → visible
  });
});
