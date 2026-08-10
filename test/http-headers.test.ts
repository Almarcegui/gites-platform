// Issue #22 — en-têtes de sécurité et de cache sur TOUTES les réponses du
// Worker. Le portage Node les posait déjà ; la production, elle, n'en posait
// aucun. Ces tests verrouillent l'alignement des deux runtimes.
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { cacheControlFor, withStandardHeaders } from "../src/services/http-headers";

/** Binding ASSETS simulé : rend ce qu'on lui demande, comme le ferait
 *  Cloudflare pour un fichier de `public/`. */
function assetsReturning(body: string, contentType: string): Fetcher {
  return {
    fetch: async () => new Response(body, { headers: { "content-type": contentType } }),
  } as unknown as Fetcher;
}

function envWith(assets: Fetcher): Env {
  return {
    DB: undefined as unknown as D1Database,
    ASSETS: assets,
    PUBLIC_BASE_URL: "https://test.local",
    EMAILS_ENABLED: "false",
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function call(url: string, assets = assetsReturning("<html></html>", "text/html; charset=utf-8")) {
  return worker.fetch(new Request(url), envWith(assets), ctx);
}

describe("en-têtes de sécurité", () => {
  it("pose les quatre en-têtes de sécurité sur une page HTML servie par les assets", async () => {
    const res = await call("https://test.local/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("pose aussi les en-têtes sur une réponse d'API (404 JSON)", async () => {
    const res = await call("https://test.local/api/route-qui-nexiste-pas");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("annonce la CSP en observation, jamais en mode bloquant", async () => {
    const res = await call("https://test.local/");
    expect(res.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy-report-only")).toContain("frame-ancestors 'none'");
    // Le jour où cette assertion tombe, c'est que quelqu'un a rendu la CSP
    // bloquante : le site public contient encore des scripts en ligne.
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("n'annonce pas HSTS en clair (http local) — les navigateurs l'ignorent de toute façon", async () => {
    const res = await call("http://localhost:8788/");
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("préserve le corps et le statut de la réponse d'origine", async () => {
    const res = await call("https://test.local/", assetsReturning("<html>bonjour</html>", "text/html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>bonjour</html>");
  });
});

describe("cache", () => {
  it("met les images en cache long et immuable", async () => {
    const res = await call("https://test.local/img/pont-entree.jpg", assetsReturning("binaire", "image/jpeg"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("empêche la mise en cache dure des pages HTML", async () => {
    const res = await call("https://test.local/book/", assetsReturning("<html></html>", "text/html; charset=utf-8"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("laisse un cache d'un jour aux autres fichiers statiques", async () => {
    const res = await call("https://test.local/admin/app.js", assetsReturning("//js", "text/javascript"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("n'écrase JAMAIS le cache-control décidé par un handler (no-store des API)", async () => {
    const res = await call("https://test.local/api/route-qui-nexiste-pas");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("cacheControlFor arbitre sur le chemin ET sur le type de contenu", () => {
    expect(cacheControlFor("/img/x.png", null)).toContain("immutable");
    expect(cacheControlFor("/media/x.png", "image/png")).toContain("immutable");
    expect(cacheControlFor("/", "text/html; charset=utf-8")).toBe("no-cache");
    expect(cacheControlFor("/style.css", "text/css")).toBe("public, max-age=86400");
  });

  it("ne casse pas une réponse sans corps (304)", () => {
    const res = withStandardHeaders(new Response(null, { status: 304 }), new URL("https://test.local/img/a.png"));
    expect(res.status).toBe(304);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
