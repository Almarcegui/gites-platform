// Conflits de synchronisation persistés (issue #72).
//
// Le comportement à prouver tient en une phrase : le même conflit reproduit à
// chaque tick reste UNE ligne dont seule la dernière détection bouge, et il se
// referme tout seul quand il ne se reproduit plus. Le reste — décision
// « Ignorer », remontée dans la carte « Santé », endpoints du back-office —
// découle de là.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { beds24UnitScope, conflictFingerprint, icalScope } from "../src/core/sync-conflicts";
import { detectOpenSyncConflicts } from "../src/core/drift";
import { syncFeed } from "../src/services/ical";
import { applyChannelBookings } from "../src/services/beds24-sync";
import { collectDriftInput, createBookingAtomic, createFeed, getFeed, listSyncConflicts } from "../src/db/repo";
import { addDays, sqlNow, todayInZone } from "../src/core/dates";

const SCIERIE = 2;
const PROPERTY = 1;

// Trois passages de cron espacés d'un quart d'heure, comme en production.
const TICK1 = new Date("2026-07-12T10:00:00Z");
const TICK2 = new Date("2026-07-12T10:15:00Z");
const TICK3 = new Date("2026-07-12T10:30:00Z");
const TICK4 = new Date("2026-07-12T10:45:00Z");

const STAY = { checkin: "2026-10-05", checkout: "2026-10-09" };

const ICS_CONFLIT = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:airbnb-CONFLIT@airbnb.com",
  "DTSTART;VALUE=DATE:20261005",
  "DTEND;VALUE=DATE:20261009",
  "SUMMARY:Reserved",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ICS_VIDE = ["BEGIN:VCALENDAR", "END:VCALENDAR"].join("\r\n");

const mockFetch = (body: string, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as typeof fetch;

let t: TestDb;
let db: D1Database;
const router = new Router();
registerAdminRoutes(router);
const ADMIN = "test-admin-token";
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["sync_conflicts", "payments", "email_log", "audit_log", "bookings", "guests", "ical_feeds"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** Une résa directe occupe déjà le créneau : tout ce que le canal annoncera
 *  dessus sera refusé — c'est le conflit qu'on veut voir vivre. */
async function occupeLeCreneau(): Promise<void> {
  const direct = await createBookingAtomic(db, {
    unitId: SCIERIE, ...STAY, adults: 4, children: 0,
    status: "confirmed", source: "direct", now: TICK1,
  });
  expect(direct.ok).toBe(true);
}

async function nouveauFlux(): Promise<NonNullable<Awaited<ReturnType<typeof getFeed>>>> {
  const id = await createFeed(db, { unitId: SCIERIE, name: "Airbnb — Scierie", url: "https://example.com/cal.ics" });
  const feed = await getFeed(db, id);
  if (!feed) throw new Error("flux non créé");
  return feed;
}

async function lignes(): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare("SELECT * FROM sync_conflicts ORDER BY id").all();
  return results as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------

describe("empreinte d'un conflit", () => {
  const base = {
    source: "ical" as const, scope: icalScope(1), kind: "import" as const,
    unitId: SCIERIE, checkin: "2026-10-05" as const, checkout: "2026-10-09" as const,
    externalUid: "feed1:abc", label: "peu importe",
  };

  it("ne dépend pas du libellé : reformuler une phrase ne ressuscite pas un conflit", () => {
    expect(conflictFingerprint({ ...base, label: "autre phrase" })).toBe(conflictFingerprint(base));
  });

  it("distingue la nature, l'hébergement, les dates et l'identifiant externe", () => {
    const empreintes = new Set([
      conflictFingerprint(base),
      conflictFingerprint({ ...base, kind: "move" }),
      conflictFingerprint({ ...base, unitId: 3 }),
      conflictFingerprint({ ...base, checkout: "2026-10-10" }),
      conflictFingerprint({ ...base, externalUid: "feed1:def" }),
      conflictFingerprint({ ...base, source: "beds24", scope: beds24UnitScope(SCIERIE) }),
    ]);
    expect(empreintes.size).toBe(6);
  });

  it("le périmètre n'entre pas dans l'identité (un flux renommé reste le même conflit)", () => {
    expect(conflictFingerprint({ ...base, scope: icalScope(9) })).toBe(conflictFingerprint(base));
  });
});

// ---------------------------------------------------------------------------

describe("import iCal — un conflit vit, se répète, puis se referme", () => {
  it("deux ticks successifs sur le même conflit : UNE ligne, dernière détection à jour", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();

    const t1 = await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    expect(t1.conflicts).toHaveLength(1);
    let rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "open",
      source: "ical",
      kind: "import",
      unit_id: SCIERIE,
      property_id: PROPERTY,
      scope: icalScope(feed.id),
      checkin: STAY.checkin,
      checkout: STAY.checkout,
      external_uid: `feed${feed.id}:airbnb-CONFLIT@airbnb.com`,
      first_seen_at: sqlNow(TICK1),
      last_seen_at: sqlNow(TICK1),
      resolved_at: null,
    });

    const t2 = await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK2);
    expect(t2.conflicts).toHaveLength(1);
    rows = await lignes();
    expect(rows).toHaveLength(1); // ← le cœur de l'issue : pas une ligne par tick
    expect(rows[0]).toMatchObject({
      status: "open",
      first_seen_at: sqlNow(TICK1), // la PREMIÈRE détection ne bouge jamais
      last_seen_at: sqlNow(TICK2),
    });
  });

  it("le conflit disparaît du flux → passé en résolu, jamais supprimé", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);

    const t2 = await syncFeed(db, feed, mockFetch(ICS_VIDE), TICK2);
    expect(t2.resolvedConflicts).toBe(1);
    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "resolved",
      first_seen_at: sqlNow(TICK1),
      last_seen_at: sqlNow(TICK1),
      resolved_at: sqlNow(TICK2),
    });
  });

  it("le créneau se libère → le conflit se referme sans intervention", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE source = 'direct'").run();

    const t2 = await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK2);
    expect(t2.imported).toBe(1);
    expect((await lignes())[0]).toMatchObject({ status: "resolved", resolved_at: sqlNow(TICK2) });
  });

  it("un conflit résolu qui revient se rouvre, en gardant sa première détection", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    await syncFeed(db, feed, mockFetch(ICS_VIDE), TICK2);
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK3);

    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "open",
      first_seen_at: sqlNow(TICK1),
      last_seen_at: sqlNow(TICK3),
      resolved_at: null,
    });
  });

  it("un flux injoignable ne referme rien : l'absence de nouvelle n'est pas une résolution", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);

    const t2 = await syncFeed(db, feed, mockFetch("", 503), TICK2);
    expect(t2.error).not.toBeNull();
    expect((await lignes())[0]).toMatchObject({ status: "open", last_seen_at: sqlNow(TICK1) });
  });

  it("deux flux, deux conflits : refermer l'un ne touche pas l'autre", async () => {
    await occupeLeCreneau();
    const a = await nouveauFlux();
    const b = await nouveauFlux();
    await syncFeed(db, a, mockFetch(ICS_CONFLIT), TICK1);
    await syncFeed(db, b, mockFetch(ICS_CONFLIT), TICK1);
    expect(await lignes()).toHaveLength(2);

    await syncFeed(db, a, mockFetch(ICS_VIDE), TICK2);
    const rows = await lignes();
    expect(rows.map((r) => [r.scope, r.status])).toEqual([
      [icalScope(a.id), "resolved"],
      [icalScope(b.id), "open"],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("canaux Beds24 — même registre, même cycle de vie", () => {
  const ROOM_TO_UNIT = new Map([[711714, SCIERIE]]);
  const resa = (over: Record<string, unknown> = {}) => ({
    id: 920001, roomId: 711714, status: "confirmed",
    arrival: STAY.checkin, departure: STAY.checkout,
    numAdult: 2, numChild: 0, lastName: "Dupont", channel: "airbnb",
    ...over,
  });

  it("créneau déjà pris localement → conflit persisté, une ligne par tick redétecté", async () => {
    await occupeLeCreneau();
    const r1 = await applyChannelBookings(db, [resa()], ROOM_TO_UNIT, TICK1);
    expect(r1.conflicts).toHaveLength(1);
    const r2 = await applyChannelBookings(db, [resa()], ROOM_TO_UNIT, TICK2);
    expect(r2.conflicts).toHaveLength(1);

    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "open",
      source: "beds24",
      kind: "import",
      scope: beds24UnitScope(SCIERIE),
      channel_label: "Airbnb",
      external_uid: "beds24:920001",
      first_seen_at: sqlNow(TICK1),
      last_seen_at: sqlNow(TICK2),
    });
  });

  it("le canal annule sa réservation → le conflit se referme au passage suivant", async () => {
    await occupeLeCreneau();
    await applyChannelBookings(db, [resa()], ROOM_TO_UNIT, TICK1);
    const r2 = await applyChannelBookings(db, [resa({ status: "cancelled" })], ROOM_TO_UNIT, TICK2);
    expect(r2.resolvedConflicts).toBe(1);
    expect((await lignes())[0]).toMatchObject({ status: "resolved", resolved_at: sqlNow(TICK2) });
  });

  it("un lot VIDE ne referme rien : la fenêtre incrémentale n'a rien dit du conflit", async () => {
    await occupeLeCreneau();
    await applyChannelBookings(db, [resa()], ROOM_TO_UNIT, TICK1);
    const r2 = await applyChannelBookings(db, [], ROOM_TO_UNIT, TICK2);
    expect(r2.resolvedConflicts).toBe(0);
    expect((await lignes())[0]).toMatchObject({ status: "open" });
  });
});

// ---------------------------------------------------------------------------

describe("décision humaine — « Ignorer » avec motif", () => {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const req = new Request(`http://test.local${path}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await router.handle(req, env);
    if (!res) throw new Error(`route non matchée : ${method} ${path}`);
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  it("un conflit ignoré le RESTE, même redétecté au tick suivant", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    const [conflit] = await listSyncConflicts(db, PROPERTY);

    const patched = await call("PATCH", `/api/admin/sync-conflicts/${conflit!.id}`, {
      status: "ignored",
      reason: "double annonce Airbnb, traitée à la main",
    });
    expect(patched.status).toBe(200);

    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK2);
    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "ignored", // ← sans quoi la décision ne tiendrait pas un quart d'heure
      ignore_reason: "double annonce Airbnb, traitée à la main",
      last_seen_at: sqlNow(TICK2), // la détection continue d'être enregistrée
    });
  });

  it("ignorer sans motif est refusé, et un conflit inconnu répond 404", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    const [conflit] = await listSyncConflicts(db, PROPERTY);

    expect((await call("PATCH", `/api/admin/sync-conflicts/${conflit!.id}`, { status: "ignored", reason: "  " })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/sync-conflicts/${conflit!.id}`, { status: "resolved" })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/sync-conflicts/999999", { status: "ignored", reason: "x" })).status).toBe(404);
  });

  it("la vue Canaux liste les ouverts et les ignorés, jamais les résolus", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    const ouvert = await call("GET", `/api/admin/channels/overview?property=${PROPERTY}`);
    const conflits = ouvert.data.conflicts as Record<string, unknown>[];
    expect(conflits).toHaveLength(1);
    expect(conflits[0]).toMatchObject({ status: "open", unitName: "La Scierie", source: "ical" });
    expect(String(conflits[0]!.label)).toContain("créneau déjà pris");

    await syncFeed(db, feed, mockFetch(ICS_VIDE), TICK2);
    const apres = await call("GET", `/api/admin/channels/overview?property=${PROPERTY}`);
    expect(apres.data.conflicts).toEqual([]);
  });

  it("rouvrir un conflit ignoré le remet dans la liste", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    const [conflit] = await listSyncConflicts(db, PROPERTY);
    await call("PATCH", `/api/admin/sync-conflicts/${conflit!.id}`, { status: "ignored", reason: "à voir plus tard" });
    await call("PATCH", `/api/admin/sync-conflicts/${conflit!.id}`, { status: "open" });
    const rows = await lignes();
    expect(rows[0]).toMatchObject({ status: "open", ignore_reason: "à voir plus tard", resolved_at: null });
  });
});

// ---------------------------------------------------------------------------

describe("carte « Santé » — les conflits ouverts comptent comme une dérive", () => {
  it("aucun conflit ouvert → aucun signal", () => {
    expect(detectOpenSyncConflicts([], TICK1)).toEqual([]);
  });

  it("plusieurs conflits → un seul signal, l'ancienneté du plus vieux, lien vers Canaux", () => {
    const signals = detectOpenSyncConflicts(
      [
        { id: 1, label: "a", firstSeenAt: sqlNow(new Date("2026-07-09T10:00:00Z")) },
        { id: 2, label: "b", firstSeenAt: sqlNow(TICK1) },
      ],
      new Date("2026-07-12T10:00:00Z"),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "sync_conflict", href: "#/canaux" });
    expect(signals[0]!.detail).toContain("2 conflits");
    expect(signals[0]!.detail).toContain("3 jours");
  });

  it("les conflits ignorés ne remontent pas dans la carte « Santé »", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    await syncFeed(db, feed, mockFetch(ICS_CONFLIT), TICK1);
    expect((await collectDriftInput(db, PROPERTY, TICK4)).openConflicts).toHaveLength(1);

    const [conflit] = await listSyncConflicts(db, PROPERTY);
    await db.prepare("UPDATE sync_conflicts SET status = 'ignored' WHERE id = ?1").bind(conflit!.id).run();
    expect((await collectDriftInput(db, PROPERTY, TICK4)).openConflicts).toEqual([]);
  });
});

// Garde-fou de non-régression : le séjour direct qui a provoqué le conflit
// n'est JAMAIS touché par la tenue du registre (le registre observe, il n'agit
// pas sur les réservations).
describe("le registre n'agit pas sur les réservations", () => {
  it("la résa directe qui bloque le créneau reste confirmée après trois ticks", async () => {
    await occupeLeCreneau();
    const feed = await nouveauFlux();
    for (const tick of [TICK1, TICK2, TICK3]) await syncFeed(db, feed, mockFetch(ICS_CONFLIT), tick);
    const row = await db
      .prepare("SELECT status, checkin, checkout FROM bookings WHERE source = 'direct'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "confirmed", ...STAY });
    expect(addDays(todayInZone(TICK1), 0)).toBe("2026-07-12"); // le fuseau ne dérive pas
  });
});
