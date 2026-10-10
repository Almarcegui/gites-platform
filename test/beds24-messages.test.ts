// Messagerie des canaux par Beds24 : relève au cron (une par passage, quota
// journalisé), rattachement à nos réservations par beds24:<id>, marquage lu en
// un appel, fil unifié dans /api/admin/messages, réponse qui repart par Beds24.
// Aucun appel réseau réel : fetch est remplacé pour api.beds24.com.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { applyChannelBookings } from "../src/services/beds24-sync";
import { MESSAGES_STATE_KEY, pullChannelMessages } from "../src/services/beds24-messages";
import { addDays, todayInZone } from "../src/core/dates";
import { getSetting } from "../src/services/settings";

const router = new Router();
registerAdminRoutes(router);
const ADMIN = "admin:jeton";
let t: TestDb;

const env = (prod = true): Env => ({
  DB: t.db, ASSETS: undefined as unknown as Fetcher, ADMIN_TOKEN: ADMIN,
  PUBLIC_BASE_URL: prod ? "https://gites.exemple.be" : "http://localhost:8798",
  BEDS24_REFRESH_TOKEN: "refresh-de-test", EMAILS_ENABLED: "false",
});

interface Call { method: string; url: URL; body: unknown }
let calls: Call[] = [];
let inbox: unknown[] = [];
let postStatus = 201;
let remaining = "93";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await createTestDb();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.beds24.com") return realFetch(input as RequestInfo, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    const credit = { "X-FiveMinCreditLimit": "100", "X-FiveMinCreditLimit-Remaining": remaining, "X-RequestCost": "1" };
    if (url.pathname.endsWith("/authentication/token")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
    if (url.pathname.endsWith("/bookings/messages") && method === "GET") {
      return new Response(JSON.stringify({ success: true, data: inbox, pages: { nextPageExists: false } }), { status: 200, headers: credit });
    }
    if (url.pathname.endsWith("/bookings/messages") && method === "POST") {
      return new Response(JSON.stringify((body as unknown[]).map(() => ({ success: postStatus < 300 }))), { status: postStatus, headers: credit });
    }
    return new Response(JSON.stringify({ error: "inattendu" }), { status: 500 });
  }) as typeof fetch;

  // une réservation Airbnb rapatriée de Beds24 (external_uid beds24:777001)
  await applyChannelBookings(t.db, [{
    id: 777001, roomId: 711714, status: "confirmed",
    arrival: addDays(todayInZone(), 60), departure: addDays(todayInZone(), 63),
    numAdult: 2, firstName: "Anna", lastName: "Jansen", email: "anna.relais@guest.airbnb.com", channel: "airbnb",
  }], new Map([[711713, 1], [711714, 2]]));
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t.dispose();
});
beforeEach(async () => {
  calls = [];
  postStatus = 201;
  remaining = "93";
  for (const table of ["channel_messages", "messages", "audit_log"]) await t.db.prepare(`DELETE FROM ${table}`).run();
  await t.db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(MESSAGES_STATE_KEY).run();
  inbox = [
    { id: 5001, bookingId: 777001, propertyId: 344555, time: "2026-10-10T08:15:00Z", read: false, source: "guest", message: "Bonjour, à quelle heure peut-on arriver ?" },
    { id: 5002, bookingId: 777001, propertyId: 344555, time: "2026-10-10T08:20:00Z", read: false, source: "system", message: "Réservation confirmée par Airbnb" },
    { id: 5003, bookingId: 999999, propertyId: 344555, time: "2026-10-10T09:00:00Z", read: false, source: "guest", message: "Question sur une autre réservation" },
  ];
});

async function api(method: string, path: string, body?: unknown, e: Env = env()) {
  const res = await router.handle(new Request(`http://test.local${path}`, {
    method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), e);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("relève des messages des canaux", () => {
  it("une seule lecture, rattachement par beds24:<id>, copie dans le fil, marquage lu en un appel", async () => {
    const r = await pullChannelMessages(env(), new Date("2026-10-10T10:00:00Z"));
    expect(r).toMatchObject({ fetched: 3, imported: 3, linked: 2, markedRead: 3, markRead: "ok" });
    const gets = calls.filter((c) => c.method === "GET" && c.url.pathname.endsWith("/bookings/messages"));
    expect(gets).toHaveLength(1);
    expect(gets[0]!.url.searchParams.get("filter")).toBe("unread");
    expect(gets[0]!.url.searchParams.get("maxAge")).toBe("30");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual([{ id: 5001, read: true }, { id: 5002, read: true }, { id: 5003, read: true }]);

    const guest = await t.db.prepare(
      "SELECT m.direction, m.channel, m.status, m.booking_id, m.from_email, m.body_text, m.received_at FROM messages m JOIN channel_messages c ON c.message_id = m.id WHERE c.beds24_message_id = 5001",
    ).first<Record<string, unknown>>();
    expect(guest).toMatchObject({ direction: "in", channel: "beds24", status: "nouveau", from_email: "anna.relais@guest.airbnb.com", received_at: "2026-10-10 08:15:00" });
    expect(guest?.booking_id).not.toBeNull();
    // le message système est gardé, pas recopié dans la boîte
    const sys = await t.db.prepare("SELECT direction, message_id, read FROM channel_messages WHERE beds24_message_id = 5002").first<Record<string, unknown>>();
    expect(sys).toMatchObject({ direction: "note", message_id: null, read: 1 });
    // résa inconnue chez nous : gardé, adresse pseudo pour regrouper le fil
    const orphan = await t.db.prepare("SELECT m.booking_id, m.from_email, m.property_id FROM messages m JOIN channel_messages c ON c.message_id = m.id WHERE c.beds24_message_id = 5003").first<Record<string, unknown>>();
    expect(orphan).toMatchObject({ booking_id: null, from_email: "beds24:999999", property_id: 1 });

    const state = JSON.parse((await getSetting(t.db, MESSAGES_STATE_KEY)) ?? "{}");
    expect(state.credit).toMatchObject({ limit: 100, remaining: 93, cost: 1 });
    const auditRow = await t.db.prepare("SELECT detail FROM audit_log WHERE action = 'beds24.messages'").first<{ detail: string }>();
    expect(JSON.parse(auditRow!.detail)).toMatchObject({ imported: 3, credit: { limit: 100 } });
  });

  it("idempotente : un message déjà relevé n'est pas recopié ; la fenêtre suit la dernière relève", async () => {
    await pullChannelMessages(env(), new Date("2026-10-10T10:00:00Z"));
    calls = [];
    const r = await pullChannelMessages(env(), new Date("2026-10-12T10:00:00Z"));
    expect(r.imported).toBe(0);
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())?.n).toBe(2);
    expect(calls.find((c) => c.method === "GET" && c.url.pathname.endsWith("/bookings/messages"))!.url.searchParams.get("maxAge")).toBe("3");
  });

  it("hors production : relève oui, marquage lu non (écriture Beds24 bloquée)", async () => {
    const r = await pullChannelMessages(env(false), new Date("2026-10-10T10:00:00Z"));
    expect(r).toMatchObject({ imported: 3, markRead: "bloqué hors production", markedRead: 0 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // la fenêtre ne recule pas : rien n'a été marqué lu chez Beds24
    expect(JSON.parse((await getSetting(t.db, MESSAGES_STATE_KEY)) ?? "{}").at).toBeUndefined();
  });

  it("réserve de crédits basse : le marquage attend le cycle suivant, la fenêtre aussi", async () => {
    remaining = "4";
    const r = await pullChannelMessages(env(), new Date("2026-10-10T10:00:00Z"));
    expect(r).toMatchObject({ imported: 3, markRead: "reporté (quota)" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'beds24.messages.credit_bas'").first<{ n: number }>()).toMatchObject({ n: 1 });
    remaining = "93";
    calls = [];
    const r2 = await pullChannelMessages(env(), new Date("2026-10-12T10:00:00Z"));
    expect(r2).toMatchObject({ imported: 0, markRead: "ok", markedRead: 3 });
    expect(calls.find((c) => c.method === "GET" && c.url.pathname.endsWith("/bookings/messages"))!.url.searchParams.get("maxAge")).toBe("30");
  });

  it("sans Beds24 configuré : rien, aucun appel", async () => {
    const r = await pullChannelMessages({ ...env(), BEDS24_REFRESH_TOKEN: undefined });
    expect(r.ran).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("fil unifié et réponse par le canal", () => {
  const guestMessageId = async () =>
    (await t.db.prepare("SELECT message_id FROM channel_messages WHERE beds24_message_id = 5001").first<{ message_id: number }>())!.message_id;

  it("la liste du back-office porte le canal du message (badge)", async () => {
    await pullChannelMessages(env());
    const { data } = await api("GET", "/api/admin/messages?status=nouveau");
    const list = data.messages as { channel: string; canal: string | null; fromEmail: string }[];
    const airbnb = list.find((m) => m.fromEmail === "anna.relais@guest.airbnb.com");
    expect(airbnb).toMatchObject({ channel: "beds24", canal: "Airbnb" });
    expect(list.find((m) => m.fromEmail === "beds24:999999")).toMatchObject({ canal: "Canal Beds24" });
  });

  it("répondre : POST /bookings/messages sur la résa Beds24, jamais de mail, message traité", async () => {
    await pullChannelMessages(env());
    const id = await guestMessageId();
    calls = [];
    const r = await api("POST", `/api/admin/messages/${id}/reply`, { body: "Bonjour Anna, dès 16 h." });
    expect(r.status).toBe(200);
    expect(r.data.delivery).toBe("beds24");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual([{ bookingId: 777001, message: "Bonjour Anna, dès 16 h." }]);
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'reply'").first<{ n: number }>())?.n).toBe(0);
    expect((await t.db.prepare("SELECT status FROM messages WHERE id = ?1").bind(id).first<{ status: string }>())?.status).toBe("traité");
    const thread = await api("GET", `/api/admin/messages/${id}/thread`);
    const items = thread.data.thread as { direction: string; channel: string; bodyText: string }[];
    expect(items.at(-1)).toMatchObject({ direction: "out", channel: "beds24", bodyText: "Bonjour Anna, dès 16 h." });
  });

  it("Beds24 refuse : 502, le message reste à répondre, aucune réponse fantôme dans le fil", async () => {
    await pullChannelMessages(env());
    const id = await guestMessageId();
    postStatus = 400;
    const r = await api("POST", `/api/admin/messages/${id}/reply`, { body: "Réponse qui ne part pas" });
    expect(r.status).toBe(502);
    expect(String(r.data.error)).toContain("Airbnb");
    expect((await t.db.prepare("SELECT status FROM messages WHERE id = ?1").bind(id).first<{ status: string }>())?.status).toBe("nouveau");
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND channel = 'beds24'").first<{ n: number }>())?.n).toBe(0);
    // et l'on peut réessayer tout de suite
    postStatus = 201;
    expect((await api("POST", `/api/admin/messages/${id}/reply`, { body: "Réponse qui ne part pas" })).status).toBe(200);
  });

  it("panne réseau pendant l'envoi : état « inconnu » gardé, pas de renvoi immédiat", async () => {
    await pullChannelMessages(env());
    const id = await guestMessageId();
    const before = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") throw new TypeError("fetch failed");
      return before(input, init);
    }) as typeof fetch;
    try {
      const r = await api("POST", `/api/admin/messages/${id}/reply`, { body: "Peut-être partie" });
      expect(r.status).toBe(502);
      expect(String(r.data.error)).toContain("peut-être partie");
    } finally {
      globalThis.fetch = before;
    }
    expect((await t.db.prepare("SELECT delivery FROM messages WHERE direction = 'out' AND channel = 'beds24'").all()).results).toEqual([{ delivery: "inconnu" }]);
    calls = [];
    expect((await api("POST", `/api/admin/messages/${id}/reply`, { body: "Peut-être partie" })).status).toBe(502);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("double clic : la même réponse ne part qu'une fois", async () => {
    await pullChannelMessages(env());
    const id = await guestMessageId();
    calls = [];
    const [a, b] = await Promise.all([
      api("POST", `/api/admin/messages/${id}/reply`, { body: "Bienvenue !" }),
      api("POST", `/api/admin/messages/${id}/reply`, { body: "Bienvenue !" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 502]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((await t.db.prepare("SELECT delivery FROM messages WHERE direction = 'out' AND channel = 'beds24'").all()).results).toEqual([{ delivery: "beds24" }]);
  });

  it("hors production : la réponse est refusée avant tout appel (garde des écritures)", async () => {
    await pullChannelMessages(env(false));
    const id = await guestMessageId();
    calls = [];
    const r = await api("POST", `/api/admin/messages/${id}/reply`, { body: "Essai local" }, env(false));
    expect(r.status).toBe(502);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
