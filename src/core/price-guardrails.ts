// Garde-fous de prix et prix conseillé par plateforme — pur, sans I/O.
//
// Pourquoi ce fichier existe (issue #50, spec UX du 10/08 § 6) : côté
// back-office, un champ vidé par mégarde vaut 0 (`toCents("") === 0`), et le
// PATCH d'une règle tarifaire n'avait AUCUNE borne basse là où le POST en
// avait une. Un tarif à 0 € partait donc vers Airbnb et Booking au push
// suivant. La borne vit ici pour être appliquée au même endroit par TOUS les
// chemins d'écriture : règle de saison comme surcharge de jour.

/** Un prix de nuit est strictement positif. 0 n'est pas « gratuit », c'est un
 *  champ vide — et un champ vide ne se publie pas. */
export const MIN_PRICE_CENTS = 1;

/** Bornes configurées sur un hébergement (colonnes units.price_min/max_cents).
 *  Null = pas de borne posée par le propriétaire. */
export interface PriceBounds {
  minCents: number | null;
  maxCents: number | null;
}

export type PriceCheck = { ok: true; cents: number } | { ok: false; message: string };

function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Valide un prix de nuit : entier de centimes, strictement positif, dans les
 *  bornes de l'hébergement. Le message est destiné à être lu tel quel par le
 *  gestionnaire — il dit la valeur refusée ET la borne violée. */
export function checkPrice(raw: unknown, bounds: PriceBounds, label = "prix"): PriceCheck {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) {
    return { ok: false, message: `${label} manquant ou invalide` };
  }
  const cents = Math.round(n);
  if (cents < MIN_PRICE_CENTS) {
    return { ok: false, message: `${label} à ${formatEuros(cents)} € refusé — un tarif doit être strictement positif` };
  }
  if (bounds.minCents != null && cents < bounds.minCents) {
    return {
      ok: false,
      message: `${label} à ${formatEuros(cents)} € sous le plancher de cet hébergement (${formatEuros(bounds.minCents)} €)`,
    };
  }
  if (bounds.maxCents != null && cents > bounds.maxCents) {
    return {
      ok: false,
      message: `${label} à ${formatEuros(cents)} € au-dessus du plafond de cet hébergement (${formatEuros(bounds.maxCents)} €)`,
    };
  }
  return { ok: true, cents };
}

/** Vérifie la cohérence d'un couple plancher/plafond avant de l'enregistrer. */
export function checkBounds(minCents: number | null, maxCents: number | null): { ok: true } | { ok: false; message: string } {
  if (minCents != null && (!Number.isFinite(minCents) || minCents < MIN_PRICE_CENTS)) {
    return { ok: false, message: "plancher invalide — il doit être strictement positif" };
  }
  if (maxCents != null && (!Number.isFinite(maxCents) || maxCents < MIN_PRICE_CENTS)) {
    return { ok: false, message: "plafond invalide — il doit être strictement positif" };
  }
  if (minCents != null && maxCents != null && minCents > maxCents) {
    return { ok: false, message: "plancher supérieur au plafond" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Prix conseillé par plateforme (issue #31)
// ---------------------------------------------------------------------------

// Les tarifs affichés sur les places de marché sont volontairement majorés par
// rapport à la vente directe, pour compenser leur commission. Le calcul est
// volontairement SANS MAGIE : prix direct × (1 + majoration %), arrondi au
// centime. Aucun modèle caché, aucune donnée de marché — le propriétaire doit
// pouvoir refaire le calcul de tête et rester maître de ses prix.

export interface ChannelMarkup {
  /** identifiant technique du canal (clé stable) */
  channel: string;
  /** intitulé affiché */
  label: string;
  /** majoration en % appliquée au prix direct */
  markupPct: number;
}

/** Valeurs de départ, modifiables depuis le back-office (app_settings).
 *  Le propriétaire évoque « +15 à 18 % » selon la plateforme. */
export const DEFAULT_CHANNEL_MARKUPS: ChannelMarkup[] = [
  { channel: "airbnb", label: "Airbnb", markupPct: 18 },
  { channel: "booking", label: "Booking.com", markupPct: 18 },
  { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15 },
];

/** Clé du réglage global qui porte la configuration des canaux. */
export const CHANNEL_MARKUPS_KEY = "pricing.channel_markups";

/** Formule exposée telle quelle par l'API, pour que l'interface puisse
 *  l'afficher au lieu de laisser croire à un calcul opaque. */
export const CHANNEL_PRICE_FORMULA = "prix direct × (1 + majoration %), arrondi au centime";

/** Majoration valide : 0 à 100 %, sur un canal identifié. */
export function normalizeChannelMarkups(raw: unknown): ChannelMarkup[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChannelMarkup[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    const channel = String(r.channel ?? "").trim().toLowerCase();
    const pct = Number(r.markupPct);
    if (!/^[a-z0-9_-]{1,32}$/.test(channel) || seen.has(channel)) return null;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    seen.add(channel);
    out.push({ channel, label: String(r.label ?? "").trim() || channel, markupPct: pct });
  }
  return out;
}

/** Relit la configuration stockée ; retombe sur les valeurs de départ si la
 *  clé est absente ou corrompue (jamais d'erreur sur un chemin d'affichage). */
export function parseChannelMarkups(stored: string | null): ChannelMarkup[] {
  if (!stored) return DEFAULT_CHANNEL_MARKUPS;
  try {
    return normalizeChannelMarkups(JSON.parse(stored)) ?? DEFAULT_CHANNEL_MARKUPS;
  } catch {
    return DEFAULT_CHANNEL_MARKUPS;
  }
}

/** Prix conseillé sur un canal, à partir du prix de vente directe. */
export function suggestedPriceCents(directCents: number, markupPct: number): number {
  return Math.round(directCents * (1 + markupPct / 100));
}

export interface ChannelSuggestion extends ChannelMarkup {
  suggestedCents: number;
}

/** Prix conseillé sur tous les canaux configurés. */
export function suggestForChannels(directCents: number, channels: readonly ChannelMarkup[]): ChannelSuggestion[] {
  return channels.map((c) => ({ ...c, suggestedCents: suggestedPriceCents(directCents, c.markupPct) }));
}
