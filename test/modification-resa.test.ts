// Modifier une réservation sans annuler-recréer (issue #73).
//
// Le geste le plus fréquent au téléphone — « on décale d'une semaine », « on
// prend finalement l'autre maison » — imposait d'annuler puis de recréer : les
// paiements reçus et la preuve d'acceptation des CGV partaient avec.
//
// Ce que ces tests protègent :
//   1. la vérification de disponibilité reste ATOMIQUE : l'ancien créneau est
//      libéré et le nouveau pris par la même instruction, sous le même
//      garde-fou que la création (liaisons et blocages manuels compris) ;
//   2. un refus ne laisse AUCUNE trace : la réservation d'origine est intacte ;
//   3. paiements, `paid_cents`, `cgv_version` et la référence survivent à la
//      modification ;
//   4. l'écart de prix devient un solde à encaisser ou un avoir à rembourser,
//      jamais un remboursement automatique.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import {
  addPayment,
  createBookingAtomic,
  createManualBlockAtomic,
  getBooking,
  listAuditByEntity,
  listPayments,
  recordCgvAcceptance,
  updateBookingStayAtomic,
  upsertGuest,
  type BookingStayPatch,
  type CreateBookingInput,
} from "../src/db/repo";

const SCIEUR = 1;
const SCIERIE = 2;
const DOMAINE = 3;

const NOW = new Date("2026-06-01T12:00:00Z");
const ADMIN = "test-admin-token";

// Séjour ~120 j dans le futur : satisfait les min-nuits du seed quelle que
// soit la saison où il tombe (même convention que test/api.test.ts).
const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);

let t: TestDb;
let db: D1Database;
let env: Env;

const router = new Router();
registerAdminRoutes(router);

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

function stay(unitId: number, checkin: string, checkout: string, over: Partial<BookingStayPatch> = {}): BookingStayPatch {
  return {
    unitId, checkin, checkout,
    adults: 2, children: 0,
    totalCents: 50000, depositCents: 15000,
    balanceDueDate: null, quoteJson: null, optionsJson: null, promoCode: null,
    ...over,
  };
}

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

// ---------------------------------------------------------------------------
// L'instruction atomique
// ---------------------------------------------------------------------------

describe("modification de séjour — atomicité (SQL)", () => {
  it("déplacer les dates libère l'ancien créneau dans la même instruction", async () => {
    const r = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await updateBookingStayAtomic(db, r.id, stay(SCIERIE, "2026-08-20", "2026-08-24"))).toBe("updated");
    // l'ancien créneau est vendable, le nouveau ne l'est plus
    expect((await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"))).ok).toBe(true);
    expect((await createBookingAtomic(db, booking(SCIERIE, "2026-08-20", "2026-08-24"))).ok).toBe(false);
  });

  it("changer de logement libère l'ancien et prend le nouveau, liaisons comprises", async () => {
    const r = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await updateBookingStayAtomic(db, r.id, stay(SCIEUR, "2026-08-10", "2026-08-14"))).toBe("updated");
    const after = await getBooking(db, r.id);
    expect(after?.unitId).toBe(SCIEUR);
    // La Scierie est libre, La Maison du Scieur ne l'est plus, le Domaine reste fermé
    expect((await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"))).ok).toBe(true);
    expect((await createBookingAtomic(db, booking(DOMAINE, "2026-08-10", "2026-08-14"))).ok).toBe(false);
  });

  it("prolonger d'une nuit ne se heurte pas à sa propre occupation", async () => {
    const r = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await updateBookingStayAtomic(db, r.id, stay(SCIERIE, "2026-08-10", "2026-08-15"))).toBe("updated");
    expect((await getBooking(db, r.id))?.checkout).toBe("2026-08-15");
  });

  it("un créneau pris refuse la modification et LAISSE la réservation intacte", async () => {
    const mine = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    const other = await createBookingAtomic(db, booking(SCIEUR, "2026-09-01", "2026-09-05"));
    expect(mine.ok && other.ok).toBe(true);
    if (!mine.ok) return;

    expect(await updateBookingStayAtomic(db, mine.id, stay(SCIEUR, "2026-09-02", "2026-09-04"))).toBe("conflict");
    const after = await getBooking(db, mine.id);
    expect(after?.unitId).toBe(SCIERIE);
    expect(after?.checkin).toBe("2026-08-10");
    expect(after?.checkout).toBe("2026-08-14");
    expect(after?.totalCents).toBe(50000);
  });

  it("la liaison ferme aussi la destination : Domaine refusé si une maison est prise", async () => {
    const mine = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    const other = await createBookingAtomic(db, booking(SCIEUR, "2026-09-01", "2026-09-05"));
    expect(mine.ok && other.ok).toBe(true);
    if (!mine.ok) return;
    expect(await updateBookingStayAtomic(db, mine.id, stay(DOMAINE, "2026-09-02", "2026-09-04"))).toBe("conflict");
  });

  it("un blocage manuel refuse la destination, comme une réservation (#74)", async () => {
    const mine = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const posed = await createManualBlockAtomic(db, {
      unitId: SCIEUR, checkin: "2026-09-01", checkout: "2026-09-05", reason: "travaux", createdBy: "julien", now: NOW,
    });
    expect(posed.ok).toBe(true);
    expect(await updateBookingStayAtomic(db, mine.id, stay(SCIEUR, "2026-09-02", "2026-09-04"))).toBe("conflict");
    expect((await getBooking(db, mine.id))?.unitId).toBe(SCIERIE);
  });

  it("une option de paiement expirée ne se déplace plus", async () => {
    const r = await createBookingAtomic(
      db,
      booking(SCIERIE, "2026-08-10", "2026-08-14", { status: "pending", holdMinutes: 30 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // tant que l'option court, la modification passe
    expect(await updateBookingStayAtomic(db, r.id, stay(SCIERIE, "2026-08-11", "2026-08-15"), "2026-06-01 12:10:00")).toBe("updated");
    // une fois l'option morte, la réservation n'occupe plus rien : la déplacer
    // donnerait l'illusion d'un créneau tenu
    expect(await updateBookingStayAtomic(db, r.id, stay(SCIERIE, "2026-08-20", "2026-08-24"), "2026-06-01 13:00:00")).toBe("not_modifiable");
    expect((await getBooking(db, r.id))?.checkin).toBe("2026-08-11");
  });

  it("une réservation annulée ne se modifie plus", async () => {
    const r = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(r.id).run();
    expect(await updateBookingStayAtomic(db, r.id, stay(SCIERIE, "2026-08-20", "2026-08-24"))).toBe("not_modifiable");
  });
});

describe("COURSES — deux modifications vers le même créneau", () => {
  it("deux réservations déplacées en même temps vers le même créneau → une seule passe", async () => {
    const a = await createBookingAtomic(db, booking(SCIERIE, "2026-08-01", "2026-08-03"));
    const b = await createBookingAtomic(db, booking(SCIEUR, "2026-08-01", "2026-08-03"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const [ra, rb] = await Promise.all([
      updateBookingStayAtomic(db, a.id, stay(SCIERIE, "2026-10-10", "2026-10-14")),
      updateBookingStayAtomic(db, b.id, stay(DOMAINE, "2026-10-10", "2026-10-14")),
    ]);
    expect([ra, rb].filter((r) => r === "updated")).toHaveLength(1);
    // la perdante n'a pas bougé
    const loser = ra === "updated" ? await getBooking(db, b.id) : await getBooking(db, a.id);
    expect(loser?.checkin).toBe("2026-08-01");
  });

  it("modification et réservation neuve simultanées sur le même créneau → un seul gagnant", async () => {
    const mine = await createBookingAtomic(db, booking(SCIERIE, "2026-08-01", "2026-08-03"));
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const [moved, created] = await Promise.all([
      updateBookingStayAtomic(db, mine.id, stay(SCIERIE, "2026-10-10", "2026-10-14")),
      createBookingAtomic(db, booking(DOMAINE, "2026-10-10", "2026-10-14")),
    ]);
    expect([moved === "updated", created.ok].filter(Boolean)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ce qui doit SURVIVRE à la modification
// ---------------------------------------------------------------------------

describe("modification — ce qui est conservé", () => {
  it("paiements, paid_cents, cgv_version et référence survivent au changement de dates", async () => {
    const guestId = await upsertGuest(db, { email: "alex@example.invalid", lastName: "Testeur", firstName: "Alex" });
    const r = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14", { guestId }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await recordCgvAcceptance(db, r.id, { version: "cgv-2026-01", ip: "203.0.113.7" });
    await addPayment(db, {
      bookingId: r.id, kind: "deposit", method: "transfer", amountCents: 15000, status: "succeeded", receivedAt: "2026-06-01 12:00:00",
    });

    const before = await getBooking(db, r.id);
    expect(before?.paidCents).toBe(15000);

    expect(await updateBookingStayAtomic(db, r.id, stay(SCIERIE, "2026-08-20", "2026-08-25", { totalCents: 62000 }))).toBe("updated");

    const after = await getBooking(db, r.id);
    expect(after?.reference).toBe(before?.reference);
    expect(after?.guestId).toBe(guestId);
    expect(after?.status).toBe("confirmed");
    expect(after?.paidCents).toBe(15000);
    expect(after?.totalCents).toBe(62000);
    expect(await listPayments(db, { bookingId: r.id })).toHaveLength(1);

    const proof = await db
      .prepare("SELECT cgv_version, cgv_accepted_at, cgv_ip FROM bookings WHERE id = ?1")
      .bind(r.id)
      .first<{ cgv_version: string; cgv_accepted_at: string; cgv_ip: string }>();
    expect(proof?.cgv_version).toBe("cgv-2026-01");
    expect(proof?.cgv_ip).toBe("203.0.113.7");
    expect(proof?.cgv_accepted_at).toBeTruthy();
  });

  it("un refus ne touche à rien : ni dates, ni paiements", async () => {
    const r = await createBookingAtomic(db, booking(SCIERIE, "2026-08-10", "2026-08-14"));
    const blocker = await createBookingAtomic(db, booking(SCIEUR, "2026-09-01", "2026-09-05"));
    expect(r.ok && blocker.ok).toBe(true);
    if (!r.ok) return;
    await addPayment(db, { bookingId: r.id, kind: "deposit", method: "transfer", amountCents: 15000, status: "succeeded" });

    expect(await updateBookingStayAtomic(db, r.id, stay(SCIEUR, "2026-09-02", "2026-09-04", { totalCents: 99000 }))).toBe("conflict");
    const after = await getBooking(db, r.id);
    expect(after?.checkin).toBe("2026-08-10");
    expect(after?.totalCents).toBe(50000);
    expect(after?.paidCents).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// La route PATCH
// ---------------------------------------------------------------------------

describe("API — PATCH /api/admin/bookings/:id", () => {
  async function sell(unitId: number, checkin = CHECKIN, checkout = CHECKOUT): Promise<Record<string, unknown>> {
    const res = await call("POST", "/api/admin/bookings", {
      unitId, checkin, checkout, adults: 2, children: 0,
      guest: { firstName: "Alex", lastName: "Testeur", email: "alex@example.invalid" },
      confirmNow: true,
    });
    expect(res.status).toBe(201);
    return res.data.booking as Record<string, unknown>;
  }

  it("décale les dates, recalcule le devis et conserve le déjà-payé", async () => {
    const b = await sell(SCIERIE);
    const id = Number(b.id);
    await call("POST", `/api/admin/bookings/${id}/payments`, { kind: "deposit", method: "transfer", amountCents: 10000 });

    const newIn = addDays(CHECKIN, 14);
    const res = await call("PATCH", `/api/admin/bookings/${id}`, { checkin: newIn, checkout: addDays(newIn, 7) });
    expect(res.status).toBe(200);
    const after = res.data.booking as Record<string, unknown>;
    expect(after.checkin).toBe(newIn);
    expect(after.paidCents).toBe(10000);
    expect(after.reference).toBe(b.reference);
    expect(res.data.quote).toBeTruthy();
    // solde à encaisser OU avoir : jamais les deux, jamais un remboursement auto
    expect(Number(res.data.balanceCents) === 0 || Number(res.data.refundCents) === 0).toBe(true);
    expect(await listPayments(db, { bookingId: id })).toHaveLength(1);
  });

  it("refuse un créneau pris en nommant le conflit, sans rien modifier", async () => {
    const mine = await sell(SCIERIE);
    const otherIn = addDays(CHECKIN, 30);
    await sell(SCIEUR, otherIn, addDays(otherIn, 7));

    const res = await call("PATCH", `/api/admin/bookings/${Number(mine.id)}`, {
      unitId: DOMAINE, checkin: otherIn, checkout: addDays(otherIn, 7),
    });
    expect(res.status).toBe(409);
    expect((res.data.conflicts as { reference: string }[]).length).toBeGreaterThan(0);

    const intact = await getBooking(db, Number(mine.id));
    expect(intact?.unitId).toBe(SCIERIE);
    expect(intact?.checkin).toBe(CHECKIN);
  });

  it("journalise la modification avec son auteur et l'avant/après", async () => {
    const b = await sell(SCIERIE);
    const id = Number(b.id);
    await call("PATCH", `/api/admin/bookings/${id}`, { unitId: SCIEUR });

    const history = await listAuditByEntity(db, `booking:${id}`);
    const entry = history.find((h) => h.action === "booking.modify");
    expect(entry).toBeTruthy();
    const detail = JSON.parse(entry!.detail ?? "{}") as {
      par: string;
      avant: { unitId: number };
      apres: { unitId: number };
    };
    expect(detail.par).toBeTruthy();
    expect(detail.avant.unitId).toBe(SCIERIE);
    expect(detail.apres.unitId).toBe(SCIEUR);
  });

  it("corrige les coordonnées du client sans toucher au séjour", async () => {
    const b = await sell(SCIERIE);
    const id = Number(b.id);
    const res = await call("PATCH", `/api/admin/bookings/${id}`, {
      guest: { firstName: "Alexandra", lastName: "Testeur", email: "alexandra@example.invalid" },
    });
    expect(res.status).toBe(200);
    const after = res.data.booking as Record<string, unknown>;
    expect(after.guestName).toBe("Alexandra Testeur");
    expect(after.guestEmail).toBe("alexandra@example.invalid");
    expect(after.checkin).toBe(CHECKIN);
  });

  it("le devis de modification ne se heurte pas à la réservation elle-même", async () => {
    const b = await sell(SCIERIE);
    const res = await call("POST", "/api/admin/quote", {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0, bookingId: Number(b.id),
    });
    expect(res.status).toBe(200);
    expect((res.data.availability as { available: boolean }).available).toBe(true);
    // sans bookingId, elle se bloque bien elle-même
    const naive = await call("POST", "/api/admin/quote", {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
    });
    expect((naive.data.availability as { available: boolean }).available).toBe(false);
  });

  it("garde la compatibilité : un PATCH de notes seules fonctionne toujours", async () => {
    const b = await sell(SCIERIE);
    const id = Number(b.id);
    const res = await call("PATCH", `/api/admin/bookings/${id}`, { internalNotes: "rappeler lundi" });
    expect(res.status).toBe(200);
    expect((await getBooking(db, id))?.internalNotes).toBe("rappeler lundi");
    // et un corps vide est refusé plutôt qu'ignoré en silence
    expect((await call("PATCH", `/api/admin/bookings/${id}`, {})).status).toBe(400);
  });

  it("refuse une capacité dépassée et des dates inversées", async () => {
    const b = await sell(SCIERIE);
    const id = Number(b.id);
    expect((await call("PATCH", `/api/admin/bookings/${id}`, { adults: 99 })).status).toBe(409);
    expect((await call("PATCH", `/api/admin/bookings/${id}`, { checkin: CHECKOUT, checkout: CHECKIN })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/bookings/999999", { adults: 3 })).status).toBe(404);
  });

  it("les options de la réservation survivent au recalcul du devis", async () => {
    // Sauna (1, per_stay 35 €) + bois de chauffage (3, per_unit_qty 15 €/stère).
    const res = await call("POST", "/api/admin/bookings", {
      unitId: SCIERIE, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      options: [{ id: 1, qty: 1 }, { id: 3, qty: 2 }],
      guest: { firstName: "Alex", lastName: "Testeur", email: "alex@example.invalid" },
      confirmNow: true,
    });
    expect(res.status).toBe(201);
    const created = res.data.booking as { id: number; totalCents: number; optionsJson: string };
    const optionLines = JSON.parse(created.optionsJson) as { label: string; amountCents: number }[];
    expect(optionLines).toHaveLength(2);
    const optionsTotal = optionLines.reduce((sum, l) => sum + l.amountCents, 0);
    expect(optionsTotal).toBe(3500 + 2 * 1500);

    // On ne renvoie PAS les options : elles doivent être reconduites, pas effacées.
    const newIn = addDays(CHECKIN, 21);
    const patched = await call("PATCH", `/api/admin/bookings/${created.id}`, {
      checkin: newIn, checkout: addDays(newIn, 7),
    });
    expect(patched.status).toBe(200);
    const after = patched.data.booking as { optionsJson: string };
    const afterLines = JSON.parse(after.optionsJson) as { label: string; amountCents: number }[];
    expect(afterLines).toHaveLength(2);
    expect(afterLines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(optionsTotal);
    // et donc aucun faux avoir à rembourser
    expect(Number(patched.data.refundCents)).toBe(0);
  });

  it("un nombre de voyageurs illisible ne contourne pas le contrôle de capacité", async () => {
    const b = await sell(SCIERIE);
    const id = Number(b.id);
    // `Number("abc")` vaut NaN, et NaN > capacité est FAUX : sans garde-fou,
    // la capacité n'était pas vérifiée et NaN partait en base.
    const res = await call("PATCH", `/api/admin/bookings/${id}`, { adults: "abc" });
    expect(res.status).toBe(200);
    const after = await getBooking(db, id);
    expect(after?.adults).toBe(2);
    expect((await call("PATCH", `/api/admin/bookings/${id}`, { adults: "99" })).status).toBe(409);
  });

  it("la garde admin protège la route", async () => {
    const req = new Request("http://test.local/api/admin/bookings/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ internalNotes: "x" }),
    });
    expect((await router.handle(req, env))!.status).toBe(401);
  });
});
