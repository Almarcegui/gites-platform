// Issue #32 — galerie de photos par hébergement.
//
// Quatre choses se verrouillent ici :
//  1. la migration 0021 charge la galerie depuis scripts/photos-sources.json,
//     sans toucher à `units.photo_url` ;
//  2. l'API publique sert la galerie et DÉRIVE la photo principale de sa
//     première photo, en gardant le repli historique quand il n'y en a pas ;
//  3. le back-office ordonne, retire et corrige — et refuse un texte
//     alternatif vide, qui est le seul vrai défaut d'accessibilité possible ici ;
//  4. le HTML servi par les trois pages de gîtes dit exactement la même chose
//     que la base : sans ce test, l'une des deux dérive en silence.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { imageSize, jpegSize } from "../src/core/image-size";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const racine = fileURLToPath(new URL("..", import.meta.url));
const lire = (rel: string): string => readFileSync(join(racine, rel), "utf8");
const SOURCES = JSON.parse(lire("scripts/photos-sources.json")) as {
  gites: Record<string, { photos: { fichier: string; alt: string; legende: string }[] }>;
};

/** Dossier de photos-sources.json → (slug d'unité, slug de domaine, page). */
const GITES = {
  "maison-du-scieur": { unit: "maison-du-scieur", property: "pre-more", page: "public/la-maison-du-scieur/index.html" },
  "la-scierie": { unit: "la-scierie", property: "pre-more", page: "public/la-scierie/index.html" },
  "le-moulin-de-braives": { unit: "le-moulin", property: "moulin-braives", page: "public/le-moulin-de-braives/index.html" },
} as const;

const ADMIN = "test-admin-token";
let t: TestDb;
let env: Env;

/** Binding ASSETS de test : sert les fichiers réels de `public/`. C'est ce que
 *  vérifie l'ajout d'une photo côté back-office — un chemin qui n'existe pas
 *  dans le dépôt doit être refusé. */
const ASSETS = {
  async fetch(req: Request): Promise<Response> {
    const chemin = new URL(req.url).pathname;
    try {
      return new Response(readFileSync(join(racine, "public", chemin)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
} as unknown as Fetcher;

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  overrideEnv?: Env,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: path.startsWith("/api/admin")
      ? { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }
      : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await router.handle(req, overrideEnv ?? env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/** Remet la galerie dans l'état du seed — les tests d'écriture la bousculent. */
async function reseed(): Promise<void> {
  await t.db.prepare("UPDATE unit_photos SET active = 1").run();
  for (const [dossier, { unit }] of Object.entries(GITES)) {
    const photos = SOURCES.gites[dossier]!.photos;
    for (const [i, p] of photos.entries()) {
      await t.db
        .prepare(
          `UPDATE unit_photos SET alt = ?3, caption = ?4, sort_order = ?5
            WHERE path = ?2 AND unit_id = (SELECT id FROM units WHERE slug = ?1)`,
        )
        .bind(unit, `/img/gites/${dossier}/${p.fichier}.jpg`, p.alt, p.legende, (i + 1) * 10)
        .run();
    }
  }
}
beforeEach(reseed);

describe("migration 0021 — le seed vient de photos-sources.json", () => {
  it("charge huit photos par gîte, toutes avec un texte alternatif", async () => {
    const { results } = await t.db
      .prepare("SELECT u.slug AS unit, p.path, p.alt, p.caption, p.sort_order, p.active FROM unit_photos p JOIN units u ON u.id = p.unit_id ORDER BY u.slug, p.sort_order")
      .all();
    const rows = results as Record<string, unknown>[];
    expect(rows).toHaveLength(24);
    for (const r of rows) {
      expect(String(r.alt).length).toBeGreaterThan(10);
      expect(r.active).toBe(1);
      expect(String(r.path)).toMatch(/^\/img\/gites\/[a-z-]+\/[a-z-]+\.jpg$/);
    }
  });

  it("respecte l'ordre et les textes de photos-sources.json", async () => {
    for (const [dossier, { unit }] of Object.entries(GITES)) {
      const { results } = await t.db
        .prepare("SELECT path, alt, caption FROM unit_photos WHERE unit_id = (SELECT id FROM units WHERE slug = ?1) ORDER BY sort_order")
        .bind(unit)
        .all();
      expect((results as Record<string, unknown>[]).map((r) => [r.path, r.alt, r.caption])).toEqual(
        SOURCES.gites[dossier]!.photos.map((p) => [`/img/gites/${dossier}/${p.fichier}.jpg`, p.alt, p.legende]),
      );
    }
  });

  it("interdit un texte alternatif vide jusque dans le schéma", async () => {
    await expect(
      t.db
        .prepare("INSERT INTO unit_photos (unit_id, path, alt) VALUES (2, '/img/x.jpg', '   ')")
        .run(),
    ).rejects.toThrow();
  });

  it("ne touche à aucune donnée existante — units.photo_url est intacte", async () => {
    const row = await t.db.prepare("SELECT photo_url FROM units WHERE id = 1").first();
    expect((row as Record<string, unknown>).photo_url).toBe("/img/vue-berge.jpg");
  });

  it("est idempotente : la rejouer ne duplique rien", async () => {
    const sql = lire("migrations/0021_unit_photos.sql")
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    for (const stmt of sql.split(";").map((p) => p.trim()).filter(Boolean)) {
      await t.db.prepare(stmt).run();
    }
    const row = await t.db.prepare("SELECT COUNT(*) AS n FROM unit_photos").first();
    expect((row as Record<string, unknown>).n).toBe(24);
  });
});

describe("API publique", () => {
  it("sert la galerie d'un gîte dans l'ordre, avec les variantes WebP", async () => {
    const { status, data } = await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie");
    expect(status).toBe(200);
    const photos = data.photos as Record<string, unknown>[];
    expect(photos).toHaveLength(8);
    expect(photos[0]!.path).toBe("/img/gites/la-scierie/facade.jpg");
    expect(photos[0]!.webpWidths).toEqual([640, 1280]);
    expect(photos[0]!.width).toBe(1280);
    expect(photos[0]!.height).toBe(960);
  });

  it("refuse un domaine ou un hébergement inconnu", async () => {
    expect((await call("GET", "/api/public/photos?property=inconnu&unit=la-scierie")).status).toBe(404);
    expect((await call("GET", "/api/public/photos?property=pre-more&unit=inconnu")).status).toBe(404);
  });

  it("dérive la photo principale de la première photo de la galerie", async () => {
    const { data } = await call("GET", "/api/public/properties/pre-more");
    const units = data.units as Record<string, unknown>[];
    const scierie = units.find((u) => u.slug === "la-scierie")!;
    expect(scierie.photoUrl).toBe("/img/gites/la-scierie/facade.jpg");
    expect((scierie.photos as unknown[]).length).toBe(8);
  });

  it("garde le repli historique pour un hébergement sans galerie", async () => {
    const { data } = await call("GET", "/api/public/properties/pre-more");
    const domaine = (data.units as Record<string, unknown>[]).find((u) => u.isComposite)!;
    expect(domaine.photos).toEqual([]);
    expect(domaine.photoUrl).toBe("/img/entre-maisons.jpg");
  });

  it("ne montre jamais une photo retirée", async () => {
    await t.db.prepare("UPDATE unit_photos SET active = 0 WHERE path = '/img/gites/la-scierie/facade.jpg'").run();
    const { data } = await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie");
    const photos = data.photos as Record<string, unknown>[];
    expect(photos).toHaveLength(7);
    expect(photos.map((p) => p.path)).not.toContain("/img/gites/la-scierie/facade.jpg");
    // …et la photo principale suit : c'est la première photo AFFICHÉE.
    const { data: prop } = await call("GET", "/api/public/properties/pre-more");
    const scierie = (prop.units as Record<string, unknown>[]).find((u) => u.slug === "la-scierie")!;
    expect(scierie.photoUrl).toBe("/img/gites/la-scierie/salon.jpg");
  });
});

describe("back-office — ordonner, retirer, corriger", () => {
  const idsScierie = async (): Promise<number[]> => {
    const { data } = await call("GET", "/api/admin/units/2/photos");
    return (data.photos as Record<string, unknown>[]).map((p) => Number(p.id));
  };

  it("liste aussi les photos retirées", async () => {
    await t.db.prepare("UPDATE unit_photos SET active = 0 WHERE unit_id = 2 AND sort_order = 10").run();
    const { data } = await call("GET", "/api/admin/units/2/photos");
    expect((data.photos as unknown[]).length).toBe(8);
  });

  it("l'ordre de la liste envoyée devient l'ordre d'affichage", async () => {
    const ids = await idsScierie();
    const inverse = [...ids].reverse();
    const { status } = await call("PUT", "/api/admin/units/2/photos", {
      photos: inverse.map((id) => ({ id, alt: `Photo ${id} de La Scierie`, caption: "", active: true })),
    });
    expect(status).toBe(200);
    const { data } = await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie");
    expect((data.photos as Record<string, unknown>[]).map((p) => p.path)).toEqual(
      SOURCES.gites["la-scierie"]!.photos.map((p) => `/img/gites/la-scierie/${p.fichier}.jpg`).reverse(),
    );
  });

  it("refuse un texte alternatif vide ou trop court", async () => {
    const ids = await idsScierie();
    const corps = (alt: string) => ({
      photos: ids.map((id, i) => ({ id, alt: i === 0 ? alt : "Un texte alternatif valable", caption: "", active: true })),
    });
    expect((await call("PUT", "/api/admin/units/2/photos", corps(""))).status).toBe(400);
    expect((await call("PUT", "/api/admin/units/2/photos", corps("ab"))).status).toBe(400);
    expect((await call("PUT", "/api/admin/units/2/photos", corps("   "))).status).toBe(400);
    // La galerie publique n'a pas bougé : un refus ne laisse rien à moitié écrit.
    const { data } = await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie");
    expect((data.photos as Record<string, unknown>[])[0]!.alt).toBe(SOURCES.gites["la-scierie"]!.photos[0]!.alt);
  });

  it("refuse une photo qui n'appartient pas à l'hébergement, ou une liste incomplète", async () => {
    const ids = await idsScierie();
    const autre = await call("GET", "/api/admin/units/1/photos");
    const idAutre = Number((autre.data.photos as Record<string, unknown>[])[0]!.id);
    expect(
      (await call("PUT", "/api/admin/units/2/photos", {
        photos: [...ids.slice(1), idAutre].map((id) => ({ id, alt: "Texte alternatif", active: true })),
      })).status,
    ).toBe(400);
    expect(
      (await call("PUT", "/api/admin/units/2/photos", {
        photos: ids.slice(0, 3).map((id) => ({ id, alt: "Texte alternatif", active: true })),
      })).status,
    ).toBe(400);
  });

  it("retire puis réactive une photo sans jamais la supprimer", async () => {
    const ids = await idsScierie();
    const corps = (active: boolean) => ({
      photos: ids.map((id, i) => ({ id, alt: "Un texte alternatif valable", caption: "", active: i === 0 ? active : true })),
    });
    await call("PUT", "/api/admin/units/2/photos", corps(false));
    expect(((await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie")).data.photos as unknown[]).length).toBe(7);
    await call("PUT", "/api/admin/units/2/photos", corps(true));
    expect(((await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie")).data.photos as unknown[]).length).toBe(8);
    const row = await t.db.prepare("SELECT COUNT(*) AS n FROM unit_photos WHERE unit_id = 2").first();
    expect((row as Record<string, unknown>).n).toBe(8);
  });

  it("rattache un fichier réellement présent, et refuse tout le reste", async () => {
    // Le fichier existe dans public/img/ : accepté, dimensions lues dans le fichier.
    const ok = await call("POST", "/api/admin/units/2/photos", {
      path: "/img/scierie.jpg",
      alt: "La Scierie vue depuis le chemin",
    });
    expect(ok.status).toBe(201);
    const { data } = await call("GET", "/api/public/photos?property=pre-more&unit=la-scierie");
    const ajoutee = (data.photos as Record<string, unknown>[]).at(-1)!;
    expect(ajoutee.path).toBe("/img/scierie.jpg");
    expect(Number(ajoutee.width)).toBeGreaterThan(0);

    // Deux fois le même fichier : refus explicite, pas un doublon silencieux.
    expect(
      (await call("POST", "/api/admin/units/2/photos", { path: "/img/scierie.jpg", alt: "Encore la Scierie" })).status,
    ).toBe(409);
    // Fichier absent du dépôt.
    expect(
      (await call("POST", "/api/admin/units/2/photos", { path: "/img/inexistant.jpg", alt: "Rien du tout" })).status,
    ).toBe(400);
    // Remontée de dossier, chemin hors /img/, et formats qui ne peuvent PAS
    // servir de repli (`path` est le fichier que reçoit un navigateur sans WebP) :
    // tous refusés avant le moindre accès au binding ASSETS.
    for (const path of [
      "/img/../.dev.vars",
      "/../../etc/passwd",
      "https://ailleurs.example/x.jpg",
      "/admin/app.js",
      "/img/gites/la-scierie/facade-640.webp",
      "/img/favicon.png",
      "/img/gites/la-scierie/facade.jpg?x=1",
    ]) {
      expect((await call("POST", "/api/admin/units/2/photos", { path, alt: "Texte alternatif" })).status).toBe(400);
    }
    // Texte alternatif obligatoire, ici aussi.
    expect(
      (await call("POST", "/api/admin/units/2/photos", { path: "/img/moulin.jpg", alt: "" })).status,
    ).toBe(400);

    await t.db.prepare("DELETE FROM unit_photos WHERE path = '/img/scierie.jpg'").run();
  });

  it("exige la garde admin", async () => {
    const req = new Request("http://test.local/api/admin/units/2/photos");
    const res = await router.handle(req, env);
    expect(res?.status).toBe(401);
  });
});

describe("le HTML des pages de gîtes et la base disent la même chose", () => {
  for (const [dossier, { unit, property, page }] of Object.entries(GITES)) {
    it(`${page} — même ordre, mêmes alt, mêmes légendes`, () => {
      const html = lire(page);
      expect(html).toContain(`data-galerie-unit="${unit}"`);
      expect(html).toContain(`data-galerie-property="${property}"`);
      const grille = html.slice(html.indexOf("<div class=\"galerie\""), html.indexOf("galerie-note"));
      const vignettes = [...grille.matchAll(/<a href="([^"]+)" data-legende="([^"]*)">[\s\S]*?<img src="[^"]+" alt="([^"]*)"/g)];
      expect(vignettes.map((m) => [m[1], m[3], m[2]])).toEqual(
        // Attributs en guillemets doubles : les apostrophes y sont servies
        // telles quelles, seuls & < > " auraient besoin d'être échappés.
        SOURCES.gites[dossier]!.photos.map((p) => [
          `/img/gites/${dossier}/${p.fichier}.jpg`,
          p.alt,
          p.legende,
        ]),
      );
    });
  }
});

describe("lecture des dimensions d'image (aucune dépendance)", () => {
  it("lit un JPEG et un WebP réels du dépôt", () => {
    const jpg = new Uint8Array(readFileSync(join(racine, "public/img/gites/la-scierie/facade.jpg")));
    expect(jpegSize(jpg)).toEqual({ width: 1280, height: 960 });
    const webp = new Uint8Array(readFileSync(join(racine, "public/img/gites/la-scierie/facade-640.webp")));
    expect(imageSize("/x/facade-640.webp", webp)?.width).toBe(640);
  });

  it("renvoie null sur ce qui n'est pas une image", () => {
    expect(imageSize("/x.jpg", new Uint8Array([0x3c, 0x21, 0x44, 0x4f]))).toBeNull();
    expect(imageSize("/x.txt", new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
