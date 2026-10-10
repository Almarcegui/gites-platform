// Néerlandais (lot 3, #34) : catalogue complet, détection du navigateur,
// bascule dans Réglages › Cet appareil, dates et montants à la belge.
import { readFileSync } from "node:fs";

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { activate, detectLocale, LOCALE_KEY } from "./i18n";
import { longDate, stayRange, hourLabel } from "./lib/dates";
import { daySentence } from "./lib/derive";
import { eur } from "./lib/money";
import { renderApp } from "./test/render";

afterEach(() => activate("fr"));

/** msgid → msgstr d'un catalogue .po (entrées sur une ou plusieurs lignes). */
function entries(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of readFileSync(new URL(path, import.meta.url), "utf-8").split("\n\n")) {
    const read = (key: string) => {
      const m = new RegExp(`^${key} ((?:".*"\\n?)+)`, "m").exec(block + "\n");
      return m ? m[1]!.trim().split("\n").map((l) => JSON.parse(l) as string).join("") : null;
    };
    const id = read("msgid");
    if (id) out.set(id, read("msgstr") ?? "");
  }
  return out;
}

describe("catalogue néerlandais", () => {
  it("chaque texte du français a sa traduction, avec les mêmes variables", () => {
    const fr = entries("./locales/fr/messages.po");
    const nl = entries("./locales/nl/messages.po");
    expect(nl.size).toBe(fr.size);
    const vars = (s: string) => (s.match(/\{[\w]+\}/g) ?? []).sort().join(",");
    for (const [id, str] of nl) {
      expect(str, id).not.toBe("");
      expect(vars(str), id).toBe(vars(id));
    }
  });

  it("termes belges : voorschot pour les arrhes, verblijfsbelasting, jamais « aanbetaling »", () => {
    const nl = entries("./locales/nl/messages.po");
    expect(nl.get("Arrhes")).toBe("Voorschot");
    expect(nl.get("Taxe de séjour")).toBe("Verblijfsbelasting");
    expect([...nl.values()].some((s) => /aanbetaling/i.test(s))).toBe(false);
  });
});

describe("langue de l'écran", () => {
  it("détection : nl-BE et nl → néerlandais, le reste → français", () => {
    expect(detectLocale(["nl-BE", "fr"])).toBe("nl");
    expect(detectLocale(["nl"])).toBe("nl");
    expect(detectLocale(["fr-BE"])).toBe("fr");
    expect(detectLocale(["en-GB", "nl-BE"])).toBe("nl");
    expect(detectLocale(["de-DE"])).toBe("fr");
    expect(detectLocale([])).toBe("fr");
  });

  it("dates, heures et montants suivent la langue", () => {
    activate("nl");
    expect(longDate("2026-10-10")).toBe("zaterdag 10 oktober");
    expect(stayRange("2026-10-23", "2026-10-30")).toBe("van 23 tot 30 oktober");
    expect(hourLabel("16:00")).toBe("16 u");
    expect(hourLabel("10:30")).toBe("10.30 u");
    expect(eur(120550)).toBe("€ 1.205,50");
    expect(daySentence(2, 1)).toBe("Een vertrek en twee aankomsten.");
    activate("fr");
    expect(longDate("2026-11-01")).toBe("dimanche 1er novembre");
    expect(eur(120550).replace(/[\u202f\u00a0]/g, " ")).toBe("1 205,50 €");
  });

  it("Réglages › Cet appareil : Nederlands bascule l'écran et reste retenu", async () => {
    const user = userEvent.setup();
    renderApp("/reglages");
    await screen.findByRole("heading", { name: "Réglages" });
    await user.click(screen.getByRole("button", { name: "Nederlands" }));
    expect(await screen.findByRole("heading", { name: "Instellingen" })).toBeInTheDocument();
    expect(screen.getByText("Dit toestel")).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_KEY)).toBe("nl");
    expect(document.documentElement.lang).toBe("nl-BE");
    await user.click(screen.getByRole("button", { name: "Français" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Réglages" })).toBeInTheDocument());
  });
});
