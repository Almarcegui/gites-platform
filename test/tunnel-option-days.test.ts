// Tunnel : rangée de jours des options « à la date » (rendu pur, a11y, texte du devis).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dayChipsHtml, dayLabels } from "../public/book/option-days.js";
import { nlText } from "../src/core/public-i18n";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const txt = { group: "Sauna : choisissez les jours", taken: "déjà réservé" };
// jeu 22 -> dim 25 octobre 2026 (dates fixes, hors été)
const days = [
  { date: "2026-10-22", taken: false },
  { date: "2026-10-23", taken: true },
  { date: "2026-10-24", taken: false },
  { date: "2026-10-25", taken: false },
];

describe("rangée de jours d'une option à la date", () => {
  it("libellés : court pour la puce, date complète pour le lecteur d'écran", () => {
    const l = dayLabels("2026-10-24", "fr-BE");
    expect(l.short).toMatch(/^sam\.? 24$/);
    expect(l.full).toBe("samedi 24 octobre");
    expect(dayLabels("2026-10-24", "nl-BE").full).toBe("zaterdag 24 oktober");
  });

  it("un bouton aria-pressed par jour, libellé complet, jour pris grisé et désactivé", () => {
    const html = dayChipsHtml({ oid: 1, days, selected: new Set(["2026-10-24"]), locale: "fr-BE", esc, txt });
    expect((html.match(/<button /g) ?? []).length).toBe(4);
    expect(html).toContain('role="group" aria-label="Sauna : choisissez les jours"');
    expect(html).toMatch(/data-date="2026-10-24"[^>]*aria-pressed="true" aria-label="samedi 24 octobre"/);
    expect(html).toMatch(/data-date="2026-10-22"[^>]*aria-pressed="false" aria-label="jeudi 22 octobre"/);
    expect(html).toMatch(/data-date="2026-10-23"[^>]*aria-label="vendredi 23 octobre, déjà réservé" disabled/);
    expect(html).toContain("<small>déjà réservé</small>");
  });

  it("un jour pris n'est jamais présenté comme choisi", () => {
    const html = dayChipsHtml({ oid: 1, days, selected: new Set(["2026-10-23"]), locale: "fr-BE", esc, txt });
    expect(html).toMatch(/data-date="2026-10-23"[^>]*aria-pressed="false"/);
  });

  it("le tunnel envoie les jours, vide les jours à la désactivation et n'ajoute rien sans jour", () => {
    const js = read("public/book/book.js");
    expect(js).toContain('import { dayChipsHtml } from "./option-days.js"');
    expect(js).toMatch(/return \{ id, qty: 1, days: \[\.\.\.\(OPT_DAYS\.get\(id\) \?\? \[\]\)\]\.sort\(\) \}/);
    expect(js).toMatch(/!\("days" in o\) \|\| o\.days\.length > 0/);
    expect(js).toMatch(/function closeOptionDays\(oid\) \{\s*OPT_DAYS\.delete\(oid\)/);
  });

  it("puces d'au moins 40 px et retour à la ligne (375 px sans débordement)", () => {
    const css = read("public/book/book.css");
    const chip = /\.day-chip\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(Number(/min-height:(\d+)px/.exec(chip)?.[1])).toBeGreaterThanOrEqual(40);
    expect(css).toMatch(/\.day-chips\{display:flex;flex-wrap:wrap/);
  });

  it("l'option à la date annonce « dès … / jour, … le week-end », traduit en néerlandais", () => {
    expect(read("public/book/book.js")).toContain('t("dès {jour} / jour, {we} le week-end"');
    expect(read("public/book/nl.js")).toContain('"dès {jour} / jour, {we} le week-end": "vanaf {jour} / dag, {we} in het weekend"');
  });

  it("le libellé de ligne du devis passe en néerlandais, le nom saisi reste", () => {
    expect(nlText("Sauna — sam 25/10 (180 €), dim 26/10 (126 €)")).toBe("Sauna — za 25/10 (€ 180,00), zo 26/10 (€ 126,00)");
    expect(nlText("Frais généraux — ménage et charges")).toBe("Algemene kosten — schoonmaak en lasten");
  });
});
