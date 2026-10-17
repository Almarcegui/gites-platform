// Issue #9 — pages légales publiques : mentions légales, confidentialité,
// conditions générales.
//
// Trois choses se verrouillent ici :
//  1. les trois pages existent, sont liées depuis le pied de page de TOUTES
//     les pages publiques et du tunnel, et suivent la politique d'indexation
//     en vigueur (noindex tant que le site est en test, issue #1) ;
//  2. rien de ce qui a été retiré par décision du propriétaire (28/08) ne
//     réapparaît dans leur rendu, et aucun placeholder de seed n'y figure ;
//  3. l'API publique ne laisse jamais sortir une coordonnée `TODO_…` — c'est
//     ce qui permet aux pages (et au tunnel) d'afficher leur repli plutôt
//     qu'un faux e-mail.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { publicContact, registerPublicRoutes } from "../src/api/public";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const read = (rel: string): string => readFileSync(join(publicDir, rel), "utf8");

const PAGES = ["mentions-legales", "confidentialite", "conditions-generales"] as const;
const LIENS = ["/mentions-legales/", "/confidentialite/", "/conditions-generales/"];

/** Toutes les pages de contenu du site vitrine : `index.html` à la racine et
 *  dans chaque sous-dossier, hors back-office et tunnel. */
function pagesVitrine(): string[] {
  const out = ["index.html"];
  for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "admin" || entry.name === "book" || entry.name === "img") continue;
    const rel = join(entry.name, "index.html");
    if (existsSync(join(publicDir, rel))) out.push(rel);
  }
  return out;
}

describe("les trois pages existent et suivent le gabarit", () => {
  for (const page of PAGES) {
    it(`/${page}/ est servie avec titre, description et canonical`, () => {
      const html = read(`${page}/index.html`);
      expect(html).toMatch(/<title>[^<]+ — Les Gîtes du Pré Moré<\/title>/);
      expect(html).toMatch(/<meta name="description" content="[^"]{40,}">/);
      expect(html).toContain(`<link rel="canonical" href="https://178-105-145-191.sslip.io/${page}/">`);
      expect(html).toContain('<nav class="top">');
      expect(html).toContain("<footer>");
      expect(html).toContain('<script src="/legal.js" type="module">');
    });

    it(`/${page}/ respecte la politique d'indexation du reste du site`, () => {
      // Tant que l'accueil est en noindex (site de test), les pages légales
      // le sont aussi — et inversement le jour du lancement.
      const accueilNoindex = /<meta name="robots" content="noindex">/.test(read("index.html"));
      expect(/<meta name="robots" content="noindex">/.test(read(`${page}/index.html`))).toBe(accueilNoindex);
    });

    it(`/${page}/ ne contient ni placeholder ni mention retirée`, () => {
      const html = read(`${page}/index.html`);
      expect(html).not.toMatch(/TODO_/);
      expect(html).not.toMatch(/\bTVA\b/i);
      expect(html).not.toMatch(/taxe de séjour/i);
      expect(html).not.toMatch(/\bdraps?\b/i);
      expect(html).not.toMatch(/\blinge\b/i);
      expect(html).not.toMatch(/numéro d'entreprise/i);
      expect(html).not.toMatch(/\{\{/); // aucun placeholder de rédaction
    });

    it(`/${page}/ figure dans le plan du site`, () => {
      expect(read("sitemap.xml")).toContain(`https://178-105-145-191.sslip.io/${page}/`);
    });
  }

  it("aucune adresse e-mail n'est écrite en dur dans les pages légales (hors autorités)", () => {
    for (const page of PAGES) {
      const emails = read(`${page}/index.html`).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
      const autorites = ["contact@apd-gba.be", "contact@mediationconsommateur.be"];
      expect(emails.filter((e) => !autorites.includes(e))).toEqual([]);
    }
  });

  it("les mentions légales prévoient le numéro d'enregistrement, masqué tant qu'absent", () => {
    const html = read("mentions-legales/index.html");
    const lignes = html.match(/<span class="reg" data-registration="[^"]+" hidden>/g) ?? [];
    expect(lignes).toHaveLength(3);
    expect(html).toContain('data-registration="pre-more/maison-du-scieur"');
    expect(html).toContain('data-registration="pre-more/la-scierie"');
    expect(html).toContain('data-registration="moulin-braives/le-moulin"');
  });

  it("la page conditions générales lit le texte de l'API, avec le rendu du tunnel", () => {
    const html = read("conditions-generales/index.html");
    expect(html).toContain('data-cgv="pre-more"');
    expect(html).toContain('data-cgv="moulin-braives"');
    expect(html).not.toMatch(/Article 1 — Parties/); // jamais de copie figée du texte
    expect(read("legal.js")).toContain('import { cgvHtml } from "/book/cgv.js"');
  });
});

describe("le pied de page lie les trois pages partout", () => {
  for (const rel of pagesVitrine()) {
    it(`${rel} — les trois liens dans le <footer>`, () => {
      const footer = read(rel).match(/<footer>[\s\S]*<\/footer>/)?.[0] ?? "";
      for (const lien of LIENS) expect(footer).toContain(`href="${lien}"`);
    });
  }

  for (const rel of ["book/index.html", "book/merci.html", "book/annule.html", "book/voucher.html"]) {
    it(`${rel} — les trois liens sous le tunnel`, () => {
      const html = read(rel);
      for (const lien of LIENS) expect(html).toContain(`href="${lien}"`);
    });
  }
});

describe("aucun script tiers ni traceur sur les pages publiques", () => {
  it("les pages publiques ne chargent aucun script externe", () => {
    for (const rel of [...pagesVitrine(), "book/index.html", "book/voucher.html"]) {
      const externes = read(rel).match(/<script[^>]+src="https?:\/\/[^"]+"/g) ?? [];
      expect(externes, rel).toEqual([]);
    }
  });
});

describe("l'API publique ne laisse pas sortir les placeholders de contact", () => {
  let t: TestDb;
  let env: Env;
  const router = new Router();
  registerPublicRoutes(router);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  beforeAll(async () => {
    t = await createTestDb();
    env = {
      DB: t.db,
      ASSETS: undefined as unknown as Fetcher,
      PUBLIC_BASE_URL: "http://test.local",
      EMAILS_ENABLED: "false",
    } as Env;
  });
  afterAll(async () => {
    await t.dispose();
  });

  it("publicContact filtre le vide et les valeurs TODO_", () => {
    expect(publicContact(null)).toBeNull();
    expect(publicContact("  ")).toBeNull();
    expect(publicContact("TODO_contact@lesgitesdupremore.be")).toBeNull();
    expect(publicContact("todo_x")).toBeNull();
    expect(publicContact(" info@exemple.test ")).toBe("info@exemple.test");
  });

  it("la fiche domaine renvoie null tant que l'adresse du seed est un TODO_", async () => {
    const res = await router.handle(new Request("http://test.local/api/public/properties/pre-more"), env, ctx);
    expect(res?.status).toBe(200);
    const data = (await res!.json()) as { property: { contactEmail: string | null }; cgvText: string };
    expect(data.property.contactEmail).toBeNull();
    expect(JSON.stringify(data)).not.toContain("TODO_contact");
    // Et le texte des CGV, source de la page publique, est bien là.
    expect(data.cgvText).toMatch(/Article 13/);
  });

  it("le texte des CGV servi au public ne contient ni placeholder ni mention retirée", async () => {
    // C'est ce texte que /conditions-generales/ affiche : le test sur le HTML
    // statique ne suffit pas, il faut vérifier la source réelle, par domaine.
    for (const slug of ["pre-more", "moulin-braives"]) {
      const res = await router.handle(new Request(`http://test.local/api/public/properties/${slug}`), env, ctx);
      const data = (await res!.json()) as { cgvText: string; property: unknown };
      expect(data.cgvText, slug).not.toMatch(/TODO_|\{\{|\bTVA\b|taxe de séjour|\bdraps?\b|\blinge\b/i);
      expect(JSON.stringify(data.property), slug).not.toMatch(/TODO_/);
    }
  });

  it("la fiche domaine expose l'adresse dès qu'une vraie valeur est réglée", async () => {
    await t.db.prepare("UPDATE properties SET contact_email = 'info@exemple.test' WHERE id = 2").run();
    const res = await router.handle(new Request("http://test.local/api/public/properties/moulin-braives"), env, ctx);
    const data = (await res!.json()) as { property: { contactEmail: string | null } };
    expect(data.property.contactEmail).toBe("info@exemple.test");
  });
});
