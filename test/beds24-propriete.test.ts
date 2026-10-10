// Création de la propriété Beds24 depuis le back-office (nouveau compte vide,
// 10/10/2026). Faux serveur Beds24 en mémoire (fetch global stubé) — AUCUN
// appel réseau réel ; vraie base D1 (Miniflare) avec les migrations, donc le
// mapping périmé de la migration 0010 (#344555, #711713, #711714) et les
// photos de la migration 0021.
// Fichier séparé : stub de fetch global et cache de token module-level.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { resetBeds24TokenCache } from "../src/services/beds24";
import { buildPropertyPlan, createBeds24Property, CreationRefusee, sameName } from "../src/services/beds24-propriete";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN_HEADER = { authorization: "Bearer test-admin-token" };
const NOM = "Les Gîtes du Pré Moré";

interface FakeRoom { id: number; name: string; [k: string]: unknown }
interface FakeProperty { id: number; name: string; roomTypes: FakeRoom[]; [k: string]: unknown }

/** Faux Beds24 : un compte, ses propriétés, et le journal des POST reçus. */
class FakeBeds24 {
  props: FakeProperty[] = [];
  posts: Record<string, unknown>[][] = [];
  nextId = 900000;
  /** Réponses forcées aux prochains POST /properties (file). */
  forced: { status: number; body: unknown; apply?: boolean }[] = [];
  /** Transforme le nom stocké (Beds24 qui encode ou renomme). */
  storeName: (n: string) => string = (n) => n;
  restrictedTo: number | null = null;

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname !== "api.beds24.com") throw new Error(`appel réseau inattendu : ${url}`);
    const method = init?.method ?? "GET";
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname === "/v2/authentication/token") return ok({ token: "acc" });
    if (url.pathname === "/v2/authentication/details") {
      return ok({
        validToken: true,
        token: { ownerId: 271828, deviceName: "gites-platform", scopes: ["all:properties"], onlyPropertyId: this.restrictedTo },
      });
    }
    if (url.pathname === "/v2/properties" && method === "GET") {
      return ok({ success: true, data: this.props.map((p) => ({ id: p.id, name: p.name, roomTypes: p.roomTypes })) });
    }
    if (url.pathname === "/v2/properties" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      this.posts.push(body);
      const forced = this.forced.shift();
      if (forced && !forced.apply) return ok(forced.body, forced.status);
      const out = body.map((item) => {
        const incoming = (item.roomTypes as Record<string, unknown>[]) ?? [];
        if (item.id) {
          const p = this.props.find((x) => x.id === item.id)!;
          Object.assign(p, { ...item, roomTypes: p.roomTypes });
          for (const r of incoming) {
            const known = r.id ? p.roomTypes.find((x) => x.id === r.id) : undefined;
            if (known) Object.assign(known, r);
            else p.roomTypes.push({ ...r, id: this.nextId++, name: this.storeName(String(r.name)) });
          }
          return { success: true, modified: { id: p.id } };
        }
        const rooms = incoming.map((r) => ({ ...r, id: this.nextId++, name: this.storeName(String(r.name)) }));
        const p: FakeProperty = { ...item, id: this.nextId++, name: this.storeName(String(item.name)), roomTypes: rooms };
        this.props.push(p);
        return { success: true, new: { id: p.id } };
      });
      if (forced) return ok(forced.body, forced.status); // appliqué, mais réponse perdue/erronée
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
    t.db.prepare("DELETE FROM app_settings WHERE key LIKE 'beds24_creation_%'"),
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
const creer = () => call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1, confirmer: true });

async function mapping() {
  const p = await t.db.prepare("SELECT beds24_property_id AS id FROM properties WHERE id = 1").first<{ id: number | null }>();
  const { results } = await t.db.prepare("SELECT id, beds24_room_id AS room FROM units WHERE property_id = 1 ORDER BY id").all<{ id: number; room: number | null }>();
  return { property: p?.id ?? null, rooms: results.map((r) => r.room) };
}

describe("plan de création (lecture de notre base)", () => {
  it("propriété et rooms complètes ; le Domaine entier reste en direct", async () => {
    const plan = await buildPropertyPlan(t.db, 1, "https://gites.example");
    expect(plan).toMatchObject({ name: NOM, country: "BE", currency: "EUR", city: "Daverdisse", checkInStart: "18:00", checkOutEnd: "18:00" });
    // l'adresse de contact de seed (TODO_…) ne part pas chez un tiers
    expect(plan.email).toBeUndefined();
    expect(plan.description).toContain("1674");
    expect(plan.rooms.map((r) => r.name)).toEqual(["La Maison du Scieur", "La Scierie"]);
    expect(plan.rooms[0]).toMatchObject({ qty: 1, maxPeople: 11, minStay: 2, rackRate: 180, cleaningFee: 120 });
    expect(plan.rooms[1]).toMatchObject({ maxPeople: 8, minStay: 2, rackRate: 120, cleaningFee: 90 });
    expect(plan.rooms[0]!.description).toContain("cuisinière de restaurant");
    expect(plan.rooms[1]!.description).toContain("feu ouvert");
    expect(plan.rooms[1]!.featureCodes).toContain("FIREPLACE");
    // rien d'affirmé que nos textes ne disent pas, rien de payant compté comme inclus
    for (const r of plan.rooms) {
      expect(r.featureCodes).not.toContain("WIFI");
      expect(r.featureCodes).not.toContain("PARKING");
      expect(r.featureCodes).not.toContain("SAUNA");
    }
    // 8 photos par maison, dans l'ordre, en URL publiques
    expect(plan.rooms[0]!.photos).toHaveLength(8);
    expect(plan.rooms[0]!.photos[0]!.url).toBe("https://gites.example/img/gites/maison-du-scieur/facade.jpg");
    expect(plan.rooms[0]!.aCompleter[0]).toMatch(/^Photos \(8\)/);
    expect(plan.aCompleter.join(" ")).toMatch(/GPS/);
    expect(plan.directOnly.map((d) => d.name)).toEqual(["Le Domaine entier"]);
  });

  it("noms comparés sans casse, espaces ni entités HTML", () => {
    expect(sameName("Les G&icirc;tes du Pr&eacute; Mor&eacute; ", NOM)).toBe(true);
    expect(sameName("Le Moulin", NOM)).toBe(false);
  });

  it("route d'aperçu : aucun appel réseau", async () => {
    const res = await call("GET", "/api/admin/beds24/creer-propriete/apercu?property=1");
    expect(res.status).toBe(200);
    expect(fake.posts).toHaveLength(0);
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
    fake.props.push({ id: 344555, name: NOM, roomTypes: [{ id: 711713, name: "La Maison du Scieur" }, { id: 711714, name: "La Scierie" }] });
    const s = (await (await call("GET", "/api/admin/beds24/status")).json()) as { mapping: { etat: string }; creationPossible: boolean };
    expect(s.mapping.etat).toBe("actif");
    expect(s.creationPossible).toBe(false);
  });

  it("écriture coupée sur ce serveur : mapping à refaire mais bouton absent", async () => {
    env.BEDS24_WRITE_ENABLED = "false";
    const s = (await (await call("GET", "/api/admin/beds24/status")).json()) as { mappingARefaire: boolean; creationPossible: boolean };
    expect(s.mappingARefaire).toBe(true);
    expect(s.creationPossible).toBe(false);
  });

  it("liaison inactive : état inconnu, pas de bouton", async () => {
    delete env.BEDS24_REFRESH_TOKEN;
    const s = (await (await call("GET", "/api/admin/beds24/status")).json()) as { connected: boolean; creationPossible: boolean };
    expect(s.connected).toBe(false);
    expect(s.creationPossible).toBe(false);
  });
});

describe("POST /api/admin/beds24/creer-propriete", () => {
  it("sans { confirmer: true } → 400, aucun appel Beds24", async () => {
    const res = await call("POST", "/api/admin/beds24/creer-propriete", { propertyId: 1 });
    expect(res.status).toBe(400);
    expect(fake.posts).toHaveLength(0);
  });

  it("écritures bloquées (local http, ou essai https avec false) → 403, aucun POST", async () => {
    delete env.BEDS24_WRITE_ENABLED;
    expect((await creer()).status).toBe(403);
    env.PUBLIC_BASE_URL = "https://essai.example";
    env.BEDS24_WRITE_ENABLED = "false";
    expect((await creer()).status).toBe(403);
    expect(fake.posts).toHaveLength(0);
    expect((await mapping()).property).toBe(344555);
  });

  it("compte vide : squelette, mapping, puis textes et équipements ; récapitulatif complet", async () => {
    env.PUBLIC_BASE_URL = "https://gites.example";
    const res = await creer();
    expect(res.status).toBe(200);
    const r = (await res.json()) as {
      propriete: { beds24PropertyId: number; creee: boolean };
      rooms: { unitId: number; beds24RoomId: number; creee: boolean }[];
      ancienMapping: { beds24PropertyId: number };
      contenu: { ok: boolean };
      envoye: { propriete: string[]; rooms: { champs: string[] }[] };
      aCompleter: { propriete: string[]; rooms: { points: string[]; photos: { url: string }[] }[] };
    };
    expect(fake.posts).toHaveLength(2);
    const core = fake.posts[0]![0]!;
    expect(core).toMatchObject({ name: NOM, country: "BE", currency: "EUR", city: "Daverdisse", checkInStart: "18:00", checkOutEnd: "18:00" });
    expect(core.id).toBeUndefined();
    expect(core.texts).toBeUndefined(); // les textes partent au second temps
    const coreRooms = core.roomTypes as Record<string, unknown>[];
    expect(coreRooms.map((x) => x.name)).toEqual(["La Maison du Scieur", "La Scierie"]);
    expect(coreRooms.map((x) => x.cleaningFee)).toEqual([120, 90]);

    const created = fake.props[0]!;
    const enrich = fake.posts[1]![0]!;
    expect(enrich.id).toBe(created.id);
    expect((enrich.texts as { language: string; propertyDescription: string }[])[0]).toMatchObject({ language: "fr" });
    const enrichRooms = enrich.roomTypes as { id: number; texts: { roomDescription: string }[]; featureCodes: string[][] }[];
    expect(enrichRooms.map((x) => x.id)).toEqual(created.roomTypes.map((x) => x.id));
    expect(enrichRooms[0]!.texts[0]!.roomDescription).toContain("quatre chambres");
    expect(enrichRooms[0]!.featureCodes[0]).toContain("KITCHEN");

    expect(r.propriete).toEqual({ beds24PropertyId: created.id, name: created.name, creee: true });
    expect(r.rooms.every((x) => x.creee)).toBe(true);
    expect(r.contenu.ok).toBe(true);
    expect(r.ancienMapping.beds24PropertyId).toBe(344555);
    expect(r.envoye.rooms[0]!.champs).toContain("ménage 120 EUR");
    expect(r.aCompleter.rooms[0]!.photos).toHaveLength(8);
    expect(r.aCompleter.rooms[0]!.photos[0]!.url).toMatch(/^https:\/\/gites\.example\/img\/gites\//);
    expect(r.aCompleter.propriete.join(" ")).toMatch(/Wi-Fi/);
    expect(await mapping()).toEqual({ property: created.id, rooms: [created.roomTypes[0]!.id, created.roomTypes[1]!.id, null] });

    const log = await t.db
      .prepare("SELECT entity, detail FROM audit_log WHERE action = 'beds24.creer_propriete' ORDER BY id DESC LIMIT 1")
      .first<{ entity: string; detail: string }>();
    expect(log?.entity).toBe("property:1");
    expect(JSON.parse(log!.detail).ancienMapping.beds24PropertyId).toBe(344555);
    // verrou relâché, marqueur de tentative levé
    expect(await t.db.prepare("SELECT key FROM app_settings WHERE key LIKE 'beds24_creation_%'").first()).toBeNull();
  });

  it("second appel : propriété mappée ET présente → 409, aucun doublon", async () => {
    expect((await creer()).status).toBe(200);
    const res = await creer();
    expect(res.status).toBe(409);
    expect(fake.posts).toHaveLength(2);
    expect(fake.props).toHaveLength(1);
  });

  it("homonyme déjà présent (mapping pas écrit) : retrouvé par nom, pas de création", async () => {
    fake.props.push({ id: 555001, name: "les gîtes du pré moré ", roomTypes: [{ id: 555011, name: "La Maison du Scieur" }, { id: 555012, name: "La Scierie" }] });
    const res = await creer();
    expect(res.status).toBe(200);
    const r = (await res.json()) as { propriete: { creee: boolean }; rooms: { creee: boolean }[] };
    expect(fake.posts).toHaveLength(1); // seulement l'enrichissement
    expect(fake.posts[0]![0]!.id).toBe(555001);
    expect(r.propriete.creee).toBe(false);
    expect(r.rooms.every((x) => !x.creee)).toBe(true);
    expect(await mapping()).toEqual({ property: 555001, rooms: [555011, 555012, null] });
  });

  it("propriété retrouvée avec une room manquante : seule la room manquante est ajoutée", async () => {
    fake.props.push({ id: 555001, name: NOM, roomTypes: [{ id: 555011, name: "La Maison du Scieur" }] });
    expect((await creer()).status).toBe(200);
    expect(fake.posts[0]).toEqual([{ id: 555001, roomTypes: [expect.objectContaining({ name: "La Scierie", qty: 1, cleaningFee: 90 })] }]);
    const m = await mapping();
    expect(m.property).toBe(555001);
    expect(m.rooms[0]).toBe(555011);
    expect(m.rooms[1]).toBe(fake.props[0]!.roomTypes[1]!.id);
  });

  it("nom transformé par Beds24 : identifiée par l'id apparu, pas par le nom", async () => {
    fake.storeName = (n) => `${n} (importé)`;
    const res = await creer();
    // la propriété est reconnue ; ses rooms aussi transformées → refus clair, mapping intact
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/room « La Maison du Scieur » absente/);
    expect(fake.props).toHaveLength(1);
    expect((await mapping()).property).toBe(344555);
  });

  it("réponse perdue après création (500) : le nouvel essai reprend la propriété apparue, sans doublon", async () => {
    fake.forced.push({ status: 500, body: { error: "gateway" }, apply: true });
    expect((await creer()).status).toBe(502);
    expect(fake.props).toHaveLength(1);
    expect(await t.db.prepare("SELECT 1 FROM app_settings WHERE key = 'beds24_creation_tentative:1'").first()).not.toBeNull();
    const res = await creer();
    expect(res.status).toBe(200);
    expect(fake.props).toHaveLength(1);
    const r = (await res.json()) as { propriete: { creee: boolean }; avertissements: string[] };
    expect(r.propriete.creee).toBe(false);
    expect(r.avertissements.join(" ")).toMatch(/tentative précédente/);
  });

  it("tentative inachevée + propriété apparue sous un autre nom → 409 sans la capter", async () => {
    await t.db.prepare("INSERT INTO app_settings (key, value) VALUES ('beds24_creation_tentative:1', ?1)").bind(JSON.stringify({ beforeIds: [] })).run();
    fake.props.push({ id: 777, name: "Le Moulin de Braives", roomTypes: [] });
    const res = await creer();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/renommer/);
    expect(fake.posts).toHaveLength(0);
  });

  it("deux homonymes dans le compte → 409, rien n'est écrit", async () => {
    fake.props.push({ id: 1, name: NOM, roomTypes: [] }, { id: 2, name: NOM, roomTypes: [] });
    expect((await creer()).status).toBe(409);
    expect(fake.posts).toHaveLength(0);
    expect((await mapping()).property).toBe(344555);
  });

  it("jeton restreint à une propriété → 409", async () => {
    fake.restrictedTo = 42;
    expect((await creer()).status).toBe(409);
    expect(fake.posts).toHaveLength(0);
  });

  it("refus Beta du squelette (201 + success:false) → 502 en clair, mapping inchangé", async () => {
    fake.forced.push({ status: 201, body: [{ success: false, errors: [{ action: "new", field: "country", message: "invalid country code" }] }] });
    const res = await creer();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("country : invalid country code");
    expect(await mapping()).toEqual({ property: 344555, rooms: [711713, 711714, null] });
    expect(await t.db.prepare("SELECT 1 FROM app_settings WHERE key = 'beds24_creation_verrou'").first()).toBeNull();
  });

  it("textes/équipements refusés : la création tient, le refus va dans « à compléter »", async () => {
    // 1er POST normal, 2e POST (enrichissement) refusé
    const original = fake.handler;
    let n = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/properties") && init?.method === "POST" && ++n === 2) {
        fake.posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify([{ success: false, errors: [{ field: "featureCodes", message: "unknown code" }] }]), { status: 201 });
      }
      return original(input, init);
    });
    const res = await creer();
    expect(res.status).toBe(200);
    const r = (await res.json()) as { contenu: { ok: boolean; erreur: string }; aCompleter: { propriete: string[] } };
    expect(r.contenu.ok).toBe(false);
    expect(r.contenu.erreur).toContain("featureCodes : unknown code");
    expect(r.aCompleter.propriete[0]).toMatch(/Textes et équipements refusés/);
    expect((await mapping()).property).toBe(fake.props[0]!.id);
  });

  it("verrou détenu par un autre appel → refus ; verrou vieilli (> 5 min) → repris", async () => {
    await t.db.prepare("INSERT INTO app_settings (key, value) VALUES ('beds24_creation_verrou', 'autre')").run();
    await expect(createBeds24Property(env, 1, "test")).rejects.toBeInstanceOf(CreationRefusee);
    expect(fake.posts).toHaveLength(0);
    // l'appel refusé n'a pas libéré le verrou d'autrui
    expect(await t.db.prepare("SELECT value FROM app_settings WHERE key = 'beds24_creation_verrou'").first()).toEqual({ value: "autre" });
    await t.db.prepare("UPDATE app_settings SET updated_at = datetime('now', '-301 seconds') WHERE key = 'beds24_creation_verrou'").run();
    expect((await creer()).status).toBe(200);
  });

  it("deux clics simultanés : une seule création", async () => {
    const [a, b] = await Promise.all([creer(), creer()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(fake.props).toHaveLength(1);
  });

  it("après création, le push existant vise les nouvelles rooms", async () => {
    await creer();
    const res = await call("POST", "/api/admin/beds24/push", { propertyId: 1, days: 3 });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { pushed: { roomId: number }[] };
    expect(r.pushed.map((x) => x.roomId)).toEqual(fake.props[0]!.roomTypes.map((x) => x.id));
  });

  it("push refusé par élément (réponse en tableau) → 502 en clair, plus de 500 opaque", async () => {
    await creer();
    const original = fake.handler;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/inventory/rooms/calendar")) {
        return new Response(JSON.stringify([{ success: false, roomId: 1, errors: [{ field: "roomId", message: "not found" }] }]), { status: 201 });
      }
      return original(input, init);
    });
    const res = await call("POST", "/api/admin/beds24/push", { propertyId: 1, days: 3 });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("roomId : not found");
  });
});
