// Les dates-heures de la base sont en UTC : l'écran les dit à l'heure de Belgique.
import { afterEach, describe, expect, it } from "vitest";

import { activate } from "../i18n";
import { sqlWhen } from "./kit";

afterEach(() => activate("fr"));

describe("sqlWhen", () => {
  it("été : UTC + 2 h", () => {
    expect(sqlWhen("2026-10-10 12:32:00")).toBe("10/10/2026 à 14 h 32");
  });
  it("hiver : UTC + 1 h", () => {
    expect(sqlWhen("2026-12-24 08:05:00")).toBe("24/12/2026 à 9 h 05");
  });
  it("passe minuit : le jour suivant", () => {
    expect(sqlWhen("2026-07-14 22:30:00")).toBe("15/07/2026 à 0 h 30");
  });
  it("format ISO avec T", () => {
    expect(sqlWhen("2026-10-10T12:32:00Z")).toBe("10/10/2026 à 14 h 32");
  });
  it("néerlandais : « om 14.32 u », sans « à »", () => {
    activate("nl");
    expect(sqlWhen("2026-10-10 12:32:00")).toBe("10/10/2026 om 14.32 u");
  });
  it("vide ou illisible", () => {
    expect(sqlWhen(null)).toBe("");
    expect(sqlWhen("hier")).toBe("hier");
  });
});
