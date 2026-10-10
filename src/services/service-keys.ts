// Accès de service : des clés d'API pour Claude et les scripts du Mac, sans
// compte humain (demande de Julien du 10/10/2026, table service_keys, migration 0024).
//
// - Clé : « gsk_ » + 32 octets aléatoires en hexadécimal, présentée en
//   `Authorization: Bearer svc:<clé>`. Seul son SHA-256 est stocké : une fuite
//   de la base ne la rend pas rejouable. Elle n'est montrée qu'à la création.
// - Droits : admin (ceux d'un compte du back-office). La création et la
//   révocation, elles, restent réservées aux humains (garde dans admin.ts).
// - Révoquer pose revoked_at ; la ligne reste, pour le journal.
// - last_used_at est rafraîchi au plus toutes les 5 minutes : pas une écriture
//   par requête.

export interface ServiceKeyRow {
  id: number;
  name: string;
  keyHint: string;
  role: string;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export const SERVICE_KEY_PREFIX = "gsk_";
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function validServiceKeyName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Crée une clé ; rend la clé en clair (une seule fois) et sa ligne. */
export async function createServiceKey(
  db: D1Database,
  name: string,
  createdBy: string,
): Promise<{ key: string; row: ServiceKeyRow }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = SERVICE_KEY_PREFIX + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hint = `${key.slice(0, 8)}…${key.slice(-4)}`;
  const res = await db
    .prepare("INSERT INTO service_keys (name, key_hash, key_hint, role, created_by) VALUES (?1, ?2, ?3, 'admin', ?4)")
    .bind(name, await sha256hex(key), hint, createdBy)
    .run();
  const row = await getServiceKey(db, res.meta.last_row_id);
  return { key, row: row! };
}

function mapRow(r: Record<string, unknown>): ServiceKeyRow {
  return {
    id: Number(r.id), name: String(r.name), keyHint: String(r.key_hint), role: String(r.role),
    createdBy: (r.created_by as string | null) ?? null, createdAt: String(r.created_at),
    lastUsedAt: (r.last_used_at as string | null) ?? null, revokedAt: (r.revoked_at as string | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
  };
}

const COLUMNS = "id, name, key_hint, role, created_by, created_at, last_used_at, revoked_at, revoked_by";

export async function getServiceKey(db: D1Database, id: number): Promise<ServiceKeyRow | null> {
  const r = await db.prepare(`SELECT ${COLUMNS} FROM service_keys WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
  return r ? mapRow(r) : null;
}

export async function listServiceKeys(db: D1Database): Promise<ServiceKeyRow[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM service_keys ORDER BY revoked_at IS NOT NULL, name`).all<Record<string, unknown>>();
  return results.map(mapRow);
}

/** Révoque ; false si inconnue ou déjà révoquée. */
export async function revokeServiceKey(db: D1Database, id: number, by: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE service_keys SET revoked_at = datetime('now'), revoked_by = ?2 WHERE id = ?1 AND revoked_at IS NULL")
    .bind(id, by)
    .run();
  return res.meta.changes === 1;
}

/** Nom de la clé si elle est valide et non révoquée, sinon null. */
export async function resolveServiceKey(db: D1Database, presented: string): Promise<string | null> {
  if (!presented.startsWith(SERVICE_KEY_PREFIX) || presented.length > 200) return null;
  const hash = await sha256hex(presented);
  const row = await db
    .prepare("SELECT id, name FROM service_keys WHERE key_hash = ?1 AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: number; name: string }>();
  if (!row) return null;
  await db
    .prepare(
      "UPDATE service_keys SET last_used_at = datetime('now') WHERE id = ?1 " +
        "AND (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes'))",
    )
    .bind(row.id)
    .run();
  return row.name;
}
