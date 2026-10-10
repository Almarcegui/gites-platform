// Accès administrateur fermé au public (lot 2, point 7).
//
// ADMIN_ALLOWED_IPS : liste d'adresses ou de plages CIDR séparées par des
// virgules ou des espaces (« 81.82.83.84, 2a02:1810::/32 »). VIDE = ouvert :
// la garde n'est jamais active par défaut. Une liste illisible ferme l'accès
// (fail-closed) plutôt que de l'ouvrir en silence.
//
// Fonctions pures : le Worker passe `cf-connecting-ip`, le serveur Node
// l'adresse de la socket (ou du proxy de confiance, cf. TRUST_PROXY).

/** Chemins protégés : l'API admin et les deux écrans.
 *
 *  Comparés SEGMENT par SEGMENT, comme le routeur les lit (segments vides
 *  retirés, chacun décodé) et sans tenir compte de la casse : « /api//admin »,
 *  « //admin2/ » ou « /api/%61dmin » ne contournent pas la garde. Un chemin
 *  indécodable est traité comme protégé. */
export function isAdminPath(pathname: string): boolean {
  let segs: string[];
  try {
    segs = pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  } catch {
    return true;
  }
  const first = segs[0] ?? "";
  if (first === "admin" || first === "admin2") return true;
  return first === "api" && segs[1] === "admin";
}

interface Range {
  v6: boolean;
  bytes: Uint8Array;
  prefix: number;
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i] ?? "";
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // IPv4 en queue (::ffff:1.2.3.4) : réécrite en deux groupes hexadécimaux.
  if (s.includes(".")) {
    const at = s.lastIndexOf(":");
    const v4 = parseV4(s.slice(at + 1));
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, at + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else groups = head;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[2 * i] = g >> 8;
    out[2 * i + 1] = g & 0xff;
  });
  return out;
}

/** Adresse IP lue, ramenée à IPv4 quand c'est une IPv4 mappée (::ffff:a.b.c.d). */
export function parseIp(s: string): { v6: boolean; bytes: Uint8Array } | null {
  const t = s.trim().replace(/^\[|\]$/g, "");
  if (!t) return null;
  const v4 = parseV4(t);
  if (v4) return { v6: false, bytes: v4 };
  const v6 = parseV6(t);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mapped) return { v6: false, bytes: v6.slice(12) };
  return { v6: true, bytes: v6 };
}

/** Liste lue. `null` si une entrée est illisible (la garde ferme alors tout). */
export function parseAllowList(raw: string | undefined | null): Range[] | null {
  const entries = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  const out: Range[] = [];
  for (const e of entries) {
    const [addr, pre] = e.split("/");
    const ip = parseIp(addr ?? "");
    if (!ip) return null;
    const max = ip.v6 ? 128 : 32;
    let prefix = max;
    if (pre !== undefined) {
      if (!/^\d{1,3}$/.test(pre)) return null;
      prefix = Number(pre);
      if (prefix > max) return null;
    }
    out.push({ v6: ip.v6, bytes: ip.bytes, prefix });
  }
  return out;
}

function inRange(ip: { v6: boolean; bytes: Uint8Array }, r: Range): boolean {
  if (ip.v6 !== r.v6) return false;
  let bits = r.prefix;
  for (let i = 0; i < r.bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((ip.bytes[i] ?? 0) & mask) !== ((r.bytes[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

/** Décision de la garde : `open` (liste vide), `allowed`, ou `denied`. */
export function adminIpDecision(raw: string | undefined | null, clientIp: string | null | undefined): "open" | "allowed" | "denied" {
  if (!(raw ?? "").trim()) return "open";
  const list = parseAllowList(raw);
  if (!list) return "denied";
  const ip = parseIp(clientIp ?? "");
  if (!ip) return "denied";
  return list.some((r) => inRange(ip, r)) ? "allowed" : "denied";
}

/** Réponse 403 explicite pour un chemin admin refusé, ou null si l'accès passe. */
export function adminIpGate(pathname: string, raw: string | undefined | null, clientIp: string | null | undefined): Response | null {
  if (!isAdminPath(pathname)) return null;
  if (adminIpDecision(raw, clientIp) !== "denied") return null;
  const message = "accès administrateur fermé depuis cette adresse (ADMIN_ALLOWED_IPS)";
  if (pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: message, code: "admin_ip_denied" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accès fermé</title><body style="font:18px/1.5 system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 16px"><h1>Accès fermé</h1><p>Le back-office n'est ouvert que depuis certaines adresses. Celle de cet appareil n'en fait pas partie.</p><p>Si c'est une erreur, la liste se règle dans la variable <code>ADMIN_ALLOWED_IPS</code> du serveur.</p></body></html>`,
    { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
