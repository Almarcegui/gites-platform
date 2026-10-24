// Signature des messages envoyés depuis le back-office (Réglages › Le domaine).
//
// Trois pièces, sans dépendance (le code tourne aussi sur Cloudflare Workers, sans DOM) :
//   - sanitizeSignatureHtml : nettoyage À L'ENREGISTREMENT, par liste blanche. Le HTML est
//     reconstruit balise par balise : tout ce qui n'est pas explicitement permis disparaît ;
//   - composeOutgoing : le corps texte + la signature, en texte et (si une signature HTML
//     existe) en HTML, prêt pour multipart/alternative ;
//   - absolutizeImages : une image `/img/…` devient une URL absolue du site (le client
//     de messagerie ne connaît pas notre domaine).

import { isPrivateHost } from "./links";

const ALLOWED_TAGS = new Set([
  "table", "tbody", "thead", "tr", "td", "th", "div", "span", "p", "br", "a", "img", "b", "i", "strong", "em",
]);
const VOID_TAGS = new Set(["br", "img"]);
/** Balises dont le CONTENU disparaît aussi (du texte de script n'a rien à faire dans un mail). */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "textarea", "select", "head", "title"]);

/** Attributs permis, par balise. `style` est filtré à part, les URL aussi. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  table: new Set(["style", "role", "cellpadding", "cellspacing", "border", "width", "align"]),
  tbody: new Set(["style"]),
  thead: new Set(["style"]),
  tr: new Set(["style", "align", "valign"]),
  td: new Set(["style", "colspan", "rowspan", "width", "height", "align", "valign"]),
  th: new Set(["style", "colspan", "rowspan", "width", "height", "align", "valign"]),
  div: new Set(["style", "align"]),
  span: new Set(["style"]),
  p: new Set(["style", "align"]),
  br: new Set([]),
  a: new Set(["style", "href", "title"]),
  img: new Set(["style", "src", "alt", "width", "height", "title"]),
  b: new Set(["style"]),
  i: new Set(["style"]),
  strong: new Set(["style"]),
  em: new Set(["style"]),
};

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|colon|tab|newline);?/gi, (_m, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n" })[n.toLowerCase()] ?? "");
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** URL d'un lien : http(s), mailto, tel ; rien d'autre (javascript:, data:, vbscript:…). */
export function safeHref(raw: string): string | null {
  const v = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
  if (v === "" || v.length > 2000) return null;
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+0-9().\-;,#*pw]+)$/i.test(v) ? v : null;
}

/** Source d'image : https, ou chemin du site (`/img/…`, pas `//hôte`). */
export function safeImgSrc(raw: string): string | null {
  const v = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
  if (v === "" || v.length > 2000) return null;
  if (/^https:\/\/[^\s]+$/i.test(v)) return v;
  if (/^\/(?!\/)[^\s\\]*$/.test(v) && !v.includes("..")) return v;
  return null;
}

/** Propriétés CSS permises (couleur, police, taille, marges, bordures, dimensions, alignement,
 *  arrondi, affichage, ajustement d'image). Tout le reste est retiré : pas de `background-image`,
 *  de `position`, de `content`, de `filter`… */
const STYLE_PROPS = new Set([
  "color", "background-color", "font", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-align", "text-decoration", "text-transform", "vertical-align", "white-space",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style", "border-width",
  "border-collapse", "border-spacing", "border-radius",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "display", "object-fit",
]);
const DISPLAY_VALUES = /^(block|inline|inline-block|table|table-row|table-cell|none)$/i;

/** Déclarations CSS une à une, par liste blanche de propriétés ; une valeur qui peut charger ou
 *  exécuter quelque chose (url(), image-set(), data:, expression, @import, \\, <, >) saute. */
function safeStyle(raw: string): string {
  const css = decodeEntities(raw).replace(/\/\*[\s\S]*?\*\//g, "");
  const kept: string[] = [];
  for (const decl of css.split(";")) {
    const d = decl.trim();
    if (!d) continue;
    const m = /^([a-z-]+)\s*:\s*([^]*)$/i.exec(d);
    if (!m) continue;
    const prop = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (!STYLE_PROPS.has(prop) || value === "" || value.length > 300) continue;
    if (/url\s*\(|image-set|expression|javascript|vbscript|data:|@|behavio|binding|\\|<|>|\bvar\s*\(|\bcalc\s*\(|!important/i.test(value)) continue;
    if (prop === "display" && !DISPLAY_VALUES.test(value)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.join(";");
}

interface Attr {
  name: string;
  value: string;
}

/** Attributs d'une balise ouvrante : guillemets doubles, simples ou absents. */
function parseAttrs(src: string): Attr[] {
  const out: Attr[] = [];
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ name: m[1]!.toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? "" });
  return out;
}

/** Nettoie un HTML de signature par liste blanche. Le texte est conservé (échappé), les balises
 *  non permises disparaissent (avec leur contenu pour script, style, iframe, form…), les
 *  attributs `on*`, les `javascript:` et les `url()` de style sont retirés. */
export function sanitizeSignatureHtml(input: string): string {
  const src = String(input ?? "").replace(/\u0000/g, "");
  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;
  let skipUntil: string | null = null;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (!skipUntil) out.push(escapeText(src.slice(i)));
      break;
    }
    if (!skipUntil && lt > i) out.push(escapeText(src.slice(i, lt)));
    // commentaire, doctype, instruction : retirés
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(src.slice(lt));
    if (!tag) {
      if (/^<[!?]/.test(src.slice(lt, lt + 2))) {
        const end = src.indexOf(">", lt);
        i = end < 0 ? src.length : end + 1;
        continue;
      }
      // « < » isolé : du texte
      if (!skipUntil) out.push("&lt;");
      i = lt + 1;
      continue;
    }
    i = lt + tag[0].length;
    const closing = tag[1] === "/";
    const name = tag[2]!.toLowerCase();
    if (skipUntil) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(tag[3] ?? "")) skipUntil = name;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) {
        while (stack.length > at) out.push(`</${stack.pop()}>`);
      }
      continue;
    }
    const allowed = ALLOWED_ATTRS[name]!;
    const attrs: string[] = [];
    let imgHasSrc = false;
    for (const a of parseAttrs(tag[3] ?? "")) {
      if (a.name.startsWith("on") || !allowed.has(a.name)) continue;
      if (a.name === "href") {
        const href = safeHref(a.value);
        if (href) attrs.push(`href="${escapeAttr(href)}"`);
      } else if (a.name === "src") {
        const s = safeImgSrc(a.value);
        if (s) {
          attrs.push(`src="${escapeAttr(s)}"`);
          imgHasSrc = true;
        }
      } else if (a.name === "style") {
        const s = safeStyle(a.value);
        if (s) attrs.push(`style="${escapeAttr(s)}"`);
      } else {
        attrs.push(`${a.name}="${escapeAttr(decodeEntities(a.value).slice(0, 300))}"`);
      }
    }
    if (name === "img" && !imgHasSrc) continue; // une image sans source valable n'a pas d'intérêt
    if (name === "a" && !attrs.some((x) => x.startsWith("href="))) {
      // lien sans destination valable : on garde le texte, pas la balise
      continue;
    }
    if (name === "a") attrs.push('rel="noopener noreferrer"');
    out.push(`<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
    if (!VOID_TAGS.has(name)) stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("").trim();
}

/** Texte d'un HTML : `&` seul reste `&amp;`, mais les entités déjà écrites ne sont pas doublées. */
function escapeText(t: string): string {
  return t.replace(/&(?!(?:[a-z][a-z0-9]{1,8}|#\d{1,7}|#x[0-9a-f]{1,6});)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Adresse publique valable pour un mail : http(s), pas une adresse locale ou privée ; sinon "". */
export function publicOrigin(base: string | null | undefined): string {
  if (!/^https?:\/\//i.test(base ?? "")) return "";
  try {
    const u = new URL(String(base));
    return isPrivateHost(u.hostname) ? "" : String(base).replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Les images en chemin du site (`/img/…`) deviennent des URL absolues : `base` est l'adresse publique
 *  du serveur. Sans adresse publique valable, l'image est RETIRÉE (une image relative serait cassée
 *  chez le destinataire). */
export function absolutizeImages(html: string, base: string | null | undefined): string {
  const origin = publicOrigin(base);
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc="(\/(?!\/)[^"]*)"/i.exec(tag);
    if (!m) return tag;
    if (!origin) return "";
    return tag.replace(m[0], `src="${origin}${m[1]}"`);
  });
}

/** Corps de texte brut → HTML simple : paragraphes (ligne vide) et `<br>` (saut de ligne). */
export function textToHtml(text: string): string {
  const paras = text.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return paras.map((p) => `<p style="margin:0 0 1em 0">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

export interface SignatureSettings {
  signatureText: string;
  signatureHtml: string;
  signatureOnReplies: boolean;
}

export interface Composed {
  text: string;
  html?: string;
}

/** Retire du bas du texte les lignes de la signature (un modèle qui finit par `{signature}` la porte
 *  déjà). null si le corps ne FINIT pas par la signature. Comparaison ligne à ligne, espaces
 *  ignorés ; un « -- » qui la précède part avec elle. */
export function stripTrailingSignature(text: string, sigText: string): string | null {
  const sigLines = sigText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (sigLines.length === 0) return null;
  const lines = text.split("\n");
  let end = lines.length;
  const skipBlank = () => {
    while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  };
  skipBlank();
  for (let k = sigLines.length - 1; k >= 0; k -= 1) {
    if (end === 0 || lines[end - 1]!.trim() !== sigLines[k]) return null;
    end -= 1;
  }
  skipBlank();
  if (end > 0 && lines[end - 1]!.trim() === "--") end -= 1;
  skipBlank();
  return lines.slice(0, end).join("\n");
}

/** Le texte à envoyer, avec la signature si elle est demandée. Jamais deux fois : si le corps FINIT
 *  déjà par la signature texte (modèle terminé par `{signature}`), le texte part tel quel, et la
 *  partie HTML reçoit le corps sans cette signature suivi de la signature HTML. */
export function composeOutgoing(body: string, sig: SignatureSettings | null, publicBase?: string | null): Composed {
  const text = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!sig || !sig.signatureOnReplies) return { text: body };
  const sigText = sig.signatureText.replace(/\r\n?/g, "\n").trim();
  const sigHtml = sig.signatureHtml.trim();
  if (!sigText && !sigHtml) return { text: body };
  const stripped = sigText ? stripTrailingSignature(text, sigText) : null;
  const already = stripped !== null;
  const textOut = already ? text : sigText ? `${text}\n\n-- \n${sigText}` : text;
  if (!sigHtml) return { text: already ? body : textOut };
  const lead = already ? stripped : text;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${textToHtml(lead)}<div style="margin-top:14px">${absolutizeImages(sigHtml, publicBase)}</div></body></html>`;
  return { text: already ? body : textOut, html };
}
