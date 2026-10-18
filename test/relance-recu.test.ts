// Issue #37 — relance des réservations abandonnées et reçu de paiement.
//
// La définition de fini de l'issue tient en trois preuves, et ce sont les trois
// premiers tests : aucune relance sans consentement enregistré, jamais deux
// relances pour la même réservation, un reçu juste pour les arrhes ET pour le
// solde. Le reste couvre les pièges repérés en écrivant le code (une résa
// abandonnée est `cancelled`, pas `pending` ; un créneau revendu ne se relance
// pas).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, sqlNow, todayInZone } from "../src/core/dates";
import { runScheduled } from "../src/services/cron";
import { formatEur } from "../src/services/email";
import {
  ABANDON_DELAY_HOURS,
  ABANDON_KIND,
  listAbandonedBookings,
  resumeUrl,
  runAbandonedReminders,
} from "../src/services/relance";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

const NOW = new Date("2026-08-10T09:00:00Z");
/** Blocage expiré il y a plus de 24 h → éligible à la relance. */
const OLD_HOLD = sqlNow(new Date(NOW.getTime() - (ABANDON_DELAY_HOURS + 2) * 3_600_000));
/** Blocage expiré il y a 2 h → trop tôt, on laisse le client respirer. */
const FRESH_HOLD = sqlNow(new Date(NOW.getTime() - 2 * 3_600_000));
const CHECKIN = addDays(todayInZone(NOW), 120);
const CHECKOUT = addDays(CHECKIN, 4);

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
  } as Env;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** Client avec ou sans consentement marketing explicite. */
async function guest(email: string, optIn: boolean): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO guests (email, first_name, last_name, marketing_opt_in, marketing_opt_in_at) VALUES (?1, 'Camille', 'Testeur', ?2, CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END)",
    )
    .bind(email, optIn ? 1 : 0)
    .run();
  return res.meta.last_row_id;
}

interface AbandonOpts {
  optIn?: boolean;
  status?: "cancelled" | "pending";
  holdExpiresAt?: string;
  unitId?: number;
  checkin?: string;
  checkout?: string;
  paidCents?: number;
  email?: string;
}

/** Réservation abandonnée telle que le système en produit réellement :
 *  le cron `expireStaleHolds` l'a basculée en `cancelled/hold_expired`. */
async function abandoned(o: AbandonOpts = {}): Promise<number> {
  const guestId = await guest(o.email ?? "camille@example.com", o.optIn ?? true);
  const status = o.status ?? "cancelled";
  const res = await db
    .prepare(
      `INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, hold_expires_at, source,
                             reference, total_cents, deposit_cents, paid_cents, guest_id, cancel_reason, cancelled_at)
       VALUES (?1, ?2, ?3, 2, 0, ?4, ?5, 'direct', ?6, 90000, 27000, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      o.unitId ?? 1,
      o.checkin ?? CHECKIN,
      o.checkout ?? CHECKOUT,
      status,
      o.holdExpiresAt ?? OLD_HOLD,
      `AB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      o.paidCents ?? 0,
      guestId,
      status === "cancelled" ? "hold_expired" : null,
      status === "cancelled" ? OLD_HOLD : null,
    )
    .run();
  return res.meta.last_row_id;
}

const relances = async () =>
  (await db.prepare("SELECT * FROM email_log WHERE kind = ?1").bind(ABANDON_KIND).all()).results as Record<string, unknown>[];

// ---------------------------------------------------------------------------
// Volet a — relance des abandons
// ---------------------------------------------------------------------------

describe("relance : consentement (définition de fini)", () => {
  it("AUCUNE relance sans consentement enregistré", async () => {
    await abandoned({ optIn: false });
    const res = await runAbandonedReminders(env, NOW);
    expect(res.sent).toBe(0);
    expect(await relances()).toHaveLength(0);
  });

  it("relance envoyée quand le consentement est enregistré", async () => {
    await abandoned({ optIn: true });
    const res = await runAbandonedReminders(env, NOW);
    expect(res.sent).toBe(1);
    const [log] = await relances();
    expect(log?.status).toBe("stub"); // envois désactivés : journalisé, pas expédié
    expect(String(log?.body_text)).toContain("/reserver/pre-more/?");
  });

  it("le filtre de consentement vit dans la requête, pas dans la boucle", async () => {
    // Sans opt-in, la réservation ne doit même pas être candidate — une refonte
    // de la boucle d'envoi ne doit pas pouvoir rouvrir la porte.
    await abandoned({ optIn: false });
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(0);
  });
});

describe("relance : jamais deux fois (définition de fini)", () => {
  it("une même réservation ne reçoit jamais deux relances", async () => {
    await abandoned();
    expect((await runAbandonedReminders(env, NOW)).sent).toBe(1);
    const second = await runAbandonedReminders(env, NOW);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await relances()).toHaveLength(1);
  });

  it("le dédoublonnage passe par email_log, sans table nouvelle", async () => {
    const id = await abandoned();
    await runAbandonedReminders(env, NOW);
    const rows = await relances();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.booking_id)).toBe(id);
  });
});

describe("relance : qui est éligible", () => {
  it("trouve les abandons RÉELS, c'est-à-dire annulés par expiration du blocage", async () => {
    // Piège du projet : `expireStaleHolds` bascule ces résas en 'cancelled'
    // toutes les 15 min. Ne chercher que 'pending' ne trouverait presque rien.
    await abandoned({ status: "cancelled" });
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(1);
  });

  it("trouve aussi celles que le cron n'a pas encore basculées", async () => {
    await abandoned({ status: "pending" });
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(1);
  });

  it("attend le délai : un abandon d'il y a 2 h n'est pas relancé", async () => {
    await abandoned({ holdExpiresAt: FRESH_HOLD });
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(0);
  });

  it("ne relance pas un abandon trop ancien", async () => {
    const vieux = sqlNow(new Date(NOW.getTime() - 30 * 86_400_000));
    await abandoned({ holdExpiresAt: vieux });
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(0);
  });

  it("ne relance pas une réservation déjà payée", async () => {
    await abandoned({ paidCents: 27000 });
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(0);
  });

  it("ne relance pas quelqu'un qui a fini par réserver ces dates", async () => {
    await abandoned();
    const guestId = (await db.prepare("SELECT id FROM guests LIMIT 1").first<{ id: number }>())!.id;
    await db
      .prepare(
        `INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, source, reference,
                               total_cents, deposit_cents, paid_cents, guest_id)
         VALUES (2, ?1, ?2, 2, 0, 'confirmed', 'direct', 'OK-1', 90000, 27000, 27000, ?3)`,
      )
      .bind(CHECKIN, CHECKOUT, guestId)
      .run();
    expect(await listAbandonedBookings(db, { now: NOW })).toHaveLength(0);
  });

  it("ne relance pas sur un créneau entre-temps revendu", async () => {
    // Inviter à « reprendre » des dates vendues serait une promesse intenable.
    await abandoned({ unitId: 1 });
    await db
      .prepare(
        `INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, source, reference,
                               total_cents, deposit_cents, paid_cents)
         VALUES (1, ?1, ?2, 2, 0, 'confirmed', 'direct', 'PRIS-1', 90000, 27000, 27000)`,
      )
      .bind(CHECKIN, CHECKOUT)
      .run();
    const res = await runAbandonedReminders(env, NOW);
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
  });
});

describe("relance : le message", () => {
  it("le lien de reprise rouvre le tunnel sur les dates choisies", async () => {
    const url = resumeUrl("http://test.local", {
      id: 1, reference: "AB-1", unitId: 2, unitSlug: "la-scierie", unitName: "La Scierie",
      propertyId: 1, propertySlug: "pre-more", guestFirstName: "Camille",
      guestEmail: "c@example.com", checkin: "2026-12-04", checkout: "2026-12-08",
      adults: 3, children: 2, holdExpiresAt: OLD_HOLD,
    });
    // Pré Moré : page dédiée, le domaine est implicite (pas de property=).
    expect(url).toContain("/reserver/pre-more/?");
    expect(url).not.toContain("property=");
    expect(url).toContain("unit=la-scierie");
    expect(url).toContain("checkin=2026-12-04");
    expect(url).toContain("checkout=2026-12-08");
    expect(url).toContain("adults=3");
    expect(url).toContain("children=2");
    expect(url).toContain("unit=la-scierie");
  });

  it("reste sobre : ni urgence, ni rareté, ni remise inventée", async () => {
    await abandoned();
    await runAbandonedReminders(env, NOW);
    const body = String((await relances())[0]?.body_text);
    expect(body).not.toMatch(/dépêch|vite|dernière chance|plus que|offre exceptionnelle|-\d+ ?%/i);
    // et il annonce qu'il est unique
    expect(body).toMatch(/seul message/i);
  });
});

describe("relance : branchement cron", () => {
  it("le traitement planifié envoie les relances dues", async () => {
    await abandoned();
    await runScheduled(env, NOW, (async () => new Response("", { status: 500 })) as typeof fetch);
    expect(await relances()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Volet b — reçu de paiement
// ---------------------------------------------------------------------------

describe("reçu de paiement (définition de fini)", () => {
  const call = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`http://test.local${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await router.handle(req, env);
    return { status: res!.status, data: (await res!.json()) as Record<string, unknown> };
  };

  const receipts = async () =>
    (await db.prepare("SELECT * FROM email_log WHERE kind = 'payment_receipt' ORDER BY id").all())
      .results as Record<string, unknown>[];

  it("un reçu part pour les arrhes, avec les bons montants", async () => {
    const checkin = addDays(todayInZone(), 200);
    const { status, data } = await call("POST", "/api/public/bookings", {
      unitId: 1, checkin, checkout: addDays(checkin, 7), adults: 2, children: 0,
      paymentMode: "deposit", cgvAccepted: true,
      guest: { firstName: "Reçu", lastName: "Arrhes", email: "recu.arrhes@example.com", phone: "+32 470 00 00 01" },
    });
    expect(status).toBe(201);
    const amountDue = Number(data.amountDueCents);

    const session = (await db
      .prepare("SELECT stripe_session_id FROM payments ORDER BY id DESC LIMIT 1")
      .first<{ stripe_session_id: string }>())!.stripe_session_id;
    expect((await call("POST", "/api/public/dev-pay/confirm", { session })).status).toBe(200);

    const [receipt] = await receipts();
    expect(receipt).toBeDefined();
    const body = String(receipt?.body_text);
    const eur = (c: number) => `${Math.floor(c / 100).toLocaleString("fr-BE").replace(/ | /g, " ")},${String(c % 100).padStart(2, "0")} €`;
    expect(String(receipt?.subject)).toContain("Reçu de paiement");
    expect(body).toContain(`Arrhes encaissées : ${formatEur(amountDue)}`);
    expect(body).toContain(`Total déjà réglé : ${formatEur(amountDue)}`);
    // solde restant = total − arrhes, et il est annoncé
    expect(body).toMatch(/Solde restant : /);
  });

  it("un second reçu part pour le solde, sans écraser le premier", async () => {
    const checkin = addDays(todayInZone(), 205);
    await call("POST", "/api/public/bookings", {
      unitId: 2, checkin, checkout: addDays(checkin, 7), adults: 2, children: 0,
      paymentMode: "deposit", cgvAccepted: true,
      guest: { firstName: "Reçu", lastName: "Solde", email: "recu.solde@example.com", phone: "+32 470 00 00 02" },
    });
    const first = (await db
      .prepare("SELECT stripe_session_id FROM payments ORDER BY id DESC LIMIT 1")
      .first<{ stripe_session_id: string }>())!.stripe_session_id;
    await call("POST", "/api/public/dev-pay/confirm", { session: first });

    // encaissement du solde, comme le ferait un lien de paiement du back-office
    const booking = (await db
      .prepare("SELECT id, total_cents, paid_cents FROM bookings ORDER BY id DESC LIMIT 1")
      .first<{ id: number; total_cents: number; paid_cents: number }>())!;
    const balance = booking.total_cents - booking.paid_cents;
    await db
      .prepare(
        "INSERT INTO payments (booking_id, kind, method, amount_cents, stripe_session_id, status) VALUES (?1, 'balance', 'stripe', ?2, 'stub_solde', 'pending')",
      )
      .bind(booking.id, balance)
      .run();
    expect((await call("POST", "/api/public/dev-pay/confirm", { session: "stub_solde" })).status).toBe(200);

    const all = await receipts();
    expect(all).toHaveLength(2);
    const solde = String(all[1]?.body_text);
    expect(solde).toContain("Solde encaissé :");
    expect(solde).toContain("Solde restant : aucun");
  });

  it("un même paiement ne produit jamais deux reçus (webhook rejoué)", async () => {
    const checkin = addDays(todayInZone(), 210);
    await call("POST", "/api/public/bookings", {
      unitId: 1, checkin, checkout: addDays(checkin, 7), adults: 2, children: 0,
      paymentMode: "full", cgvAccepted: true,
      guest: { firstName: "Idem", lastName: "Potent", email: "idem@example.com", phone: "+32 470 00 00 03" },
    });
    const session = (await db
      .prepare("SELECT stripe_session_id FROM payments ORDER BY id DESC LIMIT 1")
      .first<{ stripe_session_id: string }>())!.stripe_session_id;
    await call("POST", "/api/public/dev-pay/confirm", { session });
    await call("POST", "/api/public/dev-pay/confirm", { session });
    expect(await receipts()).toHaveLength(1);
  });
});
