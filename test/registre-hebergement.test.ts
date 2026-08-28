// Registre des personnes hébergées (issue #84).
//
// Ce que ces tests protègent, dans l'ordre d'importance :
//   1. LE CLOISONNEMENT — ces données ne sortent ni par le voucher, ni par
//      l'API publique, ni par l'export iCal, ni par les exports statistiques
//      ou réservations, ni par le journal d'audit ;
//   2. L'APPEND-ONLY — une correction ajoute une ligne qui remplace la
//      précédente, l'originale reste intacte, et aucune route ne permet de
//      modifier ni de supprimer une ligne ;
//   3. la PURGE de conservation — elle efface les séjours assez anciens, et
//      seulement ceux-là ;
//   4. l'export CSV par période, neutralisé contre l'injection de formule.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { parseGuestEntry, retentionCutoff } from "../src/core/guest-register";
import {
  createBookingAtomic,
  getUnit,
  insertGuestEntry,
  listGuestRegister,
  upsertGuest,
} from "../src/db/repo";
import { GUEST_REGISTER_PURGE_KEY, runGuestRegisterPurge } from "../src/services/guest-register";
import { getSetting, setSetting } from "../src/services/settings";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "julien:test-admin-token";
const SCIERIE = 2;
const MOULIN = 4; // Le Moulin de Braives — domaine 2 (seed 0004)

let t: TestDb;
let db: D1Database;
let env: Env;

// Le séjour de référence est dans le futur : il doit apparaître dans l'export
// iCal, ce qui rend le test de non-fuite significatif.
const CHECKIN = addDays(todayInZone(), 60);
const CHECKOUT = addDays(CHECKIN, 4);

/** Données inventées — jamais de vrai voyageur (COLLABORATION.md). */
const OCCUPANTS = [
  { lastName: "Kowalczyk", firstName: "Marika", birthDate: "1984-03-12", nationality: "Polonaise", idType: "passport", idNumber: "ZX9911223" },
  { lastName: "Vandersteen", firstName: "Bram", birthDate: "1979-11-02", nationality: "Belge", idType: "id_card", idNumber: "591-0000001-97" },
  { lastName: "Vandersteen", firstName: "Lise", birthDate: "2012-06-30", nationality: "Belge", idType: "id_card", idNumber: "591-0000002-98" },
];

function entry(o: (typeof OCCUPANTS)[number], over: Record<string, unknown> = {}) {
  return { ...o, arrivalDate: CHECKIN, departureDate: CHECKOUT, ...over };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; data: Record<string, unknown> }> {
  const auth = path.startsWith("/api/admin") && !("authorization" in headers)
    ? { authorization: `Bearer ${ADMIN}` }
    : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth, ...headers } : { ...auth, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, text, data };
}

/** Crée une réservation confirmée avec un réservant, et rend son id. */
async function makeBooking(
  checkin = CHECKIN,
  checkout = CHECKOUT,
  over: { unitId?: number; status?: "pending" | "confirmed" | "cancelled" } = {},
): Promise<{ id: number; reference: string }> {
  const guestId = await upsertGuest(db, {
    email: "reservant@example.invalid",
    firstName: "Bram",
    lastName: "Vandersteen",
    phone: null,
    address: null,
    country: "Belgique",
  });
  const created = await createBookingAtomic(db, {
    unitId: over.unitId ?? SCIERIE,
    checkin,
    checkout,
    adults: 2,
    children: 1,
    status: over.status ?? "confirmed",
    source: "direct",
    guestId,
    totalCents: 80000,
    depositCents: 24000,
  });
  if (!created.ok) throw new Error("réservation de test non créée");
  return { id: created.id, reference: created.reference };
}

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
  for (const table of ["guest_register", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(GUEST_REGISTER_PURGE_KEY).run();
});

// ---------------------------------------------------------------------------
// Saisie à l'arrivée
// ---------------------------------------------------------------------------

describe("saisie du registre depuis la fiche réservation", () => {
  it("saisie de 3 occupants → 3 lignes, avec l'auteur et l'horodatage", async () => {
    const b = await makeBooking();
    const res = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: OCCUPANTS.map((o) => entry(o)),
    });
    expect(res.status).toBe(201);

    const rows = await listGuestRegister(db, b.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.lastName)).toEqual(["Kowalczyk", "Vandersteen", "Vandersteen"]);
    // « saisi par » : l'identité authentifiée du guard, pas une valeur du corps.
    expect(rows.every((r) => r.recordedBy === "julien")).toBe(true);
    expect(rows.every((r) => r.recordedAt.length >= 19)).toBe(true);
    expect(rows.every((r) => r.supersedesId === null && r.supersededById === null)).toBe(true);
  });

  it("pré-remplit le premier occupant avec le réservant, jamais son état civil", async () => {
    const b = await makeBooking();
    const { status, data } = await call("GET", `/api/admin/bookings/${b.id}/guest-register`);
    expect(status).toBe(200);
    const prefill = data.prefill as Record<string, unknown>;
    expect(prefill.lastName).toBe("Vandersteen");
    expect(prefill.arrivalDate).toBe(CHECKIN);
    expect(prefill.departureDate).toBe(CHECKOUT);
    expect(prefill.occupants).toBe(3);
    // Rien qui ressemble à une pièce d'identité ne peut être deviné.
    expect(Object.keys(prefill)).not.toContain("idNumber");
    expect(Object.keys(prefill)).not.toContain("birthDate");
  });

  it("refuse une saisie incomplète ou aberrante, sans rien écrire", async () => {
    const b = await makeBooking();
    const cases: [string, unknown][] = [
      ["liste vide", { entries: [] }],
      ["nom manquant", { entries: [entry({ ...OCCUPANTS[0]!, lastName: "  " })] }],
      ["type de pièce inconnu", { entries: [entry({ ...OCCUPANTS[0]!, idType: "carte-de-fidélité" })] }],
      ["naissance future", { entries: [entry({ ...OCCUPANTS[0]!, birthDate: addDays(todayInZone(), 1) })] }],
      ["départ avant arrivée", { entries: [entry(OCCUPANTS[0]!, { departureDate: CHECKIN })] }],
      ["numéro de pièce trop court", { entries: [entry({ ...OCCUPANTS[0]!, idNumber: "x" })] }],
    ];
    for (const [label, body] of cases) {
      const res = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, body);
      expect(res.status, label).toBe(400);
    }
    expect(await listGuestRegister(db, b.id)).toHaveLength(0);
  });

  it("un lot dont un occupant est fautif n'écrit AUCUNE ligne", async () => {
    const b = await makeBooking();
    const res = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!), entry(OCCUPANTS[1]!), entry({ ...OCCUPANTS[2]!, nationality: "" })],
    });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("occupant 3");
    expect(await listGuestRegister(db, b.id)).toHaveLength(0);
  });

  it("refuse des dates d'occupant hors du séjour", async () => {
    const b = await makeBooking("2026-07-10", "2026-07-14");
    const avant = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { arrivalDate: "2026-07-08", departureDate: "2026-07-14" })],
    });
    expect(avant.status).toBe(400);
    // Le cas qui compte : une faute de frappe sur l'année de départ sortirait
    // la réservation du délai de conservation au prochain passage de la purge.
    const apres = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { arrivalDate: "2026-07-10", departureDate: "2016-07-14" })],
    });
    expect(apres.status).toBe(400);
    expect(await listGuestRegister(db, b.id)).toHaveLength(0);
  });

  it("refuse la saisie sur une réservation annulée", async () => {
    const b = await makeBooking(CHECKIN, CHECKOUT, { status: "cancelled" });
    const res = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] });
    expect(res.status).toBe(409);
    expect(await listGuestRegister(db, b.id)).toHaveLength(0);
  });

  it("refuse une correction glissée dans un lot d'occupants", async () => {
    // Le seul cas où une insertion peut être refusée est une correction :
    // l'interdire dans un lot garantit qu'aucun lot ne s'arrête à mi-parcours
    // en laissant des lignes derrière lui.
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] });
    const [original] = await listGuestRegister(db, b.id);
    const res = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry(OCCUPANTS[1]!), entry(OCCUPANTS[2]!, { supersedesId: original!.id })],
    });
    expect(res.status).toBe(400);
    expect(await listGuestRegister(db, b.id)).toHaveLength(1);
  });

  it("refuse une réservation inconnue", async () => {
    expect((await call("POST", "/api/admin/bookings/999999/guest-register", { entries: [entry(OCCUPANTS[0]!)] })).status).toBe(404);
    expect((await call("GET", "/api/admin/bookings/999999/guest-register")).status).toBe(404);
  });

  it("la saisie est réservée au back-office authentifié", async () => {
    const b = await makeBooking();
    const anon = await call("GET", `/api/admin/bookings/${b.id}/guest-register`, undefined, { authorization: "Bearer faux" });
    expect(anon.status).toBe(401);
    const post = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] }, { authorization: "Bearer faux" });
    expect(post.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

describe("journal append-only", () => {
  it("une correction ajoute une ligne qui remplace, l'originale reste intacte", async () => {
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] });
    const [original] = await listGuestRegister(db, b.id);
    expect(original).toBeDefined();

    const fix = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry({ ...OCCUPANTS[0]!, idNumber: "ZX9911999" }, { supersedesId: original!.id })],
    });
    expect(fix.status).toBe(201);

    const rows = await listGuestRegister(db, b.id);
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.id === original!.id)!;
    const added = rows.find((r) => r.id !== original!.id)!;
    // L'originale n'a PAS été réécrite : mêmes valeurs, même horodatage.
    expect(kept.idNumber).toBe("ZX9911223");
    expect(kept.recordedAt).toBe(original!.recordedAt);
    expect(kept.supersededById).toBe(added.id);
    expect(added.supersedesId).toBe(original!.id);
    expect(added.idNumber).toBe("ZX9911999");
    // Le registre « en vigueur » ne compte qu'une personne.
    expect(rows.filter((r) => r.supersededById == null)).toHaveLength(1);
  });

  it("une ligne déjà remplacée ne peut pas l'être une seconde fois", async () => {
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] });
    const [original] = await listGuestRegister(db, b.id);
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry({ ...OCCUPANTS[0]!, firstName: "Marika-Ann" }, { supersedesId: original!.id })],
    });
    const second = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry({ ...OCCUPANTS[0]!, firstName: "Autre" }, { supersedesId: original!.id })],
    });
    expect(second.status).toBe(409);
    expect(await listGuestRegister(db, b.id)).toHaveLength(2);
  });

  it("on ne peut pas corriger la ligne d'une AUTRE réservation", async () => {
    const a = await makeBooking();
    const c = await makeBooking(addDays(CHECKIN, 30), addDays(CHECKIN, 34));
    await call("POST", `/api/admin/bookings/${a.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] });
    const [ligneA] = await listGuestRegister(db, a.id);

    // Dates du séjour de C, pour que la garde de bornes ne masque pas le refus
    // qui nous intéresse ici : la ligne visée n'est pas la sienne.
    const res = await call("POST", `/api/admin/bookings/${c.id}/guest-register`, {
      entries: [
        entry({ ...OCCUPANTS[0]!, idNumber: "ZX0000000" }, {
          arrivalDate: addDays(CHECKIN, 30),
          departureDate: addDays(CHECKIN, 34),
          supersedesId: ligneA!.id,
        }),
      ],
    });
    expect(res.status).toBe(409);
    expect(await listGuestRegister(db, c.id)).toHaveLength(0);
    // Et la ligne visée n'a pas bougé.
    expect((await listGuestRegister(db, a.id))[0]!.supersededById).toBeNull();
  });

  it("une ligne à corriger inexistante est refusée", async () => {
    const b = await makeBooking();
    const res = await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { supersedesId: 424242 })],
    });
    expect(res.status).toBe(409);
    expect(await listGuestRegister(db, b.id)).toHaveLength(0);
  });

  it("aucune route ne permet de modifier ni de supprimer une ligne", async () => {
    const b = await makeBooking();
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const req = new Request(`http://test.local/api/admin/bookings/${b.id}/guest-register`, {
        method,
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      // Aucune route ne matche : le routeur rend `null` (les assets prennent
      // le relais côté worker). Un jour où quelqu'un en ajoutera une, ce test
      // tombera — c'est exactement ce qu'on veut.
      expect(await router.handle(req, env), method).toBeNull();
    }
  });

  it("deux corrections simultanées de la même ligne : une seule passe", async () => {
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: [entry(OCCUPANTS[0]!)] });
    const [original] = await listGuestRegister(db, b.id);

    const both = await Promise.all(
      ["A", "B"].map((suffix) =>
        insertGuestEntry(db, {
          bookingId: b.id,
          recordedBy: "julien",
          entry: {
            lastName: `Kowalczyk-${suffix}`,
            firstName: "Marika",
            birthDate: "1984-03-12",
            nationality: "Polonaise",
            idType: "passport",
            idNumber: "ZX9911223",
            arrivalDate: CHECKIN,
            departureDate: CHECKOUT,
            supersedesId: original!.id,
          },
        }).catch(() => ({ ok: false as const, reason: "supersedes" as const })),
      ),
    );
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect((await listGuestRegister(db, b.id)).filter((r) => r.supersededById == null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Non-fuite — le point qui compte le plus
// ---------------------------------------------------------------------------

describe("cloisonnement : ces données ne sortent nulle part ailleurs", () => {
  /** Tout ce qui identifie un occupant et ne doit apparaître dans aucune des
   *  sorties testées ci-dessous. */
  const SECRETS = ["Kowalczyk", "Marika", "ZX9911223", "591-0000001-97", "Polonaise", "1984-03-12"];

  it("ni l'API publique, ni le voucher, ni l'iCal, ni les exports admin ne les renvoient", async () => {
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: OCCUPANTS.map((o) => entry(o)) });
    expect(await listGuestRegister(db, b.id)).toHaveLength(3);

    const unit = await getUnit(db, SCIERIE);
    const year = Number(CHECKIN.slice(0, 4));
    const sorties: [string, string][] = [];
    for (const path of [
      `/api/public/bookings/${b.reference}?email=reservant@example.invalid`,
      `/api/public/properties`,
      `/api/public/properties/pre-more`,
      `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=2`,
      `/api/public/calendar?property=pre-more&month=${CHECKIN.slice(0, 7)}`,
      `/api/public/bookings/${b.reference}/messages?email=reservant@example.invalid`,
      `/ical/${unit!.icalToken}.ics`,
      `/api/admin/bookings/${b.id}`,
      `/api/admin/bookings.csv?property=1`,
      `/api/admin/stats.csv?property=1&year=${year}`,
      `/api/admin/planning?property=1&from=${CHECKIN}&to=${CHECKOUT}`,
      `/api/admin/overview?property=1`,
      `/api/admin/guests`,
      `/api/admin/audit`,
      `/api/admin/email-log?booking=${b.id}`,
    ]) {
      const res = await call("GET", path);
      expect(res.status, path).toBeLessThan(400);
      sorties.push([path, res.text]);
    }

    for (const [path, text] of sorties) {
      for (const secret of SECRETS) {
        expect(text.includes(secret), `${secret} fuite dans ${path}`).toBe(false);
      }
    }
  });

  it("le voucher du client reste exploitable et ne parle pas du registre", async () => {
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: OCCUPANTS.map((o) => entry(o)) });
    const { status, data } = await call("GET", `/api/public/bookings/${b.reference}?email=reservant@example.invalid`);
    expect(status).toBe(200);
    const booking = data.booking as Record<string, unknown>;
    expect(booking.reference).toBe(b.reference);
    expect(Object.keys(data)).not.toContain("guestRegister");
    expect(Object.keys(booking)).not.toContain("occupants");
  });

  it("le journal d'audit ne retient QUE le nombre d'occupants", async () => {
    const b = await makeBooking();
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, { entries: OCCUPANTS.map((o) => entry(o)) });
    const { results } = await db.prepare("SELECT action, detail FROM audit_log").all();
    const rows = results as { action: string; detail: string | null }[];
    const line = rows.find((r) => r.action === "guest_register.record");
    expect(line).toBeDefined();
    const detail = JSON.parse(line!.detail ?? "{}") as Record<string, unknown>;
    expect(detail.occupants).toBe(3);
    expect(detail.corrections).toBe(0);
    expect(detail.par).toBe("julien");
    const whole = JSON.stringify(rows);
    for (const secret of SECRETS) expect(whole.includes(secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Export CSV par période
// ---------------------------------------------------------------------------

describe("export CSV par période", () => {
  it("retient les séjours qui croisent la période, bornes incluses", async () => {
    const dedans = await makeBooking("2026-07-10", "2026-07-14");
    const dehors = await makeBooking("2026-09-10", "2026-09-14");
    await call("POST", `/api/admin/bookings/${dedans.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { arrivalDate: "2026-07-10", departureDate: "2026-07-14" })],
    });
    await call("POST", `/api/admin/bookings/${dehors.id}/guest-register`, {
      entries: [entry(OCCUPANTS[1]!, { arrivalDate: "2026-09-10", departureDate: "2026-09-14" })],
    });

    const res = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Kowalczyk");
    expect(res.text).toContain("Passeport");
    expect(res.text).toContain(dedans.reference);
    expect(res.text).not.toContain("Bram");
    expect(res.text).not.toContain(dehors.reference);
    // Bornes INCLUSES : une arrivée pile sur la borne de fin sort aussi.
    const borne = await call("GET", "/api/admin/guest-register.csv?from=2026-07-10&to=2026-07-10");
    expect(borne.text).toContain("Kowalczyk");
  });

  it("sort une personne présente pendant la période mais arrivée avant", async () => {
    // La question posée par une autorité est « qui était hébergé en juillet »,
    // pas « qui est arrivé en juillet » : un séjour à cheval doit sortir.
    const cheval = await makeBooking("2026-06-28", "2026-07-03");
    await call("POST", `/api/admin/bookings/${cheval.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { arrivalDate: "2026-06-28", departureDate: "2026-07-03" })],
    });
    const res = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31");
    expect(res.text).toContain("Kowalczyk");
    // Un séjour terminé avant la période ne sort pas.
    const avant = await call("GET", "/api/admin/guest-register.csv?from=2026-07-10&to=2026-07-31");
    expect(avant.text).not.toContain("Kowalczyk");
  });

  it("se restreint au domaine demandé", async () => {
    const preMore = await makeBooking("2026-07-10", "2026-07-14");
    const moulin = await makeBooking("2026-07-10", "2026-07-14", { unitId: MOULIN });
    await call("POST", `/api/admin/bookings/${preMore.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { arrivalDate: "2026-07-10", departureDate: "2026-07-14" })],
    });
    await call("POST", `/api/admin/bookings/${moulin.id}/guest-register`, {
      entries: [entry(OCCUPANTS[1]!, { arrivalDate: "2026-07-10", departureDate: "2026-07-14" })],
    });

    const un = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31&property=1");
    expect(un.text).toContain("Kowalczyk");
    expect(un.text).not.toContain("Bram");

    const deux = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31&property=2");
    expect(deux.text).toContain("Bram");
    expect(deux.text).not.toContain("Kowalczyk");

    // Sans paramètre : tous les domaines (demande qui ne vise pas un site).
    const tous = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31");
    expect(tous.text).toContain("Kowalczyk");
    expect(tous.text).toContain("Bram");
  });

  it("dit l'état de chaque ligne : en vigueur ou remplacée", async () => {
    const b = await makeBooking("2026-07-10", "2026-07-14");
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry(OCCUPANTS[0]!, { arrivalDate: "2026-07-10", departureDate: "2026-07-14" })],
    });
    const [original] = await listGuestRegister(db, b.id);
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [entry({ ...OCCUPANTS[0]!, idNumber: "ZX0001111" }, { arrivalDate: "2026-07-10", departureDate: "2026-07-14", supersedesId: original!.id })],
    });
    const res = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31");
    expect(res.text).toContain(`remplacée par la ligne ${original!.id + 1}`);
    expect(res.text).toContain(`en vigueur (remplace la ligne ${original!.id})`);
  });

  it("neutralise l'injection de formule et refuse une période absente ou aberrante", async () => {
    const b = await makeBooking("2026-07-10", "2026-07-14");
    await call("POST", `/api/admin/bookings/${b.id}/guest-register`, {
      entries: [
        entry(
          { ...OCCUPANTS[0]!, lastName: '=HYPERLINK("http://mechant.invalid";"Cliquez")' },
          { arrivalDate: "2026-07-10", departureDate: "2026-07-14" },
        ),
      ],
    });
    const res = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31");
    // La cellule est préfixée d'une apostrophe : Excel n'exécute plus rien.
    expect(res.text).toContain(`"'=HYPERLINK(`);

    expect((await call("GET", "/api/admin/guest-register.csv")).status).toBe(400);
    expect((await call("GET", "/api/admin/guest-register.csv?from=2026-07-01")).status).toBe(400);
    expect((await call("GET", "/api/admin/guest-register.csv?from=hier&to=demain")).status).toBe(400);
    expect((await call("GET", "/api/admin/guest-register.csv?from=2026-07-31&to=2026-07-01")).status).toBe(400);
    expect((await call("GET", "/api/admin/guest-register.csv?from=2000-01-01&to=2030-01-01")).status).toBe(400);
  });

  it("l'export est réservé au back-office et se trace sans donnée nominative", async () => {
    const anon = await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31", undefined, {
      authorization: "Bearer faux",
    });
    expect(anon.status).toBe(401);

    await call("GET", "/api/admin/guest-register.csv?from=2026-07-01&to=2026-07-31");
    const row = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'guest_register.export'")
      .first<{ detail: string }>();
    expect(row).not.toBeNull();
    const detail = JSON.parse(row!.detail) as Record<string, unknown>;
    expect(detail).toMatchObject({ from: "2026-07-01", to: "2026-07-31", par: "julien" });
    expect(typeof detail.lignes).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Purge de conservation
// ---------------------------------------------------------------------------

describe("purge après la durée de conservation", () => {
  const NOW = new Date("2026-08-28T09:00:00Z");

  async function record(bookingId: number, arrivalDate: string, departureDate: string, over: Record<string, unknown> = {}) {
    const parsed = parseGuestEntry({ ...OCCUPANTS[0]!, arrivalDate, departureDate, ...over }, "2026-08-28");
    if (!parsed.ok) throw new Error(parsed.message);
    const res = await insertGuestEntry(db, { bookingId, entry: parsed.entry, recordedBy: "julien" });
    if (!res.ok) throw new Error("insertion refusée");
    return res.id;
  }

  it("efface les séjours au-delà de 7 ans et garde les autres", async () => {
    const vieux = await makeBooking("2018-05-01", "2018-05-08");
    const recent = await makeBooking("2020-05-01", "2020-05-08");
    await record(vieux.id, "2018-05-01", "2018-05-08");
    await record(recent.id, "2020-05-01", "2020-05-08");

    const purge = await runGuestRegisterPurge(db, NOW);
    expect(purge.ran).toBe(true);
    expect(purge.cutoff).toBe("2019-08-28");
    expect(purge.deleted).toBe(1);
    expect(await listGuestRegister(db, vieux.id)).toHaveLength(0);
    expect(await listGuestRegister(db, recent.id)).toHaveLength(1);
  });

  it("garde un séjour qui vient tout juste d'atteindre la butoir", async () => {
    // Départ exactement 7 ans avant aujourd'hui : la conservation court encore
    // (le critère est « strictement antérieur à la butoir »).
    const pile = await makeBooking("2019-08-24", "2019-08-28");
    await record(pile.id, "2019-08-24", "2019-08-28");
    const purge = await runGuestRegisterPurge(db, NOW);
    expect(purge.deleted).toBe(0);
    expect(await listGuestRegister(db, pile.id)).toHaveLength(1);
  });

  it("ne casse jamais une chaîne de correction : le séjour part entier ou pas du tout", async () => {
    // Une correction tardive porte des dates récentes : le séjour reste, avec
    // sa ligne d'origine. Sans le regroupement par réservation, la ligne
    // d'origine serait effacée et `supersedes_id` pointerait dans le vide.
    const b = await makeBooking("2018-05-01", "2018-05-08");
    const origine = await record(b.id, "2018-05-01", "2018-05-08");
    await record(b.id, "2018-05-01", "2026-05-08", { supersedesId: origine });

    const purge = await runGuestRegisterPurge(db, NOW);
    expect(purge.deleted).toBe(0);
    const rows = await listGuestRegister(db, b.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === origine)!.supersededById).not.toBeNull();
  });

  it("efface une chaîne de corrections entière sans buter sur la référence", async () => {
    // `supersedes_id` pointe dans la table elle-même et les clés étrangères
    // sont actives (PRAGMA foreign_keys = 1) : la purge doit emporter la ligne
    // remplacée ET sa correction en une seule instruction.
    const b = await makeBooking("2018-05-01", "2018-05-08");
    const origine = await record(b.id, "2018-05-01", "2018-05-08");
    await record(b.id, "2018-05-01", "2018-05-08", { supersedesId: origine });

    const purge = await runGuestRegisterPurge(db, NOW);
    expect(purge.deleted).toBe(2);
    expect(await listGuestRegister(db, b.id)).toHaveLength(0);
  });

  it("ne tourne qu'une fois par jour, et reprend le lendemain", async () => {
    const vieux = await makeBooking("2018-05-01", "2018-05-08");
    await record(vieux.id, "2018-05-01", "2018-05-08");

    expect((await runGuestRegisterPurge(db, NOW)).ran).toBe(true);
    const second = await runGuestRegisterPurge(db, NOW);
    expect(second.ran).toBe(false);
    expect(second.deleted).toBe(0);
    expect(await getSetting(db, GUEST_REGISTER_PURGE_KEY)).toBe("2026-08-28");

    const lendemain = await runGuestRegisterPurge(db, new Date("2026-08-29T09:00:00Z"));
    expect(lendemain.ran).toBe(true);
  });

  it("réessaie le jour même si la purge a échoué (marqueur posé APRÈS le DELETE)", async () => {
    // Le marqueur de la veille ne bloque pas le jour suivant.
    await setSetting(db, GUEST_REGISTER_PURGE_KEY, "2026-08-27");
    expect((await runGuestRegisterPurge(db, NOW)).ran).toBe(true);
  });

  it("la butoir se calcule sans dériver, 29 février compris", () => {
    expect(retentionCutoff("2026-08-28")).toBe("2019-08-28");
    expect(retentionCutoff("2028-02-29")).toBe("2021-03-01");
    expect(retentionCutoff("2026-01-01", 1)).toBe("2025-01-01");
  });
});

// ---------------------------------------------------------------------------
// Validation pure
// ---------------------------------------------------------------------------

describe("validation d'une déclaration d'occupant (pur)", () => {
  const TODAY = "2026-08-28";

  it("nettoie les caractères de contrôle qui casseraient un CSV", () => {
    const res = parseGuestEntry(
      { ...OCCUPANTS[0]!, lastName: "Kowal\r\nczyk\t", firstName: "  Marika  ", arrivalDate: CHECKIN, departureDate: CHECKOUT },
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.lastName).toBe("Kowal czyk");
    expect(res.entry.firstName).toBe("Marika");
  });

  it("retire aussi les caractères bidirectionnels et le BOM", () => {
    const res = parseGuestEntry(
      {
        ...OCCUPANTS[0]!,
        lastName: "\u202EKowalczyk\u202C",
        idNumber: "\uFEFFZX99\u200B11223",
        arrivalDate: CHECKIN,
        departureDate: CHECKOUT,
      },
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.lastName).toBe("Kowalczyk");
    expect(res.entry.idNumber).toBe("ZX99 11223");
  });

  it("refuse ce qui n'est pas un objet, et les identifiants de correction absurdes", () => {
    expect(parseGuestEntry(null, TODAY).ok).toBe(false);
    expect(parseGuestEntry("Marika", TODAY).ok).toBe(false);
    expect(parseGuestEntry({ ...OCCUPANTS[0]!, arrivalDate: CHECKIN, departureDate: CHECKOUT, supersedesId: -3 }, TODAY).ok).toBe(false);
  });

  it("refuse une naissance postérieure à l'arrivée et une date hors bornes", () => {
    expect(parseGuestEntry({ ...OCCUPANTS[0]!, birthDate: "1899-12-31", arrivalDate: CHECKIN, departureDate: CHECKOUT }, TODAY).ok).toBe(false);
    expect(parseGuestEntry({ ...OCCUPANTS[0]!, birthDate: "2026-08-27", arrivalDate: "2026-08-20", departureDate: "2026-08-24" }, TODAY).ok).toBe(false);
  });
});
