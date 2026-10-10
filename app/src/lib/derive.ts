// Logique pure de l'écran : états des réservations, bandeau du jour, ménage,
// placement des barres, sélection de dates, calcul des prix relatifs.
// Aucune dépendance à React : tout ici se teste seul.
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import type { DayRate, IsoDate, ManualBlock, PlanningBooking, PlanningLinkBlock } from "../api/types";
import { addDays, diffDays } from "./dates";
import { roundTo5 } from "./money";

// --- états ---------------------------------------------------------------------

/** Les quatre états de barre de la maquette A. */
export type BarKind = "option" | "plat" | "solde" | "soldee";

/** Réservation venue d'un autre site (Airbnb, Booking, iCal) : encaissée ailleurs. */
export function isChannel(b: { source: string; channelLabel: string | null }): boolean {
  return b.source === "ical";
}

export function barKind(b: Pick<PlanningBooking, "status" | "source" | "channelLabel" | "balanceCents">): BarKind {
  if (b.status === "pending") return "option";
  if (isChannel(b)) return "plat";
  if (b.balanceCents > 0) return "solde";
  return "soldee";
}

export function channelName(b: { source: string; channelLabel: string | null }): string {
  if (b.source === "direct") return t`votre site`;
  if (b.source === "manual") return t`par téléphone`;
  if (b.source === "import") return t`l'ancien système`;
  return b.channelLabel?.trim() || t`un autre site`;
}

/** Légende d'une barre du calendrier, dans la langue de l'écran. */
export function barLabel(k: BarKind): string {
  switch (k) {
    case "option":
      return t`Option, arrhes pas encore payées`;
    case "plat":
      return t`Airbnb, Booking ou autre site`;
    case "solde":
      return t`Solde à encaisser`;
    default:
      return t`Confirmée et payée`;
  }
}

// --- occupation ----------------------------------------------------------------

export interface Occupancy {
  bookings: PlanningBooking[];
  blocks: PlanningLinkBlock[];
  manualBlocks: ManualBlock[];
}

function covers(span: { checkin: IsoDate; checkout: IsoDate }, night: IsoDate): boolean {
  return span.checkin <= night && night < span.checkout;
}

/** La nuit `night` du bien est-elle prise (réservation, blocage, ou bien lié pris) ? */
export function isNightTaken(o: Occupancy, unitId: number, night: IsoDate): boolean {
  return (
    o.bookings.some((b) => b.unitId === unitId && covers(b, night)) ||
    o.manualBlocks.some((k) => k.unitId === unitId && covers(k, night)) ||
    o.blocks.some((k) => k.unitId === unitId && covers(k, night))
  );
}

export type DayState = BarKind | "bloc" | "pris" | "";

/** État d'une nuit pour la vue en semaines (maquette B). */
export function nightState(o: Occupancy, unitId: number, night: IsoDate): DayState {
  const b = o.bookings.find((x) => x.unitId === unitId && covers(x, night));
  if (b) return barKind(b);
  if (o.manualBlocks.some((k) => k.unitId === unitId && covers(k, night))) return "bloc";
  const link = o.blocks.find((k) => k.unitId === unitId && covers(k, night));
  if (link) {
    const src = o.bookings.find((x) => x.id === link.sourceBookingId);
    // Une réservation du Domaine entier remplit les deux maisons de sa couleur ;
    // une maison prise ne fait que hachurer le Domaine.
    if (src && src.isComposite) return barKind(src);
    return "pris";
  }
  return "";
}

// --- bandeau du jour --------------------------------------------------------------

export interface DayEvent {
  kind: "arrive" | "depart";
  booking: PlanningBooking;
  propertyId: number;
  time: string;
}

export function dayEvents(
  perProperty: { propertyId: number; bookings: PlanningBooking[]; checkinTime: string; checkoutTime: string }[],
  today: IsoDate,
): DayEvent[] {
  const out: DayEvent[] = [];
  for (const p of perProperty) {
    for (const b of p.bookings) {
      if (b.status === "cancelled") continue;
      if (b.checkout === today) out.push({ kind: "depart", booking: b, propertyId: p.propertyId, time: p.checkoutTime });
      if (b.checkin === today) out.push({ kind: "arrive", booking: b, propertyId: p.propertyId, time: p.checkinTime });
    }
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.kind === "depart" ? -1 : 1));
}

/** Phrase du jour, maquette B : « Un départ et deux arrivées. » */
export function daySentence(arrivals: number, departures: number): string {
  if (arrivals === 0 && departures === 0) return t`Ni arrivée ni départ aujourd'hui.`;
  const dep = departures === 0 ? "" : departures === 1 ? t`un départ` : t`${nombre(departures)} départs`;
  const arr = arrivals === 0 ? "" : arrivals === 1 ? t`une arrivée` : t`${nombre(arrivals)} arrivées`;
  const s = dep && arr ? t`${dep} et ${arr}` : dep || arr;
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

const NOMBRES = {
  fr: ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"],
  nl: ["nul", "een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien"],
};
export function nombre(n: number): string {
  return (i18n.locale === "nl" ? NOMBRES.nl : NOMBRES.fr)[n] ?? String(n);
}

// --- ménage ------------------------------------------------------------------------
// Calculé côté serveur depuis le lot 2 (src/core/cleaning.ts, tâches en base) :
// l'écran lit /api/admin/tasks, cf. lib/tasks.ts.

// --- placement des barres (grille en demi-journées) --------------------------------

/** Colonnes CSS d'une barre : l'arrivée se fait l'après-midi (milieu du jour
 *  d'arrivée), le départ le matin (milieu du jour de départ). Colonne 1 = libellé. */
export function barColumns(
  start: IsoDate,
  days: number,
  checkin: IsoDate,
  checkout: IsoDate,
): { from: number; to: number; flatL: boolean; flatR: boolean } | null {
  const a = diffDays(start, checkin);
  const d = diffDays(start, checkout);
  if (d <= 0 || a >= days) return null;
  let from = 3 + 2 * a;
  let to = 3 + 2 * d;
  let flatL = false;
  let flatR = false;
  if (from < 2) {
    from = 2;
    flatL = true;
  }
  if (to > 2 + 2 * days) {
    to = 2 + 2 * days;
    flatR = true;
  }
  return { from, to, flatL, flatR };
}

// --- sélection « premier jour puis jour de départ » (maquette B) -----------------

export interface DaySelection {
  unitId: number | null;
  first: IsoDate | null;
  /** jour de départ (exclu des nuits) */
  departure: IsoDate | null;
}

export const EMPTY_SELECTION: DaySelection = { unitId: null, first: null, departure: null };

export type SelectionResult = { ok: true; selection: DaySelection } | { ok: false; error: string; selection: DaySelection };

export function tapDay(
  sel: DaySelection,
  unitId: number,
  day: IsoDate,
  ctx: { today: IsoDate; taken: (unitId: number, night: IsoDate) => boolean; unitName: string; label: (d: IsoDate) => string },
): SelectionResult {
  if (day < ctx.today) return { ok: false, error: t`Ce jour est passé : choisissez un jour à partir d'aujourd'hui.`, selection: sel };
  const restart = sel.departure != null || sel.first == null || sel.unitId !== unitId || day <= sel.first;
  if (restart) {
    if (ctx.taken(unitId, day)) {
      return { ok: false, error: t`Le ${ctx.label(day)} est déjà pris pour ${ctx.unitName}. Choisissez un jour libre.`, selection: sel };
    }
    return { ok: true, selection: { unitId, first: day, departure: null } };
  }
  for (let n = sel.first as IsoDate; n < day; n = addDays(n, 1)) {
    if (ctx.taken(unitId, n)) {
      return {
        ok: false,
        error: t`La nuit du ${ctx.label(n)} est déjà prise. Choisissez un jour de départ au plus tard le ${ctx.label(n)}.`,
        selection: sel,
      };
    }
  }
  return { ok: true, selection: { unitId, first: sel.first, departure: day } };
}

// --- prix relatifs -------------------------------------------------------------------

export type PriceChange = { kind: "set"; cents: number } | { kind: "pct"; pct: number } | { kind: "add"; cents: number };

export function newPrice(old: number | null, change: PriceChange): number | null {
  if (change.kind === "set") return change.cents;
  if (old == null) return null;
  if (change.kind === "pct") return roundTo5(old * (1 + change.pct / 100));
  return old + change.cents;
}

/** Les nuits d'un bien regroupées en plages consécutives de même nouveau prix :
 *  une requête PATCH par plage. Les nuits sans prix de départ sont écartées. */
export function priceRuns(days: DayRate[], change: PriceChange): { from: IsoDate; to: IsoDate; priceCents: number }[] {
  const runs: { from: IsoDate; to: IsoDate; priceCents: number }[] = [];
  for (const d of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const p = newPrice(d.priceCents, change);
    if (p == null || p <= 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.priceCents === p && addDays(last.to, 1) === d.date) last.to = d.date;
    else runs.push({ from: d.date, to: d.date, priceCents: p });
  }
  return runs;
}
