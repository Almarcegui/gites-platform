// Issue #57 — les dix recettes de l'ancien WordPress, rapatriées sur /recettes/.
//
// Trois choses se verrouillent ici :
//  1. la page existe, suit le gabarit des pages de contenu et porte bien les
//     dix recettes, chacune avec l'ancre que vise sa redirection 301 ;
//  2. plus AUCUN lien du site public ne sort vers `lesgitesdupremore.be` —
//     c'est la définition de fini de l'issue, et c'est le genre de régression
//     qui ne se voit que le jour où l'ancien site est débranché ;
//  3. les images de la page sont servies localement et respectent le plafond
//     de 300 Ko de l'issue #17.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, extname } from "node:path";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const read = (rel: string): string => readFileSync(join(publicDir, rel), "utf8");
const page = read("recettes/index.html");

/** Les dix articles du WordPress : ancre attendue → titre attendu.
 *  L'ordre est celui de la page ; les libellés sont ceux des articles. */
const RECETTES: readonly (readonly [string, string])[] = [
  ["truites-en-papillotes", "Filets de truites en papillotes sur lit de légumes"],
  ["truite-au-vin-jaune", "Truite au vin jaune"],
  ["tartare-de-truite", "Tartare de truite au brési"],
  ["truite-au-barbecue", "Truite en papillote au barbecue"],
  ["truite-farcie", "Truite farcie"],
  ["viandes-en-croute", "Recettes de viandes en croûte"],
  ["agneau", "Agneau | 6 heures à 85 °C"],
  ["dinde-en-daube", "Dinde en daube"],
  ["waterzooi", "Waterzooi"],
  ["carbonnade-flamande", "La carbonnade flamande (4 personnes)"],
];

describe("la page /recettes/ suit le gabarit des pages de contenu", () => {
  it("titre, description, canonical, nav et pied de page", () => {
    expect(page).toMatch(/<title>Les recettes — Les Gîtes du Pré Moré<\/title>/);
    expect(page).toMatch(/<meta name="description" content="[^"]{40,}">/);
    expect(page).toContain('<link rel="canonical" href="https://gites-platform.j-decartier.workers.dev/recettes/">');
    expect(page).toContain('<nav class="top">');
    expect(page).toContain("<footer>");
    expect(page).toContain('<script src="/nav.js" defer></script>');
    expect(page).toContain('<link rel="stylesheet" href="../site.css">');
  });

  it("respecte la politique d'indexation en vigueur, comme l'accueil", () => {
    const accueilNoindex = /<meta name="robots" content="noindex">/.test(read("index.html"));
    expect(/<meta name="robots" content="noindex">/.test(page)).toBe(accueilNoindex);
  });

  it("figure dans le plan du site", () => {
    expect(read("sitemap.xml")).toContain("https://gites-platform.j-decartier.workers.dev/recettes/");
  });

  it("ne contient aucune des mentions retirées par le propriétaire (28/08)", () => {
    expect(page).not.toMatch(/\bTVA\b/i);
    expect(page).not.toMatch(/taxe de séjour/i);
    expect(page).not.toMatch(/\bdraps?\b/i);
    expect(page).not.toMatch(/\blinge\b/i);
    expect(page).not.toMatch(/TODO_|\{\{/);
  });
});

describe("les dix recettes sont là, entières et atteignables", () => {
  for (const [ancre, titre] of RECETTES) {
    it(`#${ancre} — « ${titre} »`, () => {
      expect(page).toContain(`<h3 id="${ancre}">`);
      expect(page).toContain(titre);
    });
  }

  it("exactement dix recettes, pas neuf ni onze", () => {
    const ancres = [...page.matchAll(/<h3 id="([^"]+)">/g)].map((m) => m[1]);
    expect(ancres).toEqual(RECETTES.map(([a]) => a));
  });

  it("chaque lien interne à la page vise une ancre qui existe", () => {
    const ancres = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const cibles = [...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(cibles.length).toBeGreaterThanOrEqual(13); // 3 chapeaux + 10 du sommaire
    for (const cible of cibles) expect({ cible, existe: ancres.has(cible) }).toEqual({ cible, existe: true });
  });

  it("les trois sections thématiques portent leur ancre", () => {
    for (const section of ["truites", "four", "belges"]) {
      expect(page).toContain(`id="${section}"`);
    }
  });
});

describe("« Que manger » mène aux recettes (l'issue #29 y laissait des renvois provisoires)", () => {
  it("la page Que manger pointe vers /recettes/", () => {
    expect(read("que-manger/index.html")).toContain('href="/recettes/#truites"');
    expect(read("que-manger/index.html")).toContain('href="/recettes/#four"');
  });

  it("les recettes sont dans le menu et le pied de page de toutes les pages vitrine", () => {
    for (const rel of pagesVitrine()) {
      const html = read(rel);
      const nav = html.match(/<nav class="top">[\s\S]*?<\/nav>/)?.[0] ?? "";
      const footer = html.match(/<footer>[\s\S]*<\/footer>/)?.[0] ?? "";
      expect(nav, `${rel} — menu`).toContain('href="/recettes/"');
      expect(footer, `${rel} — pied de page`).toContain('href="/recettes/"');
    }
  });
});

describe("plus aucun lien vers l'ancien WordPress (définition de fini de #57)", () => {
  /** Les trois pages légales peuvent avoir à nommer le domaine (éditeur du
   *  site, responsable de traitement) : la mention textuelle y est tolérée,
   *  le LIEN ne l'est nulle part. */
  const PAGES_LEGALES = ["mentions-legales", "confidentialite", "conditions-generales"].map((d) => join(d, "index.html"));
  const TEXTE = new Set([".html", ".js", ".css", ".xml", ".txt", ".json", ".svg", ".webmanifest"]);

  function fichiersTexte(dir: string): string[] {
    const out: string[] = [];
    for (const nom of readdirSync(dir).sort()) {
      if (nom.startsWith(".")) continue;
      const chemin = join(dir, nom);
      if (statSync(chemin).isDirectory()) out.push(...fichiersTexte(chemin));
      else if (TEXTE.has(extname(nom).toLowerCase())) out.push(chemin);
    }
    return out;
  }

  const fichiers = fichiersTexte(publicDir).map((p) => relative(publicDir, p));

  it("le balayage porte bien sur tout public/, back-office et tunnel compris", () => {
    expect(fichiers.length).toBeGreaterThan(20);
    expect(fichiers).toContain("recettes/index.html");
    expect(fichiers).toContain("index.html");
  });

  it("aucun lien, source d'image ou URL CSS ne pointe vers lesgitesdupremore.be", () => {
    // Vise l'usage : href, src, srcset, url(…) et action de formulaire.
    const lien = /(?:href|src|srcset|action)\s*=\s*["'][^"']*lesgitesdupremore\.be|url\([^)]*lesgitesdupremore\.be/i;
    for (const rel of fichiers) {
      expect({ fichier: rel, lien: lien.test(read(rel)) }).toEqual({ fichier: rel, lien: false });
    }
  });

  it("le domaine n'apparaît nulle part ailleurs que, éventuellement, dans les pages légales", () => {
    for (const rel of fichiers) {
      if (PAGES_LEGALES.includes(rel)) continue;
      expect({ fichier: rel, mention: /lesgitesdupremore\.be/i.test(read(rel)) }).toEqual({ fichier: rel, mention: false });
    }
  });
});

describe("les images de la page sont locales et sous le plafond de 300 Ko", () => {
  const refs = [
    ...[...page.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
    ...[...page.matchAll(/srcset="([^"]+)"/g)].flatMap((m) => m[1]!.split(",").map((c) => c.trim().split(/\s+/)[0]!)),
  ].filter((u) => u.startsWith("/img/"));

  it("chaque image référencée existe dans public/ et pèse moins de 300 Ko", () => {
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      const chemin = join(publicDir, ref);
      expect({ ref, existe: existsSync(chemin) }).toEqual({ ref, existe: true });
      expect({ ref, ko: Math.round(statSync(chemin).size / 1024) <= 300 }).toEqual({ ref, ko: true });
    }
  });

  it("la feuille de style ne déforme pas les photos (height:auto)", () => {
    // Les attributs width/height sont des indications de présentation : sans
    // `height:auto`, la règle `width:100%` n'écrase que la première et la photo
    // s'affiche à la hauteur brute de son attribut. Mesuré au navigateur.
    const css = readFileSync(join(publicDir, "site.css"), "utf8");
    const regle = css.match(/\.photo-row img,\.prose figure img\{[^}]*\}/)?.[0] ?? "";
    expect(regle).toContain("width:100%");
    expect(regle).toContain("height:auto");
  });

  it("chaque <img> déclare ses dimensions (pas de décalage au chargement)", () => {
    for (const balise of page.match(/<img[^>]*>/g) ?? []) {
      expect(balise).toMatch(/\swidth="\d+"/);
      expect(balise).toMatch(/\sheight="\d+"/);
      expect(balise).toMatch(/\salt="[^"]+"/);
    }
  });
});

/** Toutes les pages du site vitrine : `index.html` à la racine et dans chaque
 *  sous-dossier, hors back-office, tunnel et images. */
function pagesVitrine(): string[] {
  const out = ["index.html"];
  for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["admin", "book", "img"].includes(entry.name)) continue;
    const rel = join(entry.name, "index.html");
    if (existsSync(join(publicDir, rel))) out.push(rel);
  }
  return out;
}
