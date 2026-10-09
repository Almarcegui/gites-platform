// Back-office — lecture du formulaire des majorations par canal (issue #97).
//
// Isolé sans DOM ni import, pour être testé directement (même parti pris que
// `badges.js` et `suggestions.js`). La vue « Canaux OTA » (config.js) lui passe
// la configuration renvoyée par `GET /api/admin/channel-markups` et les valeurs
// saisies ; il rend la liste à envoyer au `PUT`, ou l'erreur à afficher.

/** Lit un pourcentage saisi : virgule décimale acceptée (« 17,5 »), deux
 *  décimales au plus. Renvoie `null` si la saisie n'est pas un nombre. */
export function parsePct(raw) {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const pct = Number(text);
  return Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null;
}

/**
 * Construit la liste à envoyer au serveur à partir des saisies.
 *
 * @param {{channel: string, label: string, markupPct: number}[]} channels configuration actuelle
 * @param {Record<string, unknown>} values saisie par canal (`{ airbnb: "20" }`) ; un canal absent garde sa valeur
 * @param {string | null} pushChannel canal appliqué aux prix poussés, ou null
 * @param {number} maxPct borne haute de saisie, donnée par le serveur
 * @returns {{ ok: false, error: string } | { ok: true, channels: {channel: string, label: string, markupPct: number}[],
 *   changed: string[], applied: null | { label: string, from: number, to: number } }}
 *   `applied` n'est renseigné que si le canal appliqué change de taux : c'est le
 *   seul cas où l'enregistrement renvoie les calendriers aux plateformes.
 */
export function readMarkupEdits(channels, values, pushChannel, maxPct) {
  const out = [];
  const changed = [];
  let applied = null;
  for (const c of channels) {
    const raw = Object.prototype.hasOwnProperty.call(values, c.channel) ? values[c.channel] : c.markupPct;
    const pct = parsePct(raw);
    if (pct == null) return { ok: false, error: `${c.label} : saisir un pourcentage (ex. 18)` };
    if (pct < 0 || pct > maxPct) return { ok: false, error: `${c.label} : la majoration va de 0 à ${maxPct} %` };
    if (pct !== c.markupPct) {
      changed.push(c.channel);
      if (c.channel === pushChannel) applied = { label: c.label, from: c.markupPct, to: pct };
    }
    out.push({ channel: c.channel, label: c.label, markupPct: pct });
  }
  return { ok: true, channels: out, changed, applied };
}
