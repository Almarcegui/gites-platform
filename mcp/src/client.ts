// Client HTTP de l'API admin de la plateforme Gîtes.
//
// Authentification : POST /api/admin/login {user, password}.
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

/** Erreur réseau ou délai dépassé : pour une écriture, l'état réel est INCONNU. */
export class NetworkError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GitesConfig {
  const baseUrl = (env.GITES_URL ?? "").trim().replace(/\/+$/, "");
  const user = (env.GITES_ID ?? "").trim();
  let password = env.GITES_MDP ?? "";
  // Variante sans mot de passe en clair dans un fichier de configuration :
  // GITES_MDP_TROUSSEAU=<service> lit le trousseau macOS (compte = GITES_ID).
  const service = (env.GITES_MDP_TROUSSEAU ?? "").trim();
  if (!password && service && user) password = readKeychain(service, user);
  const missing = [!baseUrl && "GITES_URL", !user && "GITES_ID", !password && "GITES_MDP (ou GITES_MDP_TROUSSEAU)"].filter(Boolean);
  if (missing.length) throw new Error(`variables d'environnement manquantes : ${missing.join(", ")}`);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("GITES_URL invalide (attendu : https://… ou http://localhost:PORT)");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Le mot de passe admin ne voyage jamais en clair hors de la machine.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("GITES_URL doit être en https:// (http:// accepté seulement pour localhost)");
  }
  const timeoutMs = Number(env.GITES_TIMEOUT_MS ?? "") || undefined;
  return { baseUrl, user, password, timeoutMs };
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
      throw new NetworkError(`${reason} (${this.cfg.baseUrl})`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  /** Appel authentifié. `path` inclut la requête (?a=b). Lève ApiError si status ≥ 400. */
  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    await this.#ensureLogin();
    const started = Date.now();
    let res = await this.#raw(method, path, body, this.#bearer);
    if (res.status === 401) {
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
