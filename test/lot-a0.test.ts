// LOT A0 — non-régression des correctifs bloquants issus de l'audit ECC du
// 2026-07-30. Chaque test reproduit le scénario de panne AVANT correction :
// s'il repasse au vert après une modification future, c'est que la protection
// a sauté. Voir « 2026-07-30 – Audit technique ECC – v1 » dans le projet.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { syncFeed } from "../src/services/ical";
import { handlePaymentSuccess } from "../src/services/booking-flow";
import { beds24Fetch, beds24WritesAllowed } from "../src/services/beds24";
import { computeQuote } from "../src/core/pricing";
import {
  addPayment,
  cancelBooking,
  confirmBookingAtomic,
  createBookingAtomic,
  createFeed,
  getBooking,
  getFeed,
  healthSignals,
  setPaymentSession,
} from "../src/db/repo";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const SCIEUR = 1;
const SCIERIE = 2;
const DOMAINE = 3;

let t: TestDb;
let env: Env;
let db: D1Database;

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
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests", "ical_feeds", "promotions"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function adminCall(method: string, path: string, body?: unknown) {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  return { status: res.status, text, data: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
}

async function auditActions(): Promise<string[]> {
  const { results } = await db.prepare("SELECT action FROM audit_log ORDER BY id").all();
  return (results as { action: string }[]).map((r) => r.action);
}

// ---------------------------------------------------------------------------

describe("confirmation atomique — double réservation par webhook Stripe tardif", () => {
  const CHECKIN = addDays(todayInZone(), 210);
  const CHECKOUT = addDays(CHECKIN, 4);

  it("refuse de confirmer un hold dont le créneau a été repris entre-temps", async () => {
    // 1. Client A pose un hold très court et part payer.
    const a = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      status: "pending", source: "direct", holdMinutes: -1, // hold déjà expiré
      totalCents: 90000, depositCents: 27000, balanceDueDate: null,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // 2. Le créneau est rouvert : client B le prend, à juste titre.
    const b = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      status: "confirmed", source: "manual",
      totalCents: 90000, depositCents: 0, balanceDueDate: null,
    });
    expect(b.ok).toBe(true);

    // 3. Le webhook Stripe de A arrive enfin (Stripe retente jusqu'à 3 jours).
    //    Avant le correctif : "confirmed" → deux séjours sur les mêmes dates.
    expect(await confirmBookingAtomic(db, a.id)).toBe("conflict");
    expect((await getBooking(db, a.id))?.status).toBe("pending");
  });

  it("confirme normalement quand personne n'a pris le créneau", async () => {
    const a = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      status: "pending", source: "direct", holdMinutes: -1,
      totalCents: 90000, depositCents: 27000, balanceDueDate: null,
    });
    if (!a.ok) throw new Error("résa non créée");
    // hold expiré mais créneau libre : un paiement tardif reste honorable
    expect(await confirmBookingAtomic(db, a.id)).toBe("confirmed");
  });

  it("tient compte des liaisons : le Domaine entier bloque la confirmation d'une maison", async () => {
    const maison = await createBookingAtomic(db, {
      unitId: SCIEUR, checkin: CHECKIN, checkout: CHECKOUT, adults: 4, children: 0,
      status: "pending", source: "direct", holdMinutes: -1,
      totalCents: 120000, depositCents: 36000, balanceDueDate: null,
    });
    if (!maison.ok) throw new Error("résa non créée");
    const domaine = await createBookingAtomic(db, {
      unitId: DOMAINE, checkin: CHECKIN, checkout: CHECKOUT, adults: 15, children: 0,
      status: "confirmed", source: "manual",
      totalCents: 300000, depositCents: 0, balanceDueDate: null,
    });
    expect(domaine.ok).toBe(true);
    expect(await confirmBookingAtomic(db, maison.id)).toBe("conflict");
  });

  it("le bouton « Confirmer » du back-office renvoie 409 sur conflit, pas un doublon", async () => {
    const a = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      status: "pending", source: "direct", holdMinutes: -1,
      totalCents: 90000, depositCents: 0, balanceDueDate: null,
    });
    if (!a.ok) throw new Error("résa non créée");
    await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      status: "confirmed", source: "manual", totalCents: 90000, depositCents: 0, balanceDueDate: null,
    });
    const res = await adminCall("POST", `/api/admin/bookings/${a.id}/confirm`, {});
    expect(res.status).toBe(409);
    expect(await auditActions()).toContain("booking.confirm_conflict");
  });
});

describe("paiement orphelin — argent encaissé sans séjour", () => {
  const CHECKIN = addDays(todayInZone(), 230);

  async function payFor(bookingId: number, sessionId: string): Promise<void> {
    const paymentId = await addPayment(db, {
      bookingId, kind: "deposit", method: "stripe", amountCents: 27000, status: "pending",
    });
    await setPaymentSession(db, paymentId, sessionId);
  }

  it("un paiement reçu sur une résa annulée est signalé, pas noyé dans le journal", async () => {
    const r = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: addDays(CHECKIN, 3), adults: 2, children: 0,
      status: "pending", source: "direct", totalCents: 90000, depositCents: 27000, balanceDueDate: null,
    });
    if (!r.ok) throw new Error("résa non créée");
    await payFor(r.id, "cs_test_annulee");
    await cancelBooking(db, r.id, "hold_expired");

    const outcome = await handlePaymentSuccess(db, env, "cs_test_annulee", null);
    expect(outcome.handled).toBe(true);
    expect((await getBooking(db, r.id))?.status).toBe("cancelled");
    expect(await auditActions()).toContain("payment.orphaned");
  });

  it("un paiement dont le créneau a été repris est signalé et ne confirme rien", async () => {
    const a = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: addDays(CHECKIN, 3), adults: 2, children: 0,
      status: "pending", source: "direct", holdMinutes: -1,
      totalCents: 90000, depositCents: 27000, balanceDueDate: null,
    });
    if (!a.ok) throw new Error("résa non créée");
    await payFor(a.id, "cs_test_conflit");
    await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: addDays(CHECKIN, 3), adults: 2, children: 0,
      status: "confirmed", source: "manual", totalCents: 90000, depositCents: 0, balanceDueDate: null,
    });

    await handlePaymentSuccess(db, env, "cs_test_conflit", null);
    expect((await getBooking(db, a.id))?.status).toBe("pending");
    expect(await auditActions()).toContain("payment.orphaned");
  });

  it("la carte Santé du tableau de bord remonte ces paiements orphelins", async () => {
    const r = await createBookingAtomic(db, {
      unitId: SCIERIE, checkin: CHECKIN, checkout: addDays(CHECKIN, 3), adults: 2, children: 0,
      status: "pending", source: "direct", totalCents: 90000, depositCents: 27000, balanceDueDate: null,
    });
    if (!r.ok) throw new Error("résa non créée");
    await addPayment(db, {
      bookingId: r.id, kind: "deposit", method: "stripe", amountCents: 27000, status: "succeeded",
    });
    await cancelBooking(db, r.id, "hold_expired");

    const health = await healthSignals(db, 1);
    expect(health.orphanPayments).toHaveLength(1);
    expect(health.orphanPayments[0]?.reference).toBe(r.reference);

    const overview = await adminCall("GET", "/api/admin/overview?property=1");
    expect(overview.status).toBe(200);
    expect((overview.data.health as { ok: boolean }).ok).toBe(false);
  });
});

describe("flux iCal vide — annulation en masse", () => {
  const NOW = new Date("2026-07-12T10:00:00Z");
  const ICS = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:resa-airbnb-1@airbnb.com",
    "DTSTART;VALUE=DATE:20261101",
    "DTEND;VALUE=DATE:20261108",
    "SUMMARY:Reserved",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const mockFetch = (body: string, status = 200): typeof fetch =>
    (async () => new Response(body, { status })) as typeof fetch;

  async function makeFeed() {
    const id = await createFeed(db, { unitId: SCIERIE, name: "Airbnb — Test", url: "https://example.com/cal.ics" });
    const feed = await getFeed(db, id);
    if (!feed) throw new Error("flux non créé");
    return feed;
  }

  it("un flux qui répond 200 mais vide n'annule RIEN et lève une alerte", async () => {
    const feed = await makeFeed();
    const first = await syncFeed(db, feed, mockFetch(ICS), NOW);
    expect(first.imported).toBe(1);

    // URL Airbnb expirée : 200 + page de login HTML, aucun VEVENT.
    const loginPage = "<!DOCTYPE html><html><body>Sign in to Airbnb</body></html>";
    const second = await syncFeed(db, feed, mockFetch(loginPage), NOW);

    expect(second.suspicious).toBe(true);
    expect(second.cancelled).toBe(0); // avant le correctif : 1, et les dates repartaient à la vente
    const after = await getFeed(db, feed.id);
    expect(after?.lastStatus).toContain("⚠️");
    expect(await auditActions()).toContain("ical.sync.suspicious");
  });

  it("un flux réellement vidé par le canal annule bien, quand rien d'actif n'en dépend", async () => {
    const feed = await makeFeed();
    const empty = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
    const result = await syncFeed(db, feed, mockFetch(empty), NOW);
    expect(result.suspicious).toBe(false);
    expect(result.error).toBeNull();
  });

  it("compte les VEVENT illisibles au lieu de les ignorer en silence", async () => {
    const feed = await makeFeed();
    const partiel = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ok@airbnb.com",
      "DTSTART;VALUE=DATE:20261101",
      "DTEND;VALUE=DATE:20261108",
      "END:VEVENT",
      "BEGIN:VEVENT", // ni UID ni dates exploitables
      "SUMMARY:Corrompu",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = await syncFeed(db, feed, mockFetch(partiel), NOW);
    expect(result.malformed).toBe(1);
    expect((await getFeed(db, feed.id))?.lastStatus).toContain("illisible");
  });
});

describe("remise mal saisie — devis négatif", () => {
  const CHECKIN = addDays(todayInZone(), 60);

  const unit = {
    id: SCIERIE, name: "La Scierie", isComposite: false, components: [],
    capacityMax: 8, minNightsDefault: 1, cleaningFeeCents: 9000, baseNightCents: 15000,
  };

  it("une remise auto à 150 % est plafonnée : le total ne devient jamais négatif", () => {
    const quote = computeQuote({
      unit: unit as never,
      checkin: CHECKIN,
      checkout: addDays(CHECKIN, 4),
      adults: 2,
      children: 0,
      today: todayInZone(),
      seasons: [],
      rateRules: [],
      promotions: [
        {
          id: 1, kind: "long_stay", code: null, label: "Faute de frappe", active: true,
          discountPct: 150, discountCents: null, threshold: 2,
          validFrom: null, validUntil: null, maxUses: null, uses: 0,
        } as never,
      ],
      promoCode: null,
      optionsSelected: [],
      settings: {
        depositPct: 30, balanceDueDays: 30, touristTaxCentsPerPersonNight: 0,
        touristTaxIncludeChildren: false, cautionCents: 0,
      },
    });
    expect(quote.totalCents).toBeGreaterThanOrEqual(0);
    expect(quote.depositCents).toBeGreaterThanOrEqual(0);
    expect(quote.discountCents).toBeLessThanOrEqual(quote.accommodationCents);
  });

  it("l'API refuse d'enregistrer une remise hors bornes (0-100)", async () => {
    const bad = await adminCall("POST", "/api/admin/promotions?property=1", {
      kind: "long_stay", label: "Faute", discountPct: 150, threshold: 7,
    });
    expect(bad.status).toBe(400);

    const ok = await adminCall("POST", "/api/admin/promotions?property=1", {
      kind: "long_stay", label: "Longue durée", discountPct: 15, threshold: 7,
    });
    expect(ok.status).toBe(201);
  });
});

describe("exports CSV — injection de formule Excel", () => {
  it("un nom de client en « =HYPERLINK(…) » est neutralisé dans l'export", async () => {
    const from = addDays(todayInZone(), 250);
    const res = await router.handle(
      new Request("http://test.local/api/public/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unitId: SCIERIE, checkin: from, checkout: addDays(from, 3), adults: 2, children: 0,
          paymentMode: "deposit", cgvAccepted: true,
          guest: {
            firstName: "=HYPERLINK(\"http://mechant.tld\",\"Cliquez\")",
            lastName: "Dupont", email: "formule@example.com", phone: "+32 470 00 00 00",
          },
        }),
      }),
      env,
    );
    expect(res?.status).toBe(201);

    const csv = await adminCall("GET", "/api/admin/bookings.csv?property=1");
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("'=HYPERLINK");   // apostrophe de neutralisation
    expect(csv.text).not.toMatch(/(^|;|")=HYPERLINK/m);
  });
});

describe("Beds24 — garde-fou dev/prod et réponses partiellement refusées", () => {
  it("les écritures sont bloquées hors production, les lectures restent libres", async () => {
    const local = { ...env, BEDS24_REFRESH_TOKEN: "refresh_test" } as Env;
    expect(beds24WritesAllowed(local)).toBe(false);
    expect(beds24WritesAllowed({ ...local, PUBLIC_BASE_URL: "https://gites.example" })).toBe(true);
    expect(beds24WritesAllowed({ ...local, BEDS24_WRITE_ENABLED: "true" })).toBe(true);

    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await expect(
        beds24Fetch(local, "/inventory/rooms/calendar", { method: "POST", body: [] }),
      ).rejects.toThrow(/bloquée hors production/);
      expect(calls).toBe(0); // aucun appel réseau n'est parti vers le compte réel
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("un 200 contenant des éléments en échec est traité comme une erreur", async () => {
    const prod = {
      ...env, BEDS24_REFRESH_TOKEN: "refresh_test", PUBLIC_BASE_URL: "https://gites.example",
    } as Env;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/authentication/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: [{ success: true, roomId: 711713 }, { success: false, roomId: 711714, errors: "room not found" }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      await expect(
        beds24Fetch(prod, "/inventory/rooms/calendar", { method: "POST", body: [] }),
      ).rejects.toThrow(/refusé/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
