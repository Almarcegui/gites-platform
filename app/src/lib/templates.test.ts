// Modèles de réponse : sans réservation liée, ni le bien ni le jour d'arrivée ne
// sont connus. Le texte garde alors {bien} et {arrivee} à compléter, au lieu de
// partir avec « votre réservation à , avec une arrivée le  ».
import { describe, expect, it } from "vitest";

import { fillTemplate, unfilledVariables, type TemplateContext } from "./templates";

const CTX: TemplateContext = { firstName: "Sophie", unitName: "", arrival: "", checkinTime: "18 h", checkoutTime: "18 h", balance: undefined, signature: "Les Gîtes du Pré Moré" };
const BODY = "Bonjour {prenom},\nVotre réservation à {bien}, arrivée le {arrivee} dès {heure_arrivee}. Reste à payer : {solde}.\n{signature}";

describe("fillTemplate", () => {
  it("sans réservation liée : {bien} et {arrivee} restent visibles", () => {
    const out = fillTemplate(BODY, CTX);
    expect(out).toContain("à {bien}, arrivée le {arrivee} dès 18 h.");
    expect(unfilledVariables(out)).toEqual(["{bien}", "{arrivee}", "{solde}"]);
  });

  it("avec une réservation liée : tout est rempli", () => {
    const out = fillTemplate(BODY, { ...CTX, unitName: "La Scierie", arrival: "vendredi 23 octobre", balance: null });
    expect(out).toContain("à La Scierie, arrivée le vendredi 23 octobre");
    expect(out).toContain("Reste à payer : 0 €.");
    expect(unfilledVariables(out)).toEqual([]);
  });

  it("sans prénom : « Bonjour, »", () => {
    expect(fillTemplate(BODY, { ...CTX, firstName: " " }).startsWith("Bonjour,\n")).toBe(true);
  });
});
