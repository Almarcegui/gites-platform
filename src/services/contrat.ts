// Contrat de location en PDF (FR / NL), joint au mail de confirmation et servi
// par /api/admin/bookings/:id/contrat.pdf et /api/public/bookings/:ref/contrat.pdf.
//
// RÈGLE : le contrat ne crée AUCUNE règle. Les chiffres viennent de la
// réservation (devis figé, arrhes, échéance du solde) ; les règles de paiement
// et d'annulation sont les articles 4 et 5 des conditions générales EN BASE
// (`settings.cgv_text`), reproduits mot pour mot, puis le texte complet en
// annexe. Si les CGV changent, le contrat suit sans toucher à ce fichier.
// Le néerlandais traduit les libellés du contrat ; les CGV, elles, n'existent
// qu'en français et font foi (décision du lot 3, cf. CGV_NL_NOTE).
//
// Pour changer le texte du contrat : docs/confirmation-et-contrat.md.

import type { BookingRow, GuestRow, PropertyRow, PropertySettings } from "../db/repo";
import { getBooking, getCgvAcceptance, getGuest, getProperty, getSettings } from "../db/repo";
import { PdfDocument } from "../core/pdf";
import { nlText } from "../core/public-i18n";
import { CGV_NL_NOTE, formatDateFr, isNl, money, parseQuote, postalAddress, realContact } from "./email";

export interface ContractContext {
  booking: BookingRow;
  property: PropertyRow;
  settings: PropertySettings;
  guest: GuestRow | null;
  acceptance: { version: string | null; acceptedAt: string | null; ip: string | null };
  /** Date d'émission du document (maintenant par défaut ; injectable pour les tests). */
  issuedAt?: Date;
}

/** Nom du fichier joint : Contrat-<référence>.pdf, référence assainie. */
export function contractFileName(reference: string): string {
  return `Contrat-${reference.replace(/[^A-Za-z0-9_-]+/g, "-")}.pdf`;
}

/** Charge tout ce qu'il faut au contrat ; null si la réservation (ou son domaine) n'existe pas. */
export async function loadContractContext(db: D1Database, bookingId: number): Promise<ContractContext | null> {
  const booking = await getBooking(db, bookingId);
  if (!booking || booking.propertyId == null) return null;
  const property = await getProperty(db, booking.propertyId);
  if (!property) return null;
  const [settings, guest, acceptance] = await Promise.all([
    getSettings(db, booking.propertyId),
    booking.guestId != null ? getGuest(db, booking.guestId) : Promise.resolve(null),
    getCgvAcceptance(db, booking.id),
  ]);
  return { booking, property, settings, guest, acceptance };
}

// --- extraits des CGV ---------------------------------------------------------------

/** Bloc « Article n — … » des CGV (titre compris), ou null. */
export function cgvArticle(cgv: string, n: number): string | null {
  const lines = cgv.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^Article ${n} [—–-]`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^Article \d+ [—–-]/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n").trim();
}

/** « 3.0 » dans « Version 3.0 — 28 août 2026… », ou null. */
export function cgvVersionLabel(cgv: string): string | null {
  return /^Version\s+([0-9][0-9.]*)/m.exec(cgv)?.[1] ?? null;
}

/** Phrase « L'exploitant est … » de l'article 1, ou null. */
function cgvExploitant(cgv: string): string | null {
  const art = cgvArticle(cgv, 1);
  const m = art ? /L['’]exploitant est [^\n]*?\.(?=\s|$)/.exec(art) : null;
  return m ? m[0] : null;
}

// --- dates -------------------------------------------------------------------------

const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const JOURS_NL = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/** « samedi 12 septembre 2026 » depuis AAAA-MM-JJ. */
function longDate(iso: string, nl: boolean): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${(nl ? JOURS_NL : JOURS_FR)[dow]} ${d}${!nl && d === 1 ? "er" : ""} ${(nl ? MOIS_NL : MOIS_FR)[m - 1]} ${y}`;
}

/** « 12/09/2026 à 14:03 » en heure de Bruxelles depuis un horodatage SQL UTC (« AAAA-MM-JJ HH:MM:SS »). */
function acceptanceStamp(sql: string, nl: boolean): string {
  const d = new Date(`${sql.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return sql;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${nl ? "om" : "à"} ${get("hour")}:${get("minute")}`;
}

// --- textes -------------------------------------------------------------------------

interface Words {
  title: string;
  ref: string;
  madeOn: (date: string) => string;
  parties: string;
  landlord: string;
  landlordCgv: string;
  tenant: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  property: string;
  unit: string;
  stay: string;
  arrival: string;
  departure: string;
  fromTime: (t: string) => string;
  beforeTime: (t: string) => string;
  nights: (n: number) => string;
  guests: string;
  guestsValue: (a: number, c: number) => string;
  price: string;
  priceHeader: [string, string];
  total: string;
  payment: string;
  fullAtBooking: (amount: string) => string;
  deposit: (amount: string, pct: number | null) => string;
  balance: (amount: string, date: string) => string;
  paid: (amount: string, date: string) => string;
  paymentRules: string;
  caution: (amount: string) => string;
  cautionTitle: string;
  cgv: string;
  cgvNl: string | null;
  cgvPart: (version: string | null) => string;
  concluded: string;
  acceptedOn: (when: string, version: string | null, ip: string | null) => string;
  privacy: string;
  annex: string;
  footer: (ref: string, property: string) => string;
  pageLabel: string;
  subject: string;
}

const FR: Words = {
  title: "CONTRAT DE LOCATION SAISONNIÈRE",
  ref: "Référence de réservation",
  madeOn: (d) => `Réservation du ${d}`,
  parties: "1. Les parties",
  landlord: "Le bailleur (exploitant)",
  landlordCgv: "Selon l'article 1 des conditions générales",
  tenant: "Le locataire",
  name: "Nom",
  email: "E-mail",
  phone: "Téléphone",
  address: "Adresse",
  property: "Domaine",
  unit: "Hébergement loué",
  stay: "3. Le séjour",
  arrival: "Arrivée",
  departure: "Départ",
  fromTime: (t) => `à partir de ${t}`,
  beforeTime: (t) => `avant ${t}`,
  nights: (n) => `${n} nuit${n > 1 ? "s" : ""}`,
  guests: "Occupants",
  guestsValue: (a, c) => `${a + c} personne${a + c > 1 ? "s" : ""}${c > 0 ? ` (dont ${c} enfant${c > 1 ? "s" : ""})` : ""}`,
  price: "4. Le prix",
  priceHeader: ["Désignation", "Montant"],
  total: "Prix total du séjour",
  payment: "5. Paiement",
  fullAtBooking: (a) => `La totalité du prix, soit ${a}, est payable à la réservation.`,
  deposit: (a, p) => `Arrhes versées à la réservation : ${a}${p != null ? ` (${p} % du prix total)` : ""}.`,
  balance: (a, d) => `Solde : ${a}, exigible au plus tard le ${d}.`,
  paid: (a, d) => `Montant réglé au ${d} : ${a}.`,
  paymentRules: "Rappel des dispositions des conditions générales sur le paiement et l'annulation (texte intégral en annexe) :",
  cautionTitle: "Caution",
  caution: (a) => `Une caution de ${a} est demandée avant l'arrivée (empreinte de carte ou dépôt) et restituée après l'état des lieux.`,
  cgv: "6. Conditions générales et conclusion du contrat",
  cgvNl: null,
  cgvPart: (v) => `Les conditions générales de location${v ? ` (version ${v})` : ""} font partie intégrante du présent contrat et sont reproduites en annexe.`,
  concluded: "Le présent contrat est conclu par l'acceptation en ligne des conditions générales et le paiement des arrhes. Il ne se signe pas.",
  acceptedOn: (w, v, ip) => `Acceptation enregistrée le ${w}${v ? `, conditions générales version ${v}` : ""}${ip ? `, adresse IP ${ip}` : ""}.`,
  privacy: "Les données du locataire sont utilisées uniquement pour l'exécution du contrat de location.",
  annex: "ANNEXE — CONDITIONS GÉNÉRALES DE LOCATION",
  footer: (r, p) => `Contrat de location ${r} — ${p}`,
  pageLabel: "Page",
  subject: "Contrat de location saisonnière",
};

const NL: Words = {
  title: "HUURCONTRACT VOOR VAKANTIEVERBLIJF",
  ref: "Reserveringsreferentie",
  madeOn: (d) => `Reservering van ${d}`,
  parties: "1. De partijen",
  landlord: "De verhuurder (uitbater)",
  landlordCgv: "Volgens artikel 1 van de algemene voorwaarden",
  tenant: "De huurder",
  name: "Naam",
  email: "E-mail",
  phone: "Telefoon",
  address: "Adres",
  property: "Domein",
  unit: "Gehuurde accommodatie",
  stay: "3. Het verblijf",
  arrival: "Aankomst",
  departure: "Vertrek",
  fromTime: (t) => `vanaf ${t}`,
  beforeTime: (t) => `voor ${t}`,
  nights: (n) => `${n} ${n > 1 ? "nachten" : "nacht"}`,
  guests: "Gasten",
  guestsValue: (a, c) => `${a + c} ${a + c > 1 ? "personen" : "persoon"}${c > 0 ? ` (waarvan ${c} ${c > 1 ? "kinderen" : "kind"})` : ""}`,
  price: "4. De prijs",
  priceHeader: ["Omschrijving", "Bedrag"],
  total: "Totale prijs van het verblijf",
  payment: "5. Betaling",
  fullAtBooking: (a) => `De volledige prijs, namelijk ${a}, is betaalbaar bij de reservering.`,
  deposit: (a, p) => `Bij de reservering betaald voorschot: ${a}${p != null ? ` (${p} % van de totale prijs)` : ""}.`,
  balance: (a, d) => `Saldo: ${a}, te betalen uiterlijk op ${d}.`,
  paid: (a, d) => `Betaald bedrag op ${d}: ${a}.`,
  paymentRules: "Herinnering aan de bepalingen van de algemene voorwaarden over betaling en annulering (volledige tekst in bijlage, in het Frans):",
  cautionTitle: "Waarborg",
  caution: (a) => `Een waarborg van ${a} wordt gevraagd voor de aankomst (kaartafdruk of storting) en na de plaatsbeschrijving terugbetaald.`,
  cgv: "6. Algemene voorwaarden en totstandkoming van het contract",
  cgvNl: CGV_NL_NOTE,
  cgvPart: (v) => `De algemene verhuurvoorwaarden${v ? ` (versie ${v})` : ""} maken integraal deel uit van dit contract en zijn als bijlage opgenomen.`,
  concluded: "Dit contract komt tot stand door de online aanvaarding van de algemene voorwaarden en de betaling van het voorschot. Het wordt niet ondertekend.",
  acceptedOn: (w, v, ip) => `Aanvaarding geregistreerd op ${w}${v ? `, algemene voorwaarden versie ${v}` : ""}${ip ? `, IP-adres ${ip}` : ""}.`,
  privacy: "De gegevens van de huurder worden uitsluitend gebruikt voor de uitvoering van het huurcontract.",
  annex: "BIJLAGE — ALGEMENE VERHUURVOORWAARDEN (FRANS)",
  footer: (r, p) => `Huurcontract ${r} — ${p}`,
  pageLabel: "Pagina",
  subject: "Huurcontract voor vakantieverblijf",
};

// --- le document ---------------------------------------------------------------------

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

export function buildContractPdf(ctx: ContractContext): Uint8Array {
  const { booking: b, property, settings, guest } = ctx;
  const nl = isNl(b);
  const w = nl ? NL : FR;
  const m = (cents: number) => money(cents, nl);
  const quote = parseQuote(b);
  const issued = ctx.issuedAt ?? new Date();
  const issuedIso = issued.toISOString().slice(0, 10);
  const bookedIso = b.createdAt.slice(0, 10);
  const cgv = settings.cgvText || "";
  const propertyName = clean(property.name);

  const doc = new PdfDocument({
    title: `${w.subject} ${b.reference}`,
    author: propertyName,
    subject: w.subject,
    date: issued,
    footer: w.footer(b.reference, propertyName),
    pageLabel: w.pageLabel,
  });

  // En-tête
  doc.paragraph(propertyName, { size: 10, bold: true, color: [0.12, 0.27, 0.2], after: 2 });
  doc.heading(w.title, 1);
  doc.paragraph(`${w.ref} : ${b.reference}`, { size: 10.5, bold: true, after: 1 });
  doc.paragraph(w.madeOn(formatDateFr(bookedIso)), { size: 9.5, color: [0.4, 0.4, 0.4], after: 6 });
  doc.rule();

  // 1. Parties
  doc.heading(w.parties);
  const landlordLines = [
    propertyName,
    clean(postalAddress(property)),
    [clean(realContact(property.contactEmail)), clean(realContact(property.contactPhone))].filter(Boolean).join(" · "),
  ].filter(Boolean);
  const exploitant = cgvExploitant(cgv);
  const guestName = clean(b.guestName) || clean(guest ? `${guest.firstName ?? ""} ${guest.lastName}` : "");
  const guestAddress = [clean(guest?.address), clean(guest?.country)].filter(Boolean).join(", ");
  doc.table(
    [
      [w.landlord, [...landlordLines, ...(exploitant ? [`${w.landlordCgv} : ${exploitant}`] : [])].join("\n")],
      [
        w.tenant,
        [
          guestName,
          guestAddress,
          [clean(b.guestEmail), clean(guest?.phone)].filter(Boolean).join(" · "),
        ].filter(Boolean).join("\n"),
      ],
    ],
    { columns: [{ width: 28, bold: true }, { width: 72 }], size: 9.5 },
  );

  // 2. Bien loué
  doc.heading(`2. ${w.unit}`);
  doc.paragraph(`${clean(b.unitName)} — ${propertyName}`, { bold: true, after: 1 });
  const where = clean(postalAddress(property));
  if (where) doc.paragraph(where, { after: 4 });

  // 3. Séjour
  doc.heading(w.stay);
  const nights = quote?.nights ?? Math.max(1, Math.round((Date.parse(b.checkout) - Date.parse(b.checkin)) / 86_400_000));
  doc.table(
    [
      [w.arrival, `${longDate(b.checkin, nl)}, ${w.fromTime(settings.checkinTime)}`],
      [w.departure, `${longDate(b.checkout, nl)}, ${w.beforeTime(settings.checkoutTime)}`],
      ["", w.nights(nights)],
      [w.guests, w.guestsValue(b.adults, b.children)],
    ],
    { columns: [{ width: 28, bold: true }, { width: 72 }], size: 9.5 },
  );

  // 4. Prix
  doc.heading(w.price);
  const priceRows: string[][] = quote
    ? quote.lines.map((l) => [clean(nl ? nlText(l.publicLabel ?? l.label) : (l.publicLabel ?? l.label)), m(l.amountCents)])
    : [];
  priceRows.push([w.total, m(quote?.totalCents ?? b.totalCents)]);
  doc.table(priceRows, {
    header: [...w.priceHeader],
    columns: [{ width: 78 }, { width: 22, align: "right" }],
    size: 9.5,
    totalRow: true,
  });

  // 5. Paiement
  doc.heading(w.payment);
  if (b.balanceDueDate == null) {
    doc.paragraph(w.fullAtBooking(m(b.totalCents)), { after: 2 });
  } else {
    const pct = quote ? quote.depositPct : b.totalCents > 0 ? Math.round((b.depositCents / b.totalCents) * 100) : null;
    doc.paragraph(w.deposit(m(b.depositCents), pct), { after: 2 });
    doc.paragraph(w.balance(m(Math.max(0, b.totalCents - b.depositCents)), formatDateFr(b.balanceDueDate)), { after: 2 });
  }
  doc.paragraph(w.paid(m(b.paidCents), formatDateFr(issuedIso)), { after: 6 });
  if (settings.cautionCents > 0) {
    doc.paragraph(w.caution(m(settings.cautionCents)), { after: 6 });
  }
  const art4 = cgvArticle(cgv, 4);
  const art5 = cgvArticle(cgv, 5);
  if (art4 || art5) {
    doc.paragraph(w.paymentRules, { size: 9, bold: true, after: 3 });
    for (const art of [art4, art5]) {
      if (!art) continue;
      const [head, ...rest] = art.split("\n");
      doc.paragraph(head!, { size: 9, bold: true, after: 1 });
      doc.paragraph(rest.join("\n").trim(), { size: 9, after: 5, indent: 8 });
    }
  }

  // 6. CGV et conclusion du contrat : acceptation en ligne + arrhes, pas de signature
  doc.heading(w.cgv);
  const version = cgvVersionLabel(cgv);
  doc.paragraph(w.cgvPart(version), { after: 3 });
  if (w.cgvNl) doc.paragraph(w.cgvNl, { size: 9, bold: true, after: 3 });
  doc.paragraph(w.concluded, { after: 3 });
  if (ctx.acceptance.acceptedAt) {
    doc.paragraph(w.acceptedOn(acceptanceStamp(ctx.acceptance.acceptedAt, nl), version, clean(ctx.acceptance.ip)), { after: 3 });
  }
  doc.paragraph(w.privacy, { after: 3 });

  // Annexe : CGV intégrales
  doc.newPage();
  doc.heading(w.annex, 2);
  if (!cgv.trim()) {
    doc.paragraph("(CGV à compléter)", { after: 4 });
  } else {
    for (const block of cgv.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
      const text = block.trim();
      if (!text) continue;
      if (/^Article \d+ [—–-]/.test(text)) {
        const [head, ...rest] = text.split("\n");
        doc.heading(head!, 3);
        if (rest.join("").trim()) doc.paragraph(rest.join("\n").trim(), { size: 8.8, after: 3 });
      } else if (/^CONDITIONS GÉNÉRALES/.test(text)) continue; // le titre de l'annexe le remplace
      else doc.paragraph(text, { size: 8.8, after: 3 });
    }
  }
  return doc.build();
}
