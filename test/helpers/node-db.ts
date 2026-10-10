// La MÊME base que sur le serveur Node (Infomaniak) : node:sqlite derrière
// l'adaptateur D1 de node/sqlite-d1.mjs, migrations rejouées par
// node/migrate.mjs. Sert à jouer une suite à la fois sur Workers (Miniflare,
// helpers/d1.ts) et sur Node, sans rien changer d'autre.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestDb } from "./d1";
// @ts-expect-error — module JavaScript du serveur Node, sans déclaration de types
import { openDatabase } from "../../node/sqlite-d1.mjs";
// @ts-expect-error — idem
import { applyMigrations } from "../../node/migrate.mjs";

export async function createNodeTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "gites-node-"));
  const db = openDatabase(join(dir, "test.db"));
  applyMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
  return {
    db: db as unknown as TestDb["db"],
    dispose: async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
