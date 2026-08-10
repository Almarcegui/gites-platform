// Issue #21 — surveillance. Le traitement planifié laisse une trace à chaque
// passage, et un endpoint public permet à une sonde EXTERNE de constater son
// arrêt sans que personne n'ouvre le back-office.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { runScheduled } from "../src/services/cron";
import { CRON_HEARTBEAT_KEY, publicHealth } from "../src/services/health";
import { getSetting, setSetting } from "../src/services/settings";
import { sqlNow } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM app_settings").run();
  await db.prepare("DELETE FROM audit_log").run();
});

async function getHealth() {
  const res = await router.handle(new Request("http://test.local/api/public/health"), env);
  if (!res) throw new Error("route /api/public/health non matchée");
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("battement de cœur du traitement planifié", () => {
  it("écrit cron_last_run à chaque passage", async () => {
    const now = new Date("2026-08-10T06:00:00Z");
    await runScheduled(env, now, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    expect(await getSetting(db, CRON_HEARTBEAT_KEY)).toBe(sqlNow(now));
  });

  it("écrit le battement AVANT le reste : un import iCal en échec ne le masque pas", async () => {
    // Un flux qui explose ne doit pas faire croire que le cron ne tourne plus —
    // sinon l'alerte désigne la mauvaise panne.
    const unit = await db.prepare("SELECT id FROM units LIMIT 1").first<{ id: number }>();
    await db
      .prepare("INSERT INTO ical_feeds (unit_id, name, url, active) VALUES (?1, 'flux cassé', 'https://exemple.invalide/f.ics', 1)")
      .bind(unit?.id ?? 1)
      .run();
    const now = new Date("2026-08-10T06:15:00Z");
    const exploding = (() => {
      throw new Error("réseau injoignable");
    }) as unknown as typeof fetch;

    await runScheduled(env, now, exploding);

    expect(await getSetting(db, CRON_HEARTBEAT_KEY)).toBe(sqlNow(now));
    // Le flux, lui, est bien marqué en erreur : les deux signaux restent
    // distincts, « le cron ne tourne plus » et « un flux est cassé ».
    const feed = await db.prepare("SELECT last_status FROM ical_feeds WHERE name = 'flux cassé'").first<{ last_status: string }>();
    expect(feed?.last_status).toContain("erreur");
  });

  it("ne journalise pas le battement dans audit_log (le journal est déjà saturé)", async () => {
    await runScheduled(env, new Date("2026-08-10T06:30:00Z"), (async () => new Response("")) as unknown as typeof fetch);
    const lines = await db.prepare("SELECT action FROM audit_log").all();
    expect(lines.results.map((r) => (r as { action: string }).action)).not.toContain("cron.heartbeat");
  });
});

describe("GET /api/public/health", () => {
  it("répond 200 avec les deux champs attendus par la sonde", async () => {
    await setSetting(db, CRON_HEARTBEAT_KEY, "2026-08-10 06:00:00");
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.lastCronAt).toBe("2026-08-10 06:00:00");
  });

  it("rend lastCronAt null tant que le traitement planifié n'a jamais tourné", async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.lastCronAt).toBeNull();
    expect(body.cronAgeMinutes).toBeNull();
  });

  it("ne divulgue rien d'autre : l'endpoint est public", async () => {
    await setSetting(db, CRON_HEARTBEAT_KEY, "2026-08-10 06:00:00");
    const { body } = await getHealth();
    expect(Object.keys(body).sort()).toEqual(["cronAgeMinutes", "lastCronAt", "ok"]);
  });

  it("calcule l'âge du dernier passage en minutes, en UTC", async () => {
    const health = await publicHealth(
      {
        prepare: () => ({
          bind: () => ({ first: async () => ({ value: "2026-08-10 06:00:00" }) }),
        }),
      } as unknown as D1Database,
      new Date("2026-08-10T07:00:00Z"),
    );
    expect(health.cronAgeMinutes).toBe(60);
  });

  it("signale ok:false quand la base est illisible, sans jeter", async () => {
    const brokenDb = {
      prepare: () => {
        throw new Error("D1 injoignable");
      },
    } as unknown as D1Database;
    const health = await publicHealth(brokenDb);
    expect(health.ok).toBe(false);
    expect(health.lastCronAt).toBeNull();
  });

  it("répond 503 quand la base est illisible, pour une sonde qui ne lit que le code HTTP", async () => {
    const brokenEnv = { ...env, DB: { prepare: () => { throw new Error("D1 injoignable"); } } as unknown as D1Database };
    const res = await router.handle(new Request("http://test.local/api/public/health"), brokenEnv);
    expect(res?.status).toBe(503);
  });
});
