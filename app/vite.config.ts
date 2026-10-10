/// <reference types="vitest/config" />
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// L'écran d'administration. Servi sous /admin/ par le Worker (binding ASSETS)
// et par node/server.mjs : même origine que l'API, donc ni CORS ni changement
// serveur. Le routeur travaille en hash (/admin/#/calendrier) : aucune
// réécriture d'URL côté serveur n'est requise. L'ancienne adresse /admin2/
// redirige ici (src/core/admin-redirect.ts).
//
// En travail : `npm run dev` à la racine lance wrangler dev (API + D1 locale),
// et `npm run dev` ici sert l'écran en renvoyant /api vers lui.
declare const process: { env: Record<string, string | undefined> };
const api = process.env.GITES_API ?? "http://127.0.0.1:8795";
// Lingui et Babel cherchent leurs réglages à partir du dossier courant : on
// leur donne celui-ci, pour que le build se lance aussi depuis la racine.
const ici = decodeURIComponent(new URL(".", import.meta.url).pathname);
process.env.LINGUI_CONFIG ??= `${ici}lingui.config.ts`;
if (process.env.VITEST) process.env.TZ ??= "Europe/Brussels";

export default defineConfig({
  base: "/admin/",
  plugins: [
    react(),
    lingui(),
    babel({ cwd: ici, presets: [linguiTransformerBabelPreset({ descriptorFields: "auto" })] }),
  ],
  server: {
    port: 5185,
    strictPort: true,
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
  // Dossier de build gitignoré ; pas de sourcemap (le code ne se publie pas).
  build: { outDir: "../public/admin", emptyOutDir: true, assetsDir: "assets", sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
