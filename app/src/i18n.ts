import { i18n } from "@lingui/core";

import { messages as fr } from "./locales/fr/messages.po";
import { messages as nl } from "./locales/nl/messages.po";

// Langue de l'écran : français (langue source) ou néerlandais de Belgique
// (lot 3, issue #34). Le choix fait dans Réglages › Cet appareil est retenu sur
// l'appareil ; sans choix, on suit la langue du navigateur (nl-BE, nl… →
// néerlandais ; tout le reste → français). Les catalogues sont compilés par le
// greffon Lingui de Vite : en build, le code ne garde que les identifiants.
export type Locale = "fr" | "nl";
export const LOCALES: Locale[] = ["fr", "nl"];
export const LOCALE_KEY = "gp2_lang";

i18n.load({ fr, nl });

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return v === "fr" || v === "nl" ? v : null;
  } catch {
    return null;
  }
}

/** Langue du navigateur ramenée à fr ou nl. */
export function detectLocale(langs: readonly string[] = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []): Locale {
  for (const l of langs) {
    const base = (l ?? "").toLowerCase().split("-")[0];
    if (base === "nl") return "nl";
    if (base === "fr") return "fr";
  }
  return "fr";
}

export function activate(locale: Locale): void {
  i18n.activate(locale);
  if (typeof document !== "undefined") document.documentElement.lang = locale === "nl" ? "nl-BE" : "fr-BE";
}

/** Choix explicite (Réglages › Cet appareil), retenu sur l'appareil. */
export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    /* navigation privée : le choix vaut pour cette visite */
  }
  activate(locale);
}

/** Choix retenu, sinon langue du navigateur. */
export function initialLocale(): Locale {
  return stored() ?? detectLocale();
}

// En essai (vitest), toujours le français, sauf choix explicite du test.
activate(import.meta.env.MODE === "test" ? "fr" : initialLocale());

export { i18n };
