import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

// Textes de l'écran écrits en français (langue source) et rendus traduisibles.
// Une seule langue pour le pilote ; le néerlandais (plan v4, fonction 11)
// viendra avec son catalogue, sans toucher au code.
export default defineConfig({
  sourceLocale: "fr",
  locales: ["fr"],
  format: formatter({ lineNumbers: false }),
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["<rootDir>/src"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "<rootDir>/src/test/**"],
    },
  ],
});
