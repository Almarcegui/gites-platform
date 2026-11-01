// Export complet de la base en SQL (schéma + données), lisible par sqlite3.
//
// Sert GET /api/admin/export.sql sur les deux cibles : sur Workers, c'est la
// seule voie (D1 n'expose pas son fichier) ; sur Node, l'export binaire
// /api/admin/export.sqlite (VACUUM INTO, instantané transactionnel) est
// préféré par la sauvegarde de nuit — celui-ci lit les tables l'une après
// l'autre et n'est donc cohérent qu'à la table près si une écriture arrive
// pendant l'export.
//
// Format : celui de `sqlite3 .dump` (PRAGMA foreign_keys=OFF, une transaction,
// CREATE puis INSERT par table, index et déclencheurs à la fin) — rejouable tel
// quel dans une base vide, et vérifié comme tel par scripts/sauvegarde_nuit.py.

/** Tables internes jamais exportées : SQLite (sqlite_*) et Cloudflare (_cf_*). */
function exportable(name: string): boolean {
  return !name.startsWith("sqlite_") && !name.startsWith("_cf_");
}

/** Colonnes SECRÈTES jamais écrites dans une sauvegarde (clés Stripe secrètes et
 *  secrets de webhook, migration 0030) : la sauvegarde part vers le Mac puis vers
 *  Google Drive, ce n'est pas leur place. Restaurer une base oblige donc à les
 *  ressaisir dans Réglages > Comptes Stripe (la clé publiable, publique, est gardée). */
export const REDACTED_COLUMNS: Record<string, string[]> = {
  property_stripe: ["secret_key", "webhook_secret"],
};

/** Réglages SECRETS (app_settings) vidés à l'export : le refresh token Beds24 donne
 *  la main sur le channel manager. Après une restauration, relier Beds24 par un
 *  code d'invitation (Réglages > Canaux OTA), et reposer la clé du webhook Beds24.
 *  Même liste dans node/sqlite-d1.mjs. Les adresses des agendas lus (`ical_feeds.url`,
 *  liens privés Google) sont vidées aussi, avec leur recopie au journal d'audit :
 *  après une restauration, les ressaisir dans la page iCal. */
export const REDACTED_SETTINGS = ["beds24_refresh_token", "beds24_webhook_key"];

/** Préfixe des jetons iCal remplacés à l'export : `units.ical_token` est l'adresse
 *  secrète du calendrier exporté (NOT NULL UNIQUE) ; la sauvegarde en porte un neuf,
 *  connu de personne. Après une restauration, régénérer le jeton de chaque bien
 *  (POST /api/admin/units/:id/ical-token) et réabonner les calendriers. */
export const REDACTED_ICAL_PREFIX = "expurge-";

/** Détail d'audit JSON sans son champ `url` (illisible → vidé, par prudence). */
function withoutUrl(detail: unknown): unknown {
  if (typeof detail !== "string" || !detail.includes("url")) return detail;
  try {
    const d = JSON.parse(detail) as Record<string, unknown>;
    if (d && typeof d === "object" && "url" in d) d.url = "";
    return JSON.stringify(d);
  } catch {
    return "";
  }
}

function freshIcalToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return REDACTED_ICAL_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  if (Array.isArray(v)) {
    // D1 rend parfois un BLOB comme tableau d'octets
    return `X'${v.map((b) => (Number(b) & 0xff).toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function exportSql(db: D1Database, now: Date = new Date()): Promise<{ sql: string; tables: number; rows: number }> {
  const { results } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
    .all<{ type: string; name: string; tbl_name: string; sql: string }>();
  const objects = results.filter((o) => exportable(o.name) && exportable(o.tbl_name));
  const out: string[] = [
    `-- Export de la base des gîtes, ${now.toISOString()}`,
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
  ];
  let tables = 0;
  let rows = 0;
  for (const t of objects.filter((o) => o.type === "table")) {
    tables += 1;
    out.push(`${t.sql};`);
    const data = await db.prepare(`SELECT * FROM ${quoteIdent(t.name)}`).all<Record<string, unknown>>();
    for (const r of data.results) {
      const redacted = REDACTED_COLUMNS[t.name] ?? [];
      for (const c of redacted) if (c in r) r[c] = null;
      if (t.name === "app_settings" && REDACTED_SETTINGS.includes(String(r.key))) r.value = "";
      if (t.name === "units" && "ical_token" in r) r.ical_token = freshIcalToken();
      if (t.name === "ical_feeds" && "url" in r) r.url = "";
      if (t.name === "audit_log" && String(r.action).startsWith("ical_feed.")) r.detail = withoutUrl(r.detail);
      const cols = Object.keys(r);
      out.push(
        `INSERT INTO ${quoteIdent(t.name)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map((c) => sqlValue(r[c])).join(", ")});`,
      );
      rows += 1;
    }
  }
  for (const o of objects.filter((x) => x.type !== "table")) out.push(`${o.sql};`);
  out.push("COMMIT;");
  return { sql: out.join("\n") + "\n", tables, rows };
}
