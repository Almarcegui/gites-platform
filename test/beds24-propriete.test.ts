// Création de la propriété Beds24 depuis le back-office (nouveau compte vide,
// 10/10/2026). Faux serveur Beds24 en mémoire (fetch global stubé) — AUCUN
// appel réseau réel ; vraie base D1 (Miniflare) avec les migrations, donc le
// mapping périmé de la migration 0010 (#344555, #711713, #711714).
// Fichier séparé : stub de fetch global et cache de token module-level.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { resetBeds24TokenCache } from "../src/services/beds24";
import { buildPropertyPlan, createBeds24Property, CreationRefusee } from "../src/services/beds24-propriete";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN_HEADER = { authorization: "Bearer test-admin-token" };

interface FakeRoom { id: number; name: string; [k: string]: unknown }
interface FakeProperty { id: number; name: string; roomTypes: FakeRoom[]; [k: string]: unknown }

/** Faux Beds24 : un compte, ses propriétés, et le journal des POST reçus. */
class FakeBeds24 {
  props: FakeProperty[] = [];
  posts: unknown[] = [];
  nextId = 900000;
  /** Réponse forcée au prochain POST /properties (refus Beta). */
  rejectNext: unknown = null;

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname !== "api.beds24.com") throw new Error(`appel réseau inattendu : ${url}`);
    const method = init?.method ?? "GET";
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname === "/v2/authentication/token") return ok({ token: "acc" });
    if (url.pathname === "/v2/authentication/details") {
      return ok({ validToken: true, token: { ownerId: 271828, deviceName: "gites-platform", scopes: ["all:properties"] } });
    }
    if (url.pathname === "/v2/properties" && method === "GET") {
      return ok({ success: true, data: this.props.map((p) => ({ id: p.id, name: p.name, roomTypes: p.roomTypes })) });
    }
    if (url.pathname === "/v2/properties" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      this.posts.push(body);
      if (this.rejectNext) {
        const r = this.rejectNext;
        this.rejectNext = null;
        return ok(r, 201);
      }
      const out = body.map((item) => {
        const rooms = ((item.roomTypes as Record<string, unknown>[]) ?? []).map((r) => ({ ...r, id: this.nextId++, name: String(r.name) }));
        if (item.id) {
          const p = this.props.find((x) => x.id === item.id)!;
          p.roomTypes.push(...rooms);
          return { success: true, modified: { id: p.id } };
        }
        const p: FakeProperty = { ...item, id: this.nextId++, name: String(item.name), roomTypes: rooms };
        this.props.push(p);
        return { success: true, new: { id: p.id } };
      });
      return ok(out, 201);
    }
    if (url.pathname === "/v2/inventory/rooms/calendar") return ok([{ success: true }], 201);
    throw new Error(`route Beds24 non simulée : ${method} ${url.pathname}`);
  };
}

let fake: FakeBeds24;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  fake = new FakeBeds24();
  vi.stubGlobal("fetch", fake.handler);
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: "test-admin-token",
    BEDS24_REFRESH_TOKEN: "faux-refresh",
    BEDS24_WRITE_ENABLED: "true",
  };
  // Mapping de juillet, périmé dans le nouveau compte.
  await t.db.batch([
    t.db.prepare("UPDATE properties SET beds24_property_id = 344555 WHERE id = 1"),
    t.db.prepare("UPDATE units SET beds24_room_id = 711713 WHERE id = 1"),
    t.db.prepare("UPDATE units SET beds24_room_id = 711714 WHERE id = 2"),
    t.db.prepare("UPDATE units SET beds24_room_id = NULL WHERE id = 3"),
    t.db.prepare("DELETE FROM app_settings WHERE key = 'beds24_creation_verrou'"),
  ]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetBeds24TokenCache();
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", ...ADMIN_HEADER },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error("route inconnue");
  return res;
}

async function mapping() {
  const p = await t.db.prepare("SELECT beds24_property_id AS id FROM properties WHERE id = 1").first<{ id: number | null }>();
  const { results } = await t.db.prepare("SELECT id, beds24_room_id AS room FROM units WHERE property_id = 1 ORDER BY id").all<{ id: number; room: number | null }>();
  return { property: p?.id ?? null, rooms: results.map((r) => r.room) };
}

describe("plan de création (lecture de notre base)", () => {
  it("une room par maison, le Domaine entier reste en direct", async () => {
    const plan = await buildPropertyPlan(t.db, 1);
    expect(plan.name).toBe("Les Gîtes du Pré Moré");
    expect(plan.country).toBe("BE");
    expect(plan.currency).toBe("EUR");
    expect(plan.city).toBe("Daverdisse");
    // l'adresse de contact de seed (TODO_…) ne part pas chez un tiers
    expect(plan.email).toBeUndefined();
    expect(plan.rooms.map((r) => r.name)).toEqual(["La Maison du Scieur", "La Scierie"]);
    expect(plan.rooms[0]).toMatchObject({ qty: 1, maxPeople: 11, minStay: 2, rackRate: 180 });
    expect(plan.rooms[1]).toMatchObject({ maxPeople: 8, minStay: 2, rackRate: 120 });
    expect(plan.directOnly.map((d) => d.name)).toEqual(["Le Domaine entier"]);
  });
});

describe("GET /api/admin/beds24/status", () => {
  it("nouveau compte vide : compte relié, aucune propriété, mapping périmé → création proposée", async () => {
    const res = await call("GET", "/api/admin/beds24/status?property=1");
    expect(res.status).toBe(200);
    const s = (await res.json()) as {
      connected: boolean; compte: { id: number }; properties: unknown[];
      mapping: { etat: string; rooms: { etat: string }[] }; creationPossible: boolean;
    };
    expect(s.connected).toBe(true);
    expect(s.compte.id).toBe(271828);
    expect(s.properties).toEqual([]);
    expect(s.mapping.etat).toBe("perime");
    expect(s.mapping.rooms.map((r) => r.etat)).toEqual(["perime", "perime"]);
    expect(s.creationPossible).toBe(true);
  });

  it("mapping vivant : actif, pas de création proposée", async () => {
    fake.props.push({ id: 344555, name: "Les Gîtes du Pré Moré", roomTypes: [{ id: 711713, name: "La Maison du Scieur" }, { id: 711714, name: "La Scierie" }] });
    const s = (await (await call("GET", "/api/admin/beds24/status")).json()) as { mapping: { etat: string }; creationPossible: boolean };
    expect(s.mapping.etat).toBe("actif");
    expect(s.creationPossible).toBe(false);
  });
});

describe("POST /api/admin/beds24/creer-propriete", () => {
  it("sans { confirmer: true } → 400, aucun appel Beds24", async () => {
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1 });
    expect(res.status).toBe(400);
    expect(fake.posts).toHaveLength(0);
  });

  it("écritures bloquées hors production → 403, aucun POST", async () => {
    delete env.BEDS24_WRITE_ENABLED;
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(403);
    expect(fake.posts).toHaveLength(0);
    expect((await mapping()).property).toBe(344555);
  });

  it("compte vide : crée la propriété + 2 rooms, écrit le mapping, journalise", async () => {
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(200);
    const r = (await res.json()) as {
      propriete: { beds24PropertyId: number; creee: boolean };
      rooms: { unitId: number; beds24RoomId: number; creee: boolean }[];
      ancienMapping: { beds24PropertyId: number };
    };
    expect(fake.posts).toHaveLength(1);
    const sent = (fake.posts[0] as Record<string, unknown>[])[0]!;
    expect(sent).toMatchObject({ name: "Les Gîtes du Pré Moré", country: "BE", currency: "EUR", city: "Daverdisse" });
    expect((sent.roomTypes as { name: string }[]).map((x) => x.name)).toEqual(["La Maison du Scieur", "La Scierie"]);
    expect(sent.id).toBeUndefined();

    const created = fake.props[0]!;
    expect(r.propriete).toEqual({ beds24PropertyId: created.id, name: created.name, creee: true });
    expect(r.rooms.map((x) => x.beds24RoomId)).toEqual(created.roomTypes.map((x) => x.id));
    expect(r.rooms.every((x) => x.creee)).toBe(true);
    expect(r.ancienMapping.beds24PropertyId).toBe(344555);
    expect(await mapping()).toEqual({ property: created.id, rooms: [created.roomTypes[0]!.id, created.roomTypes[1]!.id, null] });

    const log = await t.db
      .prepare("SELECT entity, detail FROM audit_log WHERE action = 'beds24.creer_propriete' ORDER BY id DESC LIMIT 1")
      .first<{ entity: string; detail: string }>();
    expect(log?.entity).toBe("property:1");
    expect(JSON.parse(log!.detail).ancienMapping.beds24PropertyId).toBe(344555);
    // verrou relâché
    expect(await t.db.prepare("SELECT 1 FROM app_settings WHERE key = 'beds24_creation_verrou'").first()).toBeNull();
  });

  it("second appel : propriété mappée ET présente → 409, aucun doublon", async () => {
    expect((await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true })).status).toBe(200);
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(409);
    expect(fake.posts).toHaveLength(1);
    expect(fake.props).toHaveLength(1);
  });

  it("reprise après panne (créée chez Beds24, mapping pas écrit) : retrouvée par nom, aucun POST", async () => {
    fake.props.push({ id: 555001, name: "les gîtes du pré moré ", roomTypes: [{ id: 555011, name: "La Maison du Scieur" }, { id: 555012, name: "La Scierie" }] });
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { propriete: { creee: boolean }; rooms: { creee: boolean }[] };
    expect(fake.posts).toHaveLength(0);
    expect(r.propriete.creee).toBe(false);
    expect(r.rooms.every((x) => !x.creee)).toBe(true);
    expect(await mapping()).toEqual({ property: 555001, rooms: [555011, 555012, null] });
  });

  it("propriété retrouvée avec une room manquante : seule la room manquante est ajoutée", async () => {
    fake.props.push({ id: 555001, name: "Les Gîtes du Pré Moré", roomTypes: [{ id: 555011, name: "La Maison du Scieur" }] });
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(200);
    expect(fake.posts).toEqual([[{ id: 555001, roomTypes: [expect.objectContaining({ name: "La Scierie", qty: 1 })] }]]);
    const m = await mapping();
    expect(m.property).toBe(555001);
    expect(m.rooms[0]).toBe(555011);
    expect(m.rooms[1]).toBe(fake.props[0]!.roomTypes[1]!.id);
  });

  it("deux homonymes dans le compte → 409, rien n'est écrit", async () => {
    fake.props.push({ id: 1, name: "Les Gîtes du Pré Moré", roomTypes: [] }, { id: 2, name: "Les Gîtes du Pré Moré", roomTypes: [] });
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(409);
    expect(fake.posts).toHaveLength(0);
    expect((await mapping()).property).toBe(344555);
  });

  it("refus Beta de Beds24 (201 + success:false) → 502 en clair, mapping inchangé", async () => {
    fake.rejectNext = [{ success: false, errors: [{ action: "new", field: "country", message: "invalid country code" }] }];
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("country : invalid country code");
    expect(await mapping()).toEqual({ property: 344555, rooms: [711713, 711714, null] });
    expect(await t.db.prepare("SELECT 1 FROM app_settings WHERE key = 'beds24_creation_verrou'").first()).toBeNull();
  });

  it("double clic : un verrou en cours refuse le second appel", async () => {
    await t.db.prepare("INSERT INTO app_settings (key, value) VALUES ('beds24_creation_verrou', 'creation')").run();
    await expect(createBeds24Property(env, 1, "test")).rejects.toBeInstanceOf(CreationRefusee);
    expect(fake.posts).toHaveLength(0);
  });

  it("après création, le push existant vise les nouvelles rooms", async () => {
    await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });
    const res = await call("POST", "/api/admin/beds24/push", { propertyId: 1, days: 3 });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { pushed: { roomId: number }[] };
    expect(r.pushed.map((x) => x.roomId)).toEqual(fake.props[0]!.roomTypes.map((x) => x.id));
  });
});
