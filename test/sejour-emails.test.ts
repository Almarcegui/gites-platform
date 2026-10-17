// Mails automatiques du séjour (J-30, J-7, J-3, après) et relance d'échec de paiement.
// Les preuves attendues : rien sans l'interrupteur du domaine, rien pour les séjours
// importés ou venus d'un canal, une seule fois par échéance, la bonne échéance selon la
// date, la langue du client, et une relance de paiement seulement sur un échec récent
// sans nouvelle tentative.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { addDays, sqlNow, todayInZone } from "../src/core/dates";
import { updateSettings } from "../src/db/repo";
import { runScheduled } from "../src/services/cron";
import {
  PAYMENT_FAILED_KIND,
  runPaymentFailedReminders,
  runStayEmails,
  stayKindFor,
} from "../src/services/sejour-emails";

let t: TestDb;
let db: D1Database;
let env: Env;

const NOW = new Date("2026-08-10T09:00:00Z");
const TODAY = todayInZone(NOW);

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = { DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false" } as Env;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await updateSettings(db, 1, { stay_emails_enabled: "true", review_url: "", arrival_info_text: "Clés dans la boîte à code." });
});

interface StayOpts {
  checkin: string;
  nights?: number;
  source?: "direct" | "manual" | "ical" | "import";
  status?: "confirmed" | "cancelled" | "pending";
  email?: string | null;
  lang?: "fr" | "nl";
  paidCents?: number;
  unitId?: number;
}

async function stay(o: StayOpts): Promise<number> {
  let guestId: number | null = null;
  if (o.email !== null) {
    const g = await db
      .prepare("INSERT INTO guests (email, first_name, last_name, lang) VALUES (?1, 'Camille', 'Testeur', ?2)")
      .bind(o.email ?? `c${Math.random().toString(36).slice(2, 7)}@example.com`, o.lang ?? "fr")
      .run();
    guestId = g.meta.last_row_id;
  }
  const res = await db
    .prepare(
      `INSERT INTO bookings (unit_id, checkin, checkout, adults, children, status, source, reference,
                             total_cents, deposit_cents, paid_cents, guest_id)
       VALUES (?1, ?2, ?3, 2, 0, ?4, ?5, ?6, 90000, 45000, ?7, ?8)`,
    )
    .bind(
      o.unitId ?? 1, o.checkin, addDays(o.checkin, o.nights ?? 2), o.status ?? "confirmed", o.source ?? "direct",
      `PM-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, o.paidCents ?? 90000, guestId,
    )
    .run();
  return res.meta.last_row_id;
}

const mails = async (kind?: string) =>
  (
    await db
      .prepare(`SELECT * FROM email_log ${kind ? "WHERE kind = ?1" : ""} ORDER BY id`)
      .bind(...(kind ? [kind] : []))
      .all()
  ).results as Record<string, string | number>[];

describe("échéances", () => {
  it("fenêtres : J-30 de 30 à 14 jours, J-7 de 7 à 4, J-3 de 3 à 1, après de 1 à 7 jours après le départ", () => {
    const k = (inDays: number, nights = 2) => stayKindFor({ checkin: addDays(TODAY, inDays), checkout: addDays(TODAY, inDays + nights) }, TODAY);
    expect(k(31)).toBeNull();
    expect(k(30)).toBe("stay_j30");
    expect(k(14)).toBe("stay_j30");
    expect(k(13)).toBeNull();
    expect(k(7)).toBe("stay_j7");
    expect(k(4)).toBe("stay_j7");
    expect(k(3)).toBe("stay_j3");
    expect(k(1)).toBe("stay_j3");
    expect(k(0)).toBeNull(); // jour d'arrivée
    expect(k(-3, 2)).toBe("stay_after"); // parti hier
    expect(k(-9, 2)).toBe("stay_after"); // parti il y a 7 jours
    expect(k(-10, 2)).toBeNull();
  });
});

describe("runStayEmails", () => {
  it("interrupteur du domaine coupé : aucun mail", async () => {
    await updateSettings(db, 1, { stay_emails_enabled: "false" });
    await stay({ checkin: addDays(TODAY, 20) });
    expect(await runStayEmails(env, NOW)).toEqual({ queued: {} });
    expect(await mails()).toHaveLength(0);
  });

  it("une seule fois par échéance, en mode stub tant que l'envoi est coupé", async () => {
    const id = await stay({ checkin: addDays(TODAY, 20) });
    expect((await runStayEmails(env, NOW)).queued).toEqual({ stay_j30: 1 });
    expect((await runStayEmails(env, NOW)).queued).toEqual({});
    const log = await mails("stay_j30");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ booking_id: id, status: "stub" });
    expect(String(log[0]!.subject)).toMatch(/^\[PM-T-[A-Z0-9]+\] Votre séjour approche/);
    expect(String(log[0]!.body_text)).toContain("http://test.local/book/voucher.html?ref=");
  });

  it("J-7 : adresse, heures et infos d'arrivée du domaine ; le solde dû est rappelé", async () => {
    await stay({ checkin: addDays(TODAY, 6), paidCents: 45000 });
    await runStayEmails(env, NOW);
    const body = String((await mails("stay_j7"))[0]!.body_text);
    expect(body).toContain("Clés dans la boîte à code.");
    expect(body).toMatch(/Arrivée à partir de/);
    expect(body).toMatch(/Solde restant : 450,00 €/);
  });

  it("après le séjour : lien d'avis seulement s'il est réglé", async () => {
    await stay({ checkin: addDays(TODAY, -4), nights: 2 });
    await runStayEmails(env, NOW);
    expect(String((await mails("stay_after"))[0]!.body_text)).not.toMatch(/avis/);
    await db.prepare("DELETE FROM email_log").run();
    await updateSettings(db, 1, { review_url: "https://g.page/r/test/review" });
    await runStayEmails(env, NOW);
    expect(String((await mails("stay_after"))[0]!.body_text)).toContain("https://g.page/r/test/review");
  });

  it("jamais pour les séjours importés, iCal, annulés, en option ou sans adresse ; la vente au téléphone compte", async () => {
    const c = addDays(TODAY, 2);
    await stay({ checkin: c, source: "import" });
    await stay({ checkin: c, source: "ical", unitId: 2 });
    await stay({ checkin: addDays(TODAY, 5), status: "cancelled" });
    await stay({ checkin: addDays(TODAY, 5), status: "pending", unitId: 2 });
    await stay({ checkin: addDays(TODAY, 20), email: null });
    const phone = await stay({ checkin: addDays(TODAY, 22), source: "manual", unitId: 2 });
    expect((await runStayEmails(env, NOW)).queued).toEqual({ stay_j30: 1 });
    expect((await mails())[0]).toMatchObject({ booking_id: phone });
  });

  it("client néerlandophone : mail en néerlandais", async () => {
    await stay({ checkin: addDays(TODAY, 2), lang: "nl" });
    await runStayEmails(env, NOW);
    const m = (await mails("stay_j3"))[0]!;
    expect(String(m.subject)).toMatch(/Tot heel binnenkort/);
    expect(String(m.body_text)).toMatch(/Aankomst vanaf/);
  });

  it("le traitement planifié l'exécute et le journalise", async () => {
    await stay({ checkin: addDays(TODAY, 20) });
    await runScheduled(env, NOW, (async () => new Response("", { status: 404 })) as typeof fetch);
    expect(await mails("stay_j30")).toHaveLength(1);
    const row = await db.prepare("SELECT detail FROM audit_log WHERE action = 'stay.emails'").first<{ detail: string }>();
    expect(JSON.parse(row!.detail)).toMatchObject({ stay_j30: 1, payment_failed: 0 });
  });
});

describe("relance d'échec de paiement", () => {
  async function payment(bookingId: number, status: "failed" | "pending" | "succeeded", hoursAgo: number, kind = "balance") {
    await db
      .prepare("INSERT INTO payments (booking_id, kind, method, amount_cents, status, created_at) VALUES (?1, ?2, 'stripe', 45000, ?3, ?4)")
      .bind(bookingId, kind, status, sqlNow(new Date(NOW.getTime() - hoursAgo * 3_600_000)))
      .run();
  }

  it("échec récent du solde, sans nouvelle tentative : un mail, une seule fois", async () => {
    const id = await stay({ checkin: addDays(TODAY, 40), paidCents: 45000 });
    await payment(id, "failed", 3);
    expect(await runPaymentFailedReminders(env, NOW)).toBe(1);
    expect(await runPaymentFailedReminders(env, NOW)).toBe(0);
    const m = (await mails(PAYMENT_FAILED_KIND))[0]!;
    expect(String(m.subject)).toMatch(/Votre paiement n'a pas abouti/);
    expect(String(m.body_text)).toMatch(/Reste à régler : 450,00 €/);
  });

  it("pas de relance : nouvelle tentative en cours ou réussie, échec ancien, solde payé, arrhes d'une option", async () => {
    const retried = await stay({ checkin: addDays(TODAY, 40), paidCents: 45000 });
    await payment(retried, "failed", 5);
    await payment(retried, "pending", 1);
    const old = await stay({ checkin: addDays(TODAY, 45), paidCents: 45000, unitId: 2 });
    await payment(old, "failed", 72);
    const paid = await stay({ checkin: addDays(TODAY, 60) });
    await payment(paid, "failed", 2);
    const option = await stay({ checkin: addDays(TODAY, 70), status: "pending", paidCents: 0 });
    await payment(option, "failed", 2, "deposit");
    expect(await runPaymentFailedReminders(env, NOW)).toBe(0);
  });

  it("interrupteur coupé : pas de relance", async () => {
    await updateSettings(db, 1, { stay_emails_enabled: "false" });
    const id = await stay({ checkin: addDays(TODAY, 40), paidCents: 45000 });
    await payment(id, "failed", 3);
    expect(await runPaymentFailedReminders(env, NOW)).toBe(0);
  });
});
