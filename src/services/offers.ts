// Offres visibles côté client (issue #35) : remises actives et information de
// disponibilité FACTUELLE.
//
// Ligne éditoriale du propriétaire, à respecter strictement : jamais de fausse
// rareté, jamais de compte à rebours artificiel, jamais de « 12 personnes
// regardent cette page ». Uniquement des faits calculés à partir des données
// réelles — et vérifiables à la main contre le calendrier.
//
// Deux conséquences concrètes dans ce fichier :
//
//  1. Les phrases de disponibilité portent TOUJOURS leur dénominateur
//     (« 3 week-ends libres sur 9 »). Un nombre seul (« plus que 3 week-ends
//     libres ») laisse croire à une rareté que le chiffre ne dit pas : sur un
//     domaine de deux maisons, 3 sur 9 en basse saison est banal. Le
//     dénominateur rend l'information vérifiable au lieu de suggestive.
//
//  2. Les remises affichées reproduisent EXACTEMENT les conditions
//     d'éligibilité du moteur de devis (`computeQuote`, src/core/pricing.ts) :
//     mêmes bornes de validité, même absence de contrôle du nombre d'usages
//     sur les remises automatiques. Une promesse d'affichage que le devis ne
//     tiendrait pas serait une pratique commerciale trompeuse, pas un détail
//     d'ergonomie. Un test vérifie cette correspondance sur un vrai devis.

import { addDays, dayOfWeek, diffDays, type IsoDate } from "../core/dates";
import { isUnitFree, type BookingSpan, type UnitLink } from "../core/availability";
import type { Promotion } from "../core/pricing";
import { formatEur } from "./email";

// ---------------------------------------------------------------------------
// Remises actives
// ---------------------------------------------------------------------------

export interface PublicPromotion {
  kind: "long_stay" | "early_bird" | "last_minute";
  /** Phrase autonome affichable telle quelle (« À partir de 7 nuits : -10 % »). */
  label: string;
  /** Libellé saisi au back-office — celui qui apparaîtra dans le devis. */
  quoteLabel: string;
  /** Seuil brut, pour un affichage plus riche si besoin. */
  threshold: number;
  discountPct: number | null;
  discountCents: number | null;
  validUntil: IsoDate | null;
}

/** Fenêtre de validité — copie conforme de `inValidityWindow` du moteur de
 *  tarification (non exporté là-bas). La fenêtre porte sur la DATE DE
 *  RÉSERVATION, pas sur les dates du séjour. */
function inValidityWindow(p: Promotion, today: IsoDate): boolean {
  if (p.validFrom && today < p.validFrom) return false;
  if (p.validUntil && today > p.validUntil) return false;
  return true;
}

function discountText(p: Promotion): string | null {
  if (p.discountPct != null && p.discountPct > 0) return `-${p.discountPct} %`;
  if (p.discountCents != null && p.discountCents > 0) return `-${formatEur(p.discountCents)}`;
  return null;
}

/** Remises AUTOMATIQUES annonçables aujourd'hui.
 *
 *  Les promotions de type `code` sont exclues : un code promo est privé (il
 *  s'échange par email ou en direct). L'afficher sur la page reviendrait à
 *  l'offrir à tout le monde, ce qui n'est pas la décision du propriétaire.
 *
 *  Le filtre reproduit celui du moteur : `active`, seuil renseigné, fenêtre de
 *  validité. Comme le moteur, il ne regarde PAS `maxUses`/`uses` — ces deux
 *  champs ne sont contrôlés que sur les codes promo. */
export function publicPromotions(promotions: Promotion[], today: IsoDate): PublicPromotion[] {
  const out: PublicPromotion[] = [];
  for (const p of promotions) {
    if (!p.active || p.kind === "code") continue;
    if (p.threshold == null || p.threshold < 0) continue;
    if (!inValidityWindow(p, today)) continue;
    const amount = discountText(p);
    if (!amount) continue; // remise à 0 : rien à annoncer

    const n = p.threshold;
    const condition =
      p.kind === "long_stay"
        ? `À partir de ${n} nuit${n > 1 ? "s" : ""}`
        : p.kind === "early_bird"
          ? `En réservant au moins ${n} jour${n > 1 ? "s" : ""} à l'avance`
          : `Pour une arrivée dans les ${n} jour${n > 1 ? "s" : ""}`;
    out.push({
      kind: p.kind,
      label: `${condition} : ${amount}`,
      quoteLabel: p.label,
      threshold: n,
      discountPct: p.discountPct,
      discountCents: p.discountCents,
      validUntil: p.validUntil,
    });
  }
  return out;
}

/** Mention obligatoire dès qu'au moins deux remises coexistent : le moteur
 *  n'applique QUE la meilleure. Sans elle, un client qui remplit deux
 *  conditions s'attendrait légitimement à les cumuler. */
export const NON_CUMUL_NOTE = "Une seule remise s'applique — la plus avantageuse pour vous.";

// ---------------------------------------------------------------------------
// Disponibilité factuelle
// ---------------------------------------------------------------------------

const MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

/** Un « week-end » = les nuits de vendredi et de samedi de la même semaine,
 *  soit le séjour [vendredi, dimanche). C'est la définition du moteur de
 *  tarification (nuits weekend = vendredi et samedi), donc celle que le client
 *  retrouvera dans le calendrier public. */
export function weekendFridays(from: IsoDate, toExclusive: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d < toExclusive; d = addDays(d, 1)) {
    if (dayOfWeek(d) === 5) out.push(d);
  }
  return out;
}

/** Dernier jour (exclu) de la fenêtre « mois en cours + mois suivant ». */
export function twoMonthWindowEnd(today: IsoDate): IsoDate {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const endMonth = m + 2; // premier jour du mois M+2
  const year = y + Math.floor((endMonth - 1) / 12);
  const month = ((endMonth - 1) % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export interface AvailabilityFacts {
  /** Début de la fenêtre observée (aujourd'hui). */
  from: IsoDate;
  /** Fin exclusive de la fenêtre observée. */
  to: IsoDate;
  /** « août et septembre » — la période décrite par la phrase. */
  periodLabel: string;
  weekendsTotal: number;
  weekendsFree: number;
  /** Vendredi du prochain week-end libre, cherché au-delà de la fenêtre. */
  nextFreeWeekend: IsoDate | null;
  /** Phrase prête à afficher — factuelle, avec son dénominateur. */
  sentence: string;
}

function periodLabel(from: IsoDate, toExclusive: IsoDate): string {
  const first = MOIS[Number(from.slice(5, 7)) - 1] ?? "";
  const lastDay = addDays(toExclusive, -1);
  const last = MOIS[Number(lastDay.slice(5, 7)) - 1] ?? "";
  return first === last ? first : `${first} et ${last}`;
}

/** « d'août et septembre », « de septembre et octobre » — l'élision devant
 *  voyelle, sinon la phrase sonne faux et trahit le texte généré. */
function duMois(label: string): string {
  return /^[aeiouâàéèêîïôöûü]/i.test(label) ? `d'${label}` : `de ${label}`;
}

function frenchDate(iso: IsoDate): string {
  const day = Number(iso.slice(8, 10));
  const month = MOIS[Number(iso.slice(5, 7)) - 1] ?? "";
  return `${day} ${month}`;
}

export interface WeekendAvailabilityInput {
  today: IsoDate;
  /** Unités actives à considérer (composites comprises : un week-end est libre
   *  dès qu'UN hébergement est réservable). */
  unitIds: number[];
  links: UnitLink[];
  bookings: BookingSpan[];
  /** Horodatage 'YYYY-MM-DD HH:MM:SS' pour départager les options en cours. */
  now: string;
  /** Horizon de recherche du prochain week-end libre (jours). */
  horizonDays?: number;
  /** Première arrivée réservable en ligne (délai minimum, demande n° 15).
   *  Absent = aujourd'hui. */
  bookableFrom?: IsoDate;
}

/** Compte les week-ends réellement libres et rédige la phrase associée.
 *
 *  « Libre » = au moins un hébergement actif est réservable du vendredi au
 *  dimanche. Les options de paiement en cours (holds non expirés) comptent
 *  comme occupées : c'est ce que le calendrier public montre au même instant,
 *  et une phrase qui le contredirait serait invérifiable. */
export function weekendAvailability(input: WeekendAvailabilityInput): AvailabilityFacts {
  const { today, unitIds, links, bookings, now } = input;
  const to = twoMonthWindowEnd(today);
  const horizon = addDays(today, input.horizonDays ?? 400);

  const bookableFrom = input.bookableFrom ?? today;
  const freeOn = (friday: IsoDate): boolean =>
    friday >= bookableFrom && unitIds.some((id) => isUnitFree(id, friday, addDays(friday, 2), bookings, links, now));

  // Un week-end en deçà du délai minimum n'est ni libre ni pris : il sort du
  // décompte, sinon il ferait baisser le taux de week-ends libres à tort.
  const inWindow = weekendFridays(today, to).filter((f) => f >= bookableFrom);
  const weekendsTotal = inWindow.length;
  const weekendsFree = inWindow.filter(freeOn).length;

  let nextFreeWeekend: IsoDate | null = null;
  for (const friday of weekendFridays(today, horizon)) {
    if (freeOn(friday)) {
      nextFreeWeekend = friday;
      break;
    }
  }

  const label = periodLabel(today, to);
  let sentence: string;
  if (weekendsTotal === 0) {
    sentence = nextFreeWeekend
      ? `Prochain week-end libre : à partir du vendredi ${frenchDate(nextFreeWeekend)}.`
      : "Consultez le calendrier pour les disponibilités.";
  } else if (weekendsFree === 0) {
    sentence = nextFreeWeekend
      ? `Aucun week-end libre en ${label}. Prochain week-end disponible : à partir du vendredi ${frenchDate(nextFreeWeekend)}.`
      : `Aucun week-end libre en ${label}.`;
  } else if (weekendsFree === weekendsTotal) {
    sentence =
      weekendsTotal === 1
        ? `Le seul week-end ${duMois(label)} est encore libre.`
        : `Les ${weekendsTotal} week-ends ${duMois(label)} sont encore libres.`;
  } else {
    // Le dénominateur n'est pas décoratif : c'est lui qui transforme un chiffre
    // suggestif en information vérifiable contre le calendrier.
    sentence =
      `${weekendsFree} week-end${weekendsFree > 1 ? "s" : ""} encore libre${weekendsFree > 1 ? "s" : ""} ` +
      `sur les ${weekendsTotal} ${duMois(label)}.`;
  }

  return { from: today, to, periodLabel: label, weekendsTotal, weekendsFree, nextFreeWeekend, sentence };
}

/** Horizon de lecture des réservations nécessaire au calcul ci-dessus. */
export function availabilityHorizon(today: IsoDate, horizonDays = 400): IsoDate {
  return addDays(today, horizonDays);
}

/** Jours restants avant une arrivée — exposé pour les tests de cohérence avec
 *  le moteur (early bird / last minute raisonnent sur cet écart). */
export function daysAhead(today: IsoDate, checkin: IsoDate): number {
  return diffDays(today, checkin);
}
