// Tunnel verrouillé tant qu'une réservation est en cours (bug du 24/10/2026).
//
// Le tunnel est du JS sans framework : ces tests vérifient, dans les fichiers
// livrés, les éléments dont dépend le verrou. Le comportement serveur (annuler,
// remplacer, refuser) est couvert par hold-annulation.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lire = (f: string) => readFileSync(fileURLToPath(new URL(`../public/book/${f}`, import.meta.url)), "utf8");
const js = lire("book.js");
const css = lire("book.css");
const nl = lire("nl.js");

describe("verrou du tunnel", () => {
  it("le bandeau porte Continuer le paiement et Annuler, annonce le décompte", () => {
    expect(js).toMatch(/id="holdResume"/);
    expect(js).toMatch(/id="holdCancel"/);
    expect(js).toMatch(/t\("Continuer le paiement"\)/);
    expect(js).toMatch(/t\("Annuler"\)/);
    expect(js).toMatch(/Réservation en cours/);
    expect(js).toMatch(/Temps restant/);
    expect(js).toMatch(/bar\.focus\(/);
  });

  it("Annuler appelle la route du cookie, sans référence", () => {
    expect(js).toMatch(/api\("\/api\/public\/hold\/cancel", \{\}\)/);
  });

  it("le verrou rend dates, hébergement et options inertes, et masque le formulaire", () => {
    expect(js).toMatch(/function lockForHold/);
    expect(js).toMatch(/\.inert = on/);
    expect(js).toMatch(/hold-locked/);
    expect(css).toMatch(/\.hold-locked #searchCard/);
    expect(css).toMatch(/\.hold-locked #bookingPanel \.panel-side/);
    // la sélection ne peut plus changer par un autre chemin
    expect(js).toMatch(/if \(document\.body\.classList\.contains\("hold-locked"\)\) return;/);
  });

  it("le verrou se pose à chaque entrée du hold : nouvelle réservation, retour de Stripe, rechargement", () => {
    // startHoldCountdown est le passage obligé de rememberHold et restoreHold
    const m = js.match(/function startHoldCountdown[\s\S]*?\n}\n/);
    expect(m?.[0]).toMatch(/lockForHold\(true\)/);
    expect(js).toMatch(/rememberHold\(res, \{/);
    expect(js).toMatch(/rememberHold\(\{ reference: hold\.reference[^)]*\}, \{/);
  });

  it("l'expiration déverrouille et le dit", () => {
    const m = js.match(/function holdExpired[\s\S]*?\n}\n/);
    expect(m?.[0]).toMatch(/lockForHold\(false\)/);
    expect(js).toMatch(/Le délai est écoulé, les dates ont été libérées/);
  });

  it("l'annulation réussie déverrouille et garde les dates", () => {
    const m = js.match(/async function cancelHold[\s\S]*?\n}\n/);
    expect(m?.[0]).toMatch(/lockForHold\(false\)/);
    expect(m?.[0]).toMatch(/clearHold\(\)/);
    expect(m?.[0]).toMatch(/clearTimeout\(holdTimer\)/);
    expect(m?.[0]).not.toMatch(/selIn = null|selOut = null/);
  });

  it("boutons de 44 px au moins, retour à la ligne sur mobile", () => {
    expect(css).toMatch(/\.holdbar \.holdactions \.btn\{min-height:44px/);
    expect(css).toMatch(/\.holdbar\{display:flex;flex-wrap:wrap/);
  });

  it("textes traduits en néerlandais", () => {
    for (const k of ["Réservation en cours", "Temps restant :", "Continuer le paiement", "Annuler"]) {
      expect(nl).toContain(`"${k}":`);
    }
  });
});
