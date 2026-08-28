// Issue #66 — plages réservables les plus proches d'une demande impossible.
//
// Moteur pur : ces cas fixent la règle de proximité et les conditions qu'une
// suggestion doit remplir. Le pendant côté API (recherche 3 nuits en haute
// saison) vit dans test/tunnel-min-nuits.test.ts.
import { describe, expect, it } from "vitest";
import { checkinDaysLabel, isAllowedCheckin, isBookableStay, suggestStays, type NightOption } from "../src/core/stay-options";
import { addDays, dayOfWeek } from "../src/core/dates";

/** Calendrier synthétique : 60 jours à partir d'un lundi, tout libre. */
function calendar(
  from: string,
  days: number,
  over: (date: string, i: number) => Partial<NightOption> = () => ({}),
): NightOption[] {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    return { date, available: true, minNights: 2, checkinDays: null, ...over(date, i) } satisfies NightOption;
  });
}

// 2026-01-05 est un lundi — repère stable pour les tests de jour d'arrivée.
const LUNDI = "2026-01-05";

describe("suggestStays — minimum de nuits", () => {
  it("étire le séjour demandé au minimum imposé, en gardant la date d'arrivée", () => {
    const days = calendar(LUNDI, 60, () => ({ minNights: 7 }));
    const [first] = suggestStays(days, { checkin: "2026-01-12", nights: 3 });
    expect(first).toEqual({ checkin: "2026-01-12", checkout: "2026-01-19", nights: 7 });
  });

  it("n'étire jamais au-delà du nécessaire : 10 nuits demandées restent 10", () => {
    const days = calendar(LUNDI, 60, () => ({ minNights: 7 }));
    const [first] = suggestStays(days, { checkin: "2026-01-12", nights: 10 });
    expect(first?.nights).toBe(10);
  });

  it("propose deux plages distinctes, les plus proches de la date demandée", () => {
    // Du 15 au 19 tout est occupé : les arrivées les plus proches du 14 qui
    // laissent 7 nuits libres sont le 20 (+6) et le 8 (−6). À écart égal on
    // propose d'abord la plus tardive — un client décale plus facilement son
    // séjour vers l'avant que vers l'arrière.
    const busy = new Set(["2026-01-15", "2026-01-16", "2026-01-17", "2026-01-18", "2026-01-19"]);
    const days = calendar(LUNDI, 60, (date) => ({ minNights: 7, available: !busy.has(date) }));
    const out = suggestStays(days, { checkin: "2026-01-14", nights: 3 }, 2);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.checkin)).toEqual(["2026-01-20", "2026-01-08"]);
    expect(out.every((s) => s.nights === 7)).toBe(true);
  });

  it("ne propose rien quand aucune plage assez longue n'est libre dans la fenêtre", () => {
    // Une nuit occupée sur deux : impossible de tenir 7 nuits d'affilée.
    const days = calendar(LUNDI, 30, (_d, i) => ({ minNights: 7, available: i % 2 === 0 }));
    expect(suggestStays(days, { checkin: "2026-01-12", nights: 3 })).toEqual([]);
  });

  it("ne propose pas une plage tronquée par le bord de la fenêtre", () => {
    const days = calendar(LUNDI, 10, () => ({ minNights: 7 }));
    // Seules les arrivées du 05, 06, 07 et 08 janvier tiennent 7 nuits.
    const out = suggestStays(days, { checkin: "2026-01-12", nights: 3 }, 5);
    expect(out.every((s) => s.checkout <= addDays(LUNDI, 10))).toBe(true);
    expect(out[0]?.checkin).toBe("2026-01-08");
  });
});

describe("suggestStays — jours d'arrivée imposés", () => {
  it("ne propose que des arrivées le jour autorisé", () => {
    const days = calendar(LUNDI, 60, () => ({ minNights: 7, checkinDays: [6] })); // samedi
    const out = suggestStays(days, { checkin: "2026-01-14", nights: 7 }, 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => dayOfWeek(s.checkin) === 6)).toBe(true);
    expect(out[0]?.checkin).toBe("2026-01-17"); // le samedi le plus proche
  });

  it("une liste de jours VIDE veut dire « aucune arrivée », pas « aucune contrainte »", () => {
    // Cas d'un composite dont deux composantes imposent des jours d'arrivée
    // incompatibles : l'intersection est vide, plus rien n'est réservable.
    const days = calendar(LUNDI, 30, () => ({ minNights: 2, checkinDays: [] }));
    expect(isAllowedCheckin(days[0]!)).toBe(false);
    expect(suggestStays(days, { checkin: "2026-01-12", nights: 2 })).toEqual([]);
    expect(isBookableStay(days, "2026-01-12", "2026-01-14")).toBe(false);
  });

  it("un jour sans tarif n'est jamais une arrivée, ni une nuit de séjour", () => {
    const days = calendar(LUNDI, 30, (_d, i) => (i === 10 ? { minNights: null } : {}));
    const out = suggestStays(days, { checkin: addDays(LUNDI, 10), nights: 2 }, 2);
    expect(out.every((s) => s.checkin !== addDays(LUNDI, 10))).toBe(true);
    expect(out.every((s) => !(s.checkin <= addDays(LUNDI, 10) && addDays(LUNDI, 10) < s.checkout))).toBe(true);
  });
});

describe("isBookableStay", () => {
  const days = calendar(LUNDI, 30, () => ({ minNights: 7, checkinDays: [6] }));
  it("accepte un séjour conforme", () => {
    expect(isBookableStay(days, "2026-01-10", "2026-01-17")).toBe(true);
  });
  it("refuse un séjour trop court", () => {
    expect(isBookableStay(days, "2026-01-10", "2026-01-13")).toBe(false);
  });
  it("refuse une arrivée un jour interdit", () => {
    expect(isBookableStay(days, "2026-01-11", "2026-01-18")).toBe(false);
  });
  it("refuse un séjour qui traverse une nuit occupée", () => {
    const occupe = calendar(LUNDI, 30, (date) => ({
      minNights: 7,
      checkinDays: [6],
      available: date !== "2026-01-13",
    }));
    expect(isBookableStay(occupe, "2026-01-10", "2026-01-17")).toBe(false);
  });
});

describe("checkinDaysLabel", () => {
  it("nomme un jour unique", () => {
    expect(checkinDaysLabel([6])).toBe("le samedi");
  });
  it("énumère plusieurs jours dans l'ordre de la semaine française", () => {
    expect(checkinDaysLabel([0, 5])).toBe("le vendredi ou le dimanche");
  });
  it("renvoie une chaîne vide sans contrainte", () => {
    expect(checkinDaysLabel([])).toBe("");
  });
});
