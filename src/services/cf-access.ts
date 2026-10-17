// Vérification du jeton Cloudflare Access (en-tête Cf-Access-Jwt-Assertion).
//
// Audit de sécurité du 17/10/2026 : la garde admin acceptait N'IMPORTE QUELLE
// valeur de cet en-tête comme preuve d'authentification. Sans ADMIN_TOKEN, un
// visiteur qui l'inventait ouvrait tout le back-office (export de la base
// compris), sur le Worker comme devant Node. Cloudflare demande de vérifier la
// signature du jeton dans l'application : c'est ce que fait ce module.
//
// Configuration (les deux sont nécessaires, sinon l'en-tête est IGNORÉ —
// fail-closed) :
//   CF_ACCESS_TEAM_DOMAIN  ex. « monequipe.cloudflareaccess.com »
//   CF_ACCESS_AUD          l'« Application Audience (AUD) Tag » de l'application Access
//
// Contrôles : RS256, clé publiée par l'équipe (`/cdn-cgi/access/certs`, mise
// en cache une heure), émetteur, audience, expiration et « pas avant ».

interface Jwk extends JsonWebKey {
  kid?: string;
}

const CERTS_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_S = 60;
let certsCache: { url: string; at: number; keys: Jwk[] } | null = null;

/** Pour les tests : oublie les clés mises en cache. */
export function resetCfAccessCache(): void {
  certsCache = null;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function jsonPart(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function teamDomain(raw: string | undefined): string | null {
  const d = (raw ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) ? d : null;
}

async function teamKeys(domain: string, refresh: boolean): Promise<Jwk[]> {
  const url = `https://${domain}/cdn-cgi/access/certs`;
  if (!refresh && certsCache && certsCache.url === url && Date.now() - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certificats Cloudflare Access indisponibles (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  certsCache = { url, at: Date.now(), keys };
  return keys;
}

/** Adresse e-mail (ou sujet) du jeton s'il est authentique et valide, sinon null. */
export async function verifyCfAccessJwt(
  env: Pick<Env, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD">,
  token: string | null,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const domain = teamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const aud = (env.CF_ACCESS_AUD ?? "").trim();
  if (!domain || !aud || !token || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  const header = jsonPart(h);
  const payload = jsonPart(p);
  if (!header || !payload || header.alg !== "RS256") return null;

  let signature: Uint8Array;
  try {
    signature = b64urlDecode(sig);
  } catch {
    return null;
  }
  const data = new TextEncoder().encode(`${h}.${p}`);
  const verifyWith = async (keys: Jwk[]): Promise<boolean | null> => {
    const key = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!key) return null;
    const { kid: _kid, ...jwk } = key;
    const ck = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", ck, signature as unknown as BufferSource, data as unknown as BufferSource);
  };
  let ok: boolean | null;
  try {
    ok = await verifyWith(await teamKeys(domain, false));
    // Clé inconnue : Cloudflare a peut-être tourné ses clés, on relit une fois.
    if (ok === null) ok = await verifyWith(await teamKeys(domain, true));
  } catch {
    return null;
  }
  if (!ok) return null;

  if (payload.iss !== `https://${domain}`) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp + CLOCK_SKEW_S < nowS) return null;
  if (payload.nbf != null && Number(payload.nbf) - CLOCK_SKEW_S > nowS) return null;
  const who = typeof payload.email === "string" ? payload.email : typeof payload.sub === "string" ? payload.sub : "";
  return who || "access";
}
