// Relecture de conformité du site vitrine (droit belge de la consommation),
// décisions du propriétaire du 23/10/2026 :
//  · art. VI.4 CDE — le prix annoncé inclut les frais obligatoires : la carte
//    « Les deux maisons » porte la ligne de frais, chaque carte et le tableau
//    un total d'exemple « 2 nuits dès X € tout compris », calculé par
//    public/arrhes.js depuis les données de l'API (jamais écrit en dur) ;
//  · horaires 18 h / 10 h, adresse (Libin), mentions légales et confidentialité.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { fraisSejourCents, partiesFrais, prixMinNuitCents, totalExempleEuros } from "../public/arrhes.js";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8");

describe("total d'exemple — calcul pur de arrhes.js", () => {
  const scieur = { id: 1, cleaningFeeCents: 12000, chargesExtraNightCents: 0, feeIncludedNights: 2 };
  const scierie = { id: 2, cleaningFeeCents: 9000, chargesExtraNightCents: 0, feeIncludedNights: 2 };
  const deux = { id: 3, isComposite: true, compositePricing: "sum", componentIds: [1, 2], cleaningFeeCents: 0 };
  const units = [scieur, scierie, deux];

  it("2 nuits = 2 × prix par nuit + forfait de frais, arrondi à l'euro", () => {
    expect(totalExempleEuros(18000, [scieur])).toBe(480);
    expect(totalExempleEuros(12050, [scierie])).toBe(Math.round((24100 + 9000) / 100));
  });

  it("les deux maisons additionnent les frais de leurs composantes", () => {
    expect(partiesFrais(units, deux).map((u: { id: number }) => u.id)).toEqual([1, 2]);
    expect(totalExempleEuros(30000, partiesFrais(units, deux))).toBe(810);
  });

  it("le supplément par nuit n'entre que si le séjour dépasse les nuits incluses", () => {
    const u = { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 2 };
    expect(fraisSejourCents([u], 2)).toBe(24000);
    expect(fraisSejourCents([u], 4)).toBe(29000);
    const unNuit = { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 1 };
    expect(fraisSejourCents([unNuit], 2)).toBe(26500);
  });

  it("le prix minimum ignore les jours passés et sans tarif", () => {
    const mois = [{ units: [{ unitId: 1, days: [
      { past: true, priceCents: 100 }, { past: false, priceCents: null }, { past: false, priceCents: 20000 }, { past: false, priceCents: 18000 },
    ] }] }];
    expect(prixMinNuitCents(mois, 1)).toBe(18000);
    expect(prixMinNuitCents(mois, 2)).toBeNull();
  });
});

describe("total d'exemple — cohérence avec le moteur de devis", () => {
  const router = new Router();
  registerPublicRoutes(router);
  let t: TestDb;
  let env: Env;
  const call = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`http://test.local${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await router.handle(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext);
    return (await res.json()) as any;
  };
  beforeAll(async () => {
    t = await createTestDb();
    env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false" } as Env;
  });
  afterAll(async () => {
    await t.dispose();
  });

  it("le total annoncé n'est jamais supérieur au devis réel le moins cher (hors promotions) d'un séjour de 2 nuits", async () => {
    // Départ à 20 jours : ni « last minute » (≤ 7 j) ni « early bird » (≥ 90 j). Les promotions ne font que baisser le prix payé :
    // le total « dès » se compare au tarif public, sans remise.
    const debut = addDays(todayInZone(), 20);
    const m1 = debut.slice(0, 7);
    const m2 = addDays(`${m1}-01`, 32).slice(0, 7);
    const mois = [await call("GET", `/api/public/calendar?property=pre-more&month=${m1}`), await call("GET", `/api/public/calendar?property=pre-more&month=${m2}`)];
    const { units } = await call("GET", "/api/public/properties/pre-more");
    for (const u of units) {
      const min = prixMinNuitCents(mois, u.id);
      if (min == null) continue;
      const exemple = totalExempleEuros(min, partiesFrais(units, u)) * 100;
      const jours = mois.flatMap((m: any) => m.units.find((x: any) => x.unitId === u.id).days).filter((d: any) => d.date >= debut && d.priceCents != null);
      const devis: number[] = [];
      for (const j of jours.slice(0, 40)) {
        const r = await call("POST", "/api/public/quote", { unitId: u.id, checkin: j.date, checkout: addDays(j.date, 2), adults: 2, children: 0 });
        if (r.quote?.ok && !r.quote.discountCents) devis.push(r.quote.totalCents);
      }
      expect(devis.length, u.slug).toBeGreaterThan(0);
      expect(exemple, u.slug).toBeLessThanOrEqual(Math.min(...devis) + 50); // + arrondi à l'euro
    }
  });
});

describe("pages publiques statiques", () => {
  it("l'accueil : les trois cartes et le tableau portent frais et total d'exemple lus par arrhes.js", () => {
    const home = read("index.html");
    for (const n of ["1", "2", "3"]) {
      expect(home.match(new RegExp(`data-frais-unit="${n}"`, "g"))?.length, `frais ${n}`).toBeGreaterThanOrEqual(2);
      expect(home.match(new RegExp(`data-total-exemple-unit="${n}"`, "g"))?.length, `total ${n}`).toBe(2);
    }
    // la carte « Les deux maisons » annonce désormais les frais généraux
    const banniere = home.match(/domaine-banner[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(banniere).toContain("frais généraux");
    expect(banniere).toContain('data-frais-unit="3"');
  });

  it("aucun total d'exemple écrit en dur ; le module arrhes.js le produit", () => {
    for (const rel of ["index.html", "la-maison-du-scieur/index.html", "la-scierie/index.html"]) {
      expect(read(rel), rel).not.toMatch(/\d\s*€ tout compris/);
    }
    const js = read("arrhes.js");
    expect(js).toContain("data-total-exemple-unit");
    expect(js).toContain("2 nuits dès");
    expect(js).toContain("tout compris");
    for (const rel of ["la-maison-du-scieur/index.html", "la-scierie/index.html"]) {
      expect(read(rel), rel).toMatch(/data-total-exemple-unit="[12]"/);
    }
  });

  it("horaires : arrivée 18 h, départ 10 h partout sur l'accueil", () => {
    const home = read("index.html");
    expect(home).toContain("Arrivée dès 18 h · départ avant 10 h");
    expect(home).toContain("Arrivée à 18 h, départ à 10 h");
    expect(home).not.toMatch(/départ avant 18\s?h|Arrivée et départ à 18/);
  });

  it("adresse : plus de « Redu (Daverdisse) » dans les pages", () => {
    for (const rel of ["index.html", "la-maison-du-scieur/index.html", "la-scierie/index.html", "mentions-legales/index.html", "confidentialite/index.html"]) {
      expect(read(rel), rel).not.toContain("Redu (Daverdisse)");
    }
    expect(read("index.html")).toContain("6890 Redu (Libin)");
  });

  it("mentions légales : exploitant joignable, hébergeur Hetzner, numéros « en cours d'attribution »", () => {
    const html = read("mentions-legales/index.html");
    expect(html).toContain("jphde.cartier@gmail.com");
    expect(html).toContain("0498 44 08 83");
    expect(html).toContain("Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen, Allemagne");
    expect(html).not.toMatch(/cloudflare/i);
    expect(html.match(/<span data-registration-value>en cours d'attribution<\/span>/g)).toHaveLength(3);
    expect(read("legal.js")).toContain("NUMEROS_ENREGISTREMENT");
  });

  it("confidentialité : Hetzner et Google remplacent Cloudflare (hébergement) et Resend", () => {
    const html = read("confidentialite/index.html");
    expect(html).toContain("Hetzner Online GmbH");
    expect(html).toMatch(/Google Ireland Limited/);
    expect(html).not.toMatch(/Resend/);
    expect(html).not.toMatch(/hébergement du site et de la base de données, région Europe de l'Ouest/);
  });
});
