// Client HTTP de l'API admin de la plateforme Gîtes.
//
// Authentification, au choix :
//  - GITES_SERVICE_KEY (clé d'accès de service, page Utilisateurs › Accès de
//    service) : `Bearer svc:<clé>` à chaque requête, sans connexion ; une
//    réponse 401 veut dire clé révoquée, jamais rejouée ;
//  - sinon POST /api/admin/login {user, password} :
//  - compte en base → { session } : on présente `Bearer session:<jeton>` ;
//  - accès de secours ADMIN_TOKEN → pas de session : on présente `Bearer id:mdp`
//    (la garde du Worker revérifie le couple à chaque requête).
// Une réponse 401 sur une session déclenche UNE reconnexion puis un nouvel essai :
// la garde refuse avant tout traitement, rejouer la requête est donc sans effet
// de bord. Les autres erreurs ne sont jamais rejouées automatiquement.

import { execFileSync } from "node:child_process";
import { logEvent } from "./log.js";

export interface GitesConfig {
  baseUrl: string;
  user: string;
  password: string;
  /** Clé d'accès de service : remplace user/password quand elle est posée. */
  serviceKey?: string;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

/** Erreur réseau, délai dépassé, réponse coupée ou illisible : pour une
 *  écriture, l'état réel est INCONNU (la requête a pu être traitée). */
export class NetworkError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GitesConfig {
  const baseUrl = (env.GITES_URL ?? "").trim().replace(/\/+$/, "");
  const serviceKey = (env.GITES_SERVICE_KEY ?? "").trim();
  const user = (env.GITES_ID ?? "").trim();
  let password = env.GITES_MDP ?? "";
  // Variante sans mot de passe en clair dans un fichier de configuration :
  // GITES_MDP_TROUSSEAU=<service> lit le trousseau macOS (compte = GITES_ID).
  const service = (env.GITES_MDP_TROUSSEAU ?? "").trim();
  if (!serviceKey && !password && service && user) password = readKeychain(service, user);
  const missing = serviceKey
    ? [!baseUrl && "GITES_URL"].filter(Boolean)
    : [!baseUrl && "GITES_URL", !user && "GITES_ID", !password && "GITES_MDP (ou GITES_MDP_TROUSSEAU, ou GITES_SERVICE_KEY)"].filter(Boolean);
  if (missing.length) throw new Error(`variables d'environnement manquantes : ${missing.join(", ")}`);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("GITES_URL invalide (attendu : https://… ou http://localhost:PORT)");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("GITES_URL doit être une simple origine (https://hôte[:port]), sans identifiant, chemin, requête ni fragment");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Le mot de passe admin ne voyage jamais en clair hors de la machine.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("GITES_URL doit être en https:// (http:// accepté seulement pour localhost)");
  }
  const timeoutMs = Number(env.GITES_TIMEOUT_MS ?? "") || undefined;
  return { baseUrl: url.origin, user, password, timeoutMs, ...(serviceKey ? { serviceKey } : {}) };
}

function readKeychain(service: string, account: string): string {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).replace(/\n$/, "");
  } catch {
    throw new Error(`mot de passe introuvable dans le trousseau (service « ${service} », compte « ${account} »)`);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class GitesClient {
  #bearer: string | null = null;
  #isSession = false;
  #login: Promise<void> | null = null;

  constructor(
    private readonly cfg: GitesConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  /** Nom d'hôte seul — c'est tout ce qu'on affiche ou journalise de l'URL. */
  get host(): string {
    return new URL(this.cfg.baseUrl).host;
  }

  /** GET non authentifié (sonde publique) : ne dépend pas de la connexion. */
  async publicGet<T>(path: string): Promise<{ status: number; body: T }> {
    const r = await this.#raw("GET", path, undefined, null);
    return { status: r.status, body: r.body as T };
  }

  async #doLogin(): Promise<void> {
    const res = await this.#raw("POST", "/api/admin/login", { user: this.cfg.user, password: this.cfg.password }, null);
    const body = res.body as { ok?: boolean; user?: string; session?: string } | null;
    if (res.status !== 200 || !body?.ok) {
      logEvent("login.refuse", { status: res.status });
      const err = (res.body && typeof res.body === "object" ? res.body : null) as Record<string, unknown> | null;
      throw new ApiError(res.status, `connexion refusée par la plateforme (${String(err?.error ?? res.status)}) — vérifier GITES_ID / GITES_MDP`, err);
    }
    if (body.session) {
      this.#bearer = `session:${body.session}`;
      this.#isSession = true;
    } else {
      // Accès de secours : l'identifiant renvoyé est normalisé (minuscules).
      this.#bearer = `${body.user ?? this.cfg.user}:${this.cfg.password}`;
      this.#isSession = false;
    }
    logEvent("login.ok", { mode: this.#isSession ? "session" : "secours" });
  }

  async #ensureLogin(force = false): Promise<void> {
    if (this.cfg.serviceKey) {
      this.#bearer = `svc:${this.cfg.serviceKey}`;
      return;
    }
    if (this.#bearer && !force) return;
    if (!this.#login) {
      this.#login = this.#doLogin().finally(() => {
        this.#login = null;
      });
    }
    await this.#login;
  }

  async #raw(
    method: Method,
    path: string,
    body: unknown,
    bearer: string | null,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? "délai dépassé" : "plateforme injoignable";
      throw new NetworkError(`${reason} (${this.host})`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new NetworkError(`réponse interrompue (${this.host}, HTTP ${res.status})`);
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Une réponse 2xx illisible ne prouve ni succès ni échec.
        if (res.status < 400) throw new NetworkError(`réponse illisible (${this.host}, HTTP ${res.status})`);
      }
    }
    return { status: res.status, body: parsed };
  }

  /** Appel authentifié. `path` inclut la requête (?a=b). Lève ApiError si status ≥ 400. */
  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    await this.#ensureLogin();
    const started = Date.now();
    let res = await this.#raw(method, path, body, this.#bearer);
    if (res.status === 401 && !this.cfg.serviceKey) {
      // Session expirée / révoquée (ou mot de passe changé) : une seule reconnexion.
      logEvent("session.renouvelee");
      this.#bearer = null;
      await this.#ensureLogin(true);
      res = await this.#raw(method, path, body, this.#bearer);
    }
    // Journal sans paramètres de requête : ils peuvent porter un nom de client.
    logEvent("http", { methode: method, route: routeTemplate(path), status: res.status, ms: Date.now() - started });
    if (res.status >= 400) {
      const b = (res.body && typeof res.body === "object" ? res.body : null) as Record<string, unknown> | null;
      const msg = typeof b?.error === "string" ? b.error : `erreur HTTP ${res.status}`;
      throw new ApiError(res.status, msg, b);
    }
    return res.body as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

/** /api/admin/bookings/12/cancel?x=1 → /api/admin/bookings/:n/cancel */
export function routeTemplate(path: string): string {
  return (path.split("?")[0] ?? "").replace(/\/\d+(?=\/|$)/g, "/:n");
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
