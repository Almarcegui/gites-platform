// Mini-routeur HTTP — zéro dépendance, patterns /a/:id/b.
// Le 5e argument (ctx) permet aux handlers de différer du travail après la
// réponse (ctx.waitUntil — ex. push temps réel vers Beds24) ; il est absent
// dans les tests, où les helpers retombent sur un await inline.
export type Handler = (
  req: Request,
  env: Env,
  params: Record<string, string>,
  url: URL,
  ctx?: ExecutionContext,
) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

export class Router {
  #routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    this.#routes.push({ method, pattern: path.split("/").filter(Boolean), handler });
    return this;
  }
  get(path: string, h: Handler): this { return this.on("GET", path, h); }
  post(path: string, h: Handler): this { return this.on("POST", path, h); }
  patch(path: string, h: Handler): this { return this.on("PATCH", path, h); }
  put(path: string, h: Handler): this { return this.on("PUT", path, h); }
  delete(path: string, h: Handler): this { return this.on("DELETE", path, h); }

  /** Retourne null si aucune route ne matche (le worker rendra alors les assets). */
  async handle(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== req.method) continue;
      const params = matchPattern(route.pattern, segments);
      if (params) return route.handler(req, env, params, url, ctx);
    }
    return null;
  }
}

function matchPattern(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = segments[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
    else if (p !== s) return null;
  }
  return params;
}

// --- helpers de réponses JSON ------------------------------------------------

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function apiError(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
