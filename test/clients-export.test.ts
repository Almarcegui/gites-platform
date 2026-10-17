// Liste des clients : colonnes Hébergement / dernier séjour / date de réservation,
// tri par séjour, et export CSV (GET /api/admin/guests.csv). Données inventées.
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
const D3 = addDays(D1, 40);
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

async function call(path: string, auth: string | null = ADMIN, method = "GET", body?: unknown): Promise<{ status: number; text: string; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function book(unitId: number, checkin: string, checkout: string, guest: { firstName: string; lastName: string; email: string }) {
  const sale = await call("/api/admin/bookings", ADMIN, "POST", { unitId, checkin, checkout, adults: 2, guest });
  expect(sale.status).toBe(201);
  return JSON.parse(sale.text).booking as { id: number };
}

async function seed() {
  const units = (await t.db.prepare("SELECT id, name FROM units ORDER BY id LIMIT 2").all()).results as { id: number; name: string }[];
  // Dupont : séjour tardif ; Martin : séjour précoce ; Durand : seulement annulé.
  const a = await book(units[0].id, D3, D4, { firstName: "Alix", lastName: "Dupont", email: "alix@exemple.test" });
  await book(units[1].id, D1, D2, { firstName: "Bob", lastName: "Martin", email: "bob@exemple.test" });
  const c = await book(units[0].id, addDays(D4, 10), addDays(D4, 17), { firstName: "Cléo", lastName: "Durand", email: "cleo@exemple.test" });
  await t.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(c.id).run();
  return { units, a };
}

describe("liste des clients", () => {
  it("renvoie hébergement, dernier séjour et date de réservation", async () => {
    const { units } = await seed();
    const res = await call("/api/admin/guests");
    const guests = JSON.parse(res.text).guests as Record<string, unknown>[];
    const dupont = guests.find((g) => g.lastName === "Dupont")!;
    expect(dupont.gites).toBe(units[0].name);
    expect(dupont.lastCheckin).toBe(D3);
    expect(dupont.lastCheckout).toBe(D4);
    expect(String(dupont.lastBookedAt)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const durand = guests.find((g) => g.lastName === "Durand")!;
    expect(durand.lastCheckin).toBeNull(); // séjour annulé : ne compte pas
    expect(durand.staysCount).toBe(0);
  });

  it("trie par nom sans tenir compte de la casse ni des accents (de Vries entre Dupont et Martin)", async () => {
    const units = (await t.db.prepare("SELECT id FROM units ORDER BY id LIMIT 1").all()).results as { id: number }[];
    await book(units[0].id, D1, D2, { firstName: "Zoé", lastName: "Zimmer", email: "zoe@exemple.test" });
    await book(units[0].id, D3, D4, { firstName: "Éva", lastName: "Étienne", email: "eva@exemple.test" });
    await book(units[0].id, addDays(D4, 10), addDays(D4, 12), { firstName: "Dirk", lastName: "de Vries", email: "dirk@exemple.test" });
    await book(units[0].id, addDays(D4, 20), addDays(D4, 22), { firstName: "Alix", lastName: "Dupont", email: "alix@exemple.test" });
    const names = (JSON.parse((await call("/api/admin/guests")).text).guests as { lastName: string }[]).map((g) => g.lastName);
    expect(names).toEqual(["de Vries", "Dupont", "Étienne", "Zimmer"]);
  });

  it("trie par séjour : récent d'abord, ancien d'abord, sans séjour en fin", async () => {
    await seed();
    const names = async (sort: string) => (JSON.parse((await call(`/api/admin/guests?sort=${sort}`)).text).guests as { lastName: string }[]).map((g) => g.lastName);
    expect(await names("name")).toEqual(["Dupont", "Durand", "Martin"]);
    expect(await names("stay_desc")).toEqual(["Dupont", "Martin", "Durand"]);
    expect(await names("stay_asc")).toEqual(["Martin", "Dupont", "Durand"]);
  });

  it("ignore un tri inconnu (pas d'injection dans ORDER BY)", async () => {
    await seed();
    const res = await call("/api/admin/guests?sort=" + encodeURIComponent("name; DROP TABLE guests"));
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text).guests as unknown[]).length).toBe(3);
  });
});

describe("export CSV des clients", () => {
  it("exige l'authentification", async () => {
    expect((await call("/api/admin/guests.csv", null)).status).toBe(401);
    expect((await call("/api/admin/guests.csv", "mauvais-jeton")).status).toBe(401);
  });

  it("produit un CSV lisible par Excel avec les colonnes demandées", async () => {
    const { units } = await seed();
    const res = await call("/api/admin/guests.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("clients-");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = new Uint8Array(await (await router.handle(new Request("http://test.local/api/admin/guests.csv", { headers: { authorization: `Bearer ${ADMIN}` } }), env))!.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 pour Excel
    const lines = res.text.replace(/^\ufeff/, "").split("\r\n");
    expect(lines[0]).toBe("Nom;Prénom;Email;Téléphone;Langue;Pays;Hébergement(s);Premier séjour (arrivée);Dernier séjour (arrivée);Dernier séjour (départ);Dernier séjour réservé le;Nombre de séjours;Consentement marketing;Consentement donné le");
    expect(lines).toHaveLength(4);
    const dupont = lines.find((l) => l.startsWith("Dupont;"))!.split(";");
    expect(dupont[2]).toBe("alix@exemple.test");
    expect(dupont[6]).toBe(units[0].name);
    expect(dupont[8]).toBe(D3);
    expect(dupont[11]).toBe("1");
    expect(dupont[12]).toBe("non");
  });

  it("exporte le consentement marketing tel qu'enregistré", async () => {
    await seed();
    await t.db.prepare("UPDATE guests SET marketing_opt_in = 1, marketing_opt_in_at = '2026-01-05 10:00:00' WHERE last_name = 'Martin'").run();
    const lines = (await call("/api/admin/guests.csv")).text.replace(/^\ufeff/, "").split("\r\n");
    const martin = lines.find((l) => l.startsWith("Martin;"))!.split(";");
    expect(martin[12]).toBe("oui");
    expect(martin[13]).toBe("2026-01-05");
  });

  it("neutralise les formules et respecte le tri et la recherche", async () => {
    await seed();
    await t.db.prepare("UPDATE guests SET last_name = '=HYPERLINK(\"http://x\")' WHERE last_name = 'Dupont'").run();
    const all = (await call("/api/admin/guests.csv?sort=stay_asc")).text;
    expect(all).toContain("'=HYPERLINK");
    expect(all).not.toMatch(/(^|;|")=HYPERLINK/m);
    const filtered = (await call("/api/admin/guests.csv?search=Martin")).text.replace(/^\ufeff/, "").split("\r\n");
    expect(filtered).toHaveLength(2);
  });

  it("laisse un numéro de téléphone « +32 … » tel quel, sans apostrophe, mais neutralise « +1+cmd »", async () => {
    await seed();
    await t.db.prepare("UPDATE guests SET phone = '+32 470 00 01 02' WHERE last_name = 'Martin'").run();
    await t.db.prepare("UPDATE guests SET phone = '+1+cmd|calc' WHERE last_name = 'Dupont'").run();
    const text = (await call("/api/admin/guests.csv")).text;
    expect(text).toContain(";+32 470 00 01 02;");
    expect(text).not.toContain("'+32");
    expect(text).toContain(";'+1+cmd|calc;");
  });

  it("met entre guillemets une valeur contenant un retour chariot", async () => {
    await seed();
    await t.db.prepare("UPDATE guests SET notes = NULL, address = 'a\r=cmd' WHERE last_name = 'Martin'").run();
    await t.db.prepare("UPDATE guests SET country = 'x\r=cmd' WHERE last_name = 'Martin'").run();
    const text = (await call("/api/admin/guests.csv")).text;
    expect(text).toContain('"x\r=cmd"');
  });

  it("laisse une trace d'audit sans donnée nominative", async () => {
    await seed();
    await call("/api/admin/guests.csv");
    const row = (await t.db.prepare("SELECT * FROM audit_log WHERE action = 'guests.export_csv'").first()) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("exemple.test");
    expect(JSON.parse(String(row.detail)).lignes).toBe(3);
  });
});
