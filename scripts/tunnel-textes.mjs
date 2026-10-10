// Textes à traduire du tunnel de réservation public (public/book/) : les
// t("…") et pl(n, "…", "…") des scripts, les [data-i18n] et [data-i18n-attr]
// des pages, les <title>. Sert au test test/tunnel-nl.test.ts (chaque texte
// doit être dans public/book/nl.js) et, à la main, à lister ce qui manque :
//   node scripts/tunnel-textes.mjs --manquants
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../public/book/", import.meta.url));
const FILES = ["book.js", "pay-element.js", "voucher.html", "merci.html", "annule.html", "index.html"];

/** Lit un littéral JS "…" ou '…' qui commence en s[i] ; rend [valeur, fin]. */
function literal(s, i) {
  const q = s[i];
  let out = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      const n = s[j + 1];
      out += n === "n" ? "\n" : n;
      j++;
    } else if (c === q) return [out, j + 1];
    else out += c;
  }
  return [null, s.length];
}

const norm = (x) => x.replace(/\s+/g, " ").trim();

export function tunnelTexts() {
  const keys = new Set();
  for (const f of FILES) {
    const s = readFileSync(DIR + f, "utf8");
    for (const m of s.matchAll(/\b(t|pl)\(/g)) {
      let i = m.index + m[0].length;
      if (m[1] === "pl") {
        // pl(n, "un", "plusieurs") : on saute le premier argument.
        const comma = s.indexOf(",", i);
        i = comma + 1;
        for (let k = 0; k < 2; k++) {
          while (/\s/.test(s[i])) i++;
          if (s[i] !== '"' && s[i] !== "'") break;
          const [v, end] = literal(s, i);
          if (v != null) keys.add(v);
          i = end;
          while (/[\s,]/.test(s[i])) i++;
        }
        continue;
      }
      while (/\s/.test(s[i])) i++;
      if (s[i] !== '"' && s[i] !== "'") continue;
      const [v] = literal(s, i);
      if (v != null) keys.add(v);
    }
    if (f.endsWith(".html")) {
      for (const m of s.matchAll(/<(\w+)\b[^>]*\sdata-i18n(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g)) keys.add(norm(m[2]));
      for (const m of s.matchAll(/<[^>]*data-i18n-attr="([^"]+)"[^>]*>/g)) {
        for (const a of m[1].split(",")) {
          const v = new RegExp(`\\s${a.trim()}="([^"]*)"`).exec(m[0]);
          if (v) keys.add(v[1]);
        }
      }
      const title = /<title>([^<]*)<\/title>/.exec(s);
      if (title) keys.add(title[1]);
    }
  }
  return [...keys].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const keys = tunnelTexts();
  if (process.argv.includes("--manquants")) {
    const { NL } = await import("../public/book/nl.js");
    const miss = keys.filter((k) => !(k in NL));
    console.log(JSON.stringify(miss, null, 1));
    console.error(`${miss.length} manquant(s) sur ${keys.length}`);
  } else {
    console.log(JSON.stringify(keys, null, 1));
  }
}
