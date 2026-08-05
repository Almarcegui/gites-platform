// Post-traitement du build : ajoute l'extension .js aux imports relatifs.
//
// Le code source écrit `from "../core/dates"` (résolution façon bundler, ce que
// wrangler fait). Node en ESM exige l'extension explicite. Plutôt que de
// réécrire les ~60 imports de src/ — ce qui abîmerait la lisibilité et le
// build Cloudflare — on complète les chemins dans dist/ après compilation.
//
// Sûr par construction : tous les imports relatifs du projet pointent vers des
// fichiers, jamais vers des dossiers.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g;

let touched = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(RELATIVE_IMPORT, (match, head, quote, spec) => {
    if (/\.[a-z0-9]+$/i.test(spec)) return match; // extension déjà présente
    return `${head}${quote}${spec}.js${quote}`;
  });
  if (after !== before) {
    writeFileSync(file, after);
    touched += 1;
  }
}
console.log(`[build] extensions ESM complétées dans ${touched} fichier(s)`);
