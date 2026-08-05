import { describe, expect, it } from "vitest";
import {
  easterSunday,
  belgianHolidays,
  bridgeDays,
  holidayRatedDays,
  isHolidayRatedNight,
  yearsSpanned,
} from "../src/core/holidays";

describe("computus de Pâques (Gauss/Butcher)", () => {
  it("donne les dates de Pâques connues sur un large éventail d'années", () => {
    // Références historiques et futures (dont le cas limite 2038).
    expect(easterSunday(1954)).toBe("1954-04-18");
    expect(easterSunday(1981)).toBe("1981-04-19");
    expect(easterSunday(2008)).toBe("2008-03-23");
    expect(easterSunday(2011)).toBe("2011-04-24");
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2038)).toBe("2038-04-25");
    expect(easterSunday(2049)).toBe("2049-04-18");
  });
});

describe("jours fériés légaux belges", () => {
  it("liste les 10 fériés de 2026 aux bonnes dates", () => {
    const h = belgianHolidays(2026);
    expect(h.size).toBe(10);
    expect(h.get("2026-01-01")).toBe("Nouvel An");
    expect(h.get("2026-04-06")).toBe("Lundi de Pâques"); // Pâques = 05/04
    expect(h.get("2026-05-01")).toBe("Fête du Travail");
    expect(h.get("2026-05-14")).toBe("Ascension"); // Pâques + 39
    expect(h.get("2026-05-25")).toBe("Lundi de Pentecôte"); // Pâques + 50
    expect(h.get("2026-07-21")).toBe("Fête nationale");
    expect(h.get("2026-08-15")).toBe("Assomption");
    expect(h.get("2026-11-01")).toBe("Toussaint");
    expect(h.get("2026-11-11")).toBe("Armistice");
    expect(h.get("2026-12-25")).toBe("Noël");
  });
});

describe("ponts", () => {
  it("calcule les 3 ponts de 2026 : 02/01 (NA jeudi), 15/05 (Ascension), 20/07 (21/07 mardi)", () => {
    const b = bridgeDays(2026);
    expect([...b].sort()).toEqual(["2026-01-02", "2026-05-15", "2026-07-20"]);
  });
});

describe("nuits majorées", () => {
  const rated = holidayRatedDays([2026]);

  it("majore la veille d'un férié et le férié lui-même", () => {
    expect(isHolidayRatedNight("2026-12-24", rated)).toBe(true); // veille de Noël
    expect(isHolidayRatedNight("2026-12-25", rated)).toBe(true); // Noël
    expect(isHolidayRatedNight("2026-12-26", rated)).toBe(false); // samedi ordinaire
  });

  it("majore autour du pont du 21 juillet (mardi) : nuits du 19, 20 et 21", () => {
    expect(isHolidayRatedNight("2026-07-19", rated)).toBe(true); // veille du pont
    expect(isHolidayRatedNight("2026-07-20", rated)).toBe(true); // pont
    expect(isHolidayRatedNight("2026-07-21", rated)).toBe(true); // férié
    expect(isHolidayRatedNight("2026-07-22", rated)).toBe(false);
    expect(isHolidayRatedNight("2026-07-18", rated)).toBe(false);
  });

  it("couvre un séjour à cheval sur deux années (Nouvel An)", () => {
    const set = holidayRatedDays(yearsSpanned("2026-12-28", "2027-01-02"));
    expect(isHolidayRatedNight("2026-12-31", set)).toBe(true); // veille du 01/01/2027
    expect(isHolidayRatedNight("2027-01-01", set)).toBe(true);
  });
});
