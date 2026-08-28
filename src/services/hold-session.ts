// Session de réservation du tunnel public — issue #68.
//
// Le problème : le blocage de créneau (hold) est posé AVANT le paiement. Un
// retour arrière depuis Stripe, et le même visiteur qui relance sa recherche se
// voyait refuser SES PROPRES dates pendant 30 minutes. Il fallait donc pouvoir
// reconnaître « c'est le même client » entre deux requêtes.
//
// Le choix : un cookie SIGNÉ portant la référence de la réservation en cours.
// Pourquoi pas un identifiant en base ? Parce qu'il faudrait une colonne, donc
// une migration, pour une donnée dont la durée de vie est celle d'un hold
// (30 min). Pourquoi signé ? Parce que les références sont séquentielles et
// devinables (`PM-2026-007`) : sans signature, n'importe qui reprendrait la
// réservation d'un autre — et récupérerait son lien de paiement.
//
// La clé de signature est DÉRIVÉE d'ADMIN_TOKEN (secret déjà obligatoire, cf.
// CONTRIBUTING § 2) par un hachage à domaine séparé : le jeton lui-même ne
// sort jamais, et la clé ne sert qu'à ça. Sans ADMIN_TOKEN, la reprise est
// simplement désactivée (fail-closed) — le tunnel se comporte comme avant.

const COOKIE_NAME = "gp_hold";
const DOMAIN_SEPARATION = "gites-platform|hold-session|v1";
/** Marge au-delà du hold : le cookie doit survivre à l'aller-retour Stripe. */
const COOKIE_TTL_SECONDS = 2 * 60 * 60;

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signingKey(env: Env): Promise<CryptoKey | null> {
  const secret = env.ADMIN_TOKEN?.trim();
  if (!secret) return null;
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${DOMAIN_SEPARATION}|${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(env: Env, reference: string): Promise<string | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${DOMAIN_SEPARATION}|${reference}`));
  return b64url(mac).slice(0, 32);
}

/** Comparaison à temps constant — même principe que la vérification Stripe. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Valeur de cookie à poser après création d'un hold (null = fonction OFF). */
export async function holdCookieValue(env: Env, reference: string): Promise<string | null> {
  const sig = await sign(env, reference);
  return sig ? `${reference}.${sig}` : null;
}

function cookieAttributes(env: Env, maxAge: number): string {
  const secure = (env.PUBLIC_BASE_URL ?? "").startsWith("https://") ? "; Secure" : "";
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** En-tête Set-Cookie mémorisant la réservation en cours de ce visiteur. */
export async function setHoldCookie(env: Env, reference: string): Promise<Record<string, string>> {
  const value = await holdCookieValue(env, reference);
  if (!value) return {};
  return { "set-cookie": `${COOKIE_NAME}=${value}; ${cookieAttributes(env, COOKIE_TTL_SECONDS)}` };
}

/** En-tête Set-Cookie effaçant la session (hold repris, libéré ou confirmé). */
export function clearHoldCookie(env: Env): Record<string, string> {
  return { "set-cookie": `${COOKIE_NAME}=; ${cookieAttributes(env, 0)}` };
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Référence de la réservation en cours de ce visiteur, ou null.
 *
 *  Une signature absente, tronquée ou fausse renvoie null : le visiteur est
 *  alors traité comme un nouveau venu, jamais comme le propriétaire du hold. */
export async function readHoldReference(env: Env, req: Request): Promise<string | null> {
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const reference = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9-]{1,32}$/.test(reference)) return null;
  const expected = await sign(env, reference);
  return expected && safeEqual(expected, sig) ? reference : null;
}
