// Faux Cloudflare Access pour les tests : une paire RSA, ses certificats
// servis à l'adresse de l'équipe (fetch intercepté), et des jetons signés.
import { vi } from "vitest";
import { resetCfAccessCache } from "../../src/services/cf-access";

export const CF_TEAM = "equipe-test.cloudflareaccess.com";
export const CF_AUD = "aud-de-test-0123456789";

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface FakeAccess {
  env: { CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string };
  token(claims?: Record<string, unknown>, opts?: { kid?: string; sign?: CryptoKey }): Promise<string>;
  otherKey: CryptoKey;
  restore(): void;
}

export async function installFakeAccess(): Promise<FakeAccess> {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  const pair = await gen();
  const other = await gen();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "cle-1", alg: "RS256", use: "sig" };
  resetCfAccessCache();
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${CF_TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    return realFetch(input, init);
  });
  return {
    env: { CF_ACCESS_TEAM_DOMAIN: CF_TEAM, CF_ACCESS_AUD: CF_AUD },
    otherKey: other.privateKey,
    async token(claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "cle-1", typ: "JWT" }));
      const payload = b64url(JSON.stringify({ iss: `https://${CF_TEAM}`, aud: [CF_AUD], email: "julien@example.com", exp: now + 600, iat: now, ...claims }));
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.sign ?? pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
      return `${header}.${payload}.${b64url(sig)}`;
    },
    restore() {
      spy.mockRestore();
      resetCfAccessCache();
    },
  };
}
