// Back-office — suggestions tarifaires en un clic (issue #31).
//
// Trois lectures des données réelles : une nuit coincée entre deux séjours,
// des dates proches encore libres, des jours fériés déjà majorés par le
// moteur. Chaque suggestion explique son raisonnement chiffré et ne fait que
// PRÉ-REMPLIR la saisie — l'écriture reste un geste humain.
//
// Module volontairement autonome (aucun import, aucun accès au DOM) : c'est
// la seule logique métier du front, elle doit pouvoir être testée seule.

const MS_DAY = 86400000;

export function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function diffDaysIso(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / MS_DAY);
}
const dfr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const eur = (cents) =>
  (cents / 100).toLocaleString("fr-BE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });

/** Remise plafonnée sur les dates proches : au-delà, on vend sous son propre
 *  tarif de base. Majoration des dates fortes : un cran au-dessus du férié. */
export const LAST_MINUTE_PCT = 10;
export const STRONG_DATE_PCT = 15;
/** Horizon « dernière minute », en jours. */
export const LAST_MINUTE_DAYS = 21;

/**
 * @param {object} input
 * @param {Array}  input.days       jours du mois affiché (forme DayRate de l'API)
 * @param {Set}    input.soldDates  nuits déjà vendues pour ce bien
 * @param {Array}  input.bookings   réservations actives (toutes unités)
 * @param {number} input.unitId     bien concerné
 * @param {string} input.today      date du jour, ISO
 * @param {string} input.monthEnd   dernier jour du mois affiché, ISO
 * @returns {Array} suggestions, éventuellement vide — jamais d'erreur
 */
export function buildSuggestions({ days, soldDates, bookings, unitId, today, monthEnd }) {
  const out = [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const libre = (iso) => !soldDates.has(iso);

  // 1. Nuits orphelines : une ou deux nuits libres coincées entre deux séjours,
  //    que le minimum de nuits rend invendables.
  const stays = bookings
    .filter((b) => b.unitId === unitId)
    .map((b) => ({ checkin: b.checkin, checkout: b.checkout }))
    .sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
  for (let i = 0; i + 1 < stays.length; i++) {
    const from = stays[i].checkout; // le départ libère la nuit du jour même
    const to = addDaysIso(stays[i + 1].checkin, -1);
    if (from > to || from < today) continue;
    const nights = diffDaysIso(from, to) + 1;
    if (nights > 2) continue;
    const d = byDate.get(from);
    if (!d || d.minNights == null || d.minNights <= nights) continue;
    const s = nights > 1 ? "s" : "";
    out.push({
      kind: "orphelines",
      title: `Nuit${s} orpheline${s} du ${dfr(from)}`,
      why: `${nights} nuit${s} libre${s} entre deux séjours, alors que le minimum est de ${d.minNights} nuits : personne ne peut réserver ce trou.`,
      action: `Descendre le minimum à ${nights} nuit${s}`,
      from,
      to,
      prefill: { minNights: nights },
    });
    break; // une proposition de ce type à la fois : la liste doit rester lisible
  }

  // 2. Dernière minute : dates proches encore libres, remise bornée.
  const horizon = addDaysIso(today, LAST_MINUTE_DAYS);
  const proches = days.filter(
    (d) => d.date >= today && d.date <= horizon && d.date <= monthEnd && libre(d.date) && d.priceCents != null,
  );
  if (proches.length >= 2) {
    const first = proches[0];
    const last = proches[proches.length - 1];
    const cut = Math.round((first.priceCents * (100 - LAST_MINUTE_PCT)) / 100);
    out.push({
      kind: "derniere-minute",
      title: `Dernière minute — ${proches.length} nuits encore libres d'ici le ${dfr(last.date)}`,
      why: `Remise bornée à ${LAST_MINUTE_PCT} % sur ces dates proches : ${eur(first.priceCents)} − ${LAST_MINUTE_PCT} % = ${eur(cut)}. Au-delà, tu vends moins cher que ton tarif de base.`,
      action: `Proposer −${LAST_MINUTE_PCT} %`,
      from: first.date,
      to: last.date,
      prefill: { priceCents: cut },
    });
  }

  // 3. Dates fortes : fériés et ponts déjà calculés par le moteur, pas encore
  //    repris à la main.
  const fortes = days.filter(
    (d) => d.holidayRated && d.date >= today && d.priceCents != null && d.overridePriceCents == null,
  );
  if (fortes.length > 0) {
    const up = Math.round((fortes[0].priceCents * (100 + STRONG_DATE_PCT)) / 100);
    const s = fortes.length > 1 ? "s" : "";
    out.push({
      kind: "dates-fortes",
      title: `Dates fortes — ${fortes.length} jour${s} férié${s} ou pont ce mois-ci`,
      why: `Le moteur les majore déjà. Un cran de plus se justifie sur ${dfr(fortes[0].date)} : ${eur(fortes[0].priceCents)} + ${STRONG_DATE_PCT} % = ${eur(up)}.`,
      action: `Proposer +${STRONG_DATE_PCT} %`,
      from: fortes[0].date,
      to: fortes[fortes.length - 1].date,
      prefill: { priceCents: up },
    });
  }
  return out;
}
