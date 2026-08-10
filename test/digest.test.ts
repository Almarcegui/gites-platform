// Issue #27 — résumé quotidien au propriétaire.
//
// Deux exigences se vérifient ici : le contenu sur un jeu de données connu
// (arrivées, annulations, alertes), et l'absence de doublon quand le cron
// repasse dans la même heure.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import {
  DIGEST_LAST_SENT_KEY,
  DIGEST_RECIPIENTS_KEY,
  collectDigest,
  hourInBrussels,
  renderDigest,
  runDailyDigest,
} from "../src/services/digest";
import { getSetting, setSetting } from "../src/services/settings";
import { addPayment, cancelBooking, createBookingAtomic, upsertGuest } from "../src/db/repo";
import { addDays } from "../src/core/dates";

const SCIEUR = 1;
const SCIERIE = 2;

// 10 août 2026, 7 h 05 à Bruxelles = 5 h 05 UTC (heure d'été).
const MATIN = new Date("2026-08-10T05:05:00Z");
const AUJOURDHUI = "2026-08-10";

let t: TestDb;
let db: D1Database;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false", // journalisation seule — le verrou reste en place
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests", "app_settings", "ical_feeds"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function reserver(opts: {
  unitId: number;
  checkin: string;
  checkout: string;
  nom?: string;
  totalCents?: number;
  status?: "pending" | "confirmed";
  balanceDueDate?: string | null;
  createdAt?: Date;
}) {
  const guestId = opts.nom
    ? await upsertGuest(db, { firstName: opts.nom.split(" ")[0] ?? "", lastName: opts.nom.split(" ")[1] ?? "", email: `${opts.nom.replace(/\s/g, ".").toLowerCase()}@exemple.be` })
    : null;
  const res = await createBookingAtomic(db, {
    unitId: opts.unitId,
    checkin: opts.checkin,
    checkout: opts.checkout,
    adults: 2,
    children: 1,
    status: opts.status ?? "confirmed",
    source: "direct",
    guestId,
    totalCents: opts.totalCents ?? 100000,
    balanceDueDate: opts.balanceDueDate ?? null,
    now: opts.createdAt ?? MATIN,
  });
  if (!res.ok) throw new Error("réservation refusée par le moteur de disponibilité");
  return res;
}

describe("créneau d'envoi", () => {
  it("lit l'heure dans le fuseau de Bruxelles, pas en UTC", () => {
    expect(hourInBrussels(new Date("2026-08-10T05:05:00Z"))).toBe(7); // été : UTC+2
    expect(hourInBrussels(new Date("2026-01-10T06:05:00Z"))).toBe(7); // hiver : UTC+1
  });

  it("ne fait rien en dehors du créneau du matin", async () => {
    await setSetting(db, DIGEST_RECIPIENTS_KEY, "julien@exemple.be");
    expect(await runDailyDigest(env, new Date("2026-08-10T12:00:00Z"))).toBe("hors-creneau");
    const logs = await db.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>();
    expect(logs?.n).toBe(0);
  });
});

describe("contenu du résumé", () => {
  it("reprend les arrivées, départs, nouvelles réservations et annulations", async () => {
    await reserver({ unitId: SCIEUR, checkin: AUJOURDHUI, checkout: addDays(AUJOURDHUI, 3), nom: "Marie Dupont" });
    await reserver({ unitId: SCIERIE, checkin: addDays(AUJOURDHUI, -4), checkout: AUJOURDHUI, nom: "Paul Martin" });
    const annulee = await reserver({
      unitId: SCIERIE,
      checkin: addDays(AUJOURDHUI, 20),
      checkout: addDays(AUJOURDHUI, 23),
      nom: "Sophie Leroy",
    });
    await cancelBooking(db, annulee.id, "désistement", "2026-08-10 04:00:00");

    const data = await collectDigest(db, MATIN);
    const { subject, bodyText } = renderDigest(data);

    expect(subject).toContain("10/08/2026");
    expect(bodyText).toContain("Arrivées aujourd'hui");
    expect(bodyText).toContain("Marie Dupont");
    expect(bodyText).toContain("Départs aujourd'hui");
    expect(bodyText).toContain("Paul Martin");
    expect(bodyText).toContain("Annulations (dernières 24 h)");
    expect(bodyText).toContain("Sophie Leroy");
    expect(data.quiet).toBe(false);
  });

  it("annonce les encaissements et les soldes en retard", async () => {
    const b = await reserver({
      unitId: SCIEUR,
      checkin: addDays(AUJOURDHUI, 30),
      checkout: addDays(AUJOURDHUI, 33),
      nom: "Luc Bernard",
      totalCents: 120000,
      balanceDueDate: addDays(AUJOURDHUI, -2), // échéance dépassée
    });
    await addPayment(db, {
      bookingId: b.id,
      kind: "deposit",
      method: "stripe",
      amountCents: 30000,
      status: "succeeded",
      receivedAt: "2026-08-10 04:30:00",
    });

    const { bodyText } = renderDigest(await collectDigest(db, MATIN));
    expect(bodyText).toContain("Encaissements (dernières 24 h) : 300,00 €");
    expect(bodyText).toContain("Soldes en retard");
    expect(bodyText).toContain("900,00 €");
  });

  it("traduit les signaux de la carte Santé en phrases sans jargon", async () => {
    // Un paiement encaissé sur une réservation jamais confirmée : le client a
    // payé et n'a pas son séjour.
    const b = await reserver({
      unitId: SCIERIE,
      checkin: addDays(AUJOURDHUI, 40),
      checkout: addDays(AUJOURDHUI, 42),
      nom: "Anne Petit",
      status: "pending",
    });
    await addPayment(db, { bookingId: b.id, kind: "full", method: "stripe", amountCents: 50000, status: "succeeded" });

    const { subject, bodyText } = renderDigest(await collectDigest(db, MATIN));
    expect(bodyText).toContain("À regarder");
    expect(bodyText).toContain("Le client a payé et n'a pas sa réservation");
    expect(subject).toContain("points à regarder");
    // Aucun terme technique ne doit fuir dans le message.
    for (const jargon of ["orphanPayments", "healthSignals", "audit_log", "D1", "cron", "null", "undefined"]) {
      expect(bodyText).not.toContain(jargon);
    }
  });

  it("signale un calendrier externe qui ne se met plus à jour", async () => {
    await db
      .prepare("INSERT INTO ical_feeds (unit_id, name, url, active, last_status) VALUES (?1, 'Airbnb Scierie', 'https://x.invalide/f.ics', 1, 'erreur : HTTP 403')")
      .bind(SCIERIE)
      .run();
    const { bodyText } = renderDigest(await collectDigest(db, MATIN));
    expect(bodyText).toContain("Le calendrier « Airbnb Scierie » ne se met plus à jour");
  });

  it("dit en une ligne que tout va bien quand il n'y a rien à signaler", async () => {
    const data = await collectDigest(db, MATIN);
    expect(data.quiet).toBe(true);
    const { subject, bodyText } = renderDigest(data);
    expect(bodyText).toContain("Rien à signaler : tout fonctionne normalement.");
    expect(bodyText).toContain("Journée calme");
    expect(subject).not.toContain("points à regarder");
  });
});

describe("envoi", () => {
  it("journalise le résumé sans l'envoyer tant que les e-mails sont désactivés", async () => {
    await setSetting(db, DIGEST_RECIPIENTS_KEY, "julien@exemple.be");
    expect(await runDailyDigest(env, MATIN)).toBe("envoye");

    const row = await db.prepare("SELECT to_email, kind, status FROM email_log").first<{ to_email: string; kind: string; status: string }>();
    expect(row?.to_email).toBe("julien@exemple.be");
    expect(row?.kind).toBe("daily_digest");
    expect(row?.status).toBe("stub"); // journalisé, pas envoyé — verrou intact
  });

  it("n'envoie pas deux fois le même jour, même si le cron repasse", async () => {
    await setSetting(db, DIGEST_RECIPIENTS_KEY, "julien@exemple.be");
    expect(await runDailyDigest(env, MATIN)).toBe("envoye");
    expect(await runDailyDigest(env, new Date("2026-08-10T05:20:00Z"))).toBe("deja-envoye");
    expect(await runDailyDigest(env, new Date("2026-08-10T05:50:00Z"))).toBe("deja-envoye");

    const count = await db.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("repart le lendemain", async () => {
    await setSetting(db, DIGEST_RECIPIENTS_KEY, "julien@exemple.be");
    await runDailyDigest(env, MATIN);
    expect(await runDailyDigest(env, new Date("2026-08-11T05:05:00Z"))).toBe("envoye");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("accepte plusieurs destinataires", async () => {
    await setSetting(db, DIGEST_RECIPIENTS_KEY, "julien@exemple.be, cristina@exemple.be");
    expect(await runDailyDigest(env, MATIN)).toBe("envoye");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("ne part pas — et le dit — quand aucun destinataire n'est configuré", async () => {
    expect(await runDailyDigest(env, MATIN)).toBe("sans-destinataire");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>();
    expect(count?.n).toBe(0);
    const trace = await db.prepare("SELECT action FROM audit_log WHERE action = 'digest.sans_destinataire'").first();
    expect(trace).not.toBeNull();
    // Marqué comme traité : une seule ligne de journal par jour, pas quatre.
    expect(await getSetting(db, DIGEST_LAST_SENT_KEY)).toBe(AUJOURDHUI);
  });

  it("ignore une valeur de destinataire qui n'est pas une adresse", async () => {
    await setSetting(db, DIGEST_RECIPIENTS_KEY, "à compléter");
    expect(await runDailyDigest(env, MATIN)).toBe("sans-destinataire");
  });
});
