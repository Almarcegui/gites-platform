// Page de réservation dédiée au Pré Moré : /reserver/pre-more/.
//  · le domaine est fixé par la page (une ligne), jamais par l'adresse ;
//  · aucune page d'accueil multi-domaines ni choix de domaine ;
//  · seul le HTML est propre à la page : le JS et le CSS sont ceux de /book/ ;
//  · intégrable en iframe comme /book/, et seulement /book/ et /reserver/ ;
//  · les liens du site vers le Pré Moré passent par la page dédiée ;
//  · les liens de retour (voucher, annulation, relance) gardent le domaine.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import { isEmbeddablePath, withStandardHeaders } from "../src/services/http-headers";
import { bookingPath, DOMAIN_PAGES } from "../src/core/domain-pages";
import { DOMAIN_PAGES as DOMAIN_PAGES_JS, bookingPage } from "../public/book/pages.js";
import { resumeUrl } from "../src/services/relance";
import { WP_PREFIX_REDIRECTS, resolveWpRedirect } from "../src/services/redirects";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8");
const PAGE = read("reserver/pre-more/index.html");

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "admin" || n === "img" ? [] : htmlFiles(p)) : n.endsWith(".html") ? [p] : [];
  });
}

describe("page /reserver/pre-more/", () => {
  it("fixe le domaine par une seule ligne de configuration", () => {
    expect([...PAGE.matchAll(/data-property="/g)]).toHaveLength(1);
    expect(PAGE).toContain('<body data-property="pre-more">');
  });

  it("réutilise book.js et book.css par chemin absolu, sans dupliquer de code", () => {
    expect(PAGE).toContain('<script type="module" src="/book/book.js"></script>');
    expect(PAGE).toContain('href="/book/book.css"');
    // Le seul script est book.js : rien en ligne (compatible avec une CSP bloquante).
    expect([...PAGE.matchAll(/<script\b/g)]).toHaveLength(1);
  });

  it("ne montre ni accueil multi-domaines ni choix de domaine", () => {
    expect(PAGE).not.toContain('id="landing"');
    expect(PAGE).not.toMatch(/Choisissez votre domaine/);
  });

  it("garde noindex, titre, h1 et retour au site", () => {
    expect(PAGE).toContain('<meta name="robots" content="noindex">');
    expect(PAGE).toMatch(/<title>[^<]*Pré Moré[^<]*<\/title>/);
    expect(PAGE).toContain('<meta name="description"');
    expect(PAGE).toMatch(/<h1 id="propName"/);
    expect(PAGE).toMatch(/id="backSite" href="\/"/);
  });

  it("garde les mêmes éléments que le tunnel /book/ (hors accueil)", () => {
    const book = read("book/index.html");
    const ids = (h: string) => [...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!).filter((i) => i !== "landing").sort();
    expect(ids(PAGE)).toEqual(ids(book));
  });

  it("book.js : le domaine fixé par la page prime sur ?property=", () => {
    const js = read("book/book.js");
    expect(js).toContain("const PROPERTY = FIXED_PROPERTY ?? params.get(\"property\");");
    expect(js).toContain("document.body.dataset.property");
    // La clé de reprise locale est par domaine : un autre ?property= ne lit pas celle du Pré Moré.
    expect(js).toContain("gites-book:${PROPERTY}");
  });

  it("le Moulin n'a pas de page dédiée pour l'instant", () => {
    expect(Object.keys(DOMAIN_PAGES)).toEqual(["pre-more"]);
  });
});

describe("liens du site", () => {
  it("plus aucun lien du site vers /book/?property=pre-more", () => {
    const restes = htmlFiles(PUBLIC)
      .filter((f) => !f.includes("/public/book/") && !f.includes("/public/reserver/"))
      .filter((f) => readFileSync(f, "utf8").includes("/book/?property=pre-more"));
    expect(restes).toEqual([]);
    expect(read("site.js")).not.toContain("/book/?property=");
  });

  it("les liens du Moulin restent sur /book/", () => {
    expect(read("le-moulin-de-braives/index.html")).toContain("/book/?property=moulin-braives&amp;unit=le-moulin");
  });

  it("les liens par hébergement gardent le paramètre unit", () => {
    expect(read("la-scierie/index.html")).toContain("/reserver/pre-more/?unit=la-scierie");
    expect(read("la-maison-du-scieur/index.html")).toContain("/reserver/pre-more/?unit=maison-du-scieur");
    expect(read("index.html")).toContain("/reserver/pre-more/?unit=domaine-entier");
  });

  it("site.js : dates transmises à la page dédiée", () => {
    const js = read("site.js");
    expect(js).toContain("`/reserver/${PROPERTY}/?checkin=${selIn}&checkout=${selOut}`");
  });
});

describe("liens de retour", () => {
  it("la table des pages dédiées est la même en TypeScript et en JavaScript", () => {
    expect(DOMAIN_PAGES_JS).toEqual(DOMAIN_PAGES);
  });

  it("bookingPage : page dédiée pour le Pré Moré, tunnel générique pour le Moulin", () => {
    expect(bookingPage("pre-more")).toBe("/reserver/pre-more/");
    expect(bookingPage("moulin-braives")).toBe("/book/?property=moulin-braives");
    expect(bookingPage("")).toBe("/book/");
  });

  it("voucher et annulation rouvrent le domaine de la réservation, pas /book/ nu", () => {
    const voucher = read("book/voucher.html");
    expect(voucher).toContain("bookingPage(b.propertySlug)");
    expect(voucher).not.toContain('href="/book/"');
    const annule = read("book/annule.html");
    expect(annule).toContain("bookingPage(d.booking.propertySlug)");
  });

  it("le lien de relance du Pré Moré pointe la page dédiée, avec les dates", () => {
    const url = resumeUrl("http://test.local", {
      id: 1, reference: "AB-1", unitId: 2, unitSlug: "la-scierie", unitName: "La Scierie",
      propertyId: 1, propertySlug: "pre-more", guestFirstName: "Camille",
      guestEmail: "c@example.com", checkin: "2026-12-07", checkout: "2026-12-11",
      adults: 3, children: 0, holdExpiresAt: "2026-12-01 10:00:00",
    });
    expect(url.startsWith("http://test.local/reserver/pre-more/?")).toBe(true);
    expect(url).toContain("unit=la-scierie");
    expect(url).not.toContain("property=");
  });

  it("bookingPath : un domaine sans page dédiée garde ?property=", () => {
    expect(bookingPath("moulin-braives", new URLSearchParams({ unit: "le-moulin" }))).toBe("/book/?property=moulin-braives&unit=le-moulin");
  });

  it("/reserver/ n'est jamais redirigé par les règles de l'ancien WordPress", () => {
    expect(resolveWpRedirect("/reserver/pre-more/")).toBeNull();
    expect(WP_PREFIX_REDIRECTS.some((r) => "/reserver/pre-more/".startsWith(r.prefix))).toBe(false);
  });
});

describe("iframe et en-têtes", () => {
  const entete = (path: string) => withStandardHeaders(new Response("<html></html>", { headers: { "content-type": "text/html" } }), new URL(`https://test.local${path}`)).headers;

  it("/reserver/pre-more/ est intégrable comme /book/", () => {
    expect(entete("/reserver/pre-more/").get("x-frame-options")).toBeNull();
    expect(entete("/book/").get("x-frame-options")).toBeNull();
  });

  it("rien d'autre ne l'est (pas d'élargissement par préfixe)", () => {
    for (const p of ["/", "/la-scierie/", "/admin/", "/reserver", "/reserver-x/", "/booking/", "/api/public/today"]) {
      expect(entete(p).get("x-frame-options"), p).toBe("DENY");
    }
    expect(isEmbeddablePath("/reserver/pre-more/")).toBe(true);
    expect(isEmbeddablePath("/book/merci.html")).toBe(true);
  });

  it("même CSP (observation) que /book/, Stripe et Turnstile compris", () => {
    const a = entete("/reserver/pre-more/");
    const b = entete("/book/");
    expect(a.get("content-security-policy-report-only")).toBe(b.get("content-security-policy-report-only"));
    expect(a.get("content-security-policy")).toBeNull();
    expect(a.get("content-security-policy-report-only")).toContain("https://js.stripe.com");
  });

  it("le Worker sert /reserver/pre-more/ avec ces en-têtes", async () => {
    const env = {
      DB: undefined as unknown as D1Database,
      ASSETS: { fetch: async () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) } as unknown as Fetcher,
      PUBLIC_BASE_URL: "https://test.local",
      EMAILS_ENABLED: "false",
    } as Env;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://test.local/reserver/pre-more/"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain('data-property="pre-more"');
  });
});
