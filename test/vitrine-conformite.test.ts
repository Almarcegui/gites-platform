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
import { fmtEuros, fraisSejourCents, meilleurSejour2Nuits, moisSuivant, partiesFrais, totalExempleCents } from "../public/arrhes.js";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8");

describe("total d'exemple — calcul pur de arrhes.js", () => {
  const scieur = { id: 1, cleaningFeeCents: 12000, chargesExtraNightCents: 0, feeIncludedNights: 2 };
  const scierie = { id: 2, cleaningFeeCents: 9000, chargesExtraNightCents: 0, feeIncludedNights: 2 };
  const deux = { id: 3, isComposite: true, compositePricing: "sum", componentIds: [1, 2], cleaningFeeCents: 0 };
  const units = [scieur, scierie, deux];

  // Calendrier fictif d'un hébergement : jours = [date, prix en euros | null, options].
  type Opt = { available?: boolean; minNights?: number; checkinDays?: number[] | null };
  const cal = (rows: [string, number | null, Opt?][], unitId = 1) => ({
    units: [{ unitId, days: rows.map(([date, euros, o]) => ({
      date, past: false, available: o?.available ?? true, priceCents: euros == null ? null : euros * 100,
      minNights: o?.minNights ?? 2, checkinDays: o?.checkinDays ?? null,
    })) }],
  });
  // 2026-11-02 = lundi, 11-06 = vendredi.
  const FIN = "2026-11-30";

  it("fmtEuros : centimes seulement quand il y en a, espace insécable avant €", () => {
    expect(fmtEuros(20000)).toBe("200\u00a0€");
    expect(fmtEuros(17750)).toBe("177,50\u00a0€");
    expect(fmtEuros(41250)).toBe("412,50\u00a0€");
  });

  it("les montants affichés s'additionnent exactement : nuits + frais = total", () => {
    const sejour = meilleurSejour2Nuits([cal([["2026-11-02", 177.5], ["2026-11-03", 177.5], ["2026-11-04", 300]], 2)], 2, FIN);
    expect(sejour).toEqual({ arrivee: "2026-11-02", cents: 35500 });
    expect(totalExempleCents(sejour, [{ ...scierie, cleaningFeeCents: 20000 }])).toBe(55500); // 177,50 + 177,50 + 200
  });

  it("une nuit bon marché isolée (la suivante réservée ou fermée) ne compte pas : on prend la meilleure vraie paire", () => {
    const m = cal([
      ["2026-11-02", 100],                          // cheap, mais la nuit suivante est réservée
      ["2026-11-03", 90, { available: false }],
      ["2026-11-04", 150], ["2026-11-05", 160],
      ["2026-11-10", 100], ["2026-11-11", null],    // seconde nuit sans tarif
    ]);
    expect(meilleurSejour2Nuits([m], 1, FIN)).toEqual({ arrivee: "2026-11-04", cents: 31000 });
  });

  it("une nuit bon marché en toute fin de saison, sans seconde nuit, n'est pas atteignable", () => {
    const m = cal([["2026-11-25", 200], ["2026-11-26", 200], ["2026-11-30", 50]]);
    expect(meilleurSejour2Nuits([m], 1, FIN)).toEqual({ arrivee: "2026-11-25", cents: 40000 });
  });

  it("jours d'arrivée imposés : seule une arrivée autorisée compte", () => {
    const m = cal([
      ["2026-11-02", 100, { checkinDays: [5, 6] }], ["2026-11-03", 100],   // lundi : refusé
      ["2026-11-06", 150, { checkinDays: [5, 6] }], ["2026-11-07", 180],   // vendredi : accepté
    ]);
    expect(meilleurSejour2Nuits([m], 1, FIN)).toEqual({ arrivee: "2026-11-06", cents: 33000 });
    expect(meilleurSejour2Nuits([cal([["2026-11-02", 100, { checkinDays: [] }], ["2026-11-03", 100]])], 1, FIN)).toBeNull();
  });

  it("minimum de nuits supérieur à 2 : exclu", () => {
    expect(meilleurSejour2Nuits([cal([["2026-11-02", 100, { minNights: 3 }], ["2026-11-03", 100]])], 1, FIN)).toBeNull();
  });

  it("la paire qui chevauche la fin de fenêtre est retenue (seconde nuit dans le mois suivant)", () => {
    const nov = cal([["2026-11-29", 400], ["2026-11-30", 90]]);
    const dec = cal([["2026-12-01", 90], ["2026-12-02", 400]]);
    expect(meilleurSejour2Nuits([nov, dec], 1, FIN)).toEqual({ arrivee: "2026-11-30", cents: 18000 });
    // une arrivée APRÈS la fenêtre d'arrivée n'est pas envisagée
    expect(meilleurSejour2Nuits([nov, dec], 1, "2026-11-29")).toEqual({ arrivee: "2026-11-29", cents: 49000 });
  });

  it("aucun jour disponible : null, donc mention masquée", () => {
    const m = cal([["2026-11-02", 100, { available: false }], ["2026-11-03", 100, { available: false }]]);
    expect(meilleurSejour2Nuits([m], 1, FIN)).toBeNull();
    expect(meilleurSejour2Nuits([{ units: [] }], 1, FIN)).toBeNull();
    expect(totalExempleCents(null, [scieur])).toBeNull();
  });

  it("les frais : forfait, supplément par nuit au-delà des nuits incluses, composite = somme", () => {
    const u = { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 2 };
    expect(fraisSejourCents([u], 2)).toBe(24000);
    expect(fraisSejourCents([u], 4)).toBe(29000);
    expect(partiesFrais(units, deux).map((x: { id: number }) => x.id)).toEqual([1, 2]);
    expect(fraisSejourCents(partiesFrais(units, deux), 2)).toBe(21000);
  });
});

describe("total d'exemple — égalité exacte avec le devis réel le moins cher", () => {
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

  /** Ce que la page afficherait, et le devis réel le moins cher du moteur sur la même fenêtre. */
  async function compare(unitId: number) {
    const today = addDays(todayInZone(), 0);
    const m1 = today.slice(0, 7);
    const m2 = moisSuivant(m1);
    const mois = [];
    for (const m of [m1, m2, moisSuivant(m2)]) mois.push(await call("GET", `/api/public/calendar?property=pre-more&month=${m}`));
    const { units } = await call("GET", "/api/public/properties/pre-more");
    const u = units.find((x: any) => x.id === unitId);
    const page = totalExempleCents(meilleurSejour2Nuits(mois, unitId, `${m2}-31`), partiesFrais(units, u));

    // Disponibilité : celle du calendrier (le devis n'en répond pas). Tout le reste
    // — tarif, minimum de nuits, jour d'arrivée, délai — vient du moteur de devis.
    const jours = new Map<string, any>();
    for (const m of mois) for (const j of m.units.find((x: any) => x.unitId === unitId).days) jours.set(j.date, j);
    const devis: number[] = [];
    for (const [date, j] of jours) {
      if (date > `${m2}-31` || !j.available || !jours.get(addDays(date, 1))?.available) continue;
      const r = await call("POST", "/api/public/quote", { unitId, checkin: date, checkout: addDays(date, 2), adults: 2, children: 0 });
      // tarif public : les remises (last minute, early bird) ne font que baisser le prix payé
      if (r.quote?.ok) devis.push(r.quote.totalCents + (r.quote.discountCents ?? 0));
    }
    return { page, moteur: devis.length ? Math.min(...devis) : null };
  }

  it("les trois hébergements : le « dès » est égal au devis le moins cher atteignable", async () => {
    for (const id of [1, 2, 3]) {
      const { page, moteur } = await compare(id);
      expect(moteur, `unité ${id}`).not.toBeNull();
      expect(page, `unité ${id}`).toBe(moteur);
    }
  }, 180_000);

  it("une nuit réservée change la paire retenue, et le « dès » suit le moteur", async () => {
    const avant = await compare(2);
    const jour = addDays(todayInZone(), 20);
    await t.db.prepare("INSERT INTO manual_blocks (unit_id, checkin, checkout, reason) VALUES (2, ?1, ?2, 'test')").bind(jour, addDays(jour, 60)).run();
    try {
      const apres = await compare(2);
      expect(apres.page).toBe(apres.moteur);
      expect(apres.page).toBeGreaterThanOrEqual(avant.page!);
    } finally {
      await t.db.prepare("UPDATE manual_blocks SET active = 0 WHERE reason = 'test'").run();
    }
  }, 180_000);

  it("jours d'arrivée imposés (vendredi seulement) : le « dès » suit le moteur", async () => {
    await t.db.prepare("UPDATE rate_rules SET checkin_days = '5' WHERE unit_id = 2").run();
    try {
      const { page, moteur } = await compare(2);
      expect(moteur).not.toBeNull();
      expect(page).toBe(moteur);
    } finally {
      await t.db.prepare("UPDATE rate_rules SET checkin_days = NULL WHERE unit_id = 2").run();
    }
  }, 180_000);

  it("minimum de 3 nuits partout : aucun séjour de 2 nuits, aucun total (mention masquée)", async () => {
    await t.db.prepare("UPDATE rate_rules SET min_nights = 3 WHERE unit_id = 1").run();
    try {
      const { page, moteur } = await compare(1);
      expect(moteur).toBeNull();
      expect(page).toBeNull();
    } finally {
      await t.db.prepare("UPDATE rate_rules SET min_nights = 2 WHERE unit_id = 1").run();
    }
  }, 180_000);
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
    expect(js).toContain("tout compris (prochains mois)");
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

  it("mobile : la colonne « exemple » du tableau disparaît sous 600 px (la carte porte déjà le total)", () => {
    const home = read("index.html");
    expect(home).toMatch(/<th class="ex"/);
    expect(home.match(/<td class="r ex">/g)).toHaveLength(3);
    expect(read("site.css")).toMatch(/@media \(max-width:600px\)\{\.tarifs \.ex\{display:none\}/);
  });

  it("téléphone : un seul format, 0498 44 08 83", () => {
    expect(read("index.html")).toContain("0498 44 08 83");
    expect(read("index.html")).not.toMatch(/0498\s?\/\s?440/);
    expect(read("mentions-legales/index.html")).toContain(">0498 44 08 83<");
  });

  it("une seule source de calendrier partagée : site.js et prix.js passent par arrhes.js", () => {
    for (const rel of ["site.js", "prix.js"]) {
      const js = read(rel);
      expect(js, rel).toContain("calendrierMois");
      expect(js, rel).not.toMatch(/fetch\(`?\/api\/public\/calendar/);
    }
    expect(read("arrhes.js")).toContain("/api/public/today");
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
    expect(html).toContain("envoi et réception des e-mails ; Google agit selon ses propres conditions");
    expect(html).not.toMatch(/Google[^<]*lorsque ce service est actif/);
    expect(html).not.toMatch(/hébergement du site et de la base de données, région Europe de l'Ouest/);
  });
});
