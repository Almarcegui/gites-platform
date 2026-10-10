// Lot 3, remarques laissées ouvertes par la PR #107 :
//  (a) la garde IP (ADMIN_ALLOWED_IPS) ne vise que les humains : clés `svc:` et
//      compte `sauvegarde` passent depuis toute adresse ;
//  (b) les photos (UPLOADS_DIR) se sauvegardent par GET /api/admin/export-uploads.tar ;
//  (c) une clé `svc:` ne crée pas de lien public de partage du ménage.
// Joué par le point d'entrée Worker (src/index.ts), qui fait la même chose que
// node/server.mjs (la fumée Node le vérifie de son côté).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { buildTar } from "../src/core/tar";
import { adminIpCheck, isAdminApiPath } from "../src/core/ip-allow";

const worker = (await import("../src/index")).default;
const ADMIN = "julien:jeton-humain-lot3";
const ALLOWED = "81.82.83.84";
const OTHER = "1.2.3.4";
let t: TestDb;
let env: Env;
let svcKey = "";
const files = new Map<string, Uint8Array>([
  ["a".repeat(32) + ".jpg", new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])],
  ["b".repeat(32) + ".png", new Uint8Array(700).fill(7)],
]);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(method: string, path: string, ip: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return res;
}

/** Lecture tar minimale (noms, tailles, contenus) pour vérifier l'archive. */
function readTar(buf: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = new TextDecoder().decode(h.subarray(0, 100)).replace(/\0.*$/s, "");
    const size = parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, ""), 8);
    const stored = parseInt(new TextDecoder().decode(h.subarray(148, 156)).replace(/[\0 ].*$/s, ""), 8);
    const copy = new Uint8Array(h);
    copy.fill(0x20, 148, 156);
    expect(copy.reduce((a, b) => a + b, 0)).toBe(stored);
    out.push({ name, bytes: buf.slice(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
    ADMIN_ALLOWED_IPS: ALLOWED,
    UPLOADS: {
      async put() {},
      async list() { return [...files.keys(), "../evasion.jpg"]; },
      async read(name: string) { return { bytes: files.get(name)!, mtime: 1_760_000_000 }; },
    },
  } as Env;
  const created = await call("POST", "/api/admin/service-keys", ALLOWED, ADMIN, { name: "claude-mac" });
  expect(created.status).toBe(200);
  svcKey = String(((await created.json()) as { key: string }).key);
});
afterAll(async () => {
  await t.dispose();
});

describe("(a) garde IP : humains seulement", () => {
  it("décision pure : écran refusé tout de suite, API reportée après l'authentification", () => {
    expect(adminIpCheck("/admin2/", ALLOWED, OTHER)).toBe("deny");
    expect(adminIpCheck("/api/admin/units", ALLOWED, OTHER)).toBe("defer");
    expect(adminIpCheck("/api//admin/units", ALLOWED, OTHER)).toBe("defer");
    expect(adminIpCheck("/api/admin/units", ALLOWED, ALLOWED)).toBe("pass");
    expect(adminIpCheck("/api/admin/units", "", OTHER)).toBe("pass");
    expect(adminIpCheck("/book/", ALLOWED, OTHER)).toBe("pass");
    expect(isAdminApiPath("/admin2/api/admin")).toBe(false);
  });

  it("un humain hors liste est refusé (paire, jeton nu, sans rien), accepté depuis la liste", async () => {
    for (const auth of [ADMIN, "jeton-humain-lot3", null]) {
      const r = await call("GET", "/api/admin/overview?property=1", OTHER, auth);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe("admin_ip_denied");
    }
    expect((await call("GET", "/api/admin/overview?property=1", ALLOWED, ADMIN)).status).toBe(200);
    expect((await call("GET", "/admin2/", OTHER, ADMIN)).status).toBe(403);
  });

  it("une session humaine ouverte depuis la liste reste refusée hors liste ; la connexion aussi", async () => {
    const pw = String(((await (await call("POST", "/api/admin/users", ALLOWED, ADMIN, { username: "matthieu" })).json()) as { password: string }).password);
    expect((await call("POST", "/api/admin/login", OTHER, null, { user: "matthieu", password: pw })).status).toBe(403);
    const login = (await (await call("POST", "/api/admin/login", ALLOWED, null, { user: "matthieu", password: pw })).json()) as { session: string };
    expect((await call("GET", "/api/admin/overview?property=1", ALLOWED, `session:${login.session}`)).status).toBe(200);
    expect((await call("GET", "/api/admin/overview?property=1", OTHER, `session:${login.session}`)).status).toBe(403);
  });

  it("une clé de service passe depuis toute adresse", async () => {
    expect((await call("GET", "/api/admin/overview?property=1", OTHER, `svc:${svcKey}`)).status).toBe(200);
    expect((await call("GET", "/api/admin/overview?property=1", OTHER, "svc:gsk_inconnue")).status).toBe(401);
  });

  it("le compte « sauvegarde » se connecte et exporte depuis toute adresse, sans rien ouvrir d'autre", async () => {
    const pw = String(((await (await call("POST", "/api/admin/users", ALLOWED, ADMIN, { username: "sauvegarde" })).json()) as { password: string }).password);
    const login = await call("POST", "/api/admin/login", OTHER, null, { user: "sauvegarde", password: pw });
    expect(login.status).toBe(200);
    const session = `session:${((await login.json()) as { session: string }).session}`;
    expect((await call("GET", "/api/admin/export.sql", OTHER, session)).status).toBe(200);
    expect((await call("GET", "/api/admin/export-uploads.tar", OTHER, session)).status).toBe(200);
    expect((await call("GET", "/api/admin/overview?property=1", OTHER, session)).status).toBe(403);
    expect((await call("POST", "/api/admin/logout", OTHER, session, {})).status).toBe(200);
  });

  it("une route admin inconnue hors liste : refus, pas 404", async () => {
    expect((await call("GET", "/api/admin/nexiste-pas", OTHER, `svc:${svcKey}`)).status).toBe(403);
    expect((await call("GET", "/api/%61dmin/overview", OTHER, `svc:${svcKey}`)).status).toBe(403);
  });
});

describe("(b) sauvegarde des photos", () => {
  it("archive tar : chaque photo, contenu exact, nom hors motif écarté", async () => {
    const r = await call("GET", "/api/admin/export-uploads.tar", ALLOWED, ADMIN);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/x-tar");
    expect(r.headers.get("x-gites-files")).toBe("2");
    const entries = readTar(new Uint8Array(await r.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual([...files.keys()].sort());
    for (const e of entries) expect([...e.bytes]).toEqual([...files.get(e.name)!]);
    const audit = await t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.uploads'").first<{ n: number }>();
    expect(audit?.n).toBeGreaterThan(0);
  });

  it("archive vide valide ; 501 sans dépôt de photos (Workers)", async () => {
    expect(buildTar([]).length).toBe(1024);
    const saved = env.UPLOADS;
    env.UPLOADS = undefined;
    try {
      expect((await call("GET", "/api/admin/export-uploads.tar", ALLOWED, ADMIN)).status).toBe(501);
    } finally {
      env.UPLOADS = saved;
    }
  });

  it("un nom trop long est refusé par l'écrivain tar", () => {
    expect(() => buildTar([{ name: "x".repeat(120), bytes: new Uint8Array(1) }])).toThrow();
  });
});

describe("(c) lien public de partage du ménage", () => {
  it("une clé de service ne le crée pas ; un humain oui", async () => {
    const svc = await call("POST", "/api/admin/task-links", ALLOWED, `svc:${svcKey}`, { label: "Ménage Pré Moré" });
    expect(svc.status).toBe(403);
    const human = await call("POST", "/api/admin/task-links", ALLOWED, ADMIN, { label: "Ménage Pré Moré" });
    expect(human.status).toBe(201);
    // la liste reste lisible par la clé (rien de secret : le jeton n'est jamais relu)
    expect((await call("GET", "/api/admin/task-links", ALLOWED, `svc:${svcKey}`)).status).toBe(200);
  });
});
