// Promotions Airbnb et prix dérivés par canal (lot 3, Réglages › Plateformes).
//
// Deux réglages, une seule source de chiffres :
//  1. Les PROMOTIONS AIRBNB, transmises par Beds24 (`POST /channels/settings`,
//     canal airbnb) : remise 7 / 14 / 28 nuits, réservation tôt (early bird),
//     dernière minute, tarif non remboursable. Bornes du schéma Beds24 v2
//     (apiV2.yaml, airbnbSettingsPost) : durée 0-90 %, autres 0-50 %, jours
//     d'avance de l'early bird dans une liste fixe, dernière minute 0-28 jours.
//  2. Les PRIX DÉRIVÉS (`priceRules[].priceLinking` d'une chambre Beds24) : le
//     calendrier part au prix de vente directe (ligne de prix 1) et Beds24
//     calcule le prix de chaque plateforme (Booking = base × 1,18…). Les
//     multiplicateurs viennent des MAJORATIONS EXISTANTES (pricing.channel_markups) :
//     un seul endroit où l'on règle « + 18 % sur Booking ». Tant que les prix
//     dérivés sont actifs, le calendrier n'applique plus la majoration du
//     « canal de référence » (sinon la commission serait comptée deux fois).
//
// Fonctions pures : aucune lecture de base, aucun appel réseau.

import type { ChannelMarkup } from "./price-guardrails";

export interface AirbnbPromotions {
  weeklyPct: number; // 7 nuits et plus
  biweeklyPct: number; // 14 nuits et plus
  monthlyPct: number; // 28 nuits et plus
  earlyBirdDays: number | null; // null = pas d'early bird
  earlyBirdPct: number;
  lastMinuteDays: number | null; // null = pas de dernière minute
  lastMinutePct: number;
  nonRefundablePct: number;
}

export const AIRBNB_PROMOTIONS_KEY = "channels.airbnb_promotions";
export const AIRBNB_PROMOTIONS_SENT_KEY = "channels.airbnb_promotions_sent";
export const PRICE_LINKING_KEY = "channels.price_linking";

export const NO_AIRBNB_PROMOTIONS: AirbnbPromotions = {
  weeklyPct: 0,
  biweeklyPct: 0,
  monthlyPct: 0,
  earlyBirdDays: null,
  earlyBirdPct: 0,
  lastMinuteDays: null,
  lastMinutePct: 0,
  nonRefundablePct: 0,
};

/** Jours d'avance admis par Airbnb pour l'early bird (schéma Beds24). */
export const EARLY_BIRD_DAYS = [28, 30, 56, 60, 84, 90, 112, 120, 140, 150, 168, 180, 196, 210, 224, 240, 252, 270, 280, 300, 308, 330, 336, 360] as const;

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** Valide une saisie ; rend le message d'erreur en clair au lieu de corriger en silence. */
export function normalizeAirbnbPromotions(raw: unknown): { ok: true; value: AirbnbPromotions } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "promotions attendues" };
  const r = raw as Record<string, unknown>;
  const pct = (k: string, max: number) => int(r[k] ?? 0, 0, max);
  const weeklyPct = pct("weeklyPct", 90);
  const biweeklyPct = pct("biweeklyPct", 90);
  const monthlyPct = pct("monthlyPct", 90);
  if (weeklyPct == null || biweeklyPct == null || monthlyPct == null) return { ok: false, message: "remise de durée : un nombre entier de 0 à 90 %" };
  const earlyBirdPct = pct("earlyBirdPct", 50);
  const lastMinutePct = pct("lastMinutePct", 50);
  const nonRefundablePct = pct("nonRefundablePct", 50);
  if (earlyBirdPct == null || lastMinutePct == null || nonRefundablePct == null) return { ok: false, message: "réservation tôt, dernière minute, non remboursable : un nombre entier de 0 à 50 %" };
  let earlyBirdDays: number | null = null;
  if (r.earlyBirdDays != null) {
    if (!EARLY_BIRD_DAYS.includes(r.earlyBirdDays as (typeof EARLY_BIRD_DAYS)[number])) return { ok: false, message: `réservation tôt : ${EARLY_BIRD_DAYS.join(", ")} jours seulement (règle Airbnb)` };
    earlyBirdDays = r.earlyBirdDays as number;
  }
  let lastMinuteDays: number | null = null;
  if (r.lastMinuteDays != null) {
    lastMinuteDays = int(r.lastMinuteDays, 1, 28);
    if (lastMinuteDays == null) return { ok: false, message: "dernière minute : de 1 à 28 jours avant l'arrivée" };
  }
  // Une remise plus longue plus faible qu'une plus courte n'a pas de sens :
  // Airbnb applique la remise du palier atteint, pas la meilleure.
  if ((biweeklyPct && biweeklyPct < weeklyPct) || (monthlyPct && monthlyPct < Math.max(weeklyPct, biweeklyPct))) {
    return { ok: false, message: "la remise d'un séjour plus long doit être au moins égale à celle d'un séjour plus court" };
  }
  if (earlyBirdPct > 0 && earlyBirdDays == null) return { ok: false, message: "réservation tôt : choisir le nombre de jours d'avance" };
  if (lastMinutePct > 0 && lastMinuteDays == null) return { ok: false, message: "dernière minute : choisir le nombre de jours avant l'arrivée" };
  return { ok: true, value: { weeklyPct, biweeklyPct, monthlyPct, earlyBirdDays, earlyBirdPct, lastMinuteDays, lastMinutePct, nonRefundablePct } };
}

export function parseAirbnbPromotions(stored: string | null): AirbnbPromotions {
  if (!stored) return NO_AIRBNB_PROMOTIONS;
  try {
    const r = normalizeAirbnbPromotions(JSON.parse(stored));
    return r.ok ? r.value : NO_AIRBNB_PROMOTIONS;
  } catch {
    return NO_AIRBNB_PROMOTIONS;
  }
}

/** Corps de `POST /channels/settings` pour une propriété Beds24 et ses chambres. */
export function airbnbSettingsBody(beds24PropertyId: number, roomIds: number[], p: AirbnbPromotions): unknown[] {
  return [
    {
      channel: "airbnb",
      properties: [
        {
          id: beds24PropertyId,
          roomTypes: roomIds.map((id) => ({
            id,
            "7DayDiscountPercent": p.weeklyPct,
            "14DayDiscountPercent": p.biweeklyPct,
            "28DayDiscountPercent": p.monthlyPct,
            // Sans palier choisi, la remise est remise à 0 (Beds24 garde sinon l'ancienne).
            ...(p.earlyBirdDays != null ? { earlyBirdDaysToCheckin: p.earlyBirdDays } : {}),
            earlyBirdDiscountPercent: p.earlyBirdDays != null ? p.earlyBirdPct : 0,
            lastMinuteDaysToCheckin: p.lastMinuteDays ?? 0,
            lastMinuteDiscountPercent: p.lastMinuteDays != null ? p.lastMinutePct : 0,
            nonRefundableDiscountPercent: p.nonRefundablePct,
          })),
        },
      ],
    },
  ];
}

/** Remise de durée qu'Airbnb applique à un séjour de `nights` nuits (palier atteint). */
export function lengthDiscountPct(p: AirbnbPromotions, nights: number): number {
  if (nights >= 28 && p.monthlyPct) return p.monthlyPct;
  if (nights >= 14 && p.biweeklyPct) return p.biweeklyPct;
  if (nights >= 7 && p.weeklyPct) return p.weeklyPct;
  return 0;
}

const off = (cents: number, pct: number) => Math.round(cents * (1 - pct / 100));

export interface AirbnbPreview {
  stayCents: number;
  nights: number;
  markupPct: number;
  /** Prix du séjour sur Airbnb, majoration comprise, avant remise. */
  airbnbCents: number;
  lengthPct: number;
  /** Avec la remise de durée (le cas courant). */
  withLengthCents: number;
  /** Autres cas, chacun calculé SEUL à partir du prix avec remise de durée :
   *  Airbnb décide du cumul (Beds24 transmet les remises telles quelles). */
  nonRefundableCents: number | null;
  earlyBirdCents: number | null;
  lastMinuteCents: number | null;
}

/** « Un séjour de 7 nuits à 1 400 € part à … sur Airbnb. » */
export function airbnbPreview(stayCents: number, nights: number, markupPct: number, p: AirbnbPromotions): AirbnbPreview {
  const airbnbCents = Math.round(stayCents * (1 + markupPct / 100));
  const lengthPct = lengthDiscountPct(p, nights);
  const withLengthCents = off(airbnbCents, lengthPct);
  return {
    stayCents,
    nights,
    markupPct,
    airbnbCents,
    lengthPct,
    withLengthCents,
    nonRefundableCents: p.nonRefundablePct ? off(withLengthCents, p.nonRefundablePct) : null,
    earlyBirdCents: p.earlyBirdDays != null && p.earlyBirdPct ? off(withLengthCents, p.earlyBirdPct) : null,
    lastMinuteCents: p.lastMinuteDays != null && p.lastMinutePct ? off(withLengthCents, p.lastMinutePct) : null,
  };
}

// --- prix dérivés -------------------------------------------------------------

/** Nos canaux → nom du canal chez Beds24 (`priceRules[].channels.<nom>`). */
export const BEDS24_CHANNEL_OF: Record<string, string> = { airbnb: "airbnb", booking: "booking", abritel: "vrbo", vrbo: "vrbo", expedia: "expedia" };

export interface PriceLinkingState {
  enabled: boolean;
  /** Majorations envoyées au dernier envoi réussi (pour dire si Beds24 est à jour). */
  sentMarkups: Record<string, number> | null;
  sentAt: string | null;
}

export function parsePriceLinking(stored: string | null): PriceLinkingState {
  try {
    const r = stored ? (JSON.parse(stored) as Partial<PriceLinkingState>) : {};
    return { enabled: r.enabled === true, sentMarkups: r.sentMarkups ?? null, sentAt: r.sentAt ?? null };
  } catch {
    return { enabled: false, sentMarkups: null, sentAt: null };
  }
}

/** Multiplicateur Beds24 d'une majoration : + 18 % → 1,18 (borné à 0,1-9,99 par Beds24). */
export function linkMultiplier(markupPct: number): number {
  return Math.round((1 + markupPct / 100) * 10000) / 10000;
}

export interface DerivedLine {
  channel: string;
  label: string;
  beds24Channel: string;
  markupPct: number;
  multiplier: number;
  /** Ligne de prix Beds24 (2 à 16) qui porte ce canal. */
  priceId: number;
}

/** Une ligne de prix dérivée par canal relié (Airbnb, Booking, Vrbo…), dans l'ordre des majorations. */
export function derivedLines(markups: readonly ChannelMarkup[]): DerivedLine[] {
  const out: DerivedLine[] = [];
  const used = new Set<string>();
  for (const m of markups) {
    const b = BEDS24_CHANNEL_OF[m.channel];
    if (!b || used.has(b) || out.length >= 15) continue;
    used.add(b);
    out.push({ channel: m.channel, label: m.label, beds24Channel: b, markupPct: m.markupPct, multiplier: linkMultiplier(m.markupPct), priceId: out.length + 2 });
  }
  return out;
}

/** `priceRules` d'une chambre : ligne 1 = prix direct poussé par le calendrier
 *  (ouverte aux canaux sans ligne dérivée), une ligne par canal relié, liée à la
 *  ligne 1. `enabled: false` défait les liens et rend la ligne 1 à tous les canaux. */
export function priceRulesFor(lines: readonly DerivedLine[], enabled: boolean): unknown[] {
  const base: Record<string, { enabled: boolean }> = {};
  for (const l of lines) base[l.beds24Channel] = { enabled: !enabled };
  return [
    { id: 1, channels: base },
    ...lines.map((l) => ({
      id: l.priceId,
      name: `${l.label} (prix direct × ${String(l.multiplier).replace(".", ",")})`,
      priceLinking: enabled ? { roomId: null, priceId: 1, offsetMultiplier: l.multiplier, offsetAmount: 0 } : { priceId: null },
      bookingPage: { direct: false, agent: false },
      channels: { [l.beds24Channel]: { enabled } },
    })),
  ];
}

/** Corps de `POST /properties` qui pose (ou défait) les prix dérivés d'une propriété. */
export function priceLinkingBody(beds24PropertyId: number, roomIds: number[], lines: readonly DerivedLine[], enabled: boolean): unknown[] {
  return [{ id: beds24PropertyId, roomTypes: roomIds.map((id) => ({ id, priceRules: priceRulesFor(lines, enabled) })) }];
}

/** Majoration effective sur Airbnb : sa ligne dérivée si les prix dérivés sont
 *  actifs, sinon la majoration du canal de référence (le même prix partout). */
export function airbnbMarkupPct(linking: boolean, markups: readonly ChannelMarkup[], pushPct: number): number {
  if (!linking) return pushPct;
  return markups.find((m) => BEDS24_CHANNEL_OF[m.channel] === "airbnb")?.markupPct ?? 0;
}
