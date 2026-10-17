// Nuit du 17/10/2026 — cohérence des pages publiques statiques avec le moteur.
//  · « Domaine entier » a été renommé « Les deux maisons du Pré Moré » : aucun
//    texte visible ne doit encore l'employer (le slug d'URL `domaine-entier`
//    reste, il identifie l'hébergement).
//  · Les frais généraux (ménage et charges) ne s'écrivent plus en dur : la page
//    annonçait 120 / 90 / 210 € quand le moteur facturait 170 / 140 / 310 €.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));

function pagesHtml(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "admin") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? pagesHtml(p) : n.endsWith(".html") ? [p] : [];
  });
}

/** Texte visible approximatif : sans commentaires, scripts, styles, ni attributs. */
const visible = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, " ");

describe("pages publiques statiques", () => {
  const pages = pagesHtml(PUBLIC);

  it("il y a des pages à vérifier", () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it("aucun texte visible ne dit encore « domaine entier »", () => {
    const fautifs = pages.filter((p) => /domaine entier/i.test(visible(readFileSync(p, "utf8"))));
    expect(fautifs).toEqual([]);
  });

  it("aucun montant de frais généraux écrit en dur", () => {
    const fautifs = pages.filter((p) => /frais généraux\s*(<[^>]+>)?\s*\d+\s*€/i.test(readFileSync(p, "utf8")));
    expect(fautifs).toEqual([]);
  });

  it("le tableau des tarifs de l'accueil lit les frais dans la fiche du domaine", () => {
    const home = readFileSync(join(PUBLIC, "index.html"), "utf8");
    expect(home.match(/data-frais-unit="[123]"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("tunnel : la ligne Voyageurs passe à la ligne (les libellés NL débordaient à 375 px)", () => {
    const css = readFileSync(join(PUBLIC, "book", "book.css"), "utf8");
    expect(css).toMatch(/\.pax-top\{[^}]*flex-wrap:wrap/);
  });
});
