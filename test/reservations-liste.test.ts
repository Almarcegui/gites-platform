// Liste des réservations du back-office — tri et périodes (issue #51).
//
// La liste était triée par date de CRÉATION : les arrivées de la semaine
// disparaissaient sous les réservations récentes, et « qui arrive bientôt ? »
// demandait de faire défiler. Ces tests fixent le contrat de l'API sur lequel
// s'appuient les pastilles « à venir / en cours / passées » du front.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { createBookingAtomic, type CreateBookingInput } from "../src/db/repo";

const SCIERIE = 2; // property 1
const PROPERTY = 1;
const ADMIN = "test-admin-token";

const router = new Router();
registerAdminRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

const TODAY = todayInZone();
const d = (n: number): string => addDays(TODAY, n);

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

async function call(path: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new Request(`http://test.local${path}`, { headers: { authorization: `Bearer ${ADMIN}` } });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

/** Crée une réservation confirmée sur La Scierie, sur une plage libre. */
async function seed(checkin: string, checkout: string): Promise<number> {
  const input: CreateBookingInput = {
    unitId: SCIERIE,
    checkin,
    checkout,
    adults: 2,
    children: 0,
    status: "confirmed",
    source: "manual",
    totalCents: 50000,
  };
  const res = await createBookingAtomic(db, input);
  if (!res.ok) throw new Error(`création refusée pour ${checkin} → ${checkout}`);
  return res.id;
}

// Cinq séjours qui ne se chevauchent pas, répartis de part et d'autre du jour.
// L'ordre de CRÉATION est délibérément l'inverse de l'ordre d'ARRIVÉE : c'est
// la seule façon de prouver que le tri a bien changé.
let lointain = 0;
let proche = 0;
let enCours = 0;
let recent = 0;
let ancien = 0;

beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  lointain = await seed(d(20), d(25));
  proche = await seed(d(5), d(8));
  enCours = await seed(d(-2), d(3));
  recent = await seed(d(-10), d(-5));
  ancien = await seed(d(-30), d(-25));
});

const ids = (data: Record<string, unknown>): number[] =>
  (data.bookings as Array<{ id: number }>).map((b) => b.id);

describe("tri par date d'arrivée (#51)", () => {
  it("« à venir » remonte la prochaine arrivée en premier", async () => {
    const { status, data } = await call(`/api/admin/bookings?property=${PROPERTY}&period=upcoming`);
    expect(status).toBe(200);
    expect(ids(data)).toEqual([proche, lointain]);
  });

  it("« passées » remonte le dernier séjour en premier — pas 2024", async () => {
    const { data } = await call(`/api/admin/bookings?property=${PROPERTY}&period=past`);
    expect(ids(data)).toEqual([recent, ancien]);
  });

  it("`sort=created` restitue l'ordre historique, pour l'export et la compatibilité", async () => {
    const { data } = await call(`/api/admin/bookings?property=${PROPERTY}&sort=created`);
    // Créées dans l'ordre lointain → ancien, donc rendues à l'envers.
    expect(ids(data)).toEqual([ancien, recent, enCours, proche, lointain]);
  });
});

describe("filtres de période (#51)", () => {
  it("« en cours » = arrivée déjà passée et départ pas encore fait", async () => {
    const { data } = await call(`/api/admin/bookings?property=${PROPERTY}&period=current`);
    expect(ids(data)).toEqual([enCours]);
  });

  it("un séjour qui commence aujourd'hui est « en cours », pas « à venir »", async () => {
    await db.prepare("DELETE FROM bookings").run();
    const duJour = await seed(TODAY, d(4));
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=current`)).data)).toEqual([duJour]);
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=upcoming`)).data)).toEqual([]);
  });

  it("un séjour qui se termine aujourd'hui est encore « en cours » — état des lieux, ménage et solde restent à faire", async () => {
    await db.prepare("DELETE FROM bookings").run();
    const duJour = await seed(d(-4), TODAY);
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=current`)).data)).toEqual([duJour]);
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=past`)).data)).toEqual([]);
  });

  it("les trois périodes forment une partition : aucune réservation n'est perdue ni comptée deux fois", async () => {
    const total = new Set<number>();
    for (const p of ["upcoming", "current", "past"]) {
      for (const id of ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=${p}`)).data)) {
        expect(total.has(id)).toBe(false);
        total.add(id);
      }
    }
    expect(total.size).toBe(5);
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}`)).data)).toHaveLength(5);
  });

  it("les bornes du jour ne perdent rien : arrivée du jour et départ du jour restent visibles", async () => {
    await db.prepare("DELETE FROM bookings").run();
    const arriveAujourdhui = await seed(TODAY, d(3));
    const partAujourdhui = await seed(d(-4), TODAY);
    const vus = new Set<number>();
    for (const p of ["upcoming", "current", "past"]) {
      for (const id of ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=${p}`)).data)) {
        expect(vus.has(id)).toBe(false);
        vus.add(id);
      }
    }
    expect([...vus].sort()).toEqual([arriveAujourdhui, partAujourdhui].sort());
  });

  it("sans période, rien n'est filtré et le plus récent passe devant", async () => {
    const { data } = await call(`/api/admin/bookings?property=${PROPERTY}`);
    // Toujours la date d'arrivée, mais décroissante : la vue « Toutes » sert
    // la recherche, où l'on cherche d'abord dans le récent.
    expect(ids(data)).toEqual([lointain, proche, enCours, recent, ancien]);
  });

  it("une période inconnue est refusée plutôt que silencieusement ignorée", async () => {
    expect((await call(`/api/admin/bookings?property=${PROPERTY}&period=bidon`)).status).toBe(400);
  });

  it("renvoie le jour de référence, pour que le front n'aille pas filtrer sur une autre horloge", async () => {
    const { data } = await call(`/api/admin/bookings?property=${PROPERTY}&period=upcoming`);
    expect(data.today).toBe(TODAY);
    expect(data.period).toBe("upcoming");
  });

  it("période et statut se combinent sans se marcher dessus", async () => {
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(proche).run();
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=upcoming&status=confirmed`)).data)).toEqual([
      lointain,
    ]);
    expect(ids((await call(`/api/admin/bookings?property=${PROPERTY}&period=upcoming&status=cancelled`)).data)).toEqual([
      proche,
    ]);
  });
});
