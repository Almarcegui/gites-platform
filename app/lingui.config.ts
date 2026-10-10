import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

// Textes de l'écran écrits en français (langue source), traduits en
// néerlandais de Belgique (lot 3, issue #34). `npm run textes` met les deux
// catalogues à jour ; une phrase nouvelle arrive en nl avec un msgstr vide
// (affichée en français tant qu'elle n'est pas traduite : scripts/i18n-nl.mjs le signale).
export default defineConfig({
  sourceLocale: "fr",
  locales: ["fr", "nl"],
  format: formatter({ lineNumbers: false }),
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["<rootDir>/src"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "<rootDir>/src/test/**"],
    },
  ],
});
