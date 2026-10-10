// Cas de l'ancien test/backoffice-reliquat.test.ts (#97), repris sur la
// version du nouvel écran.
import { describe, expect, it } from "vitest";

import { parsePct, pctFr } from "./markups";

describe("parsePct (#97)", () => {
  it("lit un entier, un décimal à point ou à virgule", () => {
    expect(parsePct("18")).toBe(18);
    expect(parsePct("17.5")).toBe(17.5);
    expect(parsePct("17,5")).toBe(17.5);
    expect(parsePct(" 20 ")).toBe(20);
    expect(parsePct(12)).toBe(12);
  });

  it("arrondit à deux décimales", () => {
    expect(parsePct("17.333")).toBe(17.33);
  });

  it("refuse ce qui n'est pas un pourcentage positif", () => {
    for (const bad of ["", "  ", "abc", "-5", "1e3", "18 %", null, undefined]) expect(parsePct(bad)).toBeNull();
  });
});

describe("pctFr (#97)", () => {
  it("affiche la virgule décimale française", () => {
    expect(pctFr(17.5)).toBe("17,5");
    expect(pctFr(18)).toBe("18");
  });
});
