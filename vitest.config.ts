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
    // Les worktrees git d'agents (`.worktrees/<nom>/`) vivent DANS le clone :
    // sans cette exclusion, `npm test` lancé depuis le clone principal rejoue
    // aussi leurs suites — chaque test tourne N fois, sur du code qui n'est
    // pas celui de la branche courante.
    // `app/` (pilote du nouveau back-office) a ses propres essais, lancés par
    // son Vitest à lui (jsdom) : `npm --prefix app test`.
    exclude: [...configDefaults.exclude, ".worktrees/**", "app/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
