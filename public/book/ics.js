// Fichier d'ajout au calendrier du séjour (issue #47-7).
//
// Même logique que cgv.js : un module importé par la page, sans dépendance et
// testable seul (test/tunnel-ux-paquet1.test.ts l'exécute vraiment, plutôt que
// de relire le source du voucher — contre-review Gemini 2026-08-28).
//
// L'événement est une JOURNÉE ENTIÈRE : en VALUE=DATE, DTEND est exclusif, ce
// qui correspond exactement à notre date de départ. Pas de TZID à déclarer,
// donc aucun VTIMEZONE à embarquer ; les heures d'arrivée et de départ vivent
// dans la description.

/** Échappement iCalendar (RFC 5545 §3.3.11) : \ , ; et retours à la ligne. */
export const icsEsc = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([,;])/g, "\\$1")
    .replace(/\r?\n/g, "\\n");

/** Pliage des lignes à 75 octets (RFC 5545 §3.1) : la continuation commence
 *  par une espace. On compte en OCTETS (un accent en pèse deux) et on ne coupe
 *  jamais au milieu d'un caractère ni d'une séquence échappée. */
export function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let len = 0;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const unit = chars[i] === "\\" && i + 1 < chars.length ? chars[i] + chars[++i] : chars[i];
    const n = enc.encode(unit).length;
    if (len + n > 75) {
      out.push(cur);
      cur = " ";
      len = 1;
    }
    cur += unit;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

const icsDate = (iso) => String(iso).replace(/-/g, "");

/** Calendrier d'une réservation. `now` est injectable pour les tests. */
export function icsFile(b, stay = {}, address = "", now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const horaires =
    stay.checkinTime && stay.checkoutTime
      ? `Arrivée dès ${stay.checkinTime}, départ avant ${stay.checkoutTime}`
      : "";
  const desc = [
    `Référence ${b.reference}`,
    horaires,
    `${b.adults} adulte(s)${b.children ? ` + ${b.children} enfant(s)` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Les Gites//Voucher//FR",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${icsEsc(b.reference)}@gites`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(b.checkin)}`,
      `DTEND;VALUE=DATE:${icsDate(b.checkout)}`,
      `SUMMARY:${icsEsc(`Séjour — ${b.unitName}`)}`,
      address ? `LOCATION:${icsEsc(address)}` : "",
      `DESCRIPTION:${icsEsc(desc)}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .map(icsFold)
      .join("\r\n") + "\r\n"
  );
}
