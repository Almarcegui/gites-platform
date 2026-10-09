// Config Vitest — pool Node standard.
//
// ⚠️ POURQUOI PAS @cloudflare/vitest-pool-workers : son service de fallback de
// modules ne résout plus rien quand le chemin du projet contient un emoji
// (`🔧 Dev/…`). Vérifié le 2026-07-12 : suite identique verte dans un chemin
// ASCII, ERR_RUNTIME_FAILURE (No such module "node:vm") depuis le vault.
// Les tests qui ont besoin d'une VRAIE base D1 passent par Miniflare piloté
// directement (test/helpers/d1.ts) — même moteur workerd, même sémantique
// SQLite, et ça fonctionne depuis ce chemin.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // mcp/ = connecteur Claude, paquet Node à part (ses propres dépendances et
    // sa propre suite : `cd mcp && npm test`).
    exclude: [...configDefaults.exclude, "mcp/**", ".worktrees/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
