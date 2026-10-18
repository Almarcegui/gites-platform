// Moteur de tarification — pur, déterministe, sans I/O.
//
// Empilement des règles (plan v1 § 5) :
//   0. Surcharge du jour (rate_overrides, migration 0014) : un prix posé sur
//      une date précise est un PRIX FINAL ABSOLU — ni supplément week-end ni
//      majoration fériés ne s'y ajoutent (spec UX du 10/08 § 3). Sans cette
//      règle, saisir 200 € sur le 21 juillet facturerait 230 €.
//   1. Saison de chaque nuit (priorité la plus haute gagne ; nuit hors saison
//      ou saison sans règle → tarif de base, season_id NULL).
//   2. Type de nuit : semaine / weekend (nuits de vendredi et samedi) ;
//      majoration % automatique sur les nuits fériées, veilles de férié et
//      ponts belges (fériés calculés — src/core/holidays.ts).
//   3. Remises automatiques : la MEILLEURE s'applique SEULE (long séjour /
//      early bird / last minute ne se cumulent pas — défaut à valider avec
//      Julien) ; un code promo s'ajoute ENSUITE sur le montant déjà remisé.
//   4. Options payantes + taxe de séjour communale.
//
// Les remises portent sur le sous-total HÉBERGEMENT uniquement (majoration
// fériés comprise), jamais sur les options ni la taxe.
// Tous les montants sont en centimes ; les pourcentages sont arrondis au
// centime le plus proche (Math.round) au moment où chaque ligne est calculée.
//
// Unité composite (Domaine entier) :
//   'sum' → chaque maison composante est tarifée avec SES règles, le devis
//           détaille les lignes par maison (TODO_PRIX_COMBINE : défaut actuel).
//   'own' → l'unité composite a sa propre grille rate_rules.

import { addDays, dayOfWeek, diffDays, eachNight, type IsoDate } from "./dates";
import { holidayRatedDays, isHolidayRatedNight, yearsSpanned } from "./holidays";

export interface Season {
  id: number;
  name: string;
  dateStart: IsoDate; // inclus
  dateEnd: IsoDate;   // inclus
  priority: number;
}

export interface RateRule {
  id: number;
  unitId: number;
  seasonId: number | null; // NULL = tarif de base
  priceWeekCents: number;
  priceWeekendCents: number;
  holidayPct: number;
  minNights: number;
  checkinDays: number[] | null; // jours d'arrivée autorisés, 0=dim … 6=sam
}

/** Surcharge posée sur UN jour et UNE unité (table rate_overrides).
 *  `priceCents` null = pas de surcharge de prix (la saison s'applique) ;
 *  `minNights` null = pas de surcharge de minimum de nuits. */
export interface RateOverride {
  unitId: number;
  date: IsoDate;
  priceCents: number | null;
  minNights: number | null;
}

/** Provenance d'une valeur tarifaire — sert à colorer la cellule du calendrier
 *  (spec UX § 2 : trois provenances, pas deux). */
export type RateSource = "override" | "saison" | "base";

/** Index (unité, jour) → surcharge, pour une résolution en O(1) par nuit. */
export function indexOverrides(list: readonly RateOverride[]): Map<string, RateOverride> {
  const m = new Map<string, RateOverride>();
  for (const o of list) m.set(`${o.unitId}|${o.date}`, o);
  return m;
}

export interface Promotion {
  id: number;
  kind: "code" | "long_stay" | "early_bird" | "last_minute";
  code: string | null;
  label: string;
  discountPct: number | null;
  discountCents: number | null;
  /** long_stay : nuits min · early_bird : jours avant l'arrivée min ·
   *  last_minute : jours avant l'arrivée max */
  threshold: number | null;
  validFrom: IsoDate | null;  // fenêtre sur la DATE DE RÉSERVATION
  validUntil: IsoDate | null;
  maxUses: number | null;
  uses: number;
  active: boolean;
}

export interface OptionDef {
  id: number;
  name: string;
  pricingMode: "per_stay" | "per_night" | "per_person" | "per_person_night" | "per_unit_qty";
  priceCents: number;
  maxQty: number | null;
  unitLabel: string | null;
}

export interface PricingSettings {
  /** pourcentage d'arrhes du DOMAINE — repli quand l'unité n'en fixe pas
   *  (issue #75) */
  depositPct: number;
  balanceDueDays: number;                // solde exigible à J-30
  touristTaxCentsPerPersonNight: number;
  touristTaxIncludeChildren: boolean;
  cautionCents: number;                  // informatif — PAS inclus dans le total
  /** Délai minimum de réservation, en jours avant l'arrivée (demande n° 15,
   *  2026-10-17). 0 ou absent = aucune contrainte. Réglage du DOMAINE. */
  minLeadDays?: number;
}

const FRAIS_GENERAUX = "Frais généraux — ménage et charges";

type FeeSource = { cleaningFeeCents: number; chargesExtraNightCents?: number; feeIncludedNights?: number };

/** Frais généraux d'un hébergement pour `nights` nuits :
 *  forfait + max(0, nuits − nuits incluses) × supplément par nuit. */
function generalFeeCents(u: FeeSource, nights: number): number {
  const included = u.feeIncludedNights ?? 2;
  const extra = u.chargesExtraNightCents ?? 0;
  return u.cleaningFeeCents + Math.max(0, nights - included) * extra;
}

/** Libellé de la ligne. Sans supplément : le libellé historique. Avec supplément :
 *  nuits incluses et tarif par nuit. Si plusieurs composantes ont des règles
 *  différentes, le libellé reste générique (le montant, lui, est exact). */
function generalFeeLabel(parts: FeeSource[]): string {
  const withExtra = parts.filter((c) => (c.chargesExtraNightCents ?? 0) > 0);
  if (withExtra.length === 0) return FRAIS_GENERAUX;
  const included = withExtra[0]!.feeIncludedNights ?? 2;
  if (parts.some((c) => (c.feeIncludedNights ?? 2) !== included)) return FRAIS_GENERAUX;
  const extra = withExtra.reduce((s, c) => s + (c.chargesExtraNightCents ?? 0), 0);
  const eur = extra / 100;
  const eurTxt = Number.isInteger(eur) ? String(eur) : eur.toFixed(2).replace(".", ",");
  return `${FRAIS_GENERAUX} (${included} nuit${included > 1 ? "s" : ""} incluse${included > 1 ? "s" : ""}, +${eurTxt} €/nuit)`;
}

export interface UnitPricingInfo {
  id: number;
  name: string;
  compositePricing: "own" | "sum";
  /** frais de ménage fixes par séjour (0 = aucun) */
  cleaningFeeCents: number;
  /** supplément de charges par nuit au-delà des nuits incluses (0 = aucun) */
  chargesExtraNightCents?: number;
  /** nombre de nuits couvertes par le forfait (défaut 2) */
  feeIncludedNights?: number;
  /** composantes d'une unité composite en mode 'sum' (dérivées de unit_links) */
  components: {
    id: number; name: string; cleaningFeeCents: number;
    chargesExtraNightCents?: number; feeIncludedNights?: number;
  }[];
  /** pourcentage d'arrhes propre à l'hébergement (issue #75).
   *  null ou absent = repli sur `settings.depositPct` du domaine. */
  depositPct?: number | null;
}

export interface QuoteRequest {
  unit: UnitPricingInfo;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  today: IsoDate; // date de réservation (Europe/Brussels)
  seasons: Season[];
  rateRules: RateRule[]; // règles de l'unité ET de ses composantes
  /** surcharges par jour de l'unité ET de ses composantes, sur le séjour */
  rateOverrides?: readonly RateOverride[];
  promotions: Promotion[];
  promoCode?: string | null;
  optionsSelected: { option: OptionDef; qty: number }[];
  settings: PricingSettings;
  /** Vente du back-office : le délai minimum devient un avertissement
   *  (`warnings: ['lead_time']`) au lieu d'une erreur. Jamais côté public. */
  bypassLeadTime?: boolean;
}

export interface QuoteLine {
  kind: "accommodation" | "holiday_surcharge" | "discount" | "promo" | "fee" | "option" | "tax";
  label: string;
  amountCents: number; // négatif pour les remises
  /** Libellé sans l'origine du prix, pour le tunnel et le voucher (issue #47).
   *  `label` garde la provenance (« · tarif de base », nom de saison) : elle
   *  sert au back-office, pas au voyageur. Absent = pas de reformulation. */
  publicLabel?: string;
  /** Prix d'UNE nuit du groupe, quand toutes ont le même (issue #47). */
  unitPriceCents?: number;
}

export interface Quote {
  ok: boolean;
  /** erreurs bloquantes : 'invalid_dates', 'no_rate', 'min_nights', 'checkin_day', 'lead_time' */
  errors: string[];
  /** avertissements non bloquants : 'promo_invalid', 'lead_time' (back-office seulement) */
  warnings: string[];
  nights: number;
  minNights: number;
  /** jours d'arrivée autorisés par la règle de la nuit d'arrivée (0=dim … 6=sam) ;
   *  null = aucune contrainte. Exposé pour que le tunnel puisse DIRE la règle
   *  au lieu d'afficher un refus sec (issue #66). */
  checkinDays: number[] | null;
  /** Délai minimum de réservation du domaine, en jours. Présent seulement
   *  quand il est non nul : avec le réglage à 0, le devis reste identique à
   *  l'octet près (la reprise d'option compare le JSON du devis). */
  minLeadDays?: number;
  lines: QuoteLine[];
  accommodationCents: number; // hébergement avant remises (majoration comprise)
  discountCents: number;      // remise auto + code promo (positif)
  cleaningFeeCents: number;   // frais de ménage (fixes par séjour)
  optionsCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;       // dû à la réservation
  /** pourcentage d'arrhes réellement appliqué : celui de l'unité si elle en
   *  fixe un, sinon celui du domaine (issue #75) */
  depositPct: number;
  balanceCents: number;
  balanceDueDate: IsoDate | null; // null = paiement total immédiat
  cautionCents: number;
  autoDiscountApplied: string | null; // label de la remise auto retenue
  promoApplied: string | null;        // code promo appliqué
}

// ---------------------------------------------------------------------------

function seasonForNight(night: IsoDate, seasons: Season[]): Season | null {
  let best: Season | null = null;
  for (const s of seasons) {
    if (night >= s.dateStart && night <= s.dateEnd) {
      if (!best || s.priority > best.priority || (s.priority === best.priority && s.id > best.id)) {
        best = s;
      }
    }
  }
  return best;
}

function ruleFor(unitId: number, seasonId: number | null, rules: RateRule[]): RateRule | null {
  return rules.find((r) => r.unitId === unitId && r.seasonId === seasonId) ?? null;
}

interface NightResolution {
  /** règle de fond retenue — null quand seule une surcharge couvre la nuit */
  rule: RateRule | null;
  /** saison affichée (null si la nuit retombe sur le tarif de base) */
  season: Season | null;
  weekend: boolean;
  baseCents: number;
  surchargeCents: number;
  /** d'où vient le prix effectif */
  source: RateSource;
  /** minimum de nuits effectif — ne s'applique qu'à la NUIT D'ARRIVÉE (§ 4) */
  minNights: number;
  minNightsSource: "override" | "regle";
  checkinDays: number[] | null;
  /** prix qu'aurait la nuit SANS surcharge, majoration comprise — alimente le
   *  « Sans cette valeur : 184 € » de l'éditeur. Null si aucune règle de fond. */
  fallbackCents: number | null;
}

/** Résout le tarif d'UNE nuit pour UNE unité physique.
 *
 *  Priorité : surcharge du jour > règle de saison > tarif de base.
 *  Une surcharge de prix est ABSOLUE : elle remplace le prix semaine/weekend
 *  ET annule la majoration fériés (spec UX § 3).
 *  Null si ni règle ni surcharge ne couvre la nuit. */
function resolveNight(
  unitId: number,
  night: IsoDate,
  seasons: Season[],
  rules: RateRule[],
  ratedDays: Set<IsoDate>,
  overrides: Map<string, RateOverride>,
): NightResolution | null {
  const season = seasonForNight(night, seasons);
  const seasonRule = season ? ruleFor(unitId, season.id, rules) : null;
  const rule = seasonRule ?? ruleFor(unitId, null, rules);
  const override = overrides.get(`${unitId}|${night}`) ?? null;
  const overridePrice = override?.priceCents ?? null;
  if (!rule && overridePrice == null) return null;

  const dow = dayOfWeek(night);
  const weekend = dow === 5 || dow === 6; // nuits de vendredi et de samedi

  // Prix de fond (saison ou tarif de base), majoration fériés comprise.
  let fallbackCents: number | null = null;
  let fallbackSurcharge = 0;
  if (rule) {
    const raw = weekend ? rule.priceWeekendCents : rule.priceWeekCents;
    fallbackSurcharge =
      rule.holidayPct > 0 && isHolidayRatedNight(night, ratedDays)
        ? Math.round((raw * rule.holidayPct) / 100)
        : 0;
    fallbackCents = raw + fallbackSurcharge;
  }

  const overridden = overridePrice != null;
  const minNightsOverridden = override?.minNights != null;
  return {
    rule,
    season: seasonRule ? season : null,
    weekend,
    baseCents: overridden ? overridePrice : (fallbackCents ?? 0) - fallbackSurcharge,
    surchargeCents: overridden ? 0 : fallbackSurcharge,
    source: overridden ? "override" : seasonRule ? "saison" : "base",
    minNights: minNightsOverridden ? override!.minNights! : (rule?.minNights ?? 1),
    minNightsSource: minNightsOverridden ? "override" : "regle",
    checkinDays: rule?.checkinDays ?? null,
    fallbackCents,
  };
}

// ---------------------------------------------------------------------------
// Calendrier des tarifs (vue « à la elloha » : prix affiché par jour)
// ---------------------------------------------------------------------------

export interface DayRate {
  date: IsoDate;
  /** prix effectif de la nuit (majoration férié comprise, sauf sous surcharge
   *  où le prix posé est absolu) — null si aucun tarif ne couvre le jour */
  priceCents: number | null;
  /** provenance du prix effectif : la cellule se colore avec (spec UX § 2).
   *  Null quand aucun tarif ne couvre le jour. */
  source: RateSource | null;
  seasonId: number | null;
  seasonName: string | null;
  minNights: number | null;
  /** provenance du minimum de nuits, indépendante de celle du prix : une
   *  surcharge peut ne porter QUE le minimum de nuits. */
  minNightsSource: "override" | "regle" | null;
  /** jours d'arrivée autorisés si le séjour COMMENCE ce jour-là (0=dim … 6=sam) ;
   *  null = aucune contrainte. Composite « somme » : intersection des
   *  composantes (la plus restrictive gagne, comme pour le devis). */
  checkinDays: number[] | null;
  weekend: boolean;
  /** vrai si une majoration fériés a effectivement été appliquée — donc
   *  toujours faux sous une surcharge de prix, qui l'annule (§ 3) */
  holidayRated: boolean;
  /** prix qu'aurait le jour SANS surcharge — « Sans cette valeur : 184 € » */
  fallbackPriceCents: number | null;
  /** valeurs brutes de la surcharge, pour préremplir l'éditeur */
  overridePriceCents: number | null;
  overrideMinNights: number | null;
}

/** Intersection de deux jeux de jours d'arrivée autorisés. Un composite
 *  « somme » n'accepte une arrivée que si TOUTES ses composantes l'acceptent.
 *
 *  Trois états à ne pas confondre : `null` = aucune contrainte (se laisse
 *  absorber), une liste non vide = ces jours-là, et une liste VIDE = plus aucun
 *  jour possible. Confondre les deux derniers effacerait une impossibilité :
 *  deux composantes aux règles incompatibles (l'une samedi, l'autre vendredi)
 *  redeviendraient réservables n'importe quel jour. */
function intersectCheckinDays(a: number[] | null, b: number[] | null): number[] | null {
  if (b == null || b.length === 0) return a;
  if (a == null) return [...b];
  return a.filter((d) => b.includes(d));
}

/** Tarif jour par jour d'une unité sur [from, toExclusive) — pour les
 *  calendriers admin et public. Composite « somme » = addition des composantes. */
export function rateCalendar(
  unit: UnitPricingInfo,
  from: IsoDate,
  toExclusive: IsoDate,
  seasons: Season[],
  rateRules: RateRule[],
  rateOverrides: readonly RateOverride[] = [],
): DayRate[] {
  const ratedDays = holidayRatedDays(yearsSpanned(from, toExclusive));
  const overrides = indexOverrides(rateOverrides);
  const isSum = unit.compositePricing === "sum" && unit.components.length > 0;
  const partIds = isSum ? unit.components.map((c) => c.id) : [unit.id];
  const days: DayRate[] = [];
  for (let d = from; d < toExclusive; d = addDays(d, 1)) {
    let price = 0;
    let fallback: number | null = 0;
    let covered = true;
    let minNights = 1;
    let seasonName: string | null = null;
    let seasonId: number | null = null;
    let weekend = false;
    let holidayRated = false;
    let overridden = false;
    let seasonPriced = false;
    let minNightsOverridden = false;
    let overridePriceCents: number | null = null;
    let overrideMinNights: number | null = null;
    let checkinDays: number[] | null = null;
    for (const pid of partIds) {
      const r = resolveNight(pid, d, seasons, rateRules, ratedDays, overrides);
      if (!r) {
        covered = false;
        break;
      }
      price += r.baseCents + r.surchargeCents;
      fallback = fallback == null || r.fallbackCents == null ? null : fallback + r.fallbackCents;
      minNights = Math.max(minNights, r.minNights);
      checkinDays = intersectCheckinDays(checkinDays, r.checkinDays);
      if (r.season) {
        seasonName = r.season.name;
        seasonId = r.season.id;
      }
      weekend = r.weekend;
      holidayRated = holidayRated || r.surchargeCents > 0;
      overridden = overridden || r.source === "override";
      seasonPriced = seasonPriced || r.source === "saison";
      minNightsOverridden = minNightsOverridden || r.minNightsSource === "override";
      const raw = overrides.get(`${pid}|${d}`);
      if (raw && !isSum) {
        overridePriceCents = raw.priceCents;
        overrideMinNights = raw.minNights;
      }
    }
    days.push({
      date: d,
      priceCents: covered ? price : null,
      source: !covered ? null : overridden ? "override" : seasonPriced ? "saison" : "base",
      seasonId,
      seasonName,
      minNights: covered ? minNights : null,
      minNightsSource: !covered ? null : minNightsOverridden ? "override" : "regle",
      checkinDays: covered ? checkinDays : null,
      weekend,
      holidayRated,
      fallbackPriceCents: covered ? fallback : null,
      overridePriceCents,
      overrideMinNights,
    });
  }
  return days;
}

interface UnitBreakdown {
  lines: QuoteLine[];
  baseCents: number;
  holidaySurchargeCents: number;
  holidayNights: number;
  /** minimum de nuits de la NUIT D'ARRIVÉE (surcharge du jour prioritaire) */
  arrivalMinNights: number;
  arrivalCheckinDays: number[] | null;
  missingRate: boolean;
}

/** Tarifie les nuits d'UNE unité physique avec ses propres règles. */
function breakdownForUnit(
  unitId: number,
  unitName: string,
  labelWithUnit: boolean,
  nights: IsoDate[],
  seasons: Season[],
  rules: RateRule[],
  ratedDays: Set<IsoDate>,
  overrides: Map<string, RateOverride>,
): UnitBreakdown {
  interface Group {
    seasonLabel: string;
    weekend: boolean;
    count: number;
    amountCents: number;
    /** prix d'une nuit du groupe, null dès que deux nuits diffèrent */
    unitPriceCents: number | null;
  }
  const groups = new Map<string, Group>();
  let surcharge = 0;
  let holidayNights = 0;
  let arrivalMinNights = 1;
  let arrivalCheckinDays: number[] | null = null;
  let missingRate = false;

  nights.forEach((night, idx) => {
    const r = resolveNight(unitId, night, seasons, rules, ratedDays, overrides);
    if (!r) {
      missingRate = true;
      return;
    }
    if (idx === 0) {
      arrivalMinNights = r.minNights;
      arrivalCheckinDays = r.checkinDays;
    }
    // Une nuit surchargée sort du groupe de sa saison : son prix ne vient plus
    // d'elle, et le devis doit le dire au client comme au téléphone.
    const seasonLabel =
      r.source === "override" ? "prix fixé à la main" : r.season ? r.season.name : "tarif de base";
    const key = `${seasonLabel}|${r.weekend ? "we" : "wk"}`;
    const g = groups.get(key) ?? {
      seasonLabel,
      weekend: r.weekend,
      count: 0,
      amountCents: 0,
      unitPriceCents: r.baseCents,
    };
    // Deux surcharges manuelles de montants différents tombent dans le MÊME
    // groupe (même libellé « prix fixé à la main », même type de jour) : sans
    // ce contrôle nuit par nuit, le tunnel afficherait leur moyenne comme s'il
    // s'agissait du tarif affiché (contre-review Gemini 2026-08-28).
    if (g.unitPriceCents !== r.baseCents) g.unitPriceCents = null;
    g.count += 1;
    g.amountCents += r.baseCents;
    groups.set(key, g);
    if (r.surchargeCents > 0) {
      surcharge += r.surchargeCents;
      holidayNights += 1;
    }
  });

  const lines: QuoteLine[] = [...groups.values()].map((g) => {
    const stem = `${g.count} nuit${g.count > 1 ? "s" : ""} ${g.weekend ? "weekend" : "semaine"}`;
    const suffix = labelWithUnit ? ` — ${unitName}` : "";
    return {
      kind: "accommodation" as const,
      label: `${stem} · ${g.seasonLabel}${suffix}`,
      amountCents: g.amountCents,
      publicLabel: `${stem}${suffix}`,
      // Prix unitaire seulement si TOUTES les nuits du groupe valent ce
      // montant-là : jamais une moyenne présentée comme un tarif (issue #47).
      ...(g.unitPriceCents != null ? { unitPriceCents: g.unitPriceCents } : {}),
    };
  });

  return {
    lines,
    baseCents: lines.reduce((s, l) => s + l.amountCents, 0),
    holidaySurchargeCents: surcharge,
    holidayNights,
    arrivalMinNights,
    arrivalCheckinDays,
    missingRate,
  };
}

/** Montant d'une remise, TOUJOURS plafonné à la base remisable.
 *
 *  Sans ce plafond (audit ECC 2026-07-30), une remise automatique saisie à
 *  150 % au lieu de 15 % produisait un total et des arrhes négatifs : le
 *  tunnel public était sauvé par accident (contrôle « montant < 50 »), mais
 *  la vente manuelle du back-office créait la réservation telle quelle. */
function promoAmount(p: Promotion, baseCents: number): number {
  const cap = Math.max(baseCents, 0);
  if (p.discountPct != null && p.discountPct > 0) {
    const pct = Math.min(p.discountPct, 100);
    return Math.min(Math.round((cap * pct) / 100), cap);
  }
  if (p.discountCents != null && p.discountCents > 0) return Math.min(p.discountCents, cap);
  return 0;
}

function inValidityWindow(p: Promotion, today: IsoDate): boolean {
  if (p.validFrom && today < p.validFrom) return false;
  if (p.validUntil && today > p.validUntil) return false;
  return true;
}

// ---------------------------------------------------------------------------

/** Pourcentage d'arrhes en vigueur pour ce devis : celui de l'hébergement
 *  réservé, à défaut celui du domaine (issue #75). Une valeur d'unité à 0 est
 *  une valeur, pas une absence — d'où le `??` et non un `||`. */
function effectiveDepositPct(req: QuoteRequest): number {
  return req.unit.depositPct ?? req.settings.depositPct;
}

/** Délai minimum lu dans les réglages : entier de 0 à 365, tout le reste vaut 0
 *  (une valeur illisible ne doit jamais fermer la vente en ligne). */
export function normalizeLeadDays(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 365 ? n : 0;
}

/** Première date d'arrivée réservable en ligne, compte tenu du délai minimum. */
export function firstBookableDate(today: IsoDate, minLeadDays: unknown): IsoDate {
  return addDays(today, normalizeLeadDays(minLeadDays));
}

export function computeQuote(req: QuoteRequest): Quote {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty: Quote = {
    ok: false, errors, warnings, nights: 0, minNights: 1, checkinDays: null, lines: [],
    accommodationCents: 0, discountCents: 0, cleaningFeeCents: 0, optionsCents: 0, taxCents: 0,
    totalCents: 0, depositCents: 0, depositPct: effectiveDepositPct(req), balanceCents: 0, balanceDueDate: null,
    cautionCents: req.settings.cautionCents,
    autoDiscountApplied: null, promoApplied: null,
  };

  if (req.checkin >= req.checkout) {
    errors.push("invalid_dates");
    return empty;
  }
  const nightsList = eachNight(req.checkin, req.checkout);
  const nights = nightsList.length;
  const ratedDays = holidayRatedDays(yearsSpanned(req.checkin, req.checkout));

  // --- hébergement : unité simple, ou somme des composantes (mode 'sum')
  const isSum = req.unit.compositePricing === "sum" && req.unit.components.length > 0;
  const parts = isSum ? req.unit.components : [{ id: req.unit.id, name: req.unit.name }];
  const overrides = indexOverrides(req.rateOverrides ?? []);
  const breakdowns = parts.map((p) =>
    breakdownForUnit(p.id, p.name, isSum, nightsList, req.seasons, req.rateRules, ratedDays, overrides),
  );

  if (breakdowns.some((b) => b.missingRate)) errors.push("no_rate");

  const lines: QuoteLine[] = breakdowns.flatMap((b) => b.lines);
  const surchargeCents = breakdowns.reduce((s, b) => s + b.holidaySurchargeCents, 0);
  const holidayNights = breakdowns.reduce((s, b) => s + b.holidayNights, 0);
  if (surchargeCents > 0) {
    lines.push({
      kind: "holiday_surcharge",
      label: `Majoration jours fériés & ponts (${holidayNights} nuit${holidayNights > 1 ? "s" : ""})`,
      amountCents: surchargeCents,
    });
  }
  const accommodationCents = breakdowns.reduce((s, b) => s + b.baseCents, 0) + surchargeCents;

  // --- min. nuits & jour d'arrivée (règle de la nuit d'arrivée ; composite
  //     'sum' : la plus exigeante des composantes)
  const minNights = Math.max(1, ...breakdowns.map((b) => b.arrivalMinNights));
  if (nights < minNights) errors.push("min_nights");
  let checkinDays: number[] | null = null;
  for (const b of breakdowns) checkinDays = intersectCheckinDays(checkinDays, b.arrivalCheckinDays);
  // Liste vide = aucune arrivée possible : `includes` est faux, l'erreur tombe.
  if (checkinDays != null && !checkinDays.includes(dayOfWeek(req.checkin))) {
    errors.push("checkin_day");
  }

  // --- délai minimum de réservation (demande n° 15) : l'arrivée doit être au
  //     moins `minLeadDays` jours après la date de réservation. Bloquant sur le
  //     site public, simple avertissement pour une vente du back-office.
  const minLeadDays = normalizeLeadDays(req.settings.minLeadDays);
  if (minLeadDays > 0 && diffDays(req.today, req.checkin) < minLeadDays) {
    (req.bypassLeadTime ? warnings : errors).push("lead_time");
  }

  // --- remise automatique : la meilleure seule
  const daysAhead = diffDays(req.today, req.checkin);
  let autoDiscount = 0;
  let autoApplied: Promotion | null = null;
  for (const p of req.promotions) {
    if (!p.active || p.kind === "code" || !inValidityWindow(p, req.today)) continue;
    if (p.threshold == null) continue;
    const eligible =
      (p.kind === "long_stay" && nights >= p.threshold) ||
      (p.kind === "early_bird" && daysAhead >= p.threshold) ||
      (p.kind === "last_minute" && daysAhead >= 0 && daysAhead <= p.threshold);
    if (!eligible) continue;
    const amt = promoAmount(p, accommodationCents);
    if (amt > autoDiscount) {
      autoDiscount = amt;
      autoApplied = p;
    }
  }
  if (autoApplied && autoDiscount > 0) {
    lines.push({ kind: "discount", label: autoApplied.label, amountCents: -autoDiscount });
  }

  // --- code promo (s'ajoute après la remise auto)
  let promoDiscount = 0;
  let promoApplied: Promotion | null = null;
  if (req.promoCode && req.promoCode.trim() !== "") {
    const wanted = req.promoCode.trim().toLowerCase();
    const p = req.promotions.find(
      (x) => x.kind === "code" && x.active && x.code != null && x.code.toLowerCase() === wanted,
    );
    const usable = p && inValidityWindow(p, req.today) && (p.maxUses == null || p.uses < p.maxUses);
    if (p && usable) {
      promoDiscount = Math.min(promoAmount(p, accommodationCents - autoDiscount), accommodationCents - autoDiscount);
      promoApplied = p;
      if (promoDiscount > 0) {
        lines.push({ kind: "promo", label: `Code promo ${p.code}`, amountCents: -promoDiscount });
      }
    } else {
      warnings.push("promo_invalid");
    }
  }
  const discountCents = autoDiscount + promoDiscount;

  // --- frais généraux (jamais remisés) : forfait couvrant `feeIncludedNights`
  //     nuits, plus un supplément de charges par nuit au-delà.
  //     composite « somme » = même calcul sur chaque composante, additionné.
  const feeParts = isSum ? req.unit.components : [req.unit];
  const cleaningFeeCents = feeParts.reduce((s, c) => s + generalFeeCents(c, nights), 0);
  if (cleaningFeeCents > 0) {
    lines.push({ kind: "fee", label: generalFeeLabel(feeParts), amountCents: cleaningFeeCents });
  }

  // --- options
  const persons = req.adults + req.children;
  let optionsCents = 0;
  for (const sel of req.optionsSelected) {
    const o = sel.option;
    // per_unit_qty : quantité libre bornée par max_qty ; autres modes : 0 ou 1.
    let qty = o.pricingMode === "per_unit_qty" ? Math.max(0, Math.floor(sel.qty)) : (sel.qty > 0 ? 1 : 0);
    if (o.maxQty != null) qty = Math.min(qty, o.maxQty);
    if (qty === 0) continue;
    let amount = 0;
    let label = o.name;
    switch (o.pricingMode) {
      case "per_stay":
        amount = o.priceCents;
        break;
      case "per_night":
        amount = o.priceCents * nights;
        label += ` (${nights} nuit${nights > 1 ? "s" : ""})`;
        break;
      case "per_person":
        amount = o.priceCents * persons;
        label += ` (${persons} pers.)`;
        break;
      case "per_person_night":
        amount = o.priceCents * persons * nights;
        label += ` (${persons} pers. × ${nights} n)`;
        break;
      case "per_unit_qty": {
        amount = o.priceCents * qty;
        const unitLabel = o.unitLabel ?? "×";
        // pluriel naïf : « 2 stères », mais « 3 pers. » et « 2 bois » restent tels quels
        const plural = qty > 1 && /[a-zà-ü]$/.test(unitLabel) && !unitLabel.endsWith("s") ? "s" : "";
        label += ` (${qty} ${unitLabel}${plural})`;
        break;
      }
    }
    optionsCents += amount;
    lines.push({ kind: "option", label, amountCents: amount });
  }

  // --- taxe de séjour
  const taxPersons = req.adults + (req.settings.touristTaxIncludeChildren ? req.children : 0);
  const taxCents = req.settings.touristTaxCentsPerPersonNight * taxPersons * nights;
  if (taxCents > 0) {
    lines.push({
      kind: "tax",
      label: `Taxe de séjour (${taxPersons} pers. × ${nights} nuit${nights > 1 ? "s" : ""})`,
      amountCents: taxCents,
    });
  }

  // --- totaux, acompte, solde
  const totalCents = accommodationCents - discountCents + cleaningFeeCents + optionsCents + taxCents;
  const dueDate = addDays(req.checkin, -req.settings.balanceDueDays);
  const depositPct = effectiveDepositPct(req);
  let depositCents: number;
  let balanceCents: number;
  let balanceDueDate: IsoDate | null;
  if (depositPct >= 100 || req.today >= dueDate) {
    // trop proche de l'arrivée (ou acompte configuré à 100 %) → paiement total
    depositCents = totalCents;
    balanceCents = 0;
    balanceDueDate = null;
  } else {
    depositCents = Math.round((totalCents * depositPct) / 100);
    balanceCents = totalCents - depositCents;
    balanceDueDate = dueDate;
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nights,
    minNights,
    checkinDays,
    ...(minLeadDays > 0 ? { minLeadDays } : {}),
    lines,
    accommodationCents,
    discountCents,
    cleaningFeeCents,
    optionsCents,
    taxCents,
    totalCents,
    depositCents,
    depositPct,
    balanceCents,
    balanceDueDate,
    cautionCents: req.settings.cautionCents,
    autoDiscountApplied: autoApplied ? autoApplied.label : null,
    promoApplied: promoApplied ? (promoApplied.code ?? promoApplied.label) : null,
  };
}
