// Jeton de la page Merci — renvoi de la confirmation à une autre adresse.
//
// La page Merci (`/book/merci.html?ref=…`) sait déjà s'authentifier par le
// couple référence + e-mail, comme le voucher. Deux cas lui échappent :
// - une réservation SANS e-mail (option du back-office payée par un lien
//   transmis autrement) : il n'y a pas d'adresse à mettre dans l'URL ;
// - le droit de renvoyer la confirmation ne doit pas reposer sur la seule
//   référence, séquentielle et devinable (`PM-2026-007`).
//
// D'où un jeton `k` ajouté à l'URL de retour du paiement : HMAC de l'id et de
// la référence de la réservation. Aucune colonne, aucune migration : la clé est
// DÉRIVÉE d'ADMIN_TOKEN avec un domaine séparé, comme la session du tunnel
// (hold-session.ts), et ne sert qu'à ça. Sans ADMIN_TOKEN, pas de jeton
// (fail-closed) : la page retombe sur le couple référence + e-mail.

const DOMAIN_SEPARATION = "gites-platform|merci|v1";

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

/** Jeton de la page Merci pour cette réservation (null = fonction OFF). */
export async function merciToken(env: Env, booking: { id: number; reference: string }): Promise<string | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${DOMAIN_SEPARATION}|${booking.id}|${booking.reference}`));
  return b64url(mac).slice(0, 32);
}

/** Comparaison à temps constant. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Le jeton présenté est-il celui de cette réservation ? Absent, tronqué ou
 *  faux : non. Sans ADMIN_TOKEN : toujours non. */
export async function verifyMerciToken(env: Env, booking: { id: number; reference: string }, given: string | null | undefined): Promise<boolean> {
  if (!given || given.length > 64) return false;
  const expected = await merciToken(env, booking);
  return expected != null && safeEqual(expected, given);
}
