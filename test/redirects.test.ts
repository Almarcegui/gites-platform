// Issue #38 — redirections permanentes depuis l'ancien WordPress.
//
// Deux choses se testent ici, et la seconde est la plus importante :
//  1. les correspondances elles-mêmes (une ancienne adresse → UNE page qui
//     existe, en une seule étape) ;
//  2. le fait que RIEN ne s'applique tant que le Worker ne répond pas sur le
//     domaine définitif. C'est ce qui empêche une 301 fausse de se graver dans
//     les caches pendant la phase de test.
import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FINAL_HOSTS,
  WP_A_CONFIRMER,
  WP_PREFIX_REDIRECTS,
  WP_REDIRECTS,
  normalizeWpPath,
  resolveWpRedirect,
  wpRedirect,
  wpRedirectsActive,
} from "../src/services/redirects";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const FINAL_HOST = FINAL_HOSTS[0]!;
const at = (host: string, path: string): URL => new URL(`https://${host}${path}`);

describe("mode inactif — tant que le domaine définitif n'est pas branché", () => {
  it("aucune redirection sur le domaine de test workers.dev", () => {
    for (const path of ["/les-activites/", "/ce-quil-faut-savoir/", "/category/recettes/"]) {
      expect(wpRedirect(at("gites-platform.j-decartier.workers.dev", path))).toBeNull();
    }
  });

  it("aucune redirection en local", () => {
    expect(wpRedirect(new URL("http://localhost:8788/les-activites/"))).toBeNull();
    expect(wpRedirectsActive(new URL("http://localhost:8788/"))).toBe(false);
  });

  it("la correspondance existe pourtant déjà — seule l'activation manque", () => {
    // Sans cette distinction, « ça ne redirige pas » pourrait aussi bien
    // vouloir dire « la table est vide » le jour de la bascule.
    expect(resolveWpRedirect("/les-activites/")).toBe("/que-faire/");
  });
});

describe("mode actif — le Worker répond à la place du WordPress", () => {
  it("redirige en 301 les deux pages renommées", () => {
    const activites = wpRedirect(at(FINAL_HOST, "/les-activites/"));
    expect(activites?.status).toBe(301);
    expect(activites?.headers.get("location")).toBe("/que-faire/");

    const savoir = wpRedirect(at(FINAL_HOST, "/ce-quil-faut-savoir/"));
    expect(savoir?.status).toBe(301);
    expect(savoir?.headers.get("location")).toBe("/infos-pratiques/");
  });

  it("redirige les sous-pages rapatriées vers leur nouvelle adresse racine", () => {
    for (const [ancienne, nouvelle] of [
      ["/les-activites/le-bain-chaud/", "/le-bain-chaud/"],
      ["/les-activites/le-sauna/", "/le-sauna/"],
      ["/les-activites/le-four-a-pain/", "/le-four-a-pain/"],
      ["/les-activites/les-promenades/", "/les-promenades/"],
    ] as const) {
      expect(wpRedirect(at(FINAL_HOST, ancienne))?.headers.get("location")).toBe(nouvelle);
    }
  });

  it("renvoie les archives WordPress vers la page la plus proche", () => {
    expect(wpRedirect(at(FINAL_HOST, "/category/recettes/"))?.headers.get("location")).toBe("/que-manger/");
    expect(wpRedirect(at(FINAL_HOST, "/category/activites/page/2/"))?.headers.get("location")).toBe("/que-faire/");
    // archive sans équivalent thématique : l'accueil, pas une page inventée
    expect(wpRedirect(at(FINAL_HOST, "/tag/ardenne/"))?.headers.get("location")).toBe("/");
    expect(wpRedirect(at(FINAL_HOST, "/author/admin/"))?.headers.get("location")).toBe("/");
  });

  it("conserve la chaîne de requête (paramètres de campagne)", () => {
    const res = wpRedirect(at(FINAL_HOST, "/les-activites/?utm_source=newsletter"));
    expect(res?.headers.get("location")).toBe("/que-faire/?utm_source=newsletter");
  });

  it("ne touche jamais à l'application (API, iCal, tunnel, back-office)", () => {
    for (const path of ["/api/public/today", "/ical/abc.ics", "/book/", "/admin/", "/img/moulin.jpg"]) {
      expect(wpRedirect(at(FINAL_HOST, path))).toBeNull();
    }
  });

  it("laisse l'accueil et les pages actuelles répondre 200", () => {
    for (const path of ["/", "/que-faire/", "/infos-pratiques/", "/le-sauna/", "/histoire/"]) {
      expect(wpRedirect(at(FINAL_HOST, path))).toBeNull();
    }
  });
});

describe("normalisation des anciennes adresses", () => {
  it("ignore le slash final, la casse et les index.html/php hérités", () => {
    expect(normalizeWpPath("/Les-Activites/")).toBe("/les-activites");
    expect(normalizeWpPath("/les-activites")).toBe("/les-activites");
    expect(normalizeWpPath("/les-activites/index.php")).toBe("/les-activites");
    expect(normalizeWpPath("/")).toBe("/");
  });

  it("une même page redirige pareil avec ou sans slash final", () => {
    expect(resolveWpRedirect("/les-activites")).toBe(resolveWpRedirect("/les-activites/"));
  });
});

describe("cohérence de la table (définition de fini de l'issue)", () => {
  const targets = [...Object.values(WP_REDIRECTS), ...WP_PREFIX_REDIRECTS.map((r) => r.to)];

  it("aucune chaîne de redirections : une cible n'est jamais elle-même une source", () => {
    for (const target of targets) {
      expect(resolveWpRedirect(target)).toBeNull();
    }
  });

  it("chaque cible correspond à une page qui existe vraiment dans public/", () => {
    const pages = new Set(
      readdirSync(publicDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(`${publicDir}/${e.name}/index.html`))
        .map((e) => `/${e.name}/`),
    );
    pages.add("/"); // public/index.html
    for (const target of new Set(targets)) {
      expect({ target, existe: pages.has(target) }).toEqual({ target, existe: true });
    }
  });

  it("les adresses non confirmées ne sont PAS appliquées", () => {
    // Elles attendent l'export Search Console : une 301 fausse se cache des
    // mois, une 404 se corrige le jour même.
    for (const path of WP_A_CONFIRMER) {
      expect(resolveWpRedirect(path)).toBeNull();
    }
  });
});
