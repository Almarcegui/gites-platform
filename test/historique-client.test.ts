// Historique des échanges d'un client : GET /api/admin/guests/:id/history.
// Mails envoyés (email_log) + messages reçus ou écrits (messages), rangés par séjour,
// sans jamais mêler les données d'un autre client.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN = "test-admin-token";

const D1 = addDays(todayInZone(), 100);
const D2 = addDays(D1, 7);
const D3 = addDays(D2, 30);
const D4 = addDays(D3, 7);

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["channel_messages", "messages", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await t.db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function call(method: string, path: string, body?: unknown, auth: string | null = ADMIN): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function book(unitId: number, checkin: string, checkout: string, guest: { firstName: string; lastName: string; email: string }) {
  const sale = await call("POST", "/api/admin/bookings", { unitId, checkin, checkout, adults: 2, guest });
  expect(sale.status).toBe(201);
  const b = sale.data.booking as { id: number; reference: string };
  await t.db.prepare("DELETE FROM email_log").run(); // la création a journalisé son lien de paiement : on part d'un journal vide
  const row = (await t.db.prepare("SELECT guest_id FROM bookings WHERE id = ?1").bind(b.id).first()) as { guest_id: number };
  return { ...b, guestId: row.guest_id };
}

async function mail(bookingId: number | null, to: string, kind: string, subject: string, at: string, status = "sent") {
  await t.db
    .prepare("INSERT INTO email_log (booking_id, to_email, subject, body_text, kind, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(bookingId, to, subject, `corps de ${subject}`, kind, status, at)
    .run();
}

async function message(o: { bookingId?: number | null; guestId?: number | null; direction: "in" | "out"; channel?: string; from?: string; to?: string; subject: string; at: string; delivery?: string | null }) {
  const res = await t.db
    .prepare(
      `INSERT INTO messages (property_id, direction, channel, from_email, to_email, subject, body_text, booking_id, guest_id, delivery, received_at)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(o.direction, o.channel ?? "email", o.from ?? "x@example.com", o.to ?? null, o.subject, `texte de ${o.subject}`, o.bookingId ?? null, o.guestId ?? null, o.delivery ?? null, o.at)
    .run();
  return res.meta.last_row_id as number;
}

type Item = { key: string; source: string; direction: string; kind: string; subject: string; bookingId: number | null; at: string; status: string | null; canal: string | null; channel: string | null };
type Hist = { guest: { id: number; name: string; email: string | null }; stays: { bookingId: number; reference: string }[]; items: Item[] };

const MARIE = { firstName: "Marie", lastName: "Lambert", email: "marie@example.com" };
const PAUL = { firstName: "Paul", lastName: "Durand", email: "paul@example.com" };

describe("historique des échanges d'un client", () => {
  it("refuse sans session ni jeton, comme les autres routes du back-office", async () => {
    const b = await book(2, D1, D2, MARIE);
    expect((await call("GET", `/api/admin/guests/${b.guestId}/history`, undefined, null)).status).toBe(401);
    expect((await call("GET", `/api/admin/guests/${b.guestId}/history`, undefined, "mauvais-jeton")).status).toBe(401);
    expect((await call("GET", `/api/admin/guests/${b.guestId}/history`)).status).toBe(200);
  });

  it("client inconnu ou identifiant invalide", async () => {
    expect((await call("GET", "/api/admin/guests/9999/history")).status).toBe(404);
    expect((await call("GET", "/api/admin/guests/abc/history")).status).toBe(400);
  });

  it("rassemble mails et messages en une liste triée, du plus récent au plus ancien", async () => {
    const b = await book(2, D1, D2, MARIE);
    await mail(b.id, MARIE.email, "confirmation", "[R] Confirmation", "2026-10-01 10:00:00");
    await message({ bookingId: b.id, guestId: b.guestId, direction: "in", from: MARIE.email, subject: "Arrivée tardive ?", at: "2026-10-02 09:00:00" });
    await mail(b.id, MARIE.email, "balance_reminder", "[R] Solde", "2026-10-03 08:00:00", "stub");
    await message({ bookingId: b.id, guestId: b.guestId, direction: "out", to: MARIE.email, subject: "Re: Arrivée tardive ?", at: "2026-10-02 10:30:00", delivery: "stub" });
    const h = (await call("GET", `/api/admin/guests/${b.guestId}/history`)).data as unknown as Hist;
    expect(h.guest).toMatchObject({ id: b.guestId, name: "Marie Lambert", email: MARIE.email });
    expect(h.items.map((i) => i.subject)).toEqual(["[R] Solde", "Re: Arrivée tardive ?", "Arrivée tardive ?", "[R] Confirmation"]);
    expect(h.items[0]).toMatchObject({ source: "mail", direction: "out", kind: "balance_reminder", status: "stub" });
    expect(h.items[1]).toMatchObject({ source: "message", direction: "out", status: "stub" });
    expect(h.items[2]).toMatchObject({ source: "message", direction: "in", status: null });
  });

  it("range par séjour et garde un groupe hors séjour", async () => {
    const b1 = await book(2, D1, D2, MARIE);
    const b2 = await book(2, D3, D4, MARIE);
    await mail(b1.id, MARIE.email, "confirmation", "conf 1", "2026-10-01 10:00:00");
    await mail(b2.id, MARIE.email, "payment_link", "lien 2", "2026-10-05 10:00:00");
    await message({ bookingId: b2.id, direction: "in", from: MARIE.email, subject: "question séjour 2", at: "2026-10-06 10:00:00" }); // rattaché par la réservation seule
    await message({ guestId: b1.guestId, direction: "in", from: MARIE.email, channel: "form", subject: "avant de réserver", at: "2026-09-01 10:00:00" });
    await mail(null, MARIE.email, "contact_ack", "accusé", "2026-09-01 10:00:05");
    const h = (await call("GET", `/api/admin/guests/${b1.guestId}/history`)).data as unknown as Hist;
    expect(h.stays.map((s) => s.reference)).toEqual([b2.reference, b1.reference]); // séjour le plus proche d'abord
    const by = (id: number | null) => h.items.filter((i) => i.bookingId === id).map((i) => i.subject).sort();
    expect(by(b1.id)).toEqual(["conf 1"]);
    expect(by(b2.id)).toEqual(["lien 2", "question séjour 2"]);
    expect(by(null)).toEqual(["accusé", "avant de réserver"]);
  });

  it("isole les clients : rien d'un autre client ne passe, même avec une réservation ou une adresse voisine", async () => {
    const marie = await book(2, D1, D2, MARIE);
    const paul = await book(1, D1, D2, PAUL);
    await mail(marie.id, MARIE.email, "confirmation", "pour Marie", "2026-10-01 10:00:00");
    await mail(paul.id, PAUL.email, "confirmation", "pour Paul", "2026-10-01 11:00:00");
    await mail(null, PAUL.email, "contact_ack", "accusé Paul", "2026-10-01 11:05:00");
    await message({ bookingId: paul.id, guestId: paul.guestId, direction: "in", from: PAUL.email, subject: "message de Paul", at: "2026-10-02 10:00:00" });
    await message({ direction: "in", from: PAUL.email, subject: "Paul sans rattachement", at: "2026-10-02 11:00:00" });
    // message du client Marie, mais posé sur la réservation de Paul : pas de fuite de la référence de Paul
    await message({ bookingId: paul.id, guestId: marie.guestId, direction: "in", from: MARIE.email, subject: "Marie sur la résa de Paul", at: "2026-10-03 10:00:00" });
    const hm = (await call("GET", `/api/admin/guests/${marie.guestId}/history`)).data as unknown as Hist;
    expect(hm.items.map((i) => i.subject).sort()).toEqual(["Marie sur la résa de Paul", "pour Marie"]);
    expect(hm.items.find((i) => i.subject === "Marie sur la résa de Paul")!.bookingId).toBeNull();
    expect(JSON.stringify(hm)).not.toContain(paul.reference);
    expect(hm.stays.map((s) => s.bookingId)).toEqual([marie.id]);
    const hp = (await call("GET", `/api/admin/guests/${paul.guestId}/history`)).data as unknown as Hist;
    expect(hp.items.map((i) => i.subject).sort()).toEqual(["Paul sans rattachement", "accusé Paul", "message de Paul", "pour Paul"]);
  });

  it("deux fiches avec la même adresse : les échanges rattachés à rien ne sont montrés à aucune des deux", async () => {
    const b = await book(2, D1, D2, MARIE);
    await t.db.prepare("INSERT INTO guests (email, last_name) VALUES (?1, 'Homonyme')").bind(MARIE.email.toUpperCase()).run();
    await mail(null, MARIE.email, "contact_ack", "accusé sans rattachement", "2026-10-01 10:00:00");
    await message({ direction: "in", from: MARIE.email, subject: "message sans rattachement", at: "2026-10-01 11:00:00" });
    await message({ guestId: b.guestId, direction: "in", from: MARIE.email, subject: "message rattaché", at: "2026-10-01 12:00:00" });
    const h = (await call("GET", `/api/admin/guests/${b.guestId}/history`)).data as unknown as Hist;
    expect(h.items.map((i) => i.subject)).toEqual(["message rattaché"]);
  });

  it("n'affiche pas deux fois une réponse (mail « reply » + message sortant), garde le nom de la plateforme", async () => {
    const b = await book(2, D1, D2, MARIE);
    await mail(b.id, MARIE.email, "reply", "doublon de réponse", "2026-10-02 10:30:00", "stub");
    const mid = await message({ bookingId: b.id, guestId: b.guestId, direction: "in", channel: "beds24", from: "airbnb", subject: "Depuis Airbnb", at: "2026-10-02 09:00:00" });
    await t.db
      .prepare("INSERT INTO channel_messages (beds24_message_id, beds24_booking_id, booking_id, message_id, source, direction, channel_label, body_text, sent_at) VALUES (1, 1, ?1, ?2, 'guest', 'in', 'Airbnb', 'x', '2026-10-02 09:00:00')")
      .bind(b.id, mid)
      .run();
    const h = (await call("GET", `/api/admin/guests/${b.guestId}/history`)).data as unknown as Hist;
    expect(h.items.map((i) => i.subject)).toEqual(["Depuis Airbnb"]);
    expect(h.items[0]).toMatchObject({ channel: "beds24", canal: "Airbnb" });
  });
});
