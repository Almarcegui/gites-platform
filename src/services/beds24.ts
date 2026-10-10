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
const FETCH_TIMEOUT_MS = 30_000;

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
  /** `refus` : Beds24 a répondu non, rien n'a été appliqué. `inconnu` : panne
   *  réseau, délai ou erreur 5xx — une écriture a PU être appliquée. */
  constructor(message: string, public status?: number, public issue: "refus" | "inconnu" = "refus") {
    super(message);
  }
}

async function accessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  let res: Response;
  try {
    res = await fetch(`${BEDS24_API}/authentication/token`, {
      headers: { refreshToken: await refreshTokenValue(env) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Beds24Error(`renouvellement du token Beds24 injoignable (${e instanceof Error ? e.message : String(e)})`);
  }
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
  // Fermé par défaut (contrôle Codex 10/10/2026) : seule la production pose
  // BEDS24_WRITE_ENABLED="true" (wrangler.jsonc, env.production ; variable
  // d'environnement du site Node sur Infomaniak, cf. .env.example). Le https ne
  // suffit plus : l'environnement d'essai est en https et ne doit jamais
  // écrire dans le compte réel, même si on y colle un code d'invitation.
  return env.BEDS24_WRITE_ENABLED === "true";
}

/** L'API v2 répond parfois 200 avec un échec par élément
 *  ({ success:false, errors:[…] } par room) : un calendrier partiellement
 *  rejeté passait pour un push réussi. On remonte ces échecs en erreur. */
function collectFailures(data: unknown): string[] {
  const out: string[] = [];
  const describe = (item: Record<string, unknown>): string => {
    const errs = item.errors ?? item.error ?? item.message;
    const target = item.roomId ?? item.propertyId ?? item.id;
    // Format des écritures v2 (multiplePostResponse) : errors = [{ action,
    // field, message }] — rendu « champ : message » pour que l'erreur Beds24
    // remonte en clair jusqu'à l'écran, au lieu d'un JSON illisible.
    const text = Array.isArray(errs)
      ? errs
          .map((e) => {
            if (e && typeof e === "object") {
              const o = e as Record<string, unknown>;
              const field = typeof o.field === "string" && o.field ? `${o.field} : ` : "";
              return `${field}${typeof o.message === "string" ? o.message : JSON.stringify(o)}`;
            }
            return String(e);
          })
          .join(" ; ")
      : typeof errs === "string"
        ? errs
        : JSON.stringify(errs ?? "échec");
    return `${target != null ? `#${String(target)} ` : ""}${text}`;
  };
  // Les POST v2 (POST /properties, POST /inventory/rooms/calendar…) répondent
  // par un TABLEAU d'un résultat par élément envoyé, sans enveloppe `data` :
  // un refus y passait inaperçu.
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      // `success` n'est pas obligatoire dans multiplePostResponse : un élément
      // qui porte des `errors` sans se dire réussi est un échec.
      const hasErrors = Array.isArray(o.errors) && o.errors.length > 0;
      if (o.success === false || (o.success !== true && hasErrors)) out.push(describe(o));
    }
    return out;
  }
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
  init: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    query?: Record<string, string>;
    /** Reçoit les en-têtes de la réponse (quota X-FiveMinCreditLimit…), même en erreur. */
    onHeaders?: (headers: Headers) => void;
  } = {},
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
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { token, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      // Un appel qui pend indéfiniment tiendrait un verrou (création de
      // propriété) au-delà de son délai : on coupe à 30 s.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // Panne réseau ou délai dépassé : une Beds24Error, pour que l'appelant
    // la journalise et l'affiche en clair au lieu d'un 500 opaque. Pour une
    // écriture, l'issue est INCONNUE (Beds24 a pu l'appliquer).
    throw new Beds24Error(
      `Beds24 ${method} ${path} injoignable (${e instanceof Error ? e.message : String(e)})${method !== "GET" ? " — résultat inconnu côté Beds24" : ""}`,
      undefined,
      "inconnu",
    );
  }
  init.onHeaders?.(res.headers);
  const data = (await res.json().catch(() => ({}))) as T & { success?: boolean; error?: string };
  if (!res.ok) {
    throw new Beds24Error(`Beds24 ${path} → ${res.status} ${data.error ?? ""}`.trim(), res.status, res.status >= 500 ? "inconnu" : "refus");
  }
  const failures = collectFailures(data);
  if (failures.length > 0) {
    // Un élément refusé à côté d'un `new`/`modified` peut traduire une
    // application PARTIELLE (le POST n'est pas réputé atomique) : issue inconnue.
    const partial = Array.isArray(data) && data.some((i) => i && typeof i === "object" && ("new" in i || "modified" in i));
    throw new Beds24Error(
      `Beds24 ${path} → ${res.status} mais ${failures.length} élément(s) refusé(s) : ${failures.slice(0, 3).join(" · ")}`,
      res.status,
      partial ? "inconnu" : "refus",
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
export interface Beds24PropertySummary {
  id: number;
  name: string;
  roomTypes?: { id: number; name: string }[];
}

/** Identité du compte relié, telle que l'API la donne. L'API v2 n'expose PAS
 *  le nom d'utilisateur du compte (« gites-premore ») : seulement son numéro
 *  (`ownerId`), le nom donné au jeton à sa création et ses droits. */
export interface Beds24Compte {
  id: number | null;
  appareil: string | null;
  scopes: string[];
  /** Jeton restreint à une seule propriété (null = toutes). */
  limiteAPropriete: number | null;
}

function readCompte(details: unknown): Beds24Compte {
  const root = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
  const token = (root.token && typeof root.token === "object" ? root.token : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: n(token.ownerId),
    appareil: typeof token.deviceName === "string" ? token.deviceName : null,
    scopes: Array.isArray(token.scopes) ? token.scopes.filter((x): x is string => typeof x === "string") : [],
    limiteAPropriete: n(token.onlyPropertyId),
  };
}

/** Liste des propriétés du compte, avec leurs rooms. */
export async function beds24ListProperties(env: Env): Promise<Beds24PropertySummary[]> {
  // Réponse paginée (pages.nextPageExists) : une page manquée ferait croire
  // à un mapping périmé ou cacherait un homonyme — d'où un doublon.
  const all: Beds24PropertySummary[] = [];
  for (let page = 1; page <= 20; page++) {
    const props = await beds24Fetch<{ data?: Beds24PropertySummary[]; pages?: { nextPageExists?: boolean } }>(
      env,
      "/properties",
      { query: { includeAllRooms: "true", ...(page > 1 ? { page: String(page) } : {}) } },
    );
    all.push(...(props.data ?? []));
    if (!props.pages?.nextPageExists) break;
    if (page === 20) throw new Beds24Error("liste des propriétés Beds24 trop longue (plus de 20 pages)");
  }
  return all.map((p) => ({
    id: Number(p.id),
    name: String(p.name ?? ""),
    roomTypes: (p.roomTypes ?? []).map((r) => ({ id: Number(r.id), name: String(r.name ?? "") })),
  }));
}

export async function beds24Status(env: Env): Promise<{
  connected: boolean;
  account?: unknown;
  compte?: Beds24Compte;
  properties?: Beds24PropertySummary[];
  error?: string;
}> {
  if (!(await beds24Configured(env))) return { connected: false, error: "aucun refresh token Beds24 (base ou secret)" };
  try {
    const details = await beds24Fetch<{ data?: unknown }>(env, "/authentication/details");
    const properties = await beds24ListProperties(env);
    const account = details.data ?? details;
    return { connected: true, account, compte: readCompte(account), properties };
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

/** Quota de l'API v2 : des crédits sur une fenêtre glissante de 5 minutes,
 *  partagés par tous les jetons du compte. Lu dans les en-têtes de chaque
 *  réponse ; null quand Beds24 ne les envoie pas. */
export interface Beds24Credit {
  limit: number | null;
  remaining: number | null;
  resetsIn: number | null;
  cost: number | null;
}

export function readBeds24Credit(h: Headers): Beds24Credit {
  const n = (name: string): number | null => {
    const v = h.get(name);
    if (v == null || v.trim() === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    limit: n("X-FiveMinCreditLimit"),
    remaining: n("X-FiveMinCreditLimit-Remaining"),
    resetsIn: n("X-FiveMinCreditLimit-ResetsIn"),
    cost: n("X-RequestCost"),
  };
}
