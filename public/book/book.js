// Page publique : sans ?property → landing des domaines ; avec ?property →
// tunnel de réservation « ~4 clics » :
//   1. dates (calendrier)            → recherche automatique, sans bouton
//   2. hébergements disponibles      → auto-sélection s'il n'y en a qu'un
//   3. coordonnées (4 champs) + devis recalculé automatiquement, récap sticky
//   4. paiement sécurisé Stripe (créneau bloqué 30 min).
// Deep-links : ?checkin=&checkout=&adults=&children=&unit= (le site vitrine
// envoie ici avec les dates déjà choisies). La sélection est conservée 30 jours
// (localStorage) pour reprendre un devis interrompu.
// La ligne « Domaine entier » n'apparaît disponible que si TOUTES ses maisons
// sont libres — garanti par le moteur de liaison côté serveur.

import { cgvHtml } from "./cgv.js";

const params = new URLSearchParams(location.search);
const PROPERTY = params.get("property");

const eur = (c) => (c / 100).toLocaleString("fr-BE", { style: "currency", currency: "EUR" });
const eurRound = (c) => `${Math.round(c / 100)} €`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dfr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay(); // 0 = dimanche
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Règle d'arrivée en clair. Une liste VIDE n'est pas « aucune contrainte » :
 *  c'est « plus aucune arrivée possible » (règles de saison incompatibles). */
function arrivalLabel(days) {
  const label = checkinDaysLabel(days);
  return label ? `arrivée ${label}` : "aucune arrivée possible";
}

/** « le samedi », « le vendredi ou le samedi » — dire la règle, pas la subir. */
function checkinDaysLabel(days) {
  const names = [...new Set(days ?? [])].filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => JOURS[d]);
  if (names.length === 0) return "";
  if (names.length === 1) return `le ${names[0]}`;
  return `le ${names.slice(0, -1).join(", le ")} ou le ${names.at(-1)}`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `erreur ${res.status}`);
  return data;
}

const $ = (id) => document.getElementById(id);

let PROP = null;
let TODAY = null;
let SEARCH = null;
let SELECTED = null;
let QUOTE = null;
let calMonth = null; // 'YYYY-MM'
let selIn = null;
let selOut = null;
let preferredUnit = params.get("unit"); // slug — consommé au 1er résultat
let RESUMED_HOLD = null; // réservation en cours retrouvée au chargement (#68)
const calCache = new Map();

function setStep(n) {
  document.querySelectorAll("#steps span").forEach((s) => {
    const step = Number(s.dataset.step);
    s.classList.toggle("on", step === n);
    s.classList.toggle("done", step < n);
  });
  $("mobileBar").style.display = n === 3 && QUOTE?.ok ? "flex" : "none";
}

// ---------------------------------------------------------------------------
// Sélection : deep-links + reprise 30 jours
// ---------------------------------------------------------------------------

const storeKey = () => `gites-book:${PROPERTY}`;

function persistSelection() {
  const url = new URL(location.href);
  for (const [k, v] of [
    ["checkin", selIn],
    ["checkout", selOut],
    ["adults", String(pax().adults)],
    ["children", String(pax().children) === "0" ? null : String(pax().children)],
  ]) {
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  history.replaceState(null, "", url);
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ selIn, selOut, ...pax(), savedAt: Date.now() }));
  } catch { /* navigation privée */ }
}

function restoreSelection() {
  const qIn = params.get("checkin");
  const qOut = params.get("checkout");
  if (ISO_DATE.test(qIn ?? "") && ISO_DATE.test(qOut ?? "") && qIn >= TODAY && qOut > qIn) {
    selIn = qIn;
    selOut = qOut;
    setPax(Number(params.get("adults")) || 2, Number(params.get("children")) || 0);
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) ?? "null");
    if (!saved || Date.now() - saved.savedAt > 30 * 86400000) return;
    if (ISO_DATE.test(saved.selIn ?? "") && ISO_DATE.test(saved.selOut ?? "") && saved.selIn >= TODAY) {
      selIn = saved.selIn;
      selOut = saved.selOut;
      setPax(saved.adults, saved.children);
    }
  } catch { /* stockage indisponible */ }
}

function pax() {
  return { adults: Number($("qAd").value) || 2, children: Number($("qCh").value) || 0 };
}

function setPax(adults, children) {
  if (adults >= 1 && adults <= 30) $("qAd").value = String(adults);
  if (children >= 0 && children <= 30) $("qCh").value = String(children);
}

// ---------------------------------------------------------------------------
// Landing multi-domaines
// ---------------------------------------------------------------------------

async function renderLanding() {
  const landing = $("landing");
  landing.style.display = "block";
  $("propName").textContent = "Réservation en direct";
  $("propSub").textContent = "Choisissez votre domaine";
  try {
    const { properties } = await api("/api/public/properties");
    landing.innerHTML = `<div class="domains">${properties
      .map(
        (p) => `<a class="domain" href="?property=${encodeURIComponent(p.slug)}">
          <div class="ph" ${p.photoUrl ? `style="background-image:url('${esc(p.photoUrl)}')"` : ""}></div>
          <div class="bd"><b>${esc(p.name)}</b>
          <p>${esc(p.address ?? "")}</p>
          <p>${p.unitsCount} hébergement${p.unitsCount > 1 ? "s" : ""} · jusqu'à ${p.capacityMax} personnes</p>
          <p style="margin-top:8px"><span class="btn" style="padding:8px 16px">Voir & réserver</span></p></div>
        </a>`,
      )
      .join("")}</div>`;
  } catch (e) {
    landing.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Remises actives et disponibilité factuelle (issue #35)
//
// Les remises existent en base depuis le début et ne se découvraient qu'au
// devis — trop tard pour jouer leur rôle. Elles sont désormais annoncées, et
// le prix barré n'apparaît QUE lorsque le moteur applique réellement une
// remise (`quote.discountCents > 0`) : le prix de référence est toujours
// `total + remise`, jamais un montant fabriqué.
//
// Côté disponibilité : la phrase vient du serveur, qui la recalcule sur les
// vraies réservations à chaque chargement. Elle porte toujours son
// dénominateur (« 3 week-ends libres sur 9 ») — pas de fausse rareté, pas de
// compte à rebours, rien qui ne se vérifie pas contre le calendrier ci-dessous.
// ---------------------------------------------------------------------------

/** Prix de référence barré + économie, ou chaîne vide si aucune remise. */
function strikeThrough(totalCents, discountCents) {
  if (!(discountCents > 0)) return "";
  return `<span class="was">${eur(totalCents + discountCents)}</span>`;
}

async function renderOffers() {
  const card = $("offersCard");
  const body = $("offersBody");
  if (!card || !body) return;
  let data;
  try {
    data = await api(`/api/public/offers?property=${encodeURIComponent(PROPERTY)}`);
  } catch {
    return; // l'encart est un plus : son échec ne doit pas gêner la réservation
  }
  const promos = data.promotions ?? [];
  const avail = data.availability;
  if (promos.length === 0 && !avail?.sentence) return;

  const list = promos.length
    ? `<ul>${promos.map((p) => `<li>${esc(p.label)}</li>`).join("")}</ul>` +
      (data.nonCumulNote ? `<p class="cumul">${esc(data.nonCumulNote)}</p>` : "")
    : "";
  const availability = avail?.sentence
    ? `<p class="avail">${esc(avail.sentence)}
        <span class="src">Calculé à l'instant sur les réservations réelles — vérifiable dans le calendrier ci-dessous.</span></p>`
    : "";
  body.innerHTML = list + availability;
  card.hidden = false;
}

// ---------------------------------------------------------------------------
// Étape 1 — calendrier des disponibilités et prix
// ---------------------------------------------------------------------------

async function loadCalMonth(month) {
  if (!calCache.has(month)) {
    calCache.set(month, await api(`/api/public/calendar?property=${encodeURIComponent(PROPERTY)}&month=${month}`));
  }
  return calCache.get(month);
}

function monthShift(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

async function renderCalendar() {
  const data = await loadCalMonth(calMonth);
  const monthStart = `${calMonth}-01`;
  const label = new Date(monthStart + "T12:00:00Z").toLocaleDateString("fr-BE", { month: "long", year: "numeric" });
  $("calLabel").textContent = label;
  $("calPrev").disabled = calMonth <= TODAY.slice(0, 7);
  $("calNext").disabled = calMonth >= monthShift(TODAY.slice(0, 7), 23);

  // agrégat par jour : dispo = au moins un hébergement libre ; prix = plancher
  // Minimum de nuits et jours d'arrivée sont agrégés de la même façon — au plus
  // PERMISSIF des hébergements encore libres : c'est ce qui rend une
  // réservation possible ce jour-là, donc ce que le client doit lire (#66).
  const nbDays = data.units[0]?.days.length ?? 0;
  const days = [];
  for (let i = 0; i < nbDays; i++) {
    const perUnit = data.units.map((u) => u.days[i]);
    const date = perUnit[0].date;
    const free = perUnit.filter((d) => d.available && d.priceCents != null);
    // `checkinDays` a trois états côté serveur : null = aucune contrainte,
    // liste = ces jours-là, liste VIDE = aucune arrivée possible. L'agrégat est
    // une UNION : il suffit qu'un hébergement libre accepte le jour.
    const restricted = free.filter((d) => d.checkinDays != null);
    days.push({
      date,
      past: perUnit[0].past,
      available: free.length > 0,
      minPrice: free.length ? Math.min(...free.map((d) => d.priceCents)) : null,
      minNights: free.length ? Math.min(...free.map((d) => d.minNights || 1)) : null,
      // null = au moins un hébergement libre n'impose aucun jour d'arrivée
      arrivalDays: free.length && restricted.length === free.length
        ? [...new Set(restricted.flatMap((d) => d.checkinDays))].sort((a, b) => a - b)
        : null,
    });
  }

  const firstDow = (new Date(monthStart + "T12:00:00Z").getUTCDay() + 6) % 7;
  let html = ["L", "M", "M", "J", "V", "S", "D"].map((l) => `<div class="h">${l}</div>`).join("");
  for (let i = 0; i < firstDow; i++) html += `<div class="pday off"></div>`;
  for (const d of days) {
    const inRange = selIn && selOut && d.date > selIn && d.date < selOut;
    const isSel = d.date === selIn || d.date === selOut;
    const noArrival = !d.past && d.available && d.arrivalDays != null && !d.arrivalDays.includes(dow(d.date));
    const cls = ["pday", d.past ? "past" : "", !d.past && !d.available ? "full" : "",
      noArrival ? "noarr" : "", isSel ? "sel" : "", inRange ? "range" : ""].join(" ");
    const sub = d.past ? "" : d.available ? (d.minPrice != null ? `dès ${eurRound(d.minPrice)}` : "") : "complet";
    // Le minimum de nuits est écrit DANS la case : c'est la seule façon de le
    // voir avant d'avoir choisi ses dates (impasse n° 5 du parcours au clic).
    const mn = !d.past && d.available && d.minNights > 1 ? `<span class="mn">min ${d.minNights} n</span>` : "";
    const hints = d.past || !d.available ? [] : [
      d.minNights > 1 ? `${d.minNights} nuits minimum` : "",
      d.arrivalDays != null ? arrivalLabel(d.arrivalDays) : "",
    ].filter(Boolean);
    const title = hints.length ? ` title="${esc(hints.join(" · "))}"` : "";
    html += `<button type="button" class="${cls}" data-date="${d.date}"${title} ${d.past ? "disabled" : ""}>
      <span class="d">${Number(d.date.slice(8, 10))}</span><span class="p">${sub}</span>${mn}</button>`;
  }
  $("calGrid").innerHTML = html;
  $("calGrid").querySelectorAll(".pday[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => onDayClick(cell.dataset.date, cell));
  });
  renderCalRules(days);
}

/** Règles de séjour du mois affiché, regroupées par période contiguë (#66).
 *  « Séjour minimum : 7 nuits du 01/07 au 31/07 » — la règle existe depuis
 *  toujours côté moteur ; elle n'était écrite nulle part. */
function renderCalRules(days) {
  const zone = $("calRules");
  if (!zone) return;
  const segments = [];
  for (const d of days) {
    if (d.past || !d.available || d.minNights == null) continue;
    const key = `${d.minNights}|${(d.arrivalDays ?? []).join(",")}`;
    const last = segments.at(-1);
    if (last && last.key === key && nightsBetween(last.to, d.date) === 1) last.to = d.date;
    else segments.push({ key, minNights: d.minNights, arrivalDays: d.arrivalDays, from: d.date, to: d.date });
  }
  const notable = segments.filter((s) => s.minNights > 1 || s.arrivalDays != null);
  if (notable.length === 0) {
    zone.innerHTML = "";
    return;
  }
  const period = (s) => (s.from === s.to ? `le ${dfr(s.from)}` : `du ${dfr(s.from)} au ${dfr(s.to)}`);
  zone.innerHTML = notable
    .map((s) => {
      const parts = [];
      if (s.minNights > 1) parts.push(`<b>${s.minNights} nuits minimum</b>`);
      if (s.arrivalDays != null) parts.push(esc(arrivalLabel(s.arrivalDays)));
      return `<span class="rule">${parts.join(", ")} ${esc(period(s))}</span>`;
    })
    .join(" · ");
}

function onDayClick(date, cell) {
  if (cell.classList.contains("past")) return;
  const isFull = cell.classList.contains("full");
  if (!selIn || (selIn && selOut)) {
    if (isFull) return; // un jour complet ne peut pas être une arrivée
    selIn = date;
    selOut = null;
  } else if (date > selIn) {
    selOut = date; // le jour de départ peut être « complet » (rotation le jour même)
  } else {
    if (isFull) return;
    selIn = date;
    selOut = null;
  }
  renderCalendar();
  onSelectionChange();
}

function updateSummary() {
  const zone = $("staySummary");
  if (selIn && selOut) {
    const n = nightsBetween(selIn, selOut);
    zone.innerHTML = `<div class="stay-summary">Séjour du <b>${dfr(selIn)}</b> au <b>${dfr(selOut)}</b> — ${n} nuit${n > 1 ? "s" : ""}</div>`;
  } else if (selIn) {
    zone.innerHTML = `<div class="stay-summary">Arrivée le <b>${dfr(selIn)}</b> — choisissez le jour de départ.</div>`;
  } else {
    zone.innerHTML = "";
  }
}

// Recherche automatique dès que la sélection est complète (pas de bouton).
let searchTimer = null;

function onSelectionChange() {
  updateSummary();
  persistSelection();
  $("bookingPanel").innerHTML = "";
  SELECTED = null;
  QUOTE = null;
  setStep(1);
  clearTimeout(searchTimer);
  if (selIn && selOut) {
    searchTimer = setTimeout(search, 200);
  } else {
    $("results").innerHTML = "";
  }
}

// ---------------------------------------------------------------------------
// Étape 2 — hébergements disponibles
//
// Issue #66 — un séjour refusé DIT pourquoi et propose une sortie. La règle
// (minimum de nuits, jour d'arrivée imposé) vit dans le moteur de devis ; le
// serveur renvoie désormais la règle ET une ou deux plages réservables les
// plus proches, calculées sur les vraies disponibilités. Un « indisponible »
// sans explication n'est plus jamais la seule réponse.
// ---------------------------------------------------------------------------

let searchSeq = 0;

/** Énumération française : « A », « A et B », « A, B et C ». */
function frList(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/** Noms des unités LIÉES dont l'occupation rend celle-ci indisponible (#45). */
function blockerNames(u, units) {
  const byId = new Map(units.map((x) => [x.unitId, x.name]));
  return (u.blockedByUnitIds ?? []).map((id) => byId.get(id)).filter(Boolean);
}

/** Étiquette courte : pourquoi cet hébergement n'est pas réservable. */
function unavailableReason(u, nights, units = []) {
  if (u.available && !u.fitsCapacity) return `Capacité maximale : ${u.capacityMax} personnes`;
  const q = u.quote;
  if (q && !q.ok && q.errors.includes("min_nights")) {
    return `Séjour trop court : ${q.minNights} nuits minimum à ces dates (vous en avez demandé ${nights})`;
  }
  if (q && !q.ok && q.errors.includes("checkin_day")) {
    const jours = checkinDaysLabel(q.checkinDays);
    return jours
      ? `Arrivée possible uniquement ${jours} à ces dates`
      : "Aucun jour d'arrivée n'est autorisé à ces dates";
  }
  if (q && !q.ok && q.errors.includes("no_rate")) return "Tarifs pas encore publiés pour ces dates";
  if (q && !q.ok) return "Non réservable en ligne sur ces dates";
  // Issue #45 — la liaison A/B/Domaine, dite en clair. Le Domaine entier tombe
  // dès qu'UNE des deux maisons est prise : la carte se grisait sans un mot.
  // L'accord est volontairement porté par « ces nuits » (féminin pluriel,
  // invariable) : les noms d'hébergements viennent du back-office et leur genre
  // est inconnu du code.
  const blockers = blockerNames(u, units);
  if (blockers.length) return `Ces nuits sont déjà prises sur ${frList(blockers)}`;
  return "Déjà réservé sur ces dates";
}

/** Issue #45 — la sortie : ce qui reste réservable quand une unité liée tombe.
 *  L'information est déjà dans la réponse de recherche, il ne manquait que la
 *  phrase. Vide si le blocage n'est pas dû à une liaison, ou si plus rien
 *  n'est réservable (les suggestions de dates prennent alors le relais). */
function unavailableDetail(u, units, bookable) {
  if (!blockerNames(u, units).length) return "";
  const libres = bookable.filter((b) => b.unitId !== u.unitId).map((b) => b.name);
  if (!libres.length) return "";
  return `${frList(libres)} ${libres.length > 1 ? "restent libres" : "reste libre"} sur ces dates.`;
}

/** Plages réservables les plus proches, en un clic. */
function suggestionsBlock(u) {
  if (!u.suggestions?.length) return "";
  const buttons = u.suggestions
    .map(
      (s) => `<button type="button" class="btn o sugg-b" data-in="${s.checkin}" data-out="${s.checkout}">
        Du ${dfr(s.checkin)} au ${dfr(s.checkout)} — ${s.nights} nuit${s.nights > 1 ? "s" : ""} · ${eur(s.totalCents)}</button>`,
    )
    .join("");
  return `<div class="sugg"><span class="small muted">Ces dates fonctionnent :</span>${buttons}</div>`;
}

/** Applique une suggestion : dates pré-remplies, recherche relancée. */
function applySuggestion(checkin, checkout) {
  if (!ISO_DATE.test(checkin ?? "") || !ISO_DATE.test(checkout ?? "") || checkout <= checkin) return;
  selIn = checkin;
  selOut = checkout;
  calMonth = checkin.slice(0, 7);
  renderCalendar();
  onSelectionChange();
  $("searchCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function search() {
  const { adults, children } = pax();
  $("searchMsg").innerHTML = "";
  $("bookingPanel").innerHTML = "";
  SELECTED = null;
  const seq = ++searchSeq;
  $("results").innerHTML = `<div class="card muted">Recherche…</div>`;
  let data;
  try {
    data = await api(
      `/api/public/availability?property=${encodeURIComponent(PROPERTY)}&checkin=${selIn}&checkout=${selOut}&adults=${adults}&children=${children}`,
    );
  } catch (e) {
    if (seq !== searchSeq) return;
    $("results").innerHTML = "";
    $("searchMsg").innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    return;
  }
  if (seq !== searchSeq) return; // une sélection plus récente a relancé la recherche
  SEARCH = { checkin: selIn, checkout: selOut, adults, children };
  setStep(2);
  if (data.ownHold && data.ownHold.checkin === selIn && data.ownHold.checkout === selOut) {
    $("searchMsg").innerHTML =
      `<div class="note">Nous avons retrouvé votre réservation en cours (réf. ${esc(data.ownHold.reference)}) : ces dates vous restent réservées, vous reprenez là où vous en étiez.</div>`;
  }

  const nights = nightsBetween(selIn, selOut);
  const bookable = data.units.filter((u) => u.available && u.fitsCapacity && u.quote?.ok);
  const cards = data.units.map((u) => {
    const capacity = `${u.capacityBase}${u.capacityMax > u.capacityBase ? "-" + u.capacityMax : ""} p.`;
    const photo = u.photoUrl ? `style="background-image:url('${esc(u.photoUrl)}')"` : "";
    if (u.available && u.fitsCapacity && u.quote?.ok) {
      return `<div class="prop" data-unit="${u.unitId}">
        <div class="ph" ${photo}>${u.photoUrl ? "" : "photo"}</div>
        <div class="info"><b>${esc(u.name)}</b> · ${capacity}<br>
          <span class="muted small">${esc(u.description ?? "")}</span></div>
        <div class="price">${strikeThrough(u.quote.totalCents, u.quote.discountCents)}<b>${eur(u.quote.totalCents)}</b><br>
          <span class="per">${nights} nuit${nights > 1 ? "s" : ""}, ménage et taxes compris</span>
          ${u.quote.autoDiscountApplied ? `<br><span class="savings">${esc(u.quote.autoDiscountApplied)} déduite</span>` : ""}<br>
          <button class="btn" style="margin-top:6px" data-select="${u.unitId}" aria-pressed="false">Réserver</button></div>
      </div>`;
    }
    const detail = unavailableDetail(u, data.units, bookable);
    return `<div class="prop off" data-unit="${u.unitId}">
      <div class="ph" ${photo}>${u.photoUrl ? "" : "photo"}</div>
      <div class="info"><b>${esc(u.name)}</b> · ${capacity}<br><span class="tag t-bad">${esc(unavailableReason(u, nights, data.units))}</span>
        ${detail ? `<br><span class="small why">${esc(detail)}</span>` : ""}
        ${suggestionsBlock(u)}</div>
    </div>`;
  });
  $("results").innerHTML = cards.join("") || `<div class="note">Aucun hébergement.</div>`;
  document.querySelectorAll("[data-select]").forEach((b) => b.addEventListener("click", () => openBookingPanel(Number(b.dataset.select))));
  document.querySelectorAll(".sugg-b").forEach((b) =>
    b.addEventListener("click", () => applySuggestion(b.dataset.in, b.dataset.out)),
  );
  if (bookable.length === 0 && data.units.some((u) => u.suggestions?.length)) {
    $("searchMsg").innerHTML =
      `<div class="note">Aucun hébergement n'est réservable du ${dfr(selIn)} au ${dfr(selOut)} — les dates proposées ci-dessous fonctionnent, en un clic.</div>`;
  }

  // Auto-sélection : l'unité demandée en deep-link, sinon la seule réservable.
  const wanted = preferredUnit ? bookable.find((u) => u.slug === preferredUnit) : null;
  preferredUnit = null; // ne s'applique qu'à la première recherche
  const auto = wanted ?? (bookable.length === 1 ? bookable[0] : null);
  if (auto) {
    openBookingPanel(auto.unitId);
    return;
  }
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Étape 3 — coordonnées (4 champs) + récap sticky, devis auto
// ---------------------------------------------------------------------------

let quoteSeq = 0;

/** Issue #46 — la carte choisie se voit. Les autres restent cliquables : c'est
 *  un groupe de boutons bascule (`aria-pressed`), pas une liste figée. Le
 *  libellé du bouton suit l'état, pour que l'information ne repose ni sur la
 *  seule couleur ni sur la seule bordure. */
function markSelected(unitId) {
  document.querySelectorAll("#results .prop").forEach((el) => {
    const on = Number(el.dataset.unit) === unitId;
    el.classList.toggle("sel", on);
    const b = el.querySelector("[data-select]");
    if (!b) return;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? "Votre choix" : "Réserver";
  });
}

async function openBookingPanel(unitId) {
  markSelected(unitId);
  SELECTED = PROP.units.find((u) => u.id === unitId);
  QUOTE = null;
  setStep(3);
  // Équipements réservables : bouton « Ajouter » (pas de case à cocher) —
  // mise à disposition d'équipement, pas un service (linge et ménage sont
  // inclus de base dans les frais généraux, jamais en option).
  const optionRows = PROP.options
    .map((o) => {
      const priceLabel = `${eur(o.priceCents)}${o.unitLabel ? " / " + esc(o.unitLabel) : ""}`;
      const input =
        o.pricingMode === "per_unit_qty"
          ? `<input type="number" min="0" max="${o.maxQty ?? 99}" value="0" class="opt" data-oid="${o.id}">`
          : `<button type="button" class="opt-add" data-oid="${o.id}" aria-pressed="false">+ Ajouter</button>`;
      return `<div class="opt-row"><span class="name">${esc(o.name)} <span class="muted small">${priceLabel}</span></span>${input}</div>`;
    })
    .join("");

  // Pourcentage d'arrhes de l'hébergement réservé (issue #75). L'API a déjà
  // résolu le repli sur le domaine — le `??` n'est qu'un filet si un client
  // arrive avec une réponse mise en cache par un ancien déploiement.
  const depositPct = SELECTED.depositPct ?? PROP.settings.depositPct;

  const payChoices = [];
  if (PROP.settings.allowDeposit)
    payChoices.push(`<label><input type="radio" name="payMode" value="deposit" checked> <b>Arrhes de ${depositPct} %</b> maintenant — solde ${PROP.settings.balanceDueDays} jours avant l'arrivée</label>`);
  if (PROP.settings.allowFullPayment)
    payChoices.push(`<label><input type="radio" name="payMode" value="full" ${!PROP.settings.allowDeposit ? "checked" : ""}> <b>Totalité</b> maintenant</label>`);

  $("bookingPanel").innerHTML = `
    <div class="panel-grid">
      <div class="panel-main">
        ${PROP.options.length ? `<div class="card"><h3>Équipements du séjour</h3>${optionRows}</div>` : ""}
        <div class="card" id="guestCard">
          <h3 id="step3Title" tabindex="-1">Vos coordonnées</h3>
          <div class="formgrid">
            <div><label class="f" for="gFirst">Prénom</label><input id="gFirst" autocomplete="given-name"></div>
            <div><label class="f" for="gLast">Nom *</label><input id="gLast" autocomplete="family-name"></div>
            <div><label class="f" for="gEmail">Email *</label><input id="gEmail" type="email" autocomplete="email" placeholder="pour recevoir votre confirmation"></div>
            <div><label class="f" for="gPhone">Téléphone *</label><input id="gPhone" type="tel" autocomplete="tel" placeholder="pour l'accueil sur place"></div>
          </div>
          <details class="fold"><summary>Un message pour nous ? Un code promo ?</summary>
            <div class="row" style="margin-top:10px">
              <div class="n" style="width:180px"><label class="f" for="bPromo">Code promo</label><input id="bPromo" placeholder="facultatif"></div>
              <div><label class="f" for="gNotes">Message</label><input id="gNotes" placeholder="heure d'arrivée, question…"></div>
            </div>
          </details>
          <div class="paybox">
            <h4>💳 Paiement sécurisé <span class="badge-secure">Stripe</span></h4>
            ${payChoices.join("")}
            <div class="cards">Bancontact · Visa · Mastercard — aucun montant n'est débité sans confirmation.</div>
          </div>
          <div class="agree"><label class="small"><input type="checkbox" id="gCgv"> J'accepte les <a href="#" id="cgvLink">conditions générales et le contrat de location</a> *</label>
          <div id="cgvBox" class="cgv-box" style="display:none"></div>
          <label class="small optin"><input type="checkbox" id="gOptin"> Tenez-moi au courant des disponibilités et offres par email <span class="muted">(facultatif, désinscription à tout moment)</span></label></div>
          <div id="bookMsg" role="alert" aria-live="assertive"></div>
          <button class="btn big" id="bPay" style="margin-top:14px" disabled>Payer et réserver</button>
          <p class="reassure">Votre créneau est bloqué <b id="holdMin">30</b> minutes le temps du paiement.
          Réservation ferme dès paiement — pas de droit de rétractation pour les hébergements datés (art. VI.53, 12° CDE) ;
          conditions d'annulation dans les CGV.</p>
        </div>
      </div>
      <aside class="panel-side">
        <div class="card sum">
          <b class="sum-unit">${esc(SELECTED.name)}</b>
          <p class="small muted sum-stay">Du ${dfr(SEARCH.checkin)} au ${dfr(SEARCH.checkout)} · ${SEARCH.adults} adulte${SEARCH.adults > 1 ? "s" : ""}${SEARCH.children ? ` + ${SEARCH.children} enfant${SEARCH.children > 1 ? "s" : ""}` : ""}<br>
          Arrivée dès ${esc(PROP.settings.checkinTime)} · départ avant ${esc(PROP.settings.checkoutTime)} · <a href="#" id="editDates">modifier</a></p>
          <div id="quoteZone" class="small muted" aria-live="polite" aria-atomic="true">Calcul du devis…</div>
        </div>
      </aside>
    </div>`;

  $("holdMin").textContent = String(PROP.settings.holdMinutes ?? 30);
  document.querySelectorAll(".opt").forEach((el) => el.addEventListener("change", refreshQuote));
  document.querySelectorAll(".opt-add").forEach((btn) =>
    btn.addEventListener("click", () => {
      const on = btn.classList.toggle("on");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? "✓ Ajouté" : "+ Ajouter";
      refreshQuote();
    }),
  );
  let promoTimer = null;
  $("bPromo").addEventListener("input", () => {
    clearTimeout(promoTimer);
    promoTimer = setTimeout(refreshQuote, 450);
  });
  $("editDates").addEventListener("click", (e) => {
    e.preventDefault();
    $("searchCard").scrollIntoView({ behavior: "smooth" });
  });
  $("cgvLink").addEventListener("click", (e) => {
    e.preventDefault();
    const box = $("cgvBox");
    box.style.display = box.style.display === "none" ? "block" : "none";
    if (!box.innerHTML) {
      box.innerHTML = PROP.cgvText?.trim()
        ? cgvHtml(PROP.cgvText) +
          // L'article 4.1 renvoie au « pourcentage affiché lors de la
          // réservation » : on le lui donne, pour cet hébergement-ci.
          `<p class="cgv-h"><b>Pour ${esc(SELECTED.name)}, le pourcentage d'arrhes de l'article 4.1 est de ${depositPct} %.</b></p>`
        : `<p>Les conditions générales et le contrat de location complets sont joints à la confirmation de réservation et consultables à tout moment sur votre voucher en ligne.</p>`;
    }
  });
  $("gCgv").addEventListener("change", payButtonRefresh);
  $("bPay").addEventListener("click", submitBooking);
  $("mbPay").onclick = submitBooking;
  // Le passage à l'étape 3 est le plus souvent AUTOMATIQUE (auto-sélection du
  // seul hébergement réservable) : sans déplacement du focus, rien n'indique à
  // un utilisateur de lecteur d'écran qu'il est arrivé sur le formulaire.
  $("step3Title").focus({ preventScroll: true });
  $("bookingPanel").scrollIntoView({ behavior: "smooth" });
  await refreshQuote();
}

function collectOptions() {
  const numbers = [...document.querySelectorAll("input.opt")]
    .map((el) => ({ id: Number(el.dataset.oid), qty: Number(el.value) || 0 }));
  const toggles = [...document.querySelectorAll("button.opt-add.on")]
    .map((el) => ({ id: Number(el.dataset.oid), qty: 1 }));
  return [...numbers, ...toggles].filter((o) => o.qty > 0);
}

function payButtonRefresh() {
  if (!SELECTED) return;
  const ok = QUOTE?.ok === true;
  const accepted = $("gCgv")?.checked === true;
  $("bPay").disabled = !ok;
  $("mbPay").disabled = !ok || !accepted;
  if (!ok) return;
  const mode = document.querySelector('input[name="payMode"]:checked')?.value;
  const amount = mode === "full" || QUOTE.balanceDueDate == null ? QUOTE.totalCents : QUOTE.depositCents;
  const label = `Payer ${eur(amount)} et réserver`;
  $("bPay").textContent = label;
  $("mbAmount").textContent = eur(amount);
  $("mbLabel").textContent = mode === "full" || QUOTE.balanceDueDate == null ? "Totalité" : "Arrhes";
  $("mobileBar").style.display = "flex";
}

async function refreshQuote() {
  if (!SELECTED) return;
  const seq = ++quoteSeq;
  const zone = $("quoteZone");
  try {
    const { quote } = await api("/api/public/quote", {
      unitId: SELECTED.id,
      ...SEARCH,
      options: collectOptions(),
      promoCode: $("bPromo").value.trim() || null,
    });
    if (seq !== quoteSeq) return; // une saisie plus récente a relancé un devis
    QUOTE = quote;
    if (!quote.ok) {
      zone.innerHTML = `<div class="note bad">${quote.errors.includes("min_nights") ? `Minimum ${quote.minNights} nuits sur ces dates.` : "Séjour impossible à ces conditions."}</div>`;
      payButtonRefresh();
      return;
    }
    const rows = quote.lines
      .map((l) => `<tr><td>${esc(l.label)}</td><td class="r ${l.amountCents < 0 ? "neg" : ""}">${eur(l.amountCents)}</td></tr>`)
      .join("");
    const depositLine =
      quote.balanceDueDate != null
        ? `Arrhes de <b>${eur(quote.depositCents)}</b> à la réservation, solde de ${eur(quote.balanceCents)} pour le ${dfr(quote.balanceDueDate)}`
        : `Paiement de la totalité à la réservation`;
    zone.innerHTML = `
      <table class="quote">${rows}<tr class="tot"><td>Total</td>
        <td class="r">${strikeThrough(quote.totalCents, quote.discountCents)}${eur(quote.totalCents)}</td></tr></table>
      <p class="small muted" style="margin-top:8px">${depositLine}${quote.cautionCents > 0 ? ` · Caution : ${eur(quote.cautionCents)} (hors total, demandée avant l'arrivée)` : ""}</p>
      ${quote.warnings.includes("promo_invalid") ? `<div class="note bad">Code promo invalide ou expiré — devis calculé sans le code.</div>` : ""}`;
    payButtonRefresh();
    document.querySelectorAll('input[name="payMode"]').forEach((r) => r.addEventListener("change", payButtonRefresh));
  } catch (e) {
    if (seq !== quoteSeq) return;
    zone.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    QUOTE = null;
    payButtonRefresh();
  }
}

async function submitBooking() {
  const msg = $("bookMsg");
  msg.innerHTML = "";
  if (!$("gCgv").checked) {
    msg.innerHTML = `<div class="note bad">Merci d'accepter les conditions générales.</div>`;
    $("guestCard").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const lastName = $("gLast").value.trim();
  const email = $("gEmail").value.trim();
  const phone = $("gPhone").value.trim();
  if (lastName.length < 2 || !email || !phone) {
    msg.innerHTML = `<div class="note bad">Nom, email et téléphone sont nécessaires — la confirmation part par email et nous vous accueillons par téléphone.</div>`;
    $("guestCard").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  setStep(4);
  $("bPay").disabled = true;
  $("mbPay").disabled = true;
  $("bPay").textContent = "Blocage du créneau…";
  try {
    const res = await api("/api/public/bookings", {
      unitId: SELECTED.id,
      ...SEARCH,
      options: collectOptions(),
      promoCode: $("bPromo").value.trim() || null,
      paymentMode: document.querySelector('input[name="payMode"]:checked')?.value || "deposit",
      guest: {
        firstName: $("gFirst").value,
        lastName,
        email,
        phone,
      },
      notes: $("gNotes").value,
      cgvAccepted: true,
      marketingOptIn: $("gOptin").checked,
    });
    try { localStorage.removeItem(storeKey()); } catch { /* au pire la reprise re-proposera les dates */ }
    // Le créneau est bloqué à partir de maintenant : le décompte démarre ici et
    // reste visible si le visiteur revient sur le tunnel (issue #16).
    rememberHold(res);
    $("bPay").textContent = "Redirection vers le paiement sécurisé…";
    location.href = res.checkoutUrl;
  } catch (e) {
    setStep(3);
    $("bPay").disabled = false;
    payButtonRefresh();
    if (String(e.message).includes("réservé")) {
      msg.innerHTML = `<div class="note bad">😔 ${esc(e.message)} — le calendrier vient d'être mis à jour, relancez une recherche.</div>`;
      calCache.clear();
    } else {
      msg.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
    }
    msg.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ---------------------------------------------------------------------------
// Décompte du blocage de créneau
//
// Le texte était statique (« bloqué 30 minutes ») : un visiteur qui prend le
// temps de lire les conditions ne découvrait l'expiration que par un échec de
// paiement. Le décompte est calé sur l'HEURE SERVEUR (l'horloge du poste peut
// dériver de plusieurs minutes) et décompté en local, comme la page de
// simulation dev-pay.html. Il survit au retour depuis la page de paiement.
// ---------------------------------------------------------------------------

const holdKey = () => `gites-hold:${PROPERTY}`;
const sqlToMs = (s) => Date.parse(String(s).replace(" ", "T") + "Z");
let holdTimer = null;

function clearHold() {
  try { sessionStorage.removeItem(holdKey()); } catch { /* navigation privée */ }
}

/** Mémorise l'option posée par l'API et lance le décompte. */
function rememberHold(res) {
  if (!res?.holdExpiresAt || !res?.now) return;
  const hold = {
    reference: res.reference,
    checkoutUrl: res.checkoutUrl,
    // converti tout de suite en horloge locale via l'écart au temps serveur
    expiresAtLocal: Date.now() + Math.max(0, sqlToMs(res.holdExpiresAt) - sqlToMs(res.now)),
  };
  try { sessionStorage.setItem(holdKey(), JSON.stringify(hold)); } catch { /* navigation privée */ }
  startHoldCountdown(hold);
}

function startHoldCountdown(hold) {
  const bar = $("holdBanner");
  if (!bar || !hold?.expiresAtLocal) return;
  clearTimeout(holdTimer);
  bar.hidden = false;
  // Le chiffre qui défile est masqué aux lecteurs d'écran (il serait relu
  // chaque seconde) ; seuls les seuils utiles sont annoncés, dans la zone
  // vocale de la même région aria-live.
  bar.innerHTML = `<span id="holdCount" aria-hidden="true"></span><span id="holdSay" class="sr-only"></span>`;
  const count = $("holdCount");
  const say = $("holdSay");
  let lastSaid = null;

  const announce = (minutes) => {
    const step = minutes <= 0 ? "fin" : minutes <= 1 ? "1" : minutes <= 5 ? "5" : "debut";
    if (step === lastSaid) return;
    lastSaid = step;
    say.textContent =
      step === "fin"
        ? "Le blocage de votre créneau a expiré."
        : step === "1"
          ? "Attention, il reste moins d'une minute avant l'expiration du blocage de votre créneau."
          : step === "5"
            ? "Il reste moins de cinq minutes avant l'expiration du blocage de votre créneau."
            : `Votre créneau est bloqué pour vous pendant ${minutes} minutes, le temps du paiement.`;
  };

  const tick = () => {
    const left = hold.expiresAtLocal - Date.now();
    if (left <= 0) {
      bar.classList.add("expired");
      count.innerHTML = "⏳ Le blocage de votre créneau a <b>expiré</b> — ces dates sont de nouveau ouvertes à la vente. Relancez une réservation depuis le calendrier.";
      announce(0);
      clearHold();
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    const resume = hold.checkoutUrl ? ` · <a href="${esc(hold.checkoutUrl)}">reprendre le paiement</a>` : "";
    bar.classList.remove("expired");
    count.innerHTML =
      `⏳ Créneau bloqué pour vous encore <b>${m} min ${String(s).padStart(2, "0")} s</b>` +
      `${hold.reference ? ` · réservation ${esc(hold.reference)}` : ""}${resume}`;
    announce(m + 1);
    holdTimer = setTimeout(tick, 1000);
  };
  tick();
}

/** Reprise d'une réservation encore en cours, reconnue par le serveur (#68).
 *
 *  Le sessionStorage ne survit ni à la fermeture de l'onglet ni à un retour par
 *  l'accueil dans une autre fenêtre. Le serveur, lui, reconnaît le visiteur à
 *  son cookie signé et lui rend SES dates : elles ne lui sont plus affichées
 *  comme indisponibles, et le tunnel rouvre l'étape où il s'était arrêté. */
async function restoreOwnHold() {
  let data;
  try {
    data = await api(`/api/public/hold?property=${encodeURIComponent(PROPERTY)}`);
  } catch {
    return false; // la reprise est un plus : son échec ne bloque pas le tunnel
  }
  const hold = data.hold;
  if (!hold) return false;
  RESUMED_HOLD = hold;
  selIn = hold.checkin;
  selOut = hold.checkout;
  setPax(hold.adults, hold.children);
  calMonth = selIn.slice(0, 7);
  if (hold.unitSlug) preferredUnit = hold.unitSlug; // rouvre le bon hébergement
  rememberHold({ reference: hold.reference, holdExpiresAt: hold.holdExpiresAt, now: hold.now });
  return true;
}

/** Reprise après retour depuis la page de paiement (bouton « précédent »). */
function restoreHold() {
  try {
    const hold = JSON.parse(sessionStorage.getItem(holdKey()) ?? "null");
    if (!hold) return;
    if (hold.expiresAtLocal > Date.now()) startHoldCountdown(hold);
    else clearHold();
  } catch { /* stockage indisponible */ }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function fillPaxSelects() {
  $("qAd").innerHTML = Array.from({ length: 30 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  $("qCh").innerHTML = Array.from({ length: 16 }, (_, i) => `<option value="${i}">${i}</option>`).join("");
  $("qAd").value = "2";
  $("qCh").value = "0";
}

async function initFlow() {
  $("flow").style.display = "block";
  fillPaxSelects();
  try {
    PROP = await api(`/api/public/properties/${encodeURIComponent(PROPERTY)}`);
  } catch {
    $("flow").innerHTML = `<div class="note bad">Domaine introuvable. <a href="/book/">Retour à l'accueil</a></div>`;
    return;
  }
  document.title = `Réserver — ${PROP.property.name}`;
  $("propName").textContent = PROP.property.name;
  $("propSub").textContent = `Réservation directe — paiement sécurisé, sans création de compte`;
  $("contactLine").textContent = [PROP.property.contactEmail, PROP.property.contactPhone].filter(Boolean).join(" · ");

  const t = await api("/api/public/today");
  TODAY = t.today;
  calMonth = TODAY.slice(0, 7);
  if (t.demo) {
    const banner = document.createElement("div");
    banner.className = "note";
    banner.style.textAlign = "center";
    banner.textContent = "⚠️ Version de démonstration — tarifs provisoires, paiement simulé (aucun débit réel).";
    $("flow").prepend(banner);
  }
  $("calPrev").addEventListener("click", () => { calMonth = monthShift(calMonth, -1); renderCalendar(); });
  $("calNext").addEventListener("click", () => { calMonth = monthShift(calMonth, 1); renderCalendar(); });
  $("qAd").addEventListener("change", onSelectionChange);
  $("qCh").addEventListener("change", onSelectionChange);

  // question avant réservation → boîte Messages de la plateforme
  $("cSend").addEventListener("click", async () => {
    const note = $("cNote");
    note.textContent = "";
    try {
      await api("/api/public/contact", {
        property: PROPERTY,
        name: $("cName").value,
        email: $("cEmail").value,
        message: $("cMsg").value,
        website: $("cWebsite").value, // pot de miel
      });
      $("cMsg").value = "";
      note.textContent = "✅ Question envoyée — nous vous répondons par email au plus vite.";
    } catch (e) {
      note.textContent = e.message;
    }
  });

  renderOffers(); // remises actives + disponibilité factuelle (sans bloquer)
  // Une réservation encore en cours prime sur tout le reste : c'est elle qui
  // porte les dates réellement bloquées pour ce visiteur (#68).
  if (!(await restoreOwnHold())) {
    restoreHold(); // une option posée juste avant ? on reprend son décompte
    restoreSelection();
  }
  if (selIn && selOut) {
    calMonth = selIn.slice(0, 7);
    updateSummary();
    persistSelection();
    search();
  }
  await renderCalendar();
}

if (!PROPERTY) {
  renderLanding();
} else {
  initFlow();
}
