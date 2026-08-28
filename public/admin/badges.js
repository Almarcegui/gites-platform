// Badges temporels des réservations (issue #53).
//
// Le back-office savait dire où en est l'ARGENT (soldée, solde dû, impayée)
// mais pas où en est le SÉJOUR : « qui arrive aujourd'hui ? » ne se lisait que
// dans la table « 7 jours » du tableau de bord. Ces deux fonctions comblent le
// trou, et comme `bookingTag()` est partagée par la liste, la fiche et le
// tableau de bord, le badge apparaît sur les trois écrans d'un coup.
//
// Module volontairement pur — ni DOM, ni import : c'est ce qui le rend
// testable depuis vitest (même parti pris que `suggestions.js`).

/** Lendemain d'une date ISO, sans dépendre du fuseau local. */
function nextDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Où en est le séjour par rapport à `today` ?
 * @param {object} booking     réservation (`checkin`, `checkout`, `status`)
 * @param {string} today       jour de référence, ISO
 * @param {"arrival"|"departure"|null} movement
 *        Le tableau de bord liste une LIGNE PAR MOUVEMENT : la même
 *        réservation y apparaît une fois à l'arrivée et une fois au départ.
 *        Sans ce paramètre, la ligne « départ le 02/09 » d'un séjour qui
 *        commence aujourd'hui afficherait « arrive aujourd'hui » — vrai de la
 *        réservation, absurde en face d'une flèche de départ. Le préciser
 *        restreint la lecture au mouvement de la ligne.
 * @returns {"arrive-today"|"arrive-tomorrow"|"leaves-today"|null}
 *
 * Une réservation annulée n'a plus de séjour : elle ne porte aucun badge
 * temporel (sinon le planning du jour annoncerait des arrivées fantômes).
 * Les options non payées, elles, en gardent un : une arrivée demain encore
 * en attente de paiement est précisément ce qu'il faut voir.
 */
export function stayPhase(booking, today, movement = null) {
  // Un appelant sans jour de référence (ou avec une valeur aberrante) doit
  // obtenir « rien à signaler », jamais une exception qui vide l'écran.
  if (!booking || booking.status === "cancelled") return null;
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const { checkin, checkout } = booking;
  if (movement !== "departure" && checkin) {
    if (checkin === today) return "arrive-today";
    if (checkin === nextDay(today)) return "arrive-tomorrow";
  }
  if (movement !== "arrival" && checkout === today) return "leaves-today";
  return null;
}

const LABELS = {
  "arrive-today": ["t-now", "Arrive aujourd’hui"],
  "arrive-tomorrow": ["t-soon", "Arrive demain"],
  "leaves-today": ["t-now", "Part aujourd’hui"],
};

/** Le badge HTML correspondant, ou une chaîne vide s'il n'y a rien à dire.
 *  Aucune donnée saisissable n'entre ici — pas d'échappement nécessaire. */
export function stayBadge(booking, today, movement = null) {
  const phase = stayPhase(booking, today, movement);
  if (!phase) return "";
  const [cls, label] = LABELS[phase];
  return `<span class="tag ${cls}">${label}</span>`;
}
