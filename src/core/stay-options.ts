// Plages de séjour réservables les plus proches d'une demande impossible.
//
// Pourquoi ce module (issue #66) : la règle du minimum de nuits et celle des
// jours d'arrivée imposés vivaient uniquement dans le moteur de devis, qui
// répond « non ». Le client voyait « indisponible » sans savoir quoi changer —
// impasse n° 5 du parcours au clic. Ici on répond « non, MAIS voilà ce qui
// marche » : une ou deux plages réellement réservables, calculées sur les
// mêmes données que la recherche (disponibilité liée + tarifs jour par jour).
//
// Module pur : aucune I/O, testable en millisecondes.

import { addDays, dayOfWeek, diffDays, type IsoDate } from "./dates";

/** Une nuit du calendrier, vue par UNE unité. */
export interface NightOption {
  date: IsoDate;
  /** l'unité (liaisons comprises) est libre cette nuit-là */
  available: boolean;
  /** minimum de nuits imposé si le séjour COMMENCE cette nuit ;
   *  null = aucun tarif ne couvre le jour, donc pas de séjour possible */
  minNights: number | null;
  /** jours d'arrivée autorisés (0=dim … 6=sam) ; null = aucune contrainte,
   *  liste vide = aucune arrivée possible (règles de saison incompatibles) */
  checkinDays: number[] | null;
}

export interface StaySuggestion {
  checkin: IsoDate;
  checkout: IsoDate; // exclusif
  nights: number;
}

/** Ce jour est-il une arrivée autorisée par la règle de saison ?
 *  `null` = aucune contrainte ; liste vide = aucune arrivée possible. */
export function isAllowedCheckin(day: Pick<NightOption, "date" | "checkinDays">): boolean {
  const days = day.checkinDays;
  if (days == null) return true;
  return days.includes(dayOfWeek(day.date));
}

/** Le séjour [checkin, checkout) est-il réservable au vu du calendrier ? */
export function isBookableStay(days: readonly NightOption[], checkin: IsoDate, checkout: IsoDate): boolean {
  const index = new Map(days.map((d) => [d.date, d]));
  const arrival = index.get(checkin);
  if (!arrival || arrival.minNights == null) return false;
  if (!isAllowedCheckin(arrival)) return false;
  const nights = diffDays(checkin, checkout);
  if (nights < arrival.minNights) return false;
  for (let d = checkin; d < checkout; d = addDays(d, 1)) {
    const night = index.get(d);
    if (!night || !night.available || night.minNights == null) return false;
  }
  return true;
}

/** Plages réservables les plus proches d'un séjour demandé.
 *
 *  Règle de proximité : on garde la durée souhaitée quand elle suffit, sinon on
 *  l'étire au minimum imposé par la nuit d'arrivée — jamais plus. Les candidats
 *  sont ensuite classés par écart de date d'arrivée, à égalité en privilégiant
 *  une arrivée PLUS TARDIVE que celle demandée (le client a rarement la
 *  possibilité de partir plus tôt que prévu) puis le séjour le plus court.
 *
 *  `days` doit couvrir la fenêtre de recherche ET la place nécessaire à droite
 *  pour un séjour étiré : une suggestion tronquée par le bord de la fenêtre
 *  n'est pas produite. */
export function suggestStays(
  days: readonly NightOption[],
  wanted: { checkin: IsoDate; nights: number },
  max = 2,
): StaySuggestion[] {
  const index = new Map(days.map((d) => [d.date, d]));
  const wantedNights = Math.max(1, Math.floor(wanted.nights));
  const candidates: (StaySuggestion & { offset: number })[] = [];

  for (const day of days) {
    if (!day.available || day.minNights == null || !isAllowedCheckin(day)) continue;
    const nights = Math.max(wantedNights, day.minNights);
    const checkout = addDays(day.date, nights);
    let free = true;
    for (let d = day.date; d < checkout; d = addDays(d, 1)) {
      const night = index.get(d);
      if (!night || !night.available || night.minNights == null) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    candidates.push({ checkin: day.date, checkout, nights, offset: diffDays(wanted.checkin, day.date) });
  }

  candidates.sort((a, b) => {
    const da = Math.abs(a.offset);
    const db = Math.abs(b.offset);
    if (da !== db) return da - db;
    if (a.offset !== b.offset) return b.offset - a.offset; // à égalité, après plutôt qu'avant
    return a.nights - b.nights;
  });

  return candidates.slice(0, Math.max(0, max)).map(({ checkin, checkout, nights }) => ({ checkin, checkout, nights }));
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** « le samedi », « le samedi ou le dimanche » — pour dire la règle en clair. */
export function checkinDaysLabel(days: readonly number[]): string {
  const names = [...new Set(days)]
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) // semaine à la française : lundi d'abord
    .map((d) => JOURS[d] as string);
  if (names.length === 0) return "";
  if (names.length === 1) return `le ${names[0]}`;
  return `le ${names.slice(0, -1).join(", le ")} ou le ${names[names.length - 1]}`;
}
