#!/usr/bin/env node
// Fabrique des images du site (issue #17) — WebP + variantes de largeur.
//
// POURQUOI CE SCRIPT N'EST PAS APPELÉ PAR LA CI NI PAR `npm run build`.
// Ses sorties sont COMMITÉES. Le déploiement Cloudflare sert `public/` tel quel :
// il ne doit dépendre ni de `sharp` (binaire natif, ~10 Mo par plateforme) ni
// d'une étape de génération. On paie la fabrique une fois, à la main, quand une
// photo change ; la production ne connaît que des fichiers statiques.
//
// POURQUOI `sharp` PLUTÔT QUE `sips` (macOS, zéro dépendance).
// `sips --formats` liste `org.webmproject.webp` en LECTURE seule : sips sait
// ouvrir un WebP, pas en écrire. Or l'issue #17 demande explicitement du WebP
// avec repli. Sans dépendance, on ne pouvait livrer que du srcset JPEG.
// `sharp` est donc en devDependency — jamais chargé à l'exécution du Worker.
//
// CE QU'IL PRODUIT, pour chaque source `nom.jpg` :
//   · `nom-640.webp`, `nom-1280.webp` (…) — les candidats du `srcset` ;
//   · `nom.jpg` — le repli, recompressé, plafonné à 1600 px et < 300 Ko.
// Le nom canonique ne change pas : aucune référence existante ne casse, et
// `og-pre-more.jpg` reste le fichier que lisent les robots des réseaux sociaux.
//
// NON IDEMPOTENT sur ses propres sorties : relancer le script sur `public/img/`
// recompresserait des JPEG déjà compressés (perte de génération). D'où le
// garde-fou `--in` ≠ `--out`, et la provenance documentée :
//   · les 20 images historiques → `git show <sha avant ce commit>:public/img/…` ;
//   · les photos de galerie     → `scripts/photos-sources.json` (URL d'origine).
//
// Usage :
//   node scripts/optimize-images.mjs --in <dossier-sources> --out public/img
//   node scripts/optimize-images.mjs --in <sources-galerie> --out public/img/gites/la-scierie --galerie

import sharp from "sharp";
import { readdirSync, statSync, mkdirSync } from "node:fs";
import { join, parse, resolve } from "node:path";

/** Largeurs par défaut. Filtrées ensuite par la largeur naturelle : on
 *  n'agrandit jamais une source, ça ne ferait qu'ajouter du poids. */
const LARGEURS = [640, 1280];
/** Plafond du repli JPEG. 1600 px couvre un écran 2× sans dépasser 300 Ko. */
const REPLI_MAX = 1600;
/** Plafond dur de l'issue #17 : aucune variante ne dépasse cette taille. */
const POIDS_MAX_KO = 300;
/** En dessous, les artefacts deviennent visibles : mieux vaut alerter que livrer. */
const QUALITE_PLANCHER = 50;

/** Réglages par image, quand la règle générale ne convient pas. */
const CAS_PARTICULIERS = {
  // Fond du bandeau d'accueil : occupe toute la fenêtre, mérite une 3ᵉ largeur.
  // Plafonnée à 1600 et non 1920 : cette forêt d'été est si bruitée qu'à 1920 px
  // elle passait 371 Ko même à qualité 48 — sous le voile sombre du bandeau,
  // personne ne verra les 320 px manquants, alors que 71 Ko de trop, si.
  "entre-maisons": { largeurs: [640, 1280, 1600], repliMax: 1600 },
  // Aperçu de partage : les robots sociaux ne lisent ni srcset ni WebP, et les
  // balises og:image:width/height annoncent 1200×630. On ne touche qu'au poids.
  "og-pre-more": { largeurs: [], repliMax: 1200 },
  // Pictogramme de 150 px avec transparence : le PNG reste le bon format.
  "natura-2000": { largeurs: [], repliMax: 150, garderPng: true },
  // Bandeau de 900×120, déjà à 27 Ko : le WebP ne gagnerait rien de mesurable.
  promenades: { largeurs: [] },
  // Photos de fond des cartes de la page d'accueil. Elles ne sont JAMAIS
  // affichées au-delà de ~1040 px (`.exp.big`, trois colonnes) ni de ~540 px
  // (`.gite .ph`, une demi-largeur) : garder 1400 px revenait à télécharger le
  // double de pixels pour les jeter. Le plafond à 1024 fait passer la page
  // d'accueil sous le mégaoctet visé par l'issue #17.
  "terrasse-hot-tub": { largeurs: [640], repliMax: 1024 },
  jetee: { largeurs: [640], repliMax: 1024 },
  scierie: { largeurs: [640], repliMax: 1024 },
  "scierie-terrasse-haut": { largeurs: [640], repliMax: 1024 },
  "vue-berge": { largeurs: [640], repliMax: 1024 },
  // Vieilles numérisations de 750×500, granuleuses : le WebP y ré-encode le grain
  // et pèse PLUS lourd que le JPEG (111 Ko contre 74). Servir le WebP serait une
  // régression déguisée en optimisation — on garde le JPEG seul.
  "histoire-17r": { largeurs: [] },
  "histoire-18r": { largeurs: [] },
  "histoire-19r": { largeurs: [] },
};

function options() {
  const a = process.argv.slice(2);
  const lire = (nom) => {
    const i = a.indexOf(nom);
    return i === -1 ? null : a[i + 1];
  };
  return { in: lire("--in"), out: lire("--out"), galerie: a.includes("--galerie") };
}

const opt = options();
if (!opt.in || !opt.out) {
  console.error("Usage : node scripts/optimize-images.mjs --in <sources> --out <cible> [--galerie]");
  process.exit(2);
}
if (resolve(opt.in) === resolve(opt.out)) {
  console.error("❌ --in et --out identiques : le script recompresserait ses propres sorties.");
  process.exit(2);
}

mkdirSync(opt.out, { recursive: true });

const lignes = [];
let alerte = false;

for (const nom of readdirSync(opt.in).sort()) {
  const source = join(opt.in, nom);
  if (!statSync(source).isFile() || nom.startsWith(".")) continue;
  const { name: base, ext } = parse(nom);
  if (!/^\.(jpe?g|png)$/i.test(ext)) continue;

  const cas = CAS_PARTICULIERS[base] ?? {};
  const meta = await sharp(source).metadata();
  // La galerie est normalisée en 4/3 paysage : une grille régulière, des
  // width/height constants dans le HTML, et donc zéro décalage au chargement.
  const cible = opt.galerie ? { w: 1280, h: 960 } : null;
  const largeurNaturelle = cible ? cible.w : meta.width;

  const largeurRepli = Math.min(largeurNaturelle, cas.repliMax ?? REPLI_MAX);
  // Le WebP doit toujours couvrir jusqu'à la largeur du repli. Sans cette ligne,
  // une photo de 1200 px n'aurait qu'un candidat 640 : sur un grand écran, le
  // navigateur choisirait ce 640 et afficherait une image plus molle qu'avant la
  // « d'optimisation ». Le repli JPEG servirait de meilleure image que le WebP.
  // Le seuil à 0,9 évite les doublons inutiles : sur une source de 1400 px, un
  // candidat 1280 et un candidat 1400 pèsent presque pareil et ne se distinguent
  // pas à l'œil — deux fichiers pour un seul usage réel.
  const demandees = cas.largeurs ?? LARGEURS;
  const largeurs = [...new Set(demandees.filter((w) => w < largeurRepli * 0.9))];
  if (demandees.length) largeurs.push(largeurRepli);
  largeurs.sort((a, b) => a - b);

  /** Redimensionne la source : recadrage 4/3 en galerie, simple réduction sinon. */
  const redim = (w) =>
    cible
      ? sharp(source).resize(w, Math.round((w * cible.h) / cible.w), { fit: "cover", position: "attention" })
      : sharp(source).resize(w, null, { withoutEnlargement: true });

  /**
   * Écrit un fichier en baissant la qualité tant qu'il dépasse le budget.
   * Une forêt en été (`entre-maisons`) est bruitée au point de peser 583 Ko en
   * WebP à qualité 78 : sans cette recherche, le plafond de l'issue #17 tiendrait
   * du vœu pieux et se re-violerait à la première photo un peu détaillée.
   */
  async function ecrire(chemin, largeur, encodeur, qualiteDepart) {
    let qualite = qualiteDepart;
    for (;;) {
      const { size } = await encodeur(redim(largeur), qualite).toFile(chemin);
      if (size <= POIDS_MAX_KO * 1024 || qualite <= QUALITE_PLANCHER) return { size, qualite };
      qualite -= 6;
    }
  }

  const produits = [];

  for (const w of largeurs) {
    const fichier = `${base}-${w}.webp`;
    const { size, qualite } = await ecrire(
      join(opt.out, fichier),
      w,
      (p, q) => p.webp({ quality: q, effort: 6 }),
      78
    );
    produits.push([fichier, size, qualite]);
  }

  // Repli : PNG conservé seulement quand la transparence sert à quelque chose.
  const repli = cas.garderPng ? `${base}.png` : `${base}.jpg`;
  const { size: tailleRepli, qualite: qRepli } = cas.garderPng
    ? await (async () => {
        const { size } = await redim(largeurRepli).png({ compressionLevel: 9, palette: true }).toFile(join(opt.out, repli));
        return { size, qualite: null };
      })()
    : await ecrire(
        join(opt.out, repli),
        largeurRepli,
        (p, q) => p.flatten({ background: "#ffffff" }).jpeg({ quality: q, progressive: true, mozjpeg: true }),
        80
      );
  produits.push([repli, tailleRepli, qRepli]);

  const hauteurRepli = cible
    ? Math.round((largeurRepli * cible.h) / cible.w)
    : Math.round((largeurRepli / meta.width) * meta.height);

  for (const [f, size] of produits) {
    const ko = Math.round(size / 1024);
    if (ko > POIDS_MAX_KO) {
      alerte = true;
      console.error(`   ⚠️  ${f} : ${ko} Ko > ${POIDS_MAX_KO} Ko`);
    }
  }
  lignes.push({ base, dims: `${largeurRepli}×${hauteurRepli}`, produits });
}

console.log(`\n${opt.in} → ${opt.out}\n`);
for (const l of lignes) {
  const detail = l.produits
    .map(([f, s, q]) => `${f.slice(l.base.length + 1) || f}:${Math.round(s / 1024)}Ko${q != null && q < 78 ? `(q${q})` : ""}`)
    .join("  ");
  console.log(`  ${l.base.padEnd(26)} ${l.dims.padEnd(11)} ${detail}`);
}
console.log(`\n${lignes.length} source(s), ${lignes.reduce((n, l) => n + l.produits.length, 0)} fichier(s) écrit(s).`);
process.exit(alerte ? 1 : 0);
