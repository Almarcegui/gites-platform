// Intégration Beds24 API v2 — le « tuyau certifié » vers les OTAs
// (Airbnb Preferred+, Booking.com, Vrbo) : notre plateforme reste la source de
// vérité, Beds24 n'est utilisé que pour pousser tarifs/disponibilités vers les
// annonces OTA et rapatrier leurs réservations. Réf : note projet
// « 2026-07-27 – API Airbnb, middleware & canaux de distribution – v2 ».
//
// Authentification (wiki.beds24.com, Category:API_V2) :
//   1. Invite code généré dans l'UI Beds24 (SETTINGS > MARKETPLACE > API,
//      https://beds24.com/control3.php?pagetype=apiv2) — valable 24 h.
//   2. GET /authentication/setup  (header `code`)   → { token, refreshToken }.
//   3. Le refresh token est ILLIMITÉ tant qu'il sert au moins tous les 30 jours
//      → stocké en secret (BEDS24_REFRESH_TOKEN, .dev.vars / wrangler secret).
//   4. GET /authentication/token  (header `refreshToken`) → token 24 h.
//
// Sans BEDS24_REFRESH_TOKEN : mode OFF — aucun appel réseau, la plateforme
// fonctionne exactement comme avant (le direct n'a pas besoin de Beds24).

import { getSetting } from "./settings";

const BEDS24_API = "https://api.beds24.com/v2";

/** Refresh token : la base (réglable depuis le back-office, page Canaux OTA)
 *  prime sur le secret d'environnement — le secret reste le repli. */
async function refreshTokenValue(env: Env): Promise<string> {
  const stored = (await getSetting(env.DB, "beds24_refresh_token"))?.trim() ?? "";
  return stored || env.BEDS24_REFRESH_TOKEN?.trim() || "";
}

export async function beds24Configured(env: Env): Promise<boolean> {
  return (await refreshTokenValue(env)) !== "";
}

/** À appeler quand le refresh token change (nouveau code d'invitation). */
export function resetBeds24TokenCache(): void {
  cachedToken = null;
}

/** Cache d'access token par isolate (durée de vie 24 h côté Beds24 —
 *  on garde une marge en le renouvelant au bout de 20 h). */
let cachedToken: { value: string; expiresAt: number } | null = null;

export class Beds24Error extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function accessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const res = await fetch(`${BEDS24_API}/authentication/token`, {
    headers: { refreshToken: await refreshTokenValue(env) },
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) {
    throw new Beds24Error(`échec du renouvellement de token Beds24 : ${data.error ?? res.status}`, res.status);
  }
  cachedToken = { value: data.token, expiresAt: Date.now() + 20 * 3600 * 1000 };
  return cachedToken.value;
}

/** Les ÉCRITURES sortantes sont réservées à la production.
 *
 *  Beds24 n'a pas de bac à sable et `.dev.vars` porte le vrai refresh token :
 *  une session locale (base de seed, prix TODO) pousserait des tarifs et des
 *  disponibilités faux sur 400 jours dans le compte réel — et demain jusqu'à
 *  Airbnb et Booking. Jusqu'ici, seule la panne DNS du VPN Emeria empêchait
 *  ça, par accident (audit ECC 2026-07-30). Les lectures restent libres. */
export function beds24WritesAllowed(env: Env): boolean {
  if (env.BEDS24_WRITE_ENABLED === "true") return true;
  return (env.PUBLIC_BASE_URL ?? "").startsWith("https://");
}

/** L'API v2 répond parfois 200 avec un échec par élément
 *  ({ success:false, errors:[…] } par room) : un calendrier partiellement
 *  rejeté passait pour un push réussi. On remonte ces échecs en erreur. */
function collectFailures(data: unknown): string[] {
  const out: string[] = [];
  const describe = (item: Record<string, unknown>): string => {
    const errs = item.errors ?? item.error ?? item.message;
    const target = item.roomId ?? item.propertyId ?? item.id;
    return `${target != null ? `#${String(target)} ` : ""}${typeof errs === "string" ? errs : JSON.stringify(errs ?? "échec")}`;
  };
  if (data && typeof data === "object") {
    const root = data as Record<string, unknown>;
    if (root.success === false) out.push(describe(root));
    const list = root.data;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object" && (item as Record<string, unknown>).success === false) {
          out.push(describe(item as Record<string, unknown>));
        }
      }
    }
  }
  return out;
}

/** Appel générique API v2 (JSON), token gérés automatiquement. */
export async function beds24Fetch<T>(
  env: Env,
  path: string,
  init: { method?: "GET" | "POST" | "DELETE"; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  if (!(await beds24Configured(env))) throw new Beds24Error("Beds24 non configuré (aucun refresh token en base ni en secret)");
  const method = init.method ?? "GET";
  if (method !== "GET" && !beds24WritesAllowed(env)) {
    throw new Beds24Error(
      `écriture Beds24 bloquée hors production (${method} ${path}) — poser BEDS24_WRITE_ENABLED=true pour forcer`,
    );
  }
  const token = await accessToken(env);
  const url = new URL(`${BEDS24_API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { token, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { success?: boolean; error?: string };
  if (!res.ok) throw new Beds24Error(`Beds24 ${path} → ${res.status} ${data.error ?? ""}`.trim(), res.status);
  const failures = collectFailures(data);
  if (failures.length > 0) {
    throw new Beds24Error(
      `Beds24 ${path} → 200 mais ${failures.length} élément(s) refusé(s) : ${failures.slice(0, 3).join(" · ")}`,
      res.status,
    );
  }
  return data;
}

/** Échange un invite code (généré dans l'UI) contre { token, refreshToken }.
 *  Utilisé une seule fois au setup — le refreshToken part en secret. */
export async function beds24Setup(inviteCode: string): Promise<{ token: string; refreshToken: string }> {
  const res = await fetch(`${BEDS24_API}/authentication/setup`, { headers: { code: inviteCode } });
  const data = (await res.json().catch(() => ({}))) as { token?: string; refreshToken?: string; error?: string };
  if (!res.ok || !data.token || !data.refreshToken) {
    throw new Beds24Error(`setup Beds24 refusé : ${data.error ?? res.status}`, res.status);
  }
  return { token: data.token, refreshToken: data.refreshToken };
}

/** Diagnostic de connexion : détails du compte + propriétés visibles.
 *  Sert à l'endpoint admin /api/admin/beds24/status. */
export async function beds24Status(env: Env): Promise<{
  connected: boolean;
  account?: unknown;
  properties?: { id: number; name: string; roomTypes?: { id: number; name: string }[] }[];
  error?: string;
}> {
  if (!(await beds24Configured(env))) return { connected: false, error: "aucun refresh token Beds24 (base ou secret)" };
  try {
    const details = await beds24Fetch<{ data?: unknown }>(env, "/authentication/details");
    const props = await beds24Fetch<{ data?: { id: number; name: string; roomTypes?: { id: number; name: string }[] }[] }>(
      env,
      "/properties",
      { query: { includeAllRooms: "true" } },
    );
    return { connected: true, account: details.data ?? details, properties: props.data ?? [] };
  } catch (e) {
    console.error("beds24Status —", e);
    // sonde réseau : distingue « sortie internet morte » de « Beds24 inaccessible »
    const probe = async (url: string) => {
      try {
        const r = await fetch(url, { method: "GET" });
        return `${r.status}`;
      } catch (pe) {
        return `KO: ${pe instanceof Error ? pe.message.slice(0, 60) : String(pe)}`;
      }
    };
    const probes = {
      "cloudflare.com/cdn-cgi/trace": await probe("https://www.cloudflare.com/cdn-cgi/trace"),
      "api.beds24.com sans auth": await probe("https://api.beds24.com/v2/authentication/details"),
    };
    return { connected: false, error: (e instanceof Error ? e.message : String(e)) + " | sondes: " + JSON.stringify(probes) };
  }
}
