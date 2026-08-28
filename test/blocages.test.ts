// Blocages manuels (issue #74) — fermer des dates sans fabriquer de fausse
// réservation.
//
// Ce que ces tests protègent, dans l'ordre d'importance :
//   1. un blocage occupe le stock par le MÊME chemin atomique que les
//      réservations, liaisons comprises (bloquer La Scierie ferme le Domaine) ;
//   2. une course entre un blocage et une réservation ne laisse passer qu'un
//      seul des deux ;
//   3. un blocage n'est pas une vente : il reste hors des statistiques et des
//      relances, mais entre dans l'export iCal.
//
// La règle du projet (test/README.md) veut que toute modification du moteur de
// disponibilité soit couverte deux fois : côté SQL et côté TypeScript pur.
// Les deux familles sont ici.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import {
  blocksAsSpans,
  busySpans,
  isUnitFree,
  type BookingSpan,
} from "../src/core/availability";
import { computeYearStats } from "../src/core/stats";
import {
  blockingManualBlocks,
  confirmBookingAtomic,
  createBookingAtomic,
  createManualBlockAtomic,
  listLinks,
  listUnits,
  manualBlocksInWindow,
  moveBookingAtomic,
  reactivateBookingAtomic,
  releaseManualBlock,
  updateBookingDatesAtomic,
  type CreateBookingInput,
} from "../src/db/repo";
import { exportSpansForUnit } from "../src/services/ical";
import { getUnit } from "../src/db/repo";

// Unités du seed : 1 = Maison du Scieur, 2 = La Scierie, 3 = Domaine entier.
const SCIEUR = 1;
const SCIERIE = 2;
const DOMAINE = 3;

const NOW = new Date("2026-06-01T12:00:00Z");

let t: TestDb;
let db: D1Database;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests", "manual_blocks"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

function booking(unitId: number, checkin: string, checkout: string, over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    unitId, checkin, checkout,
    adults: 2, children: 0,
    status: "confirmed", source: "manual",
    totalCents: 50000, depositCents: 15000,
    now: NOW,
    ...over,
  };
}

function block(unitId: number, checkin: string, checkout: string, reason = "travaux"): Promise<{ ok: boolean }> {
  return createManualBlockAtomic(db, { unitId, checkin, checkout, reason, createdBy: "julien", now: NOW });
}

// ---------------------------------------------------------------------------
// SQL — la vérité transactionnelle
// ---------------------------------------------------------------------------

describe("blocage manuel — liaison et disponibilité (SQL)", () => {
  it("bloquer La Scierie rend le Domaine entier indisponible", async () => {
    const posed = await block(SCIERIE, "2026-08-10", "2026-08-14");
    expect(posed.ok).toBe(true);

    const domaine = await createBookingAtomic(db, booking(DOMAINE, "2026-08-11", "2026-08-13"));
    expect(domaine.ok).toBe(false);
    // et la maison elle-même est fermée
    const scierie = await createBookingAtomic(db, booking(SCIERIE, "2026-08-11", "2026-08-13"));
    expect(scierie.ok).toBe(false);
  });

  it("bloquer le Domaine entier ferme ses deux maisons", async () => {
    expect((await block(DOMAINE, "2026-08-10", "2026-08-14", "usage personnel")).ok).toBe(true);
    expect((await createBookingAtomic(db, booking(SCIEUR, "2026-08-12", "2026-08-13"))).ok).toBe(false);
    expect((await createBookingAtomic(db, booking(SCIERIE, "2026-08-12", "2026-08-13"))).ok).toBe(false);
  });

  it("ne ferme PAS l'autre maison ni les dates voisines (pas de faux positif)", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-14")).ok).toBe(true);
    // l'autre maison n'est pas liée à La Scierie
    expect((await createBookingAtomic(db, booking(SCIEUR, "2026-08-10", "2026-08-14"))).ok).toBe(true);
    // le départ est exclusif : une arrivée le 14 passe
    expect((await createBookingAtomic(db, booking(SCIERIE, "2026-08-14", "2026-08-16"))).ok).toBe(true);
  });

  it("lever le blocage libère immédiatement le créneau", async () => {
    const posed = await createManualBlockAtomic(db, {
      unitId: SCIERIE, checkin: "2026-08-10", checkout: "2026-08-14", reason: "travaux", createdBy: "julien", now: NOW,
    });
    expect(posed.ok).toBe(true);
    if (!posed.ok) return;

    expect((await createBookingAtomic(db, booking(DOMAINE, "2026-08-11", "2026-08-13"))).ok).toBe(false);
    expect(await releaseManualBlock(db, posed.id, "julien")).toBe(true);
    expect((await createBookingAtomic(db, booking(DOMAINE, "2026-08-11", "2026-08-13"))).ok).toBe(true);
    // levée deux fois : la seconde ne fait rien (idempotence du geste)
    expect(await releaseManualBlock(db, posed.id, "julien")).toBe(false);
  });

  it("un blocage ne peut pas se poser sur un créneau déjà réservé", async () => {
    expect((await createBookingAtomic(db, booking(SCIEUR, "2026-08-10", "2026-08-14"))).ok).toBe(true);
    // directement sur l'unité…
    expect((await block(SCIEUR, "2026-08-12", "2026-08-13")).ok).toBe(false);
    // …et par liaison : le Domaine est occupé par la résa de la maison
    expect((await block(DOMAINE, "2026-08-12", "2026-08-13")).ok).toBe(false);
  });

  it("une option de paiement en cours bloque, une option expirée ne bloque plus", async () => {
    const hold = await createBookingAtomic(
      db,
      booking(SCIERIE, "2026-08-10", "2026-08-14", { status: "pending", holdMinutes: 30 }),
    );
    expect(hold.ok).toBe(true);
    expect((await block(SCIERIE, "2026-08-11", "2026-08-12")).ok).toBe(false);

    // deux heures plus tard, l'option est morte : le créneau se bloque
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    const posed = await createManualBlockAtomic(db, {
      unitId: SCIERIE, checkin: "2026-08-11", checkout: "2026-08-12", reason: "travaux", createdBy: "julien", now: later,
    });
    expect(posed.ok).toBe(true);
  });

  it("deux blocages ne se superposent pas (même règle que deux réservations)", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-14")).ok).toBe(true);
    expect((await block(SCIERIE, "2026-08-13", "2026-08-16")).ok).toBe(false);
    expect((await block(DOMAINE, "2026-08-13", "2026-08-16")).ok).toBe(false);
    // mais l'autre maison reste blocable
    expect((await block(SCIEUR, "2026-08-10", "2026-08-14")).ok).toBe(true);
  });

  it("les quatre autres écritures atomiques respectent le blocage", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-14")).ok).toBe(true);

    // 1. changement de dates VERS le créneau bloqué
    const b = await createBookingAtomic(db, booking(SCIERIE, "2026-09-01", "2026-09-03"));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(await updateBookingDatesAtomic(db, b.id, SCIERIE, "2026-08-11", "2026-08-13")).toBe(false);

    // 2. déménagement vers une unité fermée par liaison
    const other = await createBookingAtomic(db, booking(SCIEUR, "2026-08-11", "2026-08-13"));
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(await moveBookingAtomic(db, other.id, DOMAINE, "2026-08-11", "2026-08-13")).toBe(false);

    // 3. confirmation d'une option posée AVANT le blocage
    const hold = await createBookingAtomic(
      db,
      booking(SCIEUR, "2026-10-01", "2026-10-03", { status: "pending", holdMinutes: 600 }),
    );
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    expect((await block(SCIEUR, "2026-10-01", "2026-10-03", "travaux")).ok).toBe(false); // le hold protège
    // on bloque les mêmes dates via une unité non liée au hold : impossible ici,
    // on force donc le cas réaliste — blocage posé pendant l'expiration du hold
    await db.prepare("UPDATE bookings SET hold_expires_at = ?2 WHERE id = ?1").bind(hold.id, "2026-05-01 00:00:00").run();
    expect((await block(SCIEUR, "2026-10-01", "2026-10-03", "travaux")).ok).toBe(true);
    await db.prepare("UPDATE bookings SET hold_expires_at = ?2 WHERE id = ?1").bind(hold.id, "2027-01-01 00:00:00").run();
    expect(await confirmBookingAtomic(db, hold.id, "2026-06-01 12:00:00")).toBe("conflict");

    // 4. réactivation d'une résa canal annulée sur un créneau bloqué
    const cancelled = await createBookingAtomic(db, booking(SCIERIE, "2026-11-01", "2026-11-03"));
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(cancelled.id).run();
    expect((await block(SCIERIE, "2026-11-01", "2026-11-03", "travaux")).ok).toBe(true);
    expect(await reactivateBookingAtomic(db, cancelled.id, SCIERIE, "2026-11-01", "2026-11-03")).toBe(false);
  });
});

describe("COURSES — blocage et réservation simultanés", () => {
  it("blocage de La Scierie et réservation du Domaine en même temps → un seul gagnant", async () => {
    const [posed, booked] = await Promise.all([
      block(SCIERIE, "2026-08-10", "2026-08-14"),
      createBookingAtomic(db, booking(DOMAINE, "2026-08-10", "2026-08-14")),
    ]);
    expect([posed.ok, booked.ok].filter(Boolean)).toHaveLength(1);
  });

  it("rafale : 4 blocages et 4 réservations sur le même créneau → une seule occupation", async () => {
    const attempts = await Promise.all([
      block(SCIERIE, "2026-08-10", "2026-08-14"),
      createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14")),
      block(DOMAINE, "2026-08-10", "2026-08-14"),
      createBookingAtomic(db, booking(DOMAINE, "2026-08-10", "2026-08-14")),
      block(SCIERIE, "2026-08-11", "2026-08-13"),
      createBookingAtomic(db, booking(SCIERIE, "2026-08-11", "2026-08-13")),
      block(DOMAINE, "2026-08-12", "2026-08-13"),
      createBookingAtomic(db, booking(DOMAINE, "2026-08-12", "2026-08-13")),
    ]);
    expect(attempts.filter((r) => r.ok)).toHaveLength(1);
  });

  it("deux blocages concurrents sur le même créneau → un seul passe", async () => {
    const [a, b] = await Promise.all([
      block(SCIERIE, "2026-08-10", "2026-08-14", "travaux"),
      block(SCIERIE, "2026-08-10", "2026-08-14", "famille"),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TypeScript pur — ce que le planning, le site public et l'export affichent
// ---------------------------------------------------------------------------

describe("blocage manuel — moteur TypeScript", () => {
  it("blocksAsSpans fait occuper un blocage comme une réservation confirmée", () => {
    const links = [
      { unitId: SCIEUR, blocksUnitId: DOMAINE },
      { unitId: SCIERIE, blocksUnitId: DOMAINE },
      { unitId: DOMAINE, blocksUnitId: SCIEUR },
      { unitId: DOMAINE, blocksUnitId: SCIERIE },
    ];
    const spans: BookingSpan[] = blocksAsSpans([
      { unitId: SCIERIE, checkin: "2026-08-10", checkout: "2026-08-14" },
    ]);
    const now = "2026-06-01 12:00:00";
    expect(isUnitFree(SCIERIE, "2026-08-11", "2026-08-13", spans, links, now)).toBe(false);
    expect(isUnitFree(DOMAINE, "2026-08-11", "2026-08-13", spans, links, now)).toBe(false);
    expect(isUnitFree(SCIEUR, "2026-08-11", "2026-08-13", spans, links, now)).toBe(true);
    // un blocage n'expire jamais : il occupe quel que soit l'instant
    expect(isUnitFree(SCIERIE, "2026-08-11", "2026-08-13", spans, links, "2030-01-01 00:00:00")).toBe(false);
    // et il remonte dans les périodes occupées du Domaine, par liaison
    expect(busySpans(DOMAINE, spans, links, now)).toHaveLength(1);
  });

  it("le même verdict côté SQL et côté TypeScript", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-14")).ok).toBe(true);
    const [links, blocks] = await Promise.all([listLinks(db, 1), manualBlocksInWindow(db, 1, "2026-08-01", "2026-09-01")]);
    const spans = blocksAsSpans(blocks);
    const now = "2026-06-01 12:00:00";

    for (const unit of [SCIERIE, DOMAINE, SCIEUR]) {
      const tsFree = isUnitFree(unit, "2026-08-11", "2026-08-13", spans, links, now);
      const sqlFree = (await createBookingAtomic(db, booking(unit, "2026-08-11", "2026-08-13"))).ok;
      expect(tsFree).toBe(sqlFree);
      if (sqlFree) await db.prepare("DELETE FROM bookings").run();
    }
  });
});

// ---------------------------------------------------------------------------
// Ce qu'un blocage n'est PAS : une vente
// ---------------------------------------------------------------------------

describe("blocage manuel — hors des ventes", () => {
  it("n'apparaît pas dans les statistiques : ni nuits vendues, ni revenus", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-20", "travaux")).ok).toBe(true);
    const units = await listUnits(db, 1);
    const links = await listLinks(db, 1);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));

    // Aucune réservation en base : les stats se lisent sur `bookings` seul.
    const { results } = await db.prepare("SELECT COUNT(*) AS n FROM bookings").all();
    expect((results[0] as { n: number }).n).toBe(0);

    const stats = computeYearStats(2026, statsUnits, links, []);
    expect(stats.soldNights).toBe(0);
    expect(stats.revenueCents).toBe(0);
    expect(stats.occupancyPct).toBe(0);
    expect(stats.perUnit).toHaveLength(0);
  });

  it("ne crée aucune ligne dans bookings", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-20")).ok).toBe(true);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("part dans l'export iCal, sur l'unité et sur celles qu'elle bloque", async () => {
    // Fenêtre d'export : 30 j en arrière → 18 mois en avant, autour de `now`.
    const now = new Date("2026-08-01T12:00:00Z");
    expect((await block(SCIERIE, "2026-08-10", "2026-08-14", "travaux")).ok).toBe(true);

    const scierie = await getUnit(db, SCIERIE);
    const domaine = await getUnit(db, DOMAINE);
    const scieur = await getUnit(db, SCIEUR);
    expect(scierie && domaine && scieur).toBeTruthy();

    const spansScierie = await exportSpansForUnit(db, scierie!, now);
    expect(spansScierie).toEqual([{ checkin: "2026-08-10", checkout: "2026-08-14" }]);
    const spansDomaine = await exportSpansForUnit(db, domaine!, now);
    expect(spansDomaine).toEqual([{ checkin: "2026-08-10", checkout: "2026-08-14" }]);
    // l'autre maison reste vendable
    expect(await exportSpansForUnit(db, scieur!, now)).toEqual([]);
  });

  it("blockingManualBlocks nomme le motif, pour pouvoir le dire au téléphone", async () => {
    expect((await block(SCIERIE, "2026-08-10", "2026-08-14", "réfection de la salle de bains")).ok).toBe(true);
    const found = await blockingManualBlocks(db, DOMAINE, "2026-08-11", "2026-08-13");
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe("réfection de la salle de bains");
    expect(found[0]?.unitName).toBe("La Scierie");
  });
});

// ---------------------------------------------------------------------------
// L'API de back-office
// ---------------------------------------------------------------------------

describe("API back-office — blocages", () => {
  const router = new Router();
  registerAdminRoutes(router);
  const ADMIN = "test-admin-token";
  let env: Env;

  beforeAll(() => {
    env = {
      DB: db,
      ASSETS: undefined as unknown as Fetcher,
      PUBLIC_BASE_URL: "http://test.local",
      EMAILS_ENABLED: "false",
      ADMIN_TOKEN: ADMIN,
    };
  });

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

  it("pose, liste, puis lève un blocage", async () => {
    const posed = await call("POST", "/api/admin/blocks", {
      unitId: SCIERIE, checkin: "2026-08-10", checkout: "2026-08-14", reason: "Travaux",
    });
    expect(posed.status).toBe(201);
    const id = (posed.data.block as { id: number }).id;

    const listed = await call("GET", "/api/admin/blocks?property=1&from=2026-08-01&to=2026-09-01");
    expect((listed.data.blocks as unknown[]).length).toBe(1);

    // le planning le porte sur son unité, et par liaison sur le Domaine
    const planning = await call("GET", "/api/admin/planning?property=1&from=2026-08-01&to=2026-09-01");
    const manual = planning.data.manualBlocks as { unitId: number; reason: string }[];
    expect(manual).toHaveLength(1);
    expect(manual[0]?.unitId).toBe(SCIERIE);
    const liaison = planning.data.blocks as { unitId: number; sourceReference: string }[];
    expect(liaison.some((b) => b.unitId === DOMAINE && b.sourceReference.includes("Travaux"))).toBe(true);

    const released = await call("DELETE", `/api/admin/blocks/${id}`);
    expect(released.status).toBe(200);
    const after = await call("GET", "/api/admin/blocks?property=1&from=2026-08-01&to=2026-09-01");
    expect((after.data.blocks as unknown[]).length).toBe(0);
  });

  it("refuse un blocage sur un créneau pris, en nommant le coupable", async () => {
    const created = await createBookingAtomic(db, booking(SCIEUR, "2026-08-10", "2026-08-14"));
    expect(created.ok).toBe(true);
    const refused = await call("POST", "/api/admin/blocks", {
      unitId: DOMAINE, checkin: "2026-08-11", checkout: "2026-08-13", reason: "Travaux",
    });
    expect(refused.status).toBe(409);
    expect((refused.data.conflicts as { reference: string }[])[0]?.reference).toMatch(/^PM-/);
  });

  it("refuse un motif vide et des dates inversées", async () => {
    expect((await call("POST", "/api/admin/blocks", { unitId: SCIERIE, checkin: "2026-08-10", checkout: "2026-08-14", reason: "" })).status).toBe(400);
    expect((await call("POST", "/api/admin/blocks", { unitId: SCIERIE, checkin: "2026-08-14", checkout: "2026-08-10", reason: "Travaux" })).status).toBe(400);
    expect((await call("POST", "/api/admin/blocks", { unitId: 999, checkin: "2026-08-10", checkout: "2026-08-14", reason: "Travaux" })).status).toBe(404);
  });

  it("la garde admin protège les trois routes", async () => {
    const anon = async (method: string, path: string, body?: unknown) => {
      const req = new Request(`http://test.local${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return (await router.handle(req, env))!.status;
    };
    expect(await anon("GET", "/api/admin/blocks?property=1")).toBe(401);
    expect(await anon("POST", "/api/admin/blocks", { unitId: SCIERIE, checkin: "2026-08-10", checkout: "2026-08-14", reason: "x" })).toBe(401);
    expect(await anon("DELETE", "/api/admin/blocks/1")).toBe(401);
  });
});
