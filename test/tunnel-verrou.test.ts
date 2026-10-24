// Tunnel verrouillé tant qu'une réservation est en cours (bug du 24/10/2026).
//
// Le comportement (verrou, reprise, annulation, refus, expiration) est exécuté
// pour de vrai dans tunnel-comportement.test.ts. Ici, seulement ce qu'un test
// d'exécution ne voit pas : la feuille de style et les traductions livrées.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lire = (f: string) => readFileSync(join(process.cwd(), "public/book", f), "utf8");
const css = lire("book.css");
const nl = lire("nl.js");

describe("verrou du tunnel : styles et traductions", () => {
  it("le verrou masque le formulaire et fige les dates", () => {
    expect(css).toMatch(/\.hold-locked #searchCard/);
    expect(css).toMatch(/\.hold-locked #bookingPanel \.panel-side/);
  });

  it("boutons de 44 px au moins, retour à la ligne sur mobile, [hidden] respecté", () => {
    expect(css).toMatch(/\.holdbar \.holdactions \.btn\{min-height:44px/);
    expect(css).toMatch(/\.holdbar\{display:flex;flex-wrap:wrap/);
    expect(css).toMatch(/\.holdactions\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("textes traduits en néerlandais", () => {
    for (const k of [
      "Réservation en cours", "Temps restant :", "Continuer le paiement", "Annuler",
      "Votre réservation en cours est annulée, les dates sont libérées.",
      "Impossible de rouvrir le paiement ici. Annulez puis recommencez.",
    ]) expect(nl).toContain(`"${k}":`);
  });
});
