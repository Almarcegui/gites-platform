// Rangée de jours d'une option « à la date » (sauna, bain chaud) — rendu pur,
// sans accès au DOM ni au réseau : testable seul. Les textes traduits arrivent
// en paramètre (book.js les passe par t()).

/** « jeu 23 » (puce) et « jeudi 23 octobre » (libellé lu par le lecteur d'écran). */
export function dayLabels(date, locale) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const fmt = (o) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...o }).format(dt).replace(/\.$/, "");
  return {
    short: `${fmt({ weekday: "short" })} ${d}`,
    full: fmt({ weekday: "long", day: "numeric", month: "long" }),
  };
}

/** HTML de la rangée : un bouton `aria-pressed` par jour, un jour déjà pris est
 *  grisé, désactivé et le dit en toutes lettres (pas seulement par la couleur).
 *  txt = { group: "Sauna : choisissez les jours", taken: "déjà réservé" }. */
export function dayChipsHtml({ oid, days, selected, locale, esc, txt }) {
  const chips = days
    .map(({ date, taken }) => {
      const { short, full } = dayLabels(date, locale);
      const on = !taken && selected.has(date);
      const label = taken ? `${full}, ${txt.taken}` : full;
      return (
        `<button type="button" class="day-chip${on ? " on" : ""}${taken ? " taken" : ""}" data-oid="${oid}" data-date="${esc(date)}"` +
        ` aria-pressed="${on ? "true" : "false"}" aria-label="${esc(label)}"${taken ? " disabled" : ""}>` +
        `<span>${esc(short)}</span>${taken ? `<small>${esc(txt.taken)}</small>` : ""}</button>`
      );
    })
    .join("");
  return `<div class="day-chips" role="group" aria-label="${esc(txt.group)}">${chips}</div>`;
}
