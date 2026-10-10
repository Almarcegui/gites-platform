// Petits outils de jeton partagés (liens de partage du ménage, sessions).
// Web Crypto seulement : la même chose tourne sur Workers et sur Node 22.

/** SHA-256 en hexadécimal d'une chaîne. */
export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Jeton aléatoire de `bytes` octets, en hexadécimal (32 octets = 64 caractères). */
export function randomHex(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}
