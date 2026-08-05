// Tests de la couche D1 réelle (workerd/Miniflare + migrations + seed Pré Moré).
// Rejoue la matrice de liaison au niveau SQL et PROUVE l'anti-course :
// deux réservations simultanées en conflit → une seule passe.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import {
  addPayment,
  cancelBooking,
  confirmBookingAtomic,
  createBookingAtomic,
  expireStaleHolds,
  getBooking,
  getQuoteContext,
  getSettings,
  listLinks,
  listUnits,
  upsertGuest,
  type CreateBookingInput,
} from "../src/db/repo";

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
  // Repart d'une base propre (les données de référence du seed restent).
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

function input(unitId: number, checkin: string, checkout: string, over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    unitId, checkin, checkout,
    adults: 4, children: 0,
    status: "confirmed", source: "manual",
    totalCents: 50000, depositCents: 15000,
    now: NOW,
    ...over,
  };
}

describe("seed et contexte", () => {
  it("le seed Pré Moré est en place : 3 unités, 4 liens, réglages", async () => {
    const units = await listUnits(db, 1);
    expect(units.map((u) => u.slug)).toEqual(["maison-du-scieur", "la-scierie", "domaine-entier"]);
    expect(units[2]?.isComposite).toBe(true);
    const links = await listLinks(db, 1);
    expect(links).toHaveLength(4);
    const settings = await getSettings(db, 1);
    expect(settings.depositPct).toBe(30);
    expect(settings.balanceDueDays).toBe(30);
  });

  it("getQuoteContext assemble composantes, règles et promos du Domaine", async () => {
    const ctx = await getQuoteContext(db, DOMAINE);
    expect(ctx).not.toBeNull();
    expect(ctx!.pricingUnit.compositePricing).toBe("sum");
    expect(ctx!.pricingUnit.components.map((c) => c.id)).toEqual([SCIEUR, SCIERIE]);
    // règles des deux composantes présentes (2 unités × 3 règles du seed)
    expect(ctx!.rateRules.filter((r) => r.unitId === SCIEUR).length).toBeGreaterThan(0);
    expect(ctx!.rateRules.filter((r) => r.unitId === SCIERIE).length).toBeGreaterThan(0);
    expect(ctx!.promotions.length).toBe(3);
  });
});

describe("création atomique et références", () => {
  it("crée une réservation avec la référence PM-2026-001 puis 002, 003", async () => {
    const r1 = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.reference).toBe("PM-2026-001");
    const r2 = await createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12"));
    if (r2.ok) expect(r2.reference).toBe("PM-2026-002");
    const r3 = await createBookingAtomic(db, input(SCIERIE, "2026-09-01", "2026-09-03"));
    if (r3.ok) expect(r3.reference).toBe("PM-2026-003");
  });

  it("une annulation consomme quand même son numéro (jamais de réutilisation)", async () => {
    const r1 = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"));
    expect(r1.ok).toBe(true);
    if (r1.ok) await cancelBooking(db, r1.id, "test");
    const r2 = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.reference).toBe("PM-2026-002");
  });

  it("rejette les dates invalides", async () => {
    await expect(createBookingAtomic(db, input(SCIERIE, "2026-08-12", "2026-08-12"))).rejects.toThrow();
    await expect(createBookingAtomic(db, input(SCIERIE, "2026-08-32", "2026-09-02"))).rejects.toThrow();
  });
});

describe("matrice de liaison au niveau SQL", () => {
  it("résa Scieur → Domaine refusé, Scierie acceptée", async () => {
    expect((await createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12"))).ok).toBe(true);
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12"))).ok).toBe(false);
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"))).ok).toBe(true);
  });

  it("résa Domaine → les deux maisons refusées", async () => {
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12"))).ok).toBe(true);
    expect((await createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12"))).ok).toBe(false);
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"))).ok).toBe(false);
  });

  it("bornes : rotation le jour même acceptée, recouvrement refusé", async () => {
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"))).ok).toBe(true);
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-12", "2026-08-14"))).ok).toBe(true);
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-08", "2026-08-10"))).ok).toBe(true);
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-09", "2026-08-11"))).ok).toBe(false);
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-12", "2026-08-14"))).ok).toBe(false); // 12-14 pris par la 2e
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-14", "2026-08-16"))).ok).toBe(true);
  });

  it("annulation → libération immédiate, re-réservation possible", async () => {
    const r = await createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12"))).ok).toBe(false);
    expect(await cancelBooking(db, r.id, "client a annulé")).toBe(true);
    expect((await createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12"))).ok).toBe(true);
    const cancelled = await getBooking(db, r.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelReason).toBe("client a annulé");
  });
});

describe("holds (options de paiement)", () => {
  it("un hold pending actif bloque ; expiré, il ne bloque plus", async () => {
    const r = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12", { status: "pending", holdMinutes: 30 }));
    expect(r.ok).toBe(true);
    // 5 minutes plus tard : le hold court toujours → conflit
    const during = new Date(NOW.getTime() + 5 * 60_000);
    expect((await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12", { now: during }))).ok).toBe(false);
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12", { now: during }))).ok).toBe(false);
    // 40 minutes plus tard : hold expiré → la place se libère toute seule
    const after = new Date(NOW.getTime() + 40 * 60_000);
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12", { now: after }))).ok).toBe(true);
  });

  it("confirmBookingAtomic transforme le hold en réservation ferme", async () => {
    const r = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12", { status: "pending", holdMinutes: 30 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await confirmBookingAtomic(db, r.id)).toBe("confirmed");
    const b = await getBooking(db, r.id);
    expect(b?.status).toBe("confirmed");
    expect(b?.holdExpiresAt).toBeNull();
    // même très longtemps après, la résa confirmée bloque toujours
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    expect((await createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12", { now: later }))).ok).toBe(false);
  });

  it("expireStaleHolds annule uniquement les holds périmés", async () => {
    const a = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12", { status: "pending", holdMinutes: 30 }));
    const b = await createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12", { status: "pending", holdMinutes: 120 }));
    expect(a.ok && b.ok).toBe(true);
    const at = "2026-06-01 13:00:00"; // NOW + 60 min : a expiré, b court encore
    expect(await expireStaleHolds(db, at)).toBe(1);
    if (a.ok) expect((await getBooking(db, a.id))?.status).toBe("cancelled");
    if (b.ok) expect((await getBooking(db, b.id))?.status).toBe("pending");
  });
});

describe("COURSES — réservations simultanées", () => {
  it("Scieur et Domaine demandés en même temps sur les mêmes dates → un seul gagnant", async () => {
    const [a, b] = await Promise.all([
      createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12")),
      createBookingAtomic(db, input(DOMAINE, "2026-08-10", "2026-08-12")),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const { results } = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").all();
    expect((results[0] as { n: number }).n).toBe(1);
  });

  it("5 clients simultanés sur la même unité → exactement 1 réservation", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12"))),
    );
    expect(attempts.filter((r) => r.ok)).toHaveLength(1);
  });

  it("les deux maisons demandées en même temps → les DEUX passent (pas de faux positif)", async () => {
    const [a, b] = await Promise.all([
      createBookingAtomic(db, input(SCIEUR, "2026-08-10", "2026-08-12")),
      createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12")),
    ]);
    expect(a.ok && b.ok).toBe(true);
    // et leurs références sont uniques
    if (a.ok && b.ok) expect(a.reference).not.toBe(b.reference);
  });

  it("rafale mixte : 8 tentatives concurrentes sur A, B et Domaine (mêmes dates)", async () => {
    const targets = [SCIEUR, SCIERIE, DOMAINE, SCIEUR, SCIERIE, DOMAINE, DOMAINE, SCIEUR];
    const results = await Promise.all(
      targets.map((u) => createBookingAtomic(db, input(u, "2026-08-10", "2026-08-12"))),
    );
    const winners = results
      .map((r, i) => ({ r, unit: targets[i] }))
      .filter((x) => x.r.ok)
      .map((x) => x.unit);
    // Issues légales : {Domaine seul} ou {Scieur, Scierie} ou {Scieur} ou {Scierie}
    // — jamais Domaine + une maison, jamais deux fois la même unité.
    const hasDomaine = winners.includes(DOMAINE);
    if (hasDomaine) {
      expect(winners).toEqual([DOMAINE]);
    } else {
      expect(winners.filter((u) => u === SCIEUR).length).toBeLessThanOrEqual(1);
      expect(winners.filter((u) => u === SCIERIE).length).toBeLessThanOrEqual(1);
      expect(winners.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("clients et paiements", () => {
  it("upsertGuest dédoublonne par email (insensible à la casse)", async () => {
    const id1 = await upsertGuest(db, { email: "Jean@Example.com", lastName: "Dupont", firstName: "Jean" });
    const id2 = await upsertGuest(db, { email: "jean@example.com", lastName: "Dupont", phone: "+32470000000" });
    expect(id2).toBe(id1);
    const id3 = await upsertGuest(db, { lastName: "Anonyme" }); // sans email → nouveau
    expect(id3).not.toBe(id1);
  });

  it("addPayment met à jour paid_cents ; un échec ne compte pas", async () => {
    const r = await createBookingAtomic(db, input(SCIERIE, "2026-08-10", "2026-08-12", { totalCents: 50000, depositCents: 15000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await addPayment(db, { bookingId: r.id, kind: "deposit", method: "stripe", amountCents: 15000, status: "succeeded" });
    expect((await getBooking(db, r.id))?.paidCents).toBe(15000);
    await addPayment(db, { bookingId: r.id, kind: "balance", method: "stripe", amountCents: 35000, status: "failed" });
    expect((await getBooking(db, r.id))?.paidCents).toBe(15000);
    await addPayment(db, { bookingId: r.id, kind: "balance", method: "transfer", amountCents: 35000, status: "succeeded" });
    expect((await getBooking(db, r.id))?.paidCents).toBe(50000);
  });
});
