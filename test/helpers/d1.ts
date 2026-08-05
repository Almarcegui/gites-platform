// Boot d'une vraie base D1 (workerd via Miniflare) pour les tests, avec les
// migrations du projet appliquées. Base en mémoire, isolée par instance.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";

export interface TestDb {
  db: D1Database;
  dispose: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const mf = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: "stub.mjs",
        contents: "export default { fetch() { return new Response('stub'); } };",
      },
    ],
    compatibilityDate: "2025-09-01",
    d1Databases: { DB: "gites-test" },
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const stmt of readMigrationStatements()) {
    await db.prepare(stmt).run();
  }
  return { db, dispose: () => mf.dispose() };
}

/** Lit et découpe les .sql de migrations. Splitter volontairement naïf :
 *  RÈGLE DE RÉDACTION des migrations du projet — jamais de `;` ni de `--`
 *  à l'intérieur d'un littéral SQL. */
function readMigrationStatements(): string[] {
  const dir = fileURLToPath(new URL("../../migrations", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const statements: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const cleaned = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const part of cleaned.split(";")) {
      const stmt = part.trim();
      if (stmt) statements.push(stmt);
    }
  }
  return statements;
}
