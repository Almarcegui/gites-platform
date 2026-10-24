// Options à la date, côté base : partage entre maisons, course, libération, devis = montant.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import {
  cancelBooking, claimOptionDays, confirmBookingAtomic, updateBookingStayAtomic, createBookingAtomic, expireStaleHolds, getQuoteContext, takenOptionDays,
  type CreateBookingInput,
} from "../src/db/repo";
import { optionDayClaims, quoteFromContext, withOptionDaysCheck } from "../src/services/booking-flow";

const SCIEUR = 1;
const SCIERIE = 2;
const DOMAINE = 3;
const NOW = new Date("2026-06-01T12:00:00Z");
const TODAY = "2026-06-01";
// Jeudi 22 → dimanche 25 octobre 2026 (hors juillet-août).
const IN = "2026-10-22";
const OUT = "2026-10-25";

let t: TestDb;
let db: D1Database;
let saunaId = 0;
let bainId = 0;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  await db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'checkout_time', '10:00')").run();
  await db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'checkout_time_sunday', '18:00')").run();
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["option_days", "payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare("DELETE FROM options WHERE name IN ('Sauna test','Bain test')").run();
  saunaId = Number(
    (await db.prepare("INSERT INTO options (property_id, name, pricing_mode, price_cents, per_date, weekend_price_cents, consecutive_pct, active) VALUES (1, 'Sauna test', 'per_stay', 12000, 1, 18000, 70, 1)").run()).meta.last_row_id,
  );
  bainId = Number(
    (await db.prepare("INSERT INTO options (property_id, name, pricing_mode, price_cents, per_date, active) VALUES (1, 'Bain test', 'per_stay', 5000, 1, 1)").run()).meta.last_row_id,
  );
});

function input(unitId: number, checkin: string, checkout: string, over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return { unitId, checkin, checkout, adults: 2, children: 0, status: "confirmed", source: "manual", totalCents: 50000, depositCents: 15000, now: NOW, ...over };
}

async function quote(unitId: number, options: { id: number; qty: number; days?: string[] }[]) {
  const ctx = await getQuoteContext(db, unitId);
  return quoteFromContext(ctx!, { unitId, checkin: IN, checkout: OUT, adults: 2, children: 0, options }, TODAY);
}

describe("devis d'une option à la date", () => {
  it("la même option envoyée deux fois = une seule ligne, union des jours, remise sur les jours consécutifs", async () => {
    const q = await quote(SCIEUR, [
      { id: saunaId, qty: 1, days: ["2026-10-24"] },
      { id: saunaId, qty: 1, days: ["2026-10-25", "2026-10-24"] },
    ]);
    const lines = q.lines.filter((l) => l.kind === "option");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.days).toEqual(["2026-10-24", "2026-10-25"]);
    expect(lines[0]?.amountCents).toBe(18000 + 12600);
  });

  it("une ligne lisible, montant = somme des jours, devis = total", async () => {
    const base = await quote(SCIEUR, []);
    const q = await quote(SCIEUR, [{ id: saunaId, qty: 1, days: ["2026-10-24", "2026-10-25"] }]);
    expect(q.errors).toEqual([]);
    const line = q.lines.find((l) => l.kind === "option")!;
    expect(line.label).toBe("Sauna test — sam 24/10 (180 €), dim 25/10 (126 €)");
    expect(line.amountCents).toBe(30600);
    expect(line.optionId).toBe(saunaId);
    expect(q.totalCents - base.totalCents).toBe(30600);
  });
  it("un jour hors séjour est refusé", async () => {
    const q = await quote(SCIEUR, [{ id: saunaId, qty: 1, days: ["2026-10-26"] }]);
    expect(q.ok).toBe(false);
    expect(q.errors).toContain("option_days_invalid");
  });
  it("sans jour choisi, aucune ligne", async () => {
    const q = await quote(SCIEUR, [{ id: saunaId, qty: 1, days: [] }]);
    expect(q.lines.some((l) => l.kind === "option")).toBe(false);
  });
});

describe("partage entre les maisons", () => {
  async function book(unitId: number, days: string[], over: Partial<CreateBookingInput> = {}) {
    const q = await quote(unitId, [{ id: saunaId, qty: 1, days }]);
    const c = await createBookingAtomic(db, input(unitId, IN, OUT, over));
    if (!c.ok) throw new Error("création");
    const ok = await claimOptionDays(db, c.id, optionDayClaims(q), NOW.toISOString().slice(0, 19).replace("T", " "));
    return { id: c.id, ok };
  }

  it("un jour pris dans une maison est refusé dans l'autre et dans « Les deux maisons »", async () => {
    // Séjours en conflit de dates entre eux : on décale les séjours des autres unités.
    const a = await book(SCIEUR, ["2026-10-24"]);
    expect(a.ok).toBe(true);
    for (const u of [SCIERIE, DOMAINE]) {
      const q = await withOptionDaysCheck(db, await quote(u, [{ id: saunaId, qty: 1, days: ["2026-10-24"] }]));
      expect(q.errors).toContain("option_day_taken");
    }
    const libre = await withOptionDaysCheck(db, await quote(SCIERIE, [{ id: saunaId, qty: 1, days: ["2026-10-23"] }]));
    expect(libre.errors).not.toContain("option_day_taken");
  });

  it("le bain chaud et le sauna sont indépendants", async () => {
    await book(SCIEUR, ["2026-10-24"]);
    const q = await withOptionDaysCheck(db, await quote(SCIERIE, [{ id: bainId, qty: 1, days: ["2026-10-24"] }]));
    expect(q.errors).not.toContain("option_day_taken");
  });

  it("la réservation qu'on édite ne se bloque pas elle-même", async () => {
    const a = await book(SCIEUR, ["2026-10-24"]);
    const q = await withOptionDaysCheck(db, await quote(SCIEUR, [{ id: saunaId, qty: 1, days: ["2026-10-24"] }]), a.id);
    expect(q.errors).not.toContain("option_day_taken");
  });

  it("course : deux clients visent le même jour, un seul l'obtient", async () => {
    const c1 = await createBookingAtomic(db, input(SCIEUR, IN, OUT));
    const c2 = await createBookingAtomic(db, input(SCIERIE, IN, OUT));
    if (!c1.ok || !c2.ok) throw new Error("création");
    const claim = [{ optionId: saunaId, date: "2026-10-24" }];
    const res = await Promise.all([claimOptionDays(db, c1.id, claim), claimOptionDays(db, c2.id, claim)]);
    expect(res.filter(Boolean)).toHaveLength(1);
    const { results } = await db.prepare("SELECT booking_id FROM option_days").all();
    expect(results).toHaveLength(1);
  });

  it("l'annulation libère le jour", async () => {
    const a = await book(SCIEUR, ["2026-10-24"]);
    expect(await cancelBooking(db, a.id, "test")).toBe(true);
    const b = await book(SCIERIE, ["2026-10-24"]);
    expect(b.ok).toBe(true);
  });

  it("l'expiration d'une option de paiement libère le jour, même sans nettoyage", async () => {
    const q = await quote(SCIEUR, [{ id: saunaId, qty: 1, days: ["2026-10-24"] }]);
    const c = await createBookingAtomic(db, input(SCIEUR, IN, OUT, { status: "pending", holdMinutes: 30 }));
    if (!c.ok) throw new Error("création");
    await claimOptionDays(db, c.id, optionDayClaims(q), "2026-06-01 12:00:00");
    // Pendant le blocage : pris.
    const pris = await takenOptionDays(db, [saunaId], IN, OUT, null, "2026-06-01 12:10:00");
    expect(pris.get(saunaId)?.has("2026-10-24")).toBe(true);
    // Après : libre sans cron.
    const libre = await takenOptionDays(db, [saunaId], IN, OUT, null, "2026-06-01 13:00:00");
    expect(libre.get(saunaId)?.has("2026-10-24") ?? false).toBe(false);
    // Et un autre client peut le prendre malgré la ligne périmée.
    const c2 = await createBookingAtomic(db, input(SCIERIE, IN, OUT));
    if (!c2.ok) throw new Error("création");
    expect(await claimOptionDays(db, c2.id, [{ optionId: saunaId, date: "2026-10-24" }], "2026-06-01 13:00:00")).toBe(true);
    // Le cron nettoie.
    expect(await expireStaleHolds(db, "2026-06-01 14:00:00")).toBeGreaterThanOrEqual(0);
  });
});

describe("paiement tardif d'un hold expiré", () => {
  async function holdWithDay(unitId: number, day: string) {
    const q = await quote(unitId, [{ id: saunaId, qty: 1, days: [day] }]);
    const optionsJson = JSON.stringify(q.lines.filter((l) => l.kind === "option"));
    const c = await createBookingAtomic(db, input(unitId, IN, OUT, { status: "pending", holdMinutes: 30, optionsJson }));
    if (!c.ok) throw new Error("création");
    await claimOptionDays(db, c.id, optionDayClaims(q), "2026-06-01 12:00:00");
    return c.id;
  }

  it("le jour repris par un autre client empêche la confirmation (conflict), rien n'est confirmé", async () => {
    const d = await holdWithDay(SCIERIE, "2026-10-24");
    // le hold expire ; un autre client prend le jour et paie
    const e = await createBookingAtomic(db, input(SCIEUR, IN, OUT));
    if (!e.ok) throw new Error("création");
    expect(await claimOptionDays(db, e.id, [{ optionId: saunaId, date: "2026-10-24" }], "2026-06-01 13:00:00")).toBe(true);
    // le paiement de D arrive après
    expect(await confirmBookingAtomic(db, d, "2026-06-01 13:05:00")).toBe("conflict");
    const st = await db.prepare("SELECT status FROM bookings WHERE id = ?1").bind(d).first<{ status: string }>();
    expect(st?.status).toBe("pending");
    const { results } = await db.prepare("SELECT booking_id FROM option_days").all();
    expect(results.map((r: any) => r.booking_id)).toEqual([e.id]);
  });

  it("jour resté libre : la confirmation repose les jours purgés", async () => {
    const d = await holdWithDay(SCIERIE, "2026-10-24");
    await db.prepare("DELETE FROM option_days").run();
    expect(await confirmBookingAtomic(db, d, "2026-06-01 12:10:00")).toBe("confirmed");
    const { results } = await db.prepare("SELECT booking_id, date FROM option_days").all();
    expect(results).toEqual([{ booking_id: d, date: "2026-10-24" }]);
  });

  it("jours intacts : la confirmation passe sans erreur", async () => {
    const d = await holdWithDay(SCIERIE, "2026-10-24");
    expect(await confirmBookingAtomic(db, d, "2026-06-01 12:10:00")).toBe("confirmed");
  });
});

describe("modification d'un séjour : jours et mise à jour dans un seul lot", () => {
  const patch = (unitId: number, checkin: string, checkout: string) => ({
    unitId, checkin, checkout, adults: 2, children: 0, totalCents: 1000, depositCents: 500,
    balanceDueDate: null, quoteJson: "{}", optionsJson: "[]", promoCode: null,
  });
  async function confirmedWithDay(unitId: number, day: string) {
    const c = await createBookingAtomic(db, input(unitId, IN, OUT));
    if (!c.ok) throw new Error("création");
    await claimOptionDays(db, c.id, [{ optionId: saunaId, date: day }]);
    return c.id;
  }
  const daysOf = async (id: number) =>
    (await db.prepare("SELECT date FROM option_days WHERE booking_id = ?1").bind(id).all()).results.map((r: any) => r.date);

  it("jour pris par un autre : tout est refusé, ni les dates ni les anciens jours ne bougent", async () => {
    const a = await confirmedWithDay(SCIERIE, "2026-10-24");
    const b = await confirmedWithDay(SCIEUR, "2026-10-23");
    const r = await updateBookingStayAtomic(db, a, patch(SCIERIE, IN, OUT), undefined, [{ optionId: saunaId, date: "2026-10-23" }]);
    expect(r).toBe("option_day_taken");
    expect(await daysOf(a)).toEqual(["2026-10-24"]);
    expect(await daysOf(b)).toEqual(["2026-10-23"]);
  });

  it("dates en conflit : les jours ne sont pas touchés", async () => {
    const a = await confirmedWithDay(SCIERIE, "2026-10-24");
    await createBookingAtomic(db, input(SCIEUR, "2026-11-10", "2026-11-14"));
    // le domaine entier bloque les deux maisons : conflit avec la réservation du Scieur
    const r = await updateBookingStayAtomic(db, a, patch(3, "2026-11-10", "2026-11-14"), undefined, [{ optionId: saunaId, date: "2026-11-13" }]);
    expect(r).toBe("conflict");
    expect(await daysOf(a)).toEqual(["2026-10-24"]);
  });

  it("modification réussie : les jours suivent, un lot vide retire les jours", async () => {
    const a = await confirmedWithDay(SCIERIE, "2026-10-24");
    expect(await updateBookingStayAtomic(db, a, patch(SCIERIE, IN, OUT), undefined, [{ optionId: saunaId, date: "2026-10-23" }])).toBe("updated");
    expect(await daysOf(a)).toEqual(["2026-10-23"]);
    expect(await updateBookingStayAtomic(db, a, patch(SCIERIE, IN, OUT), undefined, [])).toBe("updated");
    expect(await daysOf(a)).toEqual([]);
  });
});
