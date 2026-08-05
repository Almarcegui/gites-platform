// Réglages clé/valeur en base — pour tout ce qui doit être modifiable depuis
// le back-office sans redéploiement (jetons Beds24 notamment). Les secrets
// d'environnement restent le repli quand la clé n'existe pas en base.

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(key, value)
    .run();
}
