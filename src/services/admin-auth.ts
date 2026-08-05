// Comptes du back-office (table admin_users) + sessions à jeton.
//
// - Mots de passe : générés par la plateforme (jamais choisis) au format
//   « mot-mot-mot-NN » — dictables par téléphone, entropie correcte, et
//   stockés en PBKDF2-SHA256. Le nombre d'itérations reste modéré : la
//   limite CPU du plan Workers gratuit est de ~10 ms par requête, et la
//   robustesse vient d'abord du caractère aléatoire du mot de passe.
// - Sessions : jeton aléatoire remis au navigateur, seul son SHA-256 est
//   stocké — une fuite de la base ne permet pas de rejouer les sessions.

const PBKDF2_ITERATIONS = 30_000;
const SESSION_DAYS = 30;

const MOTS = (
  "moulin scierie riviere foret sentier cerise noyer tilleul granit sapin " +
  "pelouse verger ruche colline vallee cascade prairie chevre renard cerf " +
  "biche faucon merle pivert loutre truite brochet libellule papillon gland " +
  "chene erable bouleau frene meleze genet bruyere fougere mousse lichen " +
  "galet rocher grotte source etang ruisseau barrage pont lavoir fontaine " +
  "grange fenil etable moisson paille avoine seigle orge froment pommier " +
  "poirier prunier sureau noisetier chataigne airelle framboise groseille " +
  "sorbier aubepine clairiere taillis futaie lisiere combe crete versant " +
  "plateau falaise eboulis torrent meandre gue confluent berge ilot vasque"
).split(" ");

export interface AdminUserRow {
  id: number;
  username: string;
  active: number;
  created_at: string;
  last_login_at: string | null;
}

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    key,
    256,
  );
}

/** Génère un mot de passe « 3 mots + nombre » — même style que les accès initiaux. */
export function generatePassword(): string {
  const pick = () => {
    const idx = new Uint32Array(1);
    crypto.getRandomValues(idx);
    return MOTS[(idx[0] ?? 0) % MOTS.length] ?? "moulin";
  };
  const nn = new Uint32Array(1);
  crypto.getRandomValues(nn);
  return `${pick()}-${pick()}-${pick()}-${((nn[0] ?? 0) % 90) + 10}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt.buffer as ArrayBuffer)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const expected = b64decode(hashB64 ?? "");
  const actual = new Uint8Array(await pbkdf2(password, b64decode(saltB64 ?? ""), iterations));
  if (expected.length !== actual.length || expected.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
  return diff === 0;
}

/** Ouvre une session : renvoie le jeton en clair (remis une seule fois au navigateur). */
export async function createSession(db: D1Database, userId: number): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db
    .prepare("INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .bind(await sha256hex(token), userId, `+${SESSION_DAYS} days`)
    .run();
  await db.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?").bind(userId).run();
  return token;
}

/** Résout une session : nom d'utilisateur si le jeton est valide, actif et non expiré. */
export async function sessionUser(db: D1Database, token: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT u.username FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id " +
        "WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1",
    )
    .bind(await sha256hex(token))
    .first<{ username: string }>();
  return row?.username ?? null;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
}

/** Coupe toutes les sessions d'un compte (désactivation, reset de mot de passe). */
export async function deleteUserSessions(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(userId).run();
}

/** Ménage du cron : les sessions expirées ne servent plus à rien. */
export async function purgeExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')").run();
}
