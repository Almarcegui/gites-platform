// Suggestions tarifaires du back-office (issue #31). Seule logique métier du
// front : elle est isolée dans `public/admin/suggestions.js`, sans DOM ni
// import, précisément pour être testée ici.
//
// Chaque montant attendu est calculé à la main dans le commentaire — jamais
// recopié depuis la sortie du code.
import { describe, expect, it } from "vitest";

// @ts-expect-error — module ESM du front, sans typage TypeScript
import { buildSuggestions } from "../public/admin/suggestions.js";

const TODAY = "2026-08-12";

/** Un jour de calendrier au format renvoyé par `GET /api/admin/rate-calendar`. */
function jour(date: string, over: Record<string, unknown> = {}) {
  return {
    date,
    priceCents: 24000,
    source: "saison",
    seasonId: 1,
    seasonName: "Haute",
    minNights: 2,
    minNightsSource: "regle",
    weekend: false,
    holidayRated: false,
    fallbackPriceCents: 24000,
    overridePriceCents: null,
    overrideMinNights: null,
    ...over,
  };
}

function moisDe(dates: string[], over: Record<string, unknown> = {}) {
  return dates.map((d) => jour(d, over));
}

/** Suite de dates ISO inclusives, pour composer un mois lisible. */
function plage(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; ) {
    out.push(d);
    const [y, m, day] = d.split("-").map(Number);
    d = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
  }
  return out;
}

describe("suggestions — nuits orphelines", () => {
  it("détecte un trou de 2 nuits entre deux réservations quand le minimum l'interdit", () => {
    // Séjour A du 3 au 10 (départ le 10 : la nuit du 10 est libre),
    // séjour B à partir du 12 : nuits libres = 10 et 11, soit 2 nuits.
    // Minimum de 3 nuits → le trou est invendable.
    const days = moisDe(plage("2026-08-25", "2026-09-13"), { minNights: 3 });
    const res = buildSuggestions({
      days,
      soldDates: new Set(plage("2026-08-25", "2026-09-01").concat(plage("2026-09-04", "2026-09-13"))),
      bookings: [
        { unitId: 1, checkin: "2026-08-25", checkout: "2026-09-02" },
        { unitId: 1, checkin: "2026-09-04", checkout: "2026-09-14" },
      ],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-09-13",
    });

    const orpheline = res.find((s: { kind: string }) => s.kind === "orphelines");
    expect(orpheline).toBeDefined();
    expect(orpheline.from).toBe("2026-09-02");
    expect(orpheline.to).toBe("2026-09-03");
    expect(orpheline.prefill).toEqual({ minNights: 2 });
    expect(orpheline.why).toContain("2 nuits libres");
    expect(orpheline.why).toContain("minimum est de 3 nuits");
  });

  it("ne propose rien quand le trou est déjà réservable (minimum ≤ durée du trou)", () => {
    // Mêmes deux nuits libres, mais le minimum est de 2 : le trou se vend.
    const days = moisDe(plage("2026-08-25", "2026-09-13"), { minNights: 2 });
    const res = buildSuggestions({
      days,
      soldDates: new Set(plage("2026-08-25", "2026-09-01").concat(plage("2026-09-04", "2026-09-13"))),
      bookings: [
        { unitId: 1, checkin: "2026-08-25", checkout: "2026-09-02" },
        { unitId: 1, checkin: "2026-09-04", checkout: "2026-09-14" },
      ],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-09-13",
    });
    expect(res.find((s: { kind: string }) => s.kind === "orphelines")).toBeUndefined();
  });

  it("ignore un trou de 3 nuits (ce n'est plus une nuit orpheline) et les séjours d'un autre bien", () => {
    const days = moisDe(plage("2026-09-01", "2026-09-20"), { minNights: 5 });
    const troisNuits = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [
        { unitId: 1, checkin: "2026-09-01", checkout: "2026-09-05" },
        { unitId: 1, checkin: "2026-09-08", checkout: "2026-09-12" },
      ],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-09-20",
    });
    expect(troisNuits.find((s: { kind: string }) => s.kind === "orphelines")).toBeUndefined();

    const autreBien = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [
        { unitId: 2, checkin: "2026-09-01", checkout: "2026-09-05" },
        { unitId: 2, checkin: "2026-09-06", checkout: "2026-09-12" },
      ],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-09-20",
    });
    expect(autreBien.find((s: { kind: string }) => s.kind === "orphelines")).toBeUndefined();
  });

  it("ignore un trou déjà passé", () => {
    const days = moisDe(plage("2026-08-01", "2026-08-31"), { minNights: 4 });
    const res = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [
        { unitId: 1, checkin: "2026-08-01", checkout: "2026-08-05" },
        { unitId: 1, checkin: "2026-08-07", checkout: "2026-08-11" },
      ],
      unitId: 1,
      today: TODAY, // 12 août : le trou des 5-6 août est derrière nous
      monthEnd: "2026-08-31",
    });
    expect(res.find((s: { kind: string }) => s.kind === "orphelines")).toBeUndefined();
  });
});

describe("suggestions — dernière minute", () => {
  it("propose une remise de 10 % sur les nuits libres des 21 prochains jours", () => {
    // 240,00 € − 10 % = 216,00 € → 21600 centimes.
    const days = moisDe(plage("2026-08-12", "2026-08-31"));
    const res = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-08-31",
    });
    const dm = res.find((s: { kind: string }) => s.kind === "derniere-minute");
    expect(dm).toBeDefined();
    expect(dm.from).toBe("2026-08-12");
    // L'horizon est de 21 jours (jusqu'au 2 septembre) mais la proposition
    // reste bornée au mois affiché : on ne peint pas hors de l'écran.
    expect(dm.to).toBe("2026-08-31");
    expect(dm.prefill).toEqual({ priceCents: 21600 });
    expect(dm.why).toContain("10 %");
  });

  it("ne propose rien quand tout est déjà vendu", () => {
    const dates = plage("2026-08-12", "2026-08-31");
    const res = buildSuggestions({
      days: moisDe(dates),
      soldDates: new Set(dates),
      bookings: [],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-08-31",
    });
    expect(res.find((s: { kind: string }) => s.kind === "derniere-minute")).toBeUndefined();
  });
});

describe("suggestions — dates fortes", () => {
  it("propose +15 % sur les jours fériés pas encore repris à la main", () => {
    // 322,00 € + 15 % = 370,30 € → 37030 centimes.
    const days = [
      ...moisDe(plage("2026-08-12", "2026-08-13")),
      jour("2026-08-14", { priceCents: 32200, holidayRated: true }),
      jour("2026-08-15", { priceCents: 32200, holidayRated: true }),
      ...moisDe(plage("2026-08-16", "2026-08-31")),
    ];
    const res = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-08-31",
    });
    const fortes = res.find((s: { kind: string }) => s.kind === "dates-fortes");
    expect(fortes).toBeDefined();
    expect(fortes.from).toBe("2026-08-14");
    expect(fortes.to).toBe("2026-08-15");
    expect(fortes.prefill).toEqual({ priceCents: 37030 });
  });

  it("laisse tranquilles les fériés dont le prix est déjà fixé à la main", () => {
    const days = [
      ...moisDe(plage("2026-08-12", "2026-08-13")),
      jour("2026-08-14", { priceCents: 40000, holidayRated: false, source: "override", overridePriceCents: 40000 }),
      ...moisDe(plage("2026-08-15", "2026-08-31")),
    ];
    const res = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-08-31",
    });
    expect(res.find((s: { kind: string }) => s.kind === "dates-fortes")).toBeUndefined();
  });
});

describe("suggestions — contrat général", () => {
  it("ne renvoie jamais d'ordre d'écriture : chaque suggestion se limite à un pré-remplissage", () => {
    const days = moisDe(plage("2026-08-12", "2026-08-31"));
    const res = buildSuggestions({
      days,
      soldDates: new Set(),
      bookings: [],
      unitId: 1,
      today: TODAY,
      monthEnd: "2026-08-31",
    });
    expect(res.length).toBeGreaterThan(0);
    for (const s of res) {
      expect(typeof s.why).toBe("string");
      expect(s.why.length).toBeGreaterThan(20); // la justification est une phrase
      expect(Object.keys(s.prefill).every((k) => k === "priceCents" || k === "minNights")).toBe(true);
      expect(s.from <= s.to).toBe(true);
    }
  });

  it("sur un mois sans donnée, ne propose rien plutôt que d'échouer", () => {
    expect(
      buildSuggestions({ days: [], soldDates: new Set(), bookings: [], unitId: 1, today: TODAY, monthEnd: "2026-08-31" }),
    ).toEqual([]);
  });
});
