// Liens d'un mail entrant, présentés sans jamais les rendre cliquables d'office.
//
// Le texte d'un mail relevé écrit un lien HTML « texte (adresse) ». On en tire la liste des
// adresses http(s) — dédoublonnées, 20 au plus — avec leur domaine réel (celui que le
// navigateur ouvrirait, en punycode pour un nom internationalisé). L'écran affiche le
// domaine en gras ; « Ouvrir » n'existe que si Gmail atteste l'expéditeur.

export interface MailLinkInfo {
  url: string;
  /** Domaine réel : celui que le navigateur ouvrirait, ou, pour un redirecteur connu (google.com/url…), celui de la cible. */
  host: string;
  /** Adresse sûre à ouvrir : ni identifiant « user@ » devant le domaine, ni redirecteur, ni adresse locale ou privée. */
  openable: boolean;
  /** Redirecteur par lequel passe le lien (« google.com ») : la cible réelle est affichée, jamais ouvrable. */
  via?: string;
}

const MAX_LINKS = 20;
const MAX_URL = 2000;

/** Retire la ponctuation qui suit une adresse dans une phrase ; garde une « ) » seulement si elle ferme une « ( » de l'adresse. */
function trimTrail(u: string): string {
  let s = u;
  for (;;) {
    const last = s[s.length - 1];
    if (last && ".,;:!?'\"]}>".includes(last)) s = s.slice(0, -1);
    else if (last === ")" && (s.match(/\(/g) ?? []).length < (s.match(/\)/g) ?? []).length) s = s.slice(0, -1);
    else return s;
  }
}

/** Redirecteurs connus : le vrai lien est dans un paramètre. */
const REDIRECTORS: { host: RegExp; path: RegExp; params: string[] }[] = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/url$/, params: ["q", "url"] },
  { host: /^(l|lm)\.facebook\.com$/, path: /^\/l\.php$/, params: ["u"] },
  { host: /^l\.instagram\.com$/, path: /^\/$/, params: ["u"] },
  { host: /^out\.reddit\.com$/, path: /./, params: ["url"] },
  { host: /\.safelinks\.protection\.outlook\.com$/, path: /./, params: ["url"] },
  { host: /(^|\.)linkedin\.com$/, path: /^\/(safety\/go|redir\/redirect)/, params: ["url"] },
  { host: /(^|\.)youtube\.com$/, path: /^\/redirect$/, params: ["q"] },
];

/** Hôte local ou privé (boucle, réseau privé, lien local, nom sans point) : jamais ouvrable. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (h.startsWith("[")) {
    const v6 = h.slice(1, -1);
    return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:") || v6.startsWith("64:ff9b:");
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return !h.includes(".");
}

function parseHttp(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u : null;
  } catch {
    return null;
  }
}

export function extractLinks(text: string): MailLinkInfo[] {
  const out: MailLinkInfo[] = [];
  const seen = new Set<string>();
  // caractères de contrôle bidi et espaces de largeur nulle : retirés (ils déguisent un domaine ou une extension)
  const clean = text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
  for (const m of clean.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const raw = trimTrail(m[0]);
    if (raw.length > MAX_URL || seen.has(raw)) continue;
    const u = parseHttp(raw);
    if (!u) continue;
    seen.add(raw);
    let host = u.hostname;
    let via: string | undefined;
    let openable = !u.username && !u.password && !isPrivateHost(u.hostname);
    const red = REDIRECTORS.find((r) => r.host.test(u.hostname.toLowerCase()) && r.path.test(u.pathname));
    if (red) {
      const target = red.params.map((k) => u.searchParams.get(k)).find((v) => v);
      const tu = target ? parseHttp(target) : null;
      via = u.hostname;
      if (tu) host = tu.hostname;
      openable = false;
    }
    out.push({ url: raw, host, openable, ...(via ? { via } : {}) });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** Les liens d'un message et le droit de les ouvrir : expéditeur attesté par Gmail ET message non usurpé. */
export function linksOf(m: { channel: string; direction: string; bodyText: string; senderAuth: boolean; spoofed: boolean }): {
  links: MailLinkInfo[];
  linksOpenable: boolean;
} {
  if (m.channel !== "email" || m.direction !== "in") return { links: [], linksOpenable: false };
  const allowed = m.senderAuth && !m.spoofed;
  return { links: extractLinks(m.bodyText).map((l) => ({ ...l, openable: l.openable && allowed })), linksOpenable: allowed };
}
