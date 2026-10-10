#!/usr/bin/env node
// Garde-fou anti-récidive (issue #5) : un fichier de `public/img/` DOIT commencer
// par une signature d'image connue.
//
// Pourquoi : `public/img/pont-entree.jpg` a longtemps été une page d'erreur 404
// WordPress enregistrée en HTML et renommée en `.jpg`. Le navigateur recevait du
// HTML annoncé en `image/jpeg` et n'affichait rien — deux trous visuels sur la
// page d'accueil d'un site en ligne, sans le moindre message d'erreur.
//
// Usage : `npm run check:images` (et étape dédiée de la CI).
//
// Deux ajouts de l'issue #17 :
//  · le parcours est RÉCURSIF — les galeries vivent dans `public/img/gites/<gîte>/`,
//    et une version antérieure de ce script s'arrêtait au premier niveau : les 72
//    fichiers des galeries n'auraient jamais été contrôlés ;
//  · le poids est vérifié — l'issue plafonne chaque variante à 300 Ko. Le contrôle
//    coûte un `stat` et empêche qu'une photo remise à la main sans passer par
//    `scripts/optimize-images.mjs` réintroduise un fichier de 1,4 Mo.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath et non `.pathname` : `.pathname` laisse le chemin encodé
// (%F0%9F%94%A7 pour l'émoji du dossier « 🔧 Dev »), introuvable sur le disque.
const IMG_DIR = fileURLToPath(new URL("../public/img/", import.meta.url));

/** Plafond de poids par fichier (issue #17). Doit rester aligné sur
 *  `POIDS_MAX_KO` de `scripts/optimize-images.mjs`. */
const POIDS_MAX_OCTETS = 300 * 1024;

/** Tous les fichiers de `dir`, sous-dossiers compris. */
function fichiers(dir) {
  const out = [];
  for (const nom of readdirSync(dir).sort()) {
    if (nom.startsWith(".")) continue;
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) out.push(...fichiers(chemin));
    else out.push(chemin);
  }
  return out;
}

/** Signatures acceptées : les premiers octets de chaque format servi sur le site. */
const SIGNATURES = [
  { ext: [".jpg", ".jpeg"], name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { ext: [".png"], name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: [".gif"], name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: [".webp"], name: "WebP", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF….WEBP
];

/** Les SVG sont du texte : on vérifie qu'il s'agit bien d'un document SVG. */
function looksLikeSvg(buf) {
  const head = buf.subarray(0, 512).toString("utf8").trimStart();
  return head.startsWith("<?xml") || head.startsWith("<svg");
}

function startsWith(buf, bytes) {
  return bytes.every((b, i) => buf[i] === b);
}

const problems = [];
let checked = 0;

for (const path of fichiers(IMG_DIR)) {
  const name = relative(IMG_DIR, path);

  const lower = name.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  const buf = readFileSync(path);
  checked++;

  if (buf.length > POIDS_MAX_OCTETS) {
    problems.push(
      `${name} : ${Math.round(buf.length / 1024)} Ko — plafond ${POIDS_MAX_OCTETS / 1024} Ko ` +
        `(régénérer via scripts/optimize-images.mjs)`
    );
  }

  if (ext === ".svg") {
    if (!looksLikeSvg(buf)) problems.push(`${name} : extension .svg mais le contenu n'est pas du SVG`);
    continue;
  }

  const expected = SIGNATURES.find((s) => s.ext.includes(ext));
  if (!expected) {
    problems.push(`${name} : extension inattendue dans public/img/ (${ext || "aucune"})`);
    continue;
  }
  if (!startsWith(buf, expected.bytes)) {
    const head = buf.subarray(0, 32).toString("utf8").replace(/\s+/g, " ").trim();
    const hex = [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    problems.push(`${name} : pas une image ${expected.name} (octets ${hex} — « ${head}… »)`);
  }
}

if (problems.length) {
  console.error(`\n❌ public/img/ — ${problems.length} fichier(s) invalide(s) sur ${checked} :\n`);
  for (const p of problems) console.error(`   · ${p}`);
  console.error(
    "\nUn fichier qui commence par « <!DOCTYPE html> » est presque toujours une page" +
      "\nd'erreur enregistrée par erreur. Retélécharger la vraie image.\n"
  );
  process.exit(1);
}

console.log(`✅ public/img/ — ${checked} fichier(s), toutes les signatures d'image sont valides.`);
