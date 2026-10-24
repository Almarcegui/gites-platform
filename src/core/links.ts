// Liens d'un mail entrant, présentés sans jamais les rendre cliquables d'office.
//
// Le texte d'un mail relevé écrit un lien HTML « texte (adresse) ». On en tire la liste des
// adresses http(s) — dédoublonnées, 20 au plus — avec leur domaine réel (celui que le
// navigateur ouvrirait, en punycode pour un nom internationalisé). L'écran affiche le
// domaine en gras ; « Ouvrir » n'existe que si Gmail atteste l'expéditeur.

export interface MailLinkInfo {
  url: string;
  /** Domaine réel (hostname normalisé par URL). */
  host: string;
  /** Adresse sûre à ouvrir : sans identifiant « user@ » caché devant le domaine. */
  openable: boolean;
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

export function extractLinks(text: string): MailLinkInfo[] {
  const out: MailLinkInfo[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const raw = trimTrail(m[0]);
    if (raw.length > MAX_URL || seen.has(raw)) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (!u.hostname) continue;
    seen.add(raw);
    out.push({ url: raw, host: u.hostname, openable: !u.username && !u.password });
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
