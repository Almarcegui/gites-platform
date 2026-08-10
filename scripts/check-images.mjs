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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const IMG_DIR = new URL("../public/img/", import.meta.url).pathname;

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

for (const name of readdirSync(IMG_DIR).sort()) {
  const path = join(IMG_DIR, name);
  if (!statSync(path).isFile() || name.startsWith(".")) continue;

  const lower = name.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  const buf = readFileSync(path);
  checked++;

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
