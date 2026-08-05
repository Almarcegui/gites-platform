// Lanceur de migrations pour le déploiement Node/SQLite.
//
// Rejoue les migrations/*.sql dans l'ordre, une seule fois chacune, en gardant
// la trace dans `_migrations`. Même découpage naïf que le helper de tests —
// d'où la RÈGLE DE RÉDACTION du projet : jamais de `;` ni de `--` à
// l'intérieur d'un littéral SQL de migration.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export function splitStatements(sql) {
  const cleaned = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return cleaned
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Applique les migrations manquantes. Renvoie la liste des noms appliqués. */
export function applyMigrations(d1, migrationsDir) {
  const db = d1.raw;
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const done = new Set(db.prepare("SELECT name FROM _migrations").all().map((r) => r.name));

  const applied = [];
  for (const { name, sql } of readMigrationFiles(migrationsDir)) {
    if (done.has(name)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const stmt of splitStatements(sql)) db.exec(stmt);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
      applied.push(name);
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* déjà défaite */
      }
      throw new Error(`migration ${name} échouée : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return applied;
}
