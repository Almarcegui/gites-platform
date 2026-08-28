// Issue #71 — les quatre signaux de DÉRIVE LENTE de la carte « Santé ».
//
// Chaque détecteur est testé deux fois : un cas OK (rien à signaler, et
// surtout pas de faux positif) et un cas de dérive. Les détecteurs sont purs,
// donc ces tests-là tournent en millisecondes ; un dernier bloc vérifie que le
// rassemblement SQL (collectDriftInput) lit bien les tables existantes — c'est
// la moitié qui casse silencieusement si une colonne bouge.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import {
  CRON_SILENT_MINUTES,
  ICAL_STALE_HOURS,
  MESSAGE_UNANSWERED_HOURS,
  RATE_HORIZON_DAYS,
  detectDrift,
  detectSilentCron,
  detectStaleFeeds,
  detectUnansweredMessages,
  detectUnitsWithoutRate,
  type MessageState,
  type UnitRateTarget,
} from "../src/core/drift";
import { addDays, sqlNow, todayInZone } from "../src/core/dates";
import type { RateRule, Season } from "../src/core/pricing";
import { collectDriftInput } from "../src/db/repo";

const NOW = new Date("2026-08-28T12:00:00Z");
/** Horodatage SQL situé `hours` heures avant NOW. */
const agoHours = (hours: number) => sqlNow(new Date(NOW.getTime() - hours * 3_600_000));
const agoMinutes = (minutes: number) => sqlNow(new Date(NOW.getTime() - minutes * 60_000));

// ---------------------------------------------------------------------------
// 1. Flux iCal muet
// ---------------------------------------------------------------------------

describe("signal 1 — flux iCal sans relevé depuis plus de 24 h", () => {
  it("OK : un flux relevé il y a moins de 24 h ne dit rien", () => {
    const signals = detectStaleFeeds(
      [{ id: 1, name: "Airbnb — Scierie", active: true, lastSyncAt: agoHours(ICAL_STALE_HOURS - 1) }],
      NOW,
    );
    expect(signals).toEqual([]);
  });

  it("dérive : plus de 24 h sans relevé → signal cliquable vers Synchro iCal", () => {
    const signals = detectStaleFeeds(
      [{ id: 1, name: "Airbnb — Scierie", unitName: "La Scierie", active: true, lastSyncAt: agoHours(50) }],
      NOW,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("ical_stale");
    expect(signals[0]!.href).toBe("#/ical");
    expect(signals[0]!.detail).toContain("Airbnb — Scierie");
    expect(signals[0]!.detail).toContain("2 jours");
  });

  it("un flux DÉSACTIVÉ n'est pas une dérive : ne plus le relever est un choix", () => {
    expect(detectStaleFeeds([{ id: 1, name: "vieux flux", active: false, lastSyncAt: agoHours(500) }], NOW)).toEqual([]);
  });

  it("un flux jamais relevé se juge sur sa date d'ajout, pas sur l'absence de relevé", () => {
    const frais = detectStaleFeeds(
      [{ id: 1, name: "flux tout neuf", active: true, lastSyncAt: null, createdAt: agoMinutes(10) }],
      NOW,
    );
    expect(frais).toEqual([]);
    const vieux = detectStaleFeeds(
      [{ id: 2, name: "flux oublié", active: true, lastSyncAt: null, createdAt: agoHours(72) }],
      NOW,
    );
    expect(vieux).toHaveLength(1);
    expect(vieux[0]!.detail).toContain("jamais relevé");
  });
});

// ---------------------------------------------------------------------------
// 2. Unité active sans tarif applicable sur les 90 prochains jours
// ---------------------------------------------------------------------------

const TODAY = "2026-08-28";

function unit(id: number, name: string, active = true): UnitRateTarget {
  return {
    active,
    pricingUnit: { id, name, compositePricing: "own", cleaningFeeCents: 0, components: [] },
  };
}

const baseRule = (unitId: number): RateRule => ({
  id: unitId * 10,
  unitId,
  seasonId: null,
  priceWeekCents: 12000,
  priceWeekendCents: 15000,
  holidayPct: 0,
  minNights: 2,
  checkinDays: null,
});

describe("signal 2 — unité active sans tarif applicable sur 90 jours", () => {
  it("OK : un tarif de base couvre tous les jours à venir", () => {
    expect(detectUnitsWithoutRate([unit(1, "La Scierie")], TODAY, [], [baseRule(1)])).toEqual([]);
  });

  it("dérive : aucune règle du tout → l'unité est invendable et personne ne le sait", () => {
    const signals = detectUnitsWithoutRate([unit(1, "La Scierie")], TODAY, [], []);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("unit_no_rate");
    expect(signals[0]!.href).toBe("#/tarifs");
    expect(signals[0]!.detail).toContain("aucun tarif applicable");
    expect(signals[0]!.detail).toContain(String(RATE_HORIZON_DAYS));
  });

  it("dérive : une saison qui s'arrête sans successeur laisse un trou daté", () => {
    // Pas de tarif de base : seule la saison porte un prix, et elle se termine
    // dans 9 jours. C'est LA dérive lente typique — rien ne casse le jour même.
    const season: Season = { id: 1, name: "Été", dateStart: TODAY, dateEnd: addDays(TODAY, 9), priority: 1 };
    const rule: RateRule = { ...baseRule(1), seasonId: 1 };
    const signals = detectUnitsWithoutRate([unit(1, "La Scierie")], TODAY, [season], [rule]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.detail).toContain(`${RATE_HORIZON_DAYS - 10} des ${RATE_HORIZON_DAYS} prochains jours`);
    // premier jour non couvert = le lendemain de la fin de saison, en JJ/MM/AAAA
    const [y, m, d] = addDays(TODAY, 10).split("-");
    expect(signals[0]!.detail).toContain(`${d}/${m}/${y}`);
  });

  it("une unité désactivée est hors sujet", () => {
    expect(detectUnitsWithoutRate([unit(1, "gîte fermé", false)], TODAY, [], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Message client sans réponse depuis plus de 48 h
// ---------------------------------------------------------------------------

function message(over: Partial<MessageState> & { id: number }): MessageState {
  return {
    direction: "in",
    status: "nouveau",
    receivedAt: agoHours(1),
    fromName: "Camille Martin",
    fromEmail: "camille.martin@example.org",
    bookingId: null,
    bookingReference: null,
    guestId: 7,
    ...over,
  };
}

describe("signal 3 — message client sans réponse depuis plus de 48 h", () => {
  it("OK : un message d'il y a 47 h n'est pas encore une dérive", () => {
    expect(detectUnansweredMessages([message({ id: 1, receivedAt: agoHours(MESSAGE_UNANSWERED_HOURS - 1) })], NOW)).toEqual([]);
  });

  it("dérive : plus de 48 h sans réponse → signal cliquable vers Messages", () => {
    const signals = detectUnansweredMessages(
      [message({ id: 1, receivedAt: agoHours(72), bookingId: 4, bookingReference: "PM-2026-004" })],
      NOW,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("message_unanswered");
    expect(signals[0]!.href).toBe("#/messages");
    expect(signals[0]!.detail).toContain("Camille Martin");
    expect(signals[0]!.detail).toContain("PM-2026-004");
    expect(signals[0]!.detail).toContain("3 jours");
  });

  it("OK : une réponse de l'équipe postérieure ferme le fil", () => {
    const signals = detectUnansweredMessages(
      [
        message({ id: 1, receivedAt: agoHours(72) }),
        message({ id: 2, direction: "out", status: "traité", receivedAt: agoHours(70) }),
      ],
      NOW,
    );
    expect(signals).toEqual([]);
  });

  it("OK : un message passé en « traité » compte comme répondu (réponse au téléphone)", () => {
    expect(detectUnansweredMessages([message({ id: 1, receivedAt: agoHours(72), status: "traité" })], NOW)).toEqual([]);
  });

  it("dérive : le client relance après notre réponse et attend à nouveau", () => {
    const signals = detectUnansweredMessages(
      [
        message({ id: 1, receivedAt: agoHours(120) }),
        message({ id: 2, direction: "out", status: "traité", receivedAt: agoHours(110) }),
        message({ id: 3, receivedAt: agoHours(60) }),
      ],
      NOW,
    );
    expect(signals).toHaveLength(1);
  });

  it("les fils sont indépendants : un client servi n'excuse pas le client oublié", () => {
    const signals = detectUnansweredMessages(
      [
        message({ id: 1, guestId: 1, receivedAt: agoHours(72) }),
        message({ id: 2, guestId: 2, receivedAt: agoHours(72), fromName: "Bea Lopez" }),
        message({ id: 3, guestId: 2, direction: "out", status: "traité", receivedAt: agoHours(2) }),
      ],
      NOW,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.detail).toContain("Camille Martin");
  });
});

// ---------------------------------------------------------------------------
// 4. Cron muet
// ---------------------------------------------------------------------------

describe("signal 4 — traitement planifié muet depuis plus de 30 min", () => {
  it("OK : un tick il y a 15 min, cadence normale", () => {
    expect(detectSilentCron(agoMinutes(15), NOW)).toEqual([]);
  });

  it("dérive : plus de 30 min sans tick → deux passages manqués", () => {
    const signals = detectSilentCron(agoMinutes(CRON_SILENT_MINUTES + 15), NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("cron_silent");
    expect(signals[0]!.href).toBe("#/ical");
    expect(signals[0]!.detail).toContain("45 min");
  });

  it("jamais tourné n'est PAS une dérive : c'est l'état d'une mise en service", () => {
    expect(detectSilentCron(null, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rassemblement, sur une vraie base
// ---------------------------------------------------------------------------

describe("collectDriftInput — lecture des tables existantes (aucune migration)", () => {
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
    for (const table of ["ical_feeds", "messages", "app_settings"]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it("base de départ : le seed ne déclenche aucun signal", async () => {
    const input = await collectDriftInput(db, 1, new Date());
    expect(detectDrift(input, new Date())).toEqual([]);
  });

  it("les quatre signaux remontent ensemble depuis la base", async () => {
    const now = new Date();
    const old = sqlNow(new Date(now.getTime() - 72 * 3_600_000));

    await db
      .prepare("INSERT INTO ical_feeds (unit_id, name, url, active, last_sync_at) VALUES (2, 'Airbnb — Scierie', 'https://exemple.test/f.ics', 1, ?1)")
      .bind(old)
      .run();
    await db
      .prepare(
        `INSERT INTO messages (property_id, direction, channel, from_email, from_name, subject, body_text, status, received_at)
         VALUES (1, 'in', 'form', 'camille.martin@example.org', 'Camille Martin', 'Question', 'Bonjour, une question', 'nouveau', ?1)`,
      )
      .bind(old)
      .run();
    await db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('cron_last_run', ?1)")
      .bind(sqlNow(new Date(now.getTime() - 90 * 60_000)))
      .run();
    // Le tarif de base de La Scierie disparaît : la maison ET le Domaine
    // entier (composite « somme ») deviennent invendables du même coup.
    await db.prepare("DELETE FROM rate_rules WHERE unit_id = 2").run();

    const signals = detectDrift(await collectDriftInput(db, 1, now), now);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("ical_stale");
    expect(kinds).toContain("unit_no_rate");
    expect(kinds).toContain("message_unanswered");
    expect(kinds).toContain("cron_silent");
    const noRate = signals.filter((s) => s.kind === "unit_no_rate");
    expect(noRate.map((s) => s.detail).join(" ")).toContain("La Scierie");
    expect(noRate.map((s) => s.detail).join(" ")).toContain("Le Domaine entier");
    // Tous les signaux pointent vers un écran du back-office (issue #48).
    expect(signals.every((s) => s.href.startsWith("#/"))).toBe(true);
  });

  it("un flux d'un AUTRE domaine ne pollue pas la carte du domaine courant", async () => {
    const now = new Date();
    await db
      .prepare("INSERT INTO ical_feeds (unit_id, name, url, active, last_sync_at) VALUES (4, 'Booking — Moulin', 'https://exemple.test/m.ics', 1, ?1)")
      .bind(sqlNow(new Date(now.getTime() - 72 * 3_600_000)))
      .run();
    const preMore = detectDrift(await collectDriftInput(db, 1, now), now);
    expect(preMore.filter((s) => s.kind === "ical_stale")).toEqual([]);
    const braives = detectDrift(await collectDriftInput(db, 2, now), now);
    expect(braives.filter((s) => s.kind === "ical_stale")).toHaveLength(1);
  });

  it("le seuil des tarifs se compte à partir d'aujourd'hui, pas d'une date figée", async () => {
    const input = await collectDriftInput(db, 1, new Date());
    expect(input.today).toBe(todayInZone());
  });
});
