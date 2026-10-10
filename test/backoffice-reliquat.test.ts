// Back-office — reliquat du paquet UX (issues #52 et #97).
//
// #97 : la lecture du formulaire des majorations est isolée dans
// `public/admin/markups.js`, sans DOM, pour être testée ici. Le comportement
// serveur (borne 50 %, push replanifié) est couvert par tarifs-push-canal.
// #52 : gardes de source — les deux écritures mono-domaine du back-office
// (nouvelle vente, import elloha) ne retombent plus en silence sur le premier
// domaine quand « Tous les domaines » est sélectionné.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — module ESM du front, sans typage TypeScript
import { parsePct, pctFr, readMarkupEdits } from "../public/admin/markups.js";
// @ts-expect-error — module ESM du front, sans typage TypeScript
import { propertyChoice } from "../public/admin/scope.js";

const CHANNELS = [
  { channel: "airbnb", label: "Airbnb", markupPct: 18 },
  { channel: "booking", label: "Booking.com", markupPct: 18 },
  { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15 },
];

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

describe("readMarkupEdits (#97)", () => {
  it("aucune saisie modifiée → rien à enregistrer", () => {
    const r = readMarkupEdits(CHANNELS, { airbnb: "18", booking: "18", abritel: "15" }, "airbnb", 50);
    expect(r).toMatchObject({ ok: true, changed: [], applied: null });
    expect(r.channels).toEqual(CHANNELS);
  });

  it("garde les libellés et l'ordre, ne change que le taux saisi", () => {
    const r = readMarkupEdits(CHANNELS, { booking: "22,5" }, null, 50);
    expect(r.ok).toBe(true);
    expect(r.channels).toEqual([
      { channel: "airbnb", label: "Airbnb", markupPct: 18 },
      { channel: "booking", label: "Booking.com", markupPct: 22.5 },
      { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15 },
    ]);
    expect(r.changed).toEqual(["booking"]);
    expect(r.applied).toBeNull(); // aucun canal appliqué : rien ne repart aux plateformes
  });

  it("signale le changement du canal APPLIQUÉ — c'est lui qui repousse les calendriers", () => {
    const r = readMarkupEdits(CHANNELS, { airbnb: "20" }, "airbnb", 50);
    expect(r.applied).toEqual({ label: "Airbnb", from: 18, to: 20 });
  });

  it("un canal non appliqué qui change ne déclenche pas d'alerte de push", () => {
    const r = readMarkupEdits(CHANNELS, { abritel: "16" }, "airbnb", 50);
    expect(r).toMatchObject({ ok: true, changed: ["abritel"], applied: null });
  });

  it("bornes : 0 et la borne haute sont acceptés, au-delà non", () => {
    expect(readMarkupEdits(CHANNELS, { airbnb: "0" }, null, 50).ok).toBe(true);
    expect(readMarkupEdits(CHANNELS, { airbnb: "50" }, null, 50).ok).toBe(true);
    const r = readMarkupEdits(CHANNELS, { airbnb: "50.5" }, null, 50);
    expect(r).toEqual({ ok: false, error: "Airbnb : la majoration va de 0 à 50 %" });
  });

  it("une saisie vide ou illisible est refusée en nommant la plateforme", () => {
    expect(readMarkupEdits(CHANNELS, { booking: "" }, null, 50)).toEqual({
      ok: false,
      error: "Booking.com : saisir un pourcentage (ex. 18)",
    });
  });
});

describe("propertyChoice — faut-il demander le domaine ? (#52)", () => {
  const DEUX = [{ id: 1 }, { id: 2 }];

  it("un domaine sélectionné : on écrit dessus sans rien demander", () => {
    expect(propertyChoice(2, DEUX)).toEqual({ kind: "direct", id: 2 });
  });

  it("« Tous » avec plusieurs domaines : on demande, jamais de repli sur le premier", () => {
    expect(propertyChoice(0, DEUX)).toEqual({ kind: "ask" });
  });

  it("« Tous » avec un seul domaine : c'est forcément lui", () => {
    expect(propertyChoice(0, [{ id: 7 }])).toEqual({ kind: "direct", id: 7 });
  });

  it("aucun domaine connu : on n'écrit rien (pas de repli sur l'id 1)", () => {
    expect(propertyChoice(0, [])).toEqual({ kind: "none" });
    expect(propertyChoice(3, [])).toEqual({ kind: "none" });
    expect(propertyChoice(0, undefined)).toEqual({ kind: "none" });
  });

  it("un domaine sélectionné devenu inconnu ne sert pas de cible", () => {
    expect(propertyChoice(9, DEUX)).toEqual({ kind: "ask" });
  });
});

describe("écritures mono-domaine en « Tous les domaines » (#52)", () => {
  const app = readFileSync(fileURLToPath(new URL("../public/admin/app.js", import.meta.url)), "utf8");

  /** Corps d'une fonction du front, borné sur sa propre accolade fermante. */
  function body(signature: string): string {
    const start = app.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = app.indexOf("{", start); i < app.length; i++) {
      if (app[i] === "{") depth++;
      else if (app[i] === "}" && --depth === 0) return app.slice(start, i + 1);
    }
    throw new Error(`fin de ${signature} introuvable`);
  }

  it("le choix du domaine n'est demandé qu'en « Tous » avec plusieurs biens", () => {
    const fn = body("export function chooseProperty(");
    expect(fn).toContain("propertyChoice(state.propertyId, state.properties)");
    expect(fn).toContain("data-pick");
    // fermer sans choisir résout null, quelle que soit la façon de fermer
    expect(fn).toContain("MutationObserver");
    expect(fn).not.toContain("currentPropertyId()");
  });

  it("la nouvelle vente demande son domaine au lieu de prendre le premier", () => {
    const fn = body("export async function openNewSale(");
    expect(fn).toContain('await chooseProperty("Nouvelle vente (téléphone)")');
    expect(fn).toContain("if (pid == null) return;");
    expect(fn).not.toContain("currentPropertyId()");
    expect(fn).toContain("propertySuffix(pid)");
  });

  it("l'import elloha demande son domaine au lieu de prendre le premier", () => {
    const fn = body("async function openEllohaImport(");
    expect(fn).toContain('await chooseProperty("Importer les réservations elloha")');
    expect(fn).toContain("if (pid == null) return;");
    expect(fn).not.toContain("currentPropertyId()");
    expect(fn).toContain("/api/admin/import/elloha?property=${pid}");
  });
});
