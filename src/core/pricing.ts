// Moteur de tarification — pur, déterministe, sans I/O.
//
// Empilement des règles (plan v1 § 5) :
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
  depositPct: number;                    // 30 → acompte de 30 %
  balanceDueDays: number;                // solde exigible à J-30
  touristTaxCentsPerPersonNight: number;
  touristTaxIncludeChildren: boolean;
  cautionCents: number;                  // informatif — PAS inclus dans le total
}

export interface UnitPricingInfo {
  id: number;
  name: string;
  compositePricing: "own" | "sum";
  /** frais de ménage fixes par séjour (0 = aucun) */
  cleaningFeeCents: number;
  /** composantes d'une unité composite en mode 'sum' (dérivées de unit_links) */
  components: { id: number; name: string; cleaningFeeCents: number }[];
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
  promotions: Promotion[];
  promoCode?: string | null;
  optionsSelected: { option: OptionDef; qty: number }[];
  settings: PricingSettings;
}

export interface QuoteLine {
  kind: "accommodation" | "holiday_surcharge" | "discount" | "promo" | "fee" | "option" | "tax";
  label: string;
  amountCents: number; // négatif pour les remises
}

export interface Quote {
  ok: boolean;
  /** erreurs bloquantes : 'invalid_dates', 'no_rate', 'min_nights', 'checkin_day' */
  errors: string[];
  /** avertissements non bloquants : 'promo_invalid' */
  warnings: string[];
  nights: number;
  minNights: number;
  lines: QuoteLine[];
  accommodationCents: number; // hébergement avant remises (majoration comprise)
  discountCents: number;      // remise auto + code promo (positif)
  cleaningFeeCents: number;   // frais de ménage (fixes par séjour)
  optionsCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;       // dû à la réservation
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
  rule: RateRule;
  /** saison affichée (null si la nuit retombe sur le tarif de base) */
  season: Season | null;
  weekend: boolean;
  baseCents: number;
  surchargeCents: number;
}

/** Résout le tarif d'UNE nuit pour UNE unité physique : saison prioritaire →
 *  règle de saison, sinon tarif de base ; prix semaine/weekend ; majoration
 *  férié/pont éventuelle. Null si aucune règle ne couvre la nuit. */
function resolveNight(
  unitId: number,
  night: IsoDate,
  seasons: Season[],
  rules: RateRule[],
  ratedDays: Set<IsoDate>,
): NightResolution | null {
  const season = seasonForNight(night, seasons);
  const seasonRule = season ? ruleFor(unitId, season.id, rules) : null;
  const rule = seasonRule ?? ruleFor(unitId, null, rules);
  if (!rule) return null;
  const dow = dayOfWeek(night);
  const weekend = dow === 5 || dow === 6; // nuits de vendredi et de samedi
  const baseCents = weekend ? rule.priceWeekendCents : rule.priceWeekCents;
  const surchargeCents =
    rule.holidayPct > 0 && isHolidayRatedNight(night, ratedDays)
      ? Math.round((baseCents * rule.holidayPct) / 100)
      : 0;
  return { rule, season: seasonRule ? season : null, weekend, baseCents, surchargeCents };
}

// ---------------------------------------------------------------------------
// Calendrier des tarifs (vue « à la elloha » : prix affiché par jour)
// ---------------------------------------------------------------------------

export interface DayRate {
  date: IsoDate;
  /** prix de la nuit (majoration férié comprise) — null si aucune règle */
  priceCents: number | null;
  seasonId: number | null;
  seasonName: string | null;
  minNights: number | null;
  weekend: boolean;
  holidayRated: boolean;
}

/** Tarif jour par jour d'une unité sur [from, toExclusive) — pour les
 *  calendriers admin et public. Composite « somme » = addition des composantes. */
export function rateCalendar(
  unit: UnitPricingInfo,
  from: IsoDate,
  toExclusive: IsoDate,
  seasons: Season[],
  rateRules: RateRule[],
): DayRate[] {
  const ratedDays = holidayRatedDays(yearsSpanned(from, toExclusive));
  const isSum = unit.compositePricing === "sum" && unit.components.length > 0;
  const partIds = isSum ? unit.components.map((c) => c.id) : [unit.id];
  const days: DayRate[] = [];
  for (let d = from; d < toExclusive; d = addDays(d, 1)) {
    let price = 0;
    let covered = true;
    let minNights = 1;
    let seasonName: string | null = null;
    let seasonId: number | null = null;
    let weekend = false;
    let holidayRated = false;
    for (const pid of partIds) {
      const r = resolveNight(pid, d, seasons, rateRules, ratedDays);
      if (!r) {
        covered = false;
        break;
      }
      price += r.baseCents + r.surchargeCents;
      minNights = Math.max(minNights, r.rule.minNights);
      if (r.season) {
        seasonName = r.season.name;
        seasonId = r.season.id;
      }
      weekend = r.weekend;
      holidayRated = holidayRated || r.surchargeCents > 0;
    }
    days.push({
      date: d,
      priceCents: covered ? price : null,
      seasonId,
      seasonName,
      minNights: covered ? minNights : null,
      weekend,
      holidayRated,
    });
  }
  return days;
}

interface UnitBreakdown {
  lines: QuoteLine[];
  baseCents: number;
  holidaySurchargeCents: number;
  holidayNights: number;
  arrivalRule: RateRule | null;
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
): UnitBreakdown {
  interface Group { seasonLabel: string; weekend: boolean; count: number; amountCents: number }
  const groups = new Map<string, Group>();
  let surcharge = 0;
  let holidayNights = 0;
  let arrivalRule: RateRule | null = null;
  let missingRate = false;

  nights.forEach((night, idx) => {
    const r = resolveNight(unitId, night, seasons, rules, ratedDays);
    if (!r) {
      missingRate = true;
      return;
    }
    if (idx === 0) arrivalRule = r.rule;
    const seasonLabel = r.season ? r.season.name : "tarif de base";
    const key = `${seasonLabel}|${r.weekend ? "we" : "wk"}`;
    const g = groups.get(key) ?? { seasonLabel, weekend: r.weekend, count: 0, amountCents: 0 };
    g.count += 1;
    g.amountCents += r.baseCents;
    groups.set(key, g);
    if (r.surchargeCents > 0) {
      surcharge += r.surchargeCents;
      holidayNights += 1;
    }
  });

  const lines: QuoteLine[] = [...groups.values()].map((g) => ({
    kind: "accommodation",
    label:
      `${g.count} nuit${g.count > 1 ? "s" : ""} ${g.weekend ? "weekend" : "semaine"} · ${g.seasonLabel}` +
      (labelWithUnit ? ` — ${unitName}` : ""),
    amountCents: g.amountCents,
  }));

  return {
    lines,
    baseCents: lines.reduce((s, l) => s + l.amountCents, 0),
    holidaySurchargeCents: surcharge,
    holidayNights,
    arrivalRule,
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

export function computeQuote(req: QuoteRequest): Quote {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty: Quote = {
    ok: false, errors, warnings, nights: 0, minNights: 1, lines: [],
    accommodationCents: 0, discountCents: 0, cleaningFeeCents: 0, optionsCents: 0, taxCents: 0,
    totalCents: 0, depositCents: 0, balanceCents: 0, balanceDueDate: null,
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
  const breakdowns = parts.map((p) =>
    breakdownForUnit(p.id, p.name, isSum, nightsList, req.seasons, req.rateRules, ratedDays),
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
  const minNights = Math.max(1, ...breakdowns.map((b) => b.arrivalRule?.minNights ?? 1));
  if (nights < minNights) errors.push("min_nights");
  for (const b of breakdowns) {
    const days = b.arrivalRule?.checkinDays;
    if (days && days.length > 0 && !days.includes(dayOfWeek(req.checkin))) {
      errors.push("checkin_day");
      break;
    }
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

  // --- frais de ménage (fixes par séjour, jamais remisés)
  //     composite « somme » = addition des ménages des composantes
  const cleaningFeeCents = isSum
    ? req.unit.components.reduce((s, c) => s + c.cleaningFeeCents, 0)
    : req.unit.cleaningFeeCents;
  if (cleaningFeeCents > 0) {
    lines.push({ kind: "fee", label: "Frais généraux — ménage, draps et charges", amountCents: cleaningFeeCents });
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
  let depositCents: number;
  let balanceCents: number;
  let balanceDueDate: IsoDate | null;
  if (req.settings.depositPct >= 100 || req.today >= dueDate) {
    // trop proche de l'arrivée (ou acompte configuré à 100 %) → paiement total
    depositCents = totalCents;
    balanceCents = 0;
    balanceDueDate = null;
  } else {
    depositCents = Math.round((totalCents * req.settings.depositPct) / 100);
    balanceCents = totalCents - depositCents;
    balanceDueDate = dueDate;
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nights,
    minNights,
    lines,
    accommodationCents,
    discountCents,
    cleaningFeeCents,
    optionsCents,
    taxCents,
    totalCents,
    depositCents,
    balanceCents,
    balanceDueDate,
    cautionCents: req.settings.cautionCents,
    autoDiscountApplied: autoApplied ? autoApplied.label : null,
    promoApplied: promoApplied ? (promoApplied.code ?? promoApplied.label) : null,
  };
}
