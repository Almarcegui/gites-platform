// Back-office — CALENDRIER UNIFIÉ (issues #24 #25, finit #31 #50).
//
// « Planning » et « Tarifs & saisons » ne sont plus deux écrans : c'est le
// même objet — une grille de jours — regardé sous trois couches.
//   · Occupation : qui dort où ce mois-ci (ex-Planning)
//   · Prix       : le prix et le minimum de nuits de chaque jour, éditables
//                  sur la cellule ou sur une plage
//   · Année      : 12 mois d'un coup d'œil, pour repérer les trous
//
// Le clic sur un jour a changé de sens (spec UX § 1) : il ouvre la saisie du
// jour, plus la création d'une période. Les périodes se créent depuis leur
// propre carte, en bas de la couche Prix.

import {
  addDaysIso, api, currentPropertyId, dfr, diffDaysIso, esc, eur, eurInput, focusableIn,
  openModal, registerView, renderOccupation, setPageTitle, state, toCents,
  toast, toastUndo, todayIso,
} from "./app.js";

/** Fin de glisser-déposer hors de la grille : un seul écouteur pour toute la
 *  session, remplacé à chaque rendu (sinon ils s'empilent à chaque mois). */
let dragRelease = null;

const LAYER_TITLES = {
  occupation: "Calendrier — Occupation",
  prix: "Calendrier — Prix",
  annee: "Calendrier — Année",
};

/** Jour demandé depuis la vue Année : la couche Prix l'ouvre à l'arrivée. */
let pendingEdit = null;

const DOW_SHORT = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
const DOW_INITIALS = ["L", "M", "M", "J", "V", "S", "D"]; // grille lundi → dimanche
const MONTHS_SHORT = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];

const dowOf = (iso) => new Date(iso + "T12:00:00Z").getUTCDay(); // 0 = dimanche, comme l'API
const dfrLong = (iso) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("fr-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const monthLabel = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("fr-BE", { month: "long", year: "numeric" });
const daysInMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const euroShort = (cents) => Math.round(cents / 100) + " €";

export function registerCalendarView() {
  registerView("cal", "Calendrier", async (root, sub) => {
    const layer = sub === "prix" || sub === "annee" ? sub : "occupation";
    setPageTitle(LAYER_TITLES[layer]);
    if (!state.calMonth) state.calMonth = todayIso().slice(0, 7);
    if (!state.calYear) state.calYear = Number(todayIso().slice(0, 4));

    root.innerHTML = `
      <div class="cal-bar"><div class="cal-period" id="calPeriod"></div></div>
      <div id="calBody"><div class="card muted">Chargement…</div></div>`;
    renderPeriodNav(root, layer);

    const body = root.querySelector("#calBody");
    if (layer === "occupation") await renderOccupation(body, state.calMonth + "-01");
    else if (layer === "prix") await renderPrix(body, root);
    else await renderYear(body);
  });
}

/** Bandeau de période, commun aux trois couches : les mois ne se promènent
 *  plus chacun de leur côté (state.planMonth vs state.tarifMonth). */
function renderPeriodNav(root, layer) {
  const holder = root.querySelector("#calPeriod");
  const reload = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
  if (layer === "annee") {
    holder.innerHTML = `
      <button class="btn o sm" id="calPrev" aria-label="Année précédente">◀</button>
      <b>${state.calYear}</b>
      <button class="btn o sm" id="calNext" aria-label="Année suivante">▶</button>
      <button class="btn o sm" id="calNow">année en cours</button>`;
    holder.querySelector("#calPrev").onclick = () => { state.calYear -= 1; reload(); };
    holder.querySelector("#calNext").onclick = () => { state.calYear += 1; reload(); };
    holder.querySelector("#calNow").onclick = () => { state.calYear = Number(todayIso().slice(0, 4)); reload(); };
    return;
  }
  const monthStart = state.calMonth + "-01";
  holder.innerHTML = `
    <button class="btn o sm" id="calPrev" aria-label="Mois précédent">◀</button>
    <b>${esc(monthLabel(monthStart))}</b>
    <button class="btn o sm" id="calNext" aria-label="Mois suivant">▶</button>
    <button class="btn o sm" id="calNow">aujourd'hui</button>`;
  holder.querySelector("#calPrev").onclick = () => { state.calMonth = addDaysIso(monthStart, -1).slice(0, 7); reload(); };
  holder.querySelector("#calNext").onclick = () => {
    state.calMonth = addDaysIso(monthStart, daysInMonth(state.calMonth)).slice(0, 7);
    reload();
  };
  holder.querySelector("#calNow").onclick = () => { state.calMonth = todayIso().slice(0, 7); reload(); };
}

function announce(text) {
  const live = document.getElementById("calLive");
  if (live) live.textContent = text;
}

// ---------------------------------------------------------------------------
// COUCHE PRIX — édition sur la cellule et sur la plage
// ---------------------------------------------------------------------------

async function renderPrix(body, root) {
  const pid = currentPropertyId();
  const monthStart = state.calMonth + "-01";
  const nbDays = daysInMonth(state.calMonth);
  const nextMonth = addDaysIso(monthStart, nbDays);
  const today = todayIso();

  const [{ units }, { seasons }, { rules }] = await Promise.all([
    api(`/api/admin/units?property=${pid}`),
    api(`/api/admin/seasons?property=${pid}`),
    api(`/api/admin/rate-rules?property=${pid}`),
  ]);
  const sellable = units.filter((u) => u.active);
  if (!state.tarifUnit || !sellable.some((u) => u.id === state.tarifUnit)) state.tarifUnit = sellable[0]?.id ?? null;
  if (!state.tarifUnit) {
    body.innerHTML = `<div class="note">Aucun bien actif sur ce domaine.</div>`;
    return;
  }
  const unit = sellable.find((u) => u.id === state.tarifUnit);

  const [cal, planning, markups] = await Promise.all([
    api(`/api/admin/rate-calendar?unit=${unit.id}&from=${monthStart}&to=${nextMonth}`),
    api(`/api/admin/planning?property=${pid}&from=${monthStart}&to=${nextMonth}`),
    api("/api/admin/channel-markups").catch(() => ({ channels: [], formula: "" })),
  ]);
  const editable = cal.unit.editable !== false;
  const sold = soldNights(planning, unit.id);

  const PALETTE = ["#EAF3EC", "#FBF0DE", "#EFE7FA", "#E7F0FA", "#FBE9E7", "#F2EFD9"];
  const seasonColor = (id) => (id == null ? "#fff" : PALETTE[Math.max(0, seasons.findIndex((s) => s.id === id)) % PALETTE.length]);

  // --- cellules (grille lundi → dimanche, semaines en lignes ARIA)
  const firstDow = (new Date(monthStart + "T12:00:00Z").getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="rc-day off" aria-hidden="true"></div>`);
  for (const d of cal.days) {
    const past = d.date < today;
    // Provenance : couleur ET mot. Sur téléphone la cellule fait 44 px de
    // large, d'où une version courte du libellé — jamais sa disparition.
    const src =
      d.priceCents == null ? { cls: "no", label: "pas de tarif", short: "aucun" }
      : d.source === "override" ? { cls: "ov", label: "fixé à la main", short: "fixé" }
      : d.source === "saison" ? { cls: "sa", label: d.seasonName || "saison", short: "saison" }
      : { cls: "ba", label: "tarif de base", short: "base" };
    const title = [
      dfrLong(d.date),
      d.priceCents == null ? "aucun tarif ne couvre ce jour" : `${eur(d.priceCents)} · ${src.label}`,
      d.minNights ? `min ${d.minNights} nuit${d.minNights > 1 ? "s" : ""} à l'arrivée` : "",
      sold.has(d.date) ? "nuit déjà vendue" : "",
      d.holidayRated ? "majoration fériés appliquée" : "",
    ].filter(Boolean).join(" · ");
    cells.push(`<div class="rc-day ${d.weekend ? "we" : ""} ${d.priceCents == null ? "norate" : ""} ${past ? "past" : ""} ${
      sold.has(d.date) ? "sold" : ""
    }" role="gridcell" tabindex="-1" aria-selected="false" ${past ? 'aria-disabled="true"' : ""}
      data-date="${d.date}" style="--seasonbg:${seasonColor(d.seasonId)}" title="${esc(title)}">
      <span class="d">${Number(d.date.slice(8, 10))}<span class="dw">${DOW_SHORT[dowOf(d.date)]}</span></span>
      ${d.holidayRated ? `<span class="hol" title="majoration fériés">férié</span>` : ""}
      <b>${d.priceCents == null ? "—" : euroShort(d.priceCents)}</b>
      <span class="mn">${d.minNights ? "min " + d.minNights + " n" : "&nbsp;"}</span>
      <span class="src ${src.cls}"><span class="lgl">${esc(src.label)}</span><span class="shrt">${esc(src.short)}</span></span>
    </div>`);
  }
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(`<div role="row" class="rc-row">${cells.slice(i, i + 7).join("")}</div>`);
  }

  const legend = [
    `<span><i class="lg ov"></i>fixé à la main (surcharge)</span>`,
    `<span><i class="lg sa"></i>prix de saison</span>`,
    `<span><i class="lg ba"></i>tarif de base</span>`,
    `<span><i class="lg no"></i>pas de tarif — invendable</span>`,
    `<span><i class="lg sold"></i>nuit déjà vendue</span>`,
    unit.cleaningFeeCents > 0 ? `<span class="right">+ ménage ${eur(unit.cleaningFeeCents)} / séjour</span>` : "",
  ].join("");

  body.innerHTML = `
    <div class="unit-tabs" role="tablist" aria-label="Hébergement">${sellable
      .map((u) => `<button role="tab" aria-selected="${u.id === unit.id}" data-unit="${u.id}" class="${u.id === unit.id ? "on" : ""}">${esc(u.name)}${u.isComposite ? " 🔗" : ""}</button>`)
      .join("")}</div>
    ${editable ? "" : `<div class="note" id="sumNote">Chargement de la règle…</div>`}
    <div class="card mb">
      <p class="small muted mb">${
        editable
          ? "Clique un jour pour changer son prix. Glisse (ou Maj+clic) pour une plage. Au clavier : flèches pour se déplacer, Entrée pour ouvrir, Maj+flèches pour étendre."
          : "Calendrier en lecture seule."
      }</p>
      <div class="rc-wrap">
        <div class="rc ${editable ? "" : "ro"}" role="grid" aria-label="Prix du mois de ${esc(monthLabel(monthStart))} — ${esc(unit.name)}">
          <div role="row" class="rc-row">${DOW_INITIALS.map((l, i) => `<div role="columnheader" class="rc-h">${l}<span class="sr">${DOW_SHORT[(i + 1) % 7]}</span></div>`).join("")}</div>
          ${rows.join("")}
        </div>
        <div id="rcPop"></div>
      </div>
      <div class="rc-legend">${legend}</div>
    </div>
    <div id="rcSuggest"></div>
    ${rulesCard(unit, seasons, rules, editable)}
    ${seasonsCard(seasons, PALETTE)}`;

  // --- onglets de biens
  body.querySelectorAll(".unit-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      state.tarifUnit = Number(b.dataset.unit);
      reload();
    }),
  );

  function reload() {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  // --- bien combiné en mode somme : on demande son refus au serveur plutôt
  //     que de le paraphraser (le PATCH sans valeur n'écrit rien, § 5).
  if (!editable) {
    explainReadOnly(unit).then((message) => {
      const note = body.querySelector("#sumNote");
      if (!note) return;
      note.innerHTML = `${esc(message)} <button class="btn o sm" id="goOwn" style="margin-left:8px">Basculer ce bien en tarif propre</button>`;
      note.querySelector("#goOwn").onclick = () => { location.hash = "#/params"; };
    });
  }

  // --- grille : sélection souris + clavier
  const grid = body.querySelector(".rc");
  const dayCells = [...body.querySelectorAll(".rc-day[data-date]")];
  let anchor = null; // début de plage
  let head = null; // fin de plage
  let dragging = false;
  let roving = dayCells.find((c) => c.dataset.date === today) || dayCells[0];
  if (roving) roving.tabIndex = 0;

  const paint = () => {
    const [a, b] = ordered();
    for (const c of dayCells) {
      const inSel = a && c.dataset.date >= a && c.dataset.date <= b;
      c.classList.toggle("sel", !!inSel);
      c.setAttribute("aria-selected", inSel ? "true" : "false");
    }
  };
  const ordered = () => (anchor == null ? [null, null] : anchor <= head ? [anchor, head] : [head, anchor]);
  const setRoving = (cell) => {
    if (!cell) return;
    for (const c of dayCells) c.tabIndex = -1;
    cell.tabIndex = 0;
    cell.focus();
    roving = cell;
  };

  for (const cell of dayCells) {
    cell.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setRoving(cell);
      if (e.shiftKey && anchor) head = cell.dataset.date;
      else { anchor = cell.dataset.date; head = anchor; }
      dragging = true;
      paint();
    });
    cell.addEventListener("mouseenter", () => {
      if (!dragging) return;
      head = cell.dataset.date;
      paint();
    });
  }
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    const [a, b] = ordered();
    if (a) openEditor(a, b);
  };
  grid.addEventListener("mouseup", endDrag);
  if (dragRelease) document.removeEventListener("mouseup", dragRelease);
  dragRelease = endDrag;
  document.addEventListener("mouseup", dragRelease);

  grid.addEventListener("keydown", (e) => {
    const cur = e.target.closest(".rc-day[data-date]");
    if (!cur) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step != null) {
      e.preventDefault();
      const next = dayCells[dayCells.indexOf(cur) + step];
      if (!next) return;
      setRoving(next);
      if (e.shiftKey) {
        if (!anchor) anchor = cur.dataset.date;
        head = next.dataset.date;
        paint();
        announce(`Sélection du ${dfr(ordered()[0])} au ${dfr(ordered()[1])}`);
      } else {
        // Se déplacer sans Maj replie la sélection sur le jour atteint —
        // sinon Entrée ouvrirait une plage que l'on croit avoir quittée.
        anchor = next.dataset.date;
        head = anchor;
        paint();
      }
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setRoving(e.key === "Home" ? dayCells[0] : dayCells[dayCells.length - 1]);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!anchor) { anchor = cur.dataset.date; head = anchor; paint(); }
      const [a, b] = ordered();
      openEditor(a, b);
      return;
    }
    if (e.key === "Escape") {
      anchor = null;
      head = null;
      paint();
    }
  });

  // --- éditeur de cellule / de plage
  const popHolder = body.querySelector("#rcPop");

  function openEditor(from, to, prefill = null) {
    if (!editable) {
      toast("Ce bien est tarifé par la somme de ses maisons — pose le prix sur chaque maison.", true);
      return;
    }
    if (to < today) {
      toast("Jour passé : le tarif n'est plus modifiable.", true);
      return;
    }
    const days = cal.days.filter((d) => d.date >= from && d.date <= to);
    const anchorCell = dayCells.find((c) => c.dataset.date === from);
    renderEditor({
      holder: popHolder,
      anchorCell,
      unit,
      cal,
      days,
      from,
      to,
      markups,
      prefill,
      onDone: (message) => { announce(message); reload(); },
      onClose: () => { if (anchorCell) anchorCell.focus(); },
    });
  }

  // --- suggestions en un clic (#31) : elles PRÉ-REMPLISSENT, elles n'écrivent pas
  if (editable) {
    const list = buildSuggestions({ days: cal.days, sold, planning, unitId: unit.id, today, monthEnd: addDaysIso(nextMonth, -1) });
    const holder = body.querySelector("#rcSuggest");
    if (list.length > 0) {
      holder.innerHTML = `<div class="card mb"><h3>Suggestions</h3>
        <p class="small muted mb">Calculées sur tes données réelles. Chaque bouton pré-remplit la saisie — rien n'est enregistré sans ta validation.</p>
        <div class="sugg">${list
          .map(
            (s, i) => `<div class="sugg-item"><b>${esc(s.title)}</b>
              <p class="small muted">${esc(s.why)}</p>
              <button class="btn o sm" data-sugg="${i}">${esc(s.action)}</button></div>`,
          )
          .join("")}</div></div>`;
      holder.querySelectorAll("[data-sugg]").forEach((b) =>
        b.addEventListener("click", () => {
          const s = list[Number(b.dataset.sugg)];
          anchor = s.from;
          head = s.to;
          paint();
          openEditor(s.from, s.to, s.prefill);
        }),
      );
    }
  }

  // --- cartes règles & périodes
  wireRules(body, unit, seasons, rules, sellable, reload);

  if (pendingEdit) {
    const target = pendingEdit;
    pendingEdit = null;
    const cell = dayCells.find((c) => c.dataset.date === target);
    if (cell) {
      anchor = target;
      head = target;
      paint();
      setRoving(cell);
      openEditor(target, target);
    }
  }
}

/** Nuits vendues (réservations actives) d'un bien, pour l'affichage en
 *  filigrane et le repérage des nuits orphelines. */
function soldNights(planning, unitId) {
  const set = new Set();
  for (const b of planning.bookings.filter((x) => x.unitId === unitId)) {
    for (let d = b.checkin; d < b.checkout; d = addDaysIso(d, 1)) set.add(d);
  }
  for (const blk of (planning.blocks || []).filter((x) => x.unitId === unitId)) {
    for (let d = blk.checkin; d < blk.checkout; d = addDaysIso(d, 1)) set.add(d);
  }
  return set;
}

/** Le message de refus vient du serveur : un PATCH sans prix ni minimum de
 *  nuits est rejeté par le contrôle « composite en somme » AVANT toute
 *  écriture — on lit donc la vraie phrase au lieu de la recopier ici. */
async function explainReadOnly(unit) {
  const fallback = `« ${unit.name} » est tarifé par la somme de ses maisons — pose le prix sur chaque maison, ou bascule ce bien en tarif propre.`;
  try {
    const t = todayIso();
    await api("/api/admin/rate-overrides", { method: "PATCH", body: { unitId: unit.id, from: t, to: t } });
    return fallback;
  } catch (e) {
    return e.message || fallback;
  }
}

// ---------------------------------------------------------------------------
// L'éditeur : une saisie, deux portées (un jour ou une plage)
// ---------------------------------------------------------------------------

function renderEditor({ holder, anchorCell, unit, cal, days, from, to, markups, prefill, onDone, onClose }) {
  const many = from !== to;
  const uniq = (list) => [...new Set(list)];
  const prices = uniq(days.map((d) => d.priceCents));
  const mins = uniq(days.map((d) => d.minNights));
  const initialPrice = prefill?.priceCents != null
    ? eurInput(prefill.priceCents)
    : prices.length === 1 && prices[0] != null ? eurInput(prices[0]) : "";
  const initialMin = prefill?.minNights != null ? String(prefill.minNights) : mins.length === 1 && mins[0] != null ? String(mins[0]) : "";
  // Une valeur venue d'une suggestion est déjà une modification à envoyer,
  // même si l'humain la valide sans y toucher.
  const forcePrice = prefill?.priceCents != null;
  const forceMin = prefill?.minNights != null;
  const anchorDay = days[0];
  const hasOverride = days.some((d) => d.overridePriceCents != null || d.overrideMinNights != null);

  const fallbackLine = (() => {
    if (many) return "";
    const d = anchorDay;
    if (d.overridePriceCents == null || d.fallbackPriceCents == null) return "";
    const origin = d.seasonName ? esc(d.seasonName) : "tarif de base";
    return `<p class="pop-fallback">Sans cette valeur : <b>${eur(d.fallbackPriceCents)}</b> <span class="muted">(${origin}${
      d.holidayRated ? " + majoration fériés" : ""
    })</span></p>`;
  })();

  const title = many
    ? `Du ${dfr(from)} au ${dfr(to)} — ${days.length} jour${days.length > 1 ? "s" : ""}`
    : dfrLong(from);

  holder.innerHTML = `
    <div class="rc-pop" role="dialog" aria-labelledby="popTitle">
      <h3 id="popTitle">${esc(title)}<span class="muted"> — ${esc(unit.name)}</span></h3>
      <div class="row mb">
        <div class="n"><label class="f" for="popPrice">Prix de la nuit</label>
          <input id="popPrice" class="inline-num" inputmode="decimal" value="${esc(initialPrice)}"
            placeholder="${prices.length > 1 ? "plusieurs prix" : ""}" aria-describedby="popErr"> €</div>
        <div class="n"><label class="f" for="popMin">Minimum de nuits à l'arrivée</label>
          <input id="popMin" class="inline-num" style="width:70px" type="number" min="1" max="60" value="${esc(initialMin)}"
            placeholder="${mins.length > 1 ? "variable" : ""}"></div>
      </div>
      <p class="fielderr" id="popErr" hidden></p>
      ${fallbackLine}
      ${many ? weekdayFilter(from, to) : ""}
      <div class="pop-channels" id="popChan"></div>
      <div class="row">
        <div class="n"><button class="btn sm" id="popSave">Enregistrer</button></div>
        ${hasOverride ? `<div class="n"><button class="btn o sm" id="popClear">Annuler la surcharge</button></div>` : ""}
        <div class="n"><button class="btn o sm" id="popClose">Fermer</button></div>
      </div>
      <p class="small muted" style="margin-top:6px">Entrée pour valider · Échap pour annuler</p>
      <div id="popConfirm"></div>
    </div>`;

  const pop = holder.querySelector(".rc-pop");
  place(pop, anchorCell, holder);

  const priceInput = pop.querySelector("#popPrice");
  const minInput = pop.querySelector("#popMin");
  const err = pop.querySelector("#popErr");
  const showErr = (msg) => {
    err.textContent = msg;
    err.hidden = false;
    priceInput.setAttribute("aria-invalid", "true");
    announce(msg);
  };
  const clearErr = () => {
    err.hidden = true;
    priceInput.removeAttribute("aria-invalid");
  };

  const close = () => {
    holder.innerHTML = "";
    document.removeEventListener("mousedown", outside, true);
    onClose?.();
  };
  function outside(e) {
    if (!holder.contains(e.target) && !e.target.closest(".rc-day")) close();
  }
  document.addEventListener("mousedown", outside, true);

  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); save(); return; }
    if (e.key !== "Tab") return;
    const items = focusableIn(pop);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // --- prix conseillé par plateforme (#31) : la formule est affichée telle
  //     que l'API la donne, pour que le calcul reste refaisable de tête.
  let chanTimer = null;
  const refreshChannels = async () => {
    const cents = toCents(priceInput.value);
    const box = pop.querySelector("#popChan");
    if (!cents || cents < 1) { box.innerHTML = ""; return; }
    try {
      const s = await api(`/api/admin/suggested-prices?priceCents=${cents}`);
      box.innerHTML = `<b>Prix conseillé sur les places de marché</b><ul>${s.channels
        .map((c) => `<li>${esc(c.label)} <b>${eur(c.suggestedCents)}</b> <span class="muted">(+${c.markupPct} %)</span></li>`)
        .join("")}</ul><span class="muted">${esc(s.formula || markups.formula || "")}</span>`;
    } catch {
      box.innerHTML = "";
    }
  };
  priceInput.addEventListener("input", () => {
    clearErr();
    clearTimeout(chanTimer);
    chanTimer = setTimeout(refreshChannels, 400);
  });
  refreshChannels();

  // Raccourcis du filtre de jours : « tous les week-ends de la plage » est le
  // geste réel du propriétaire, pas sept cases à décocher une par une.
  pop.querySelector("#wdAll")?.addEventListener("click", () => {
    pop.querySelectorAll(".wdBox").forEach((b) => { b.checked = true; });
    announce("Tous les jours de la plage sélectionnés");
  });
  pop.querySelector("#wdWe")?.addEventListener("click", () => {
    pop.querySelectorAll(".wdBox").forEach((b) => { b.checked = b.value === "5" || b.value === "6"; });
    announce("Vendredis et samedis de la plage sélectionnés");
  });

  pop.querySelector("#popClose").onclick = close;
  pop.querySelector("#popSave").onclick = () => save();
  pop.querySelector("#popClear")?.addEventListener("click", async () => {
    const q = new URLSearchParams({ unit: String(unit.id), from, to });
    const wd = weekdaysParam(pop);
    if (wd) q.set("weekdays", wd);
    try {
      const res = await api(`/api/admin/rate-overrides?${q}`, { method: "DELETE" });
      toast(`Surcharge retirée sur ${res.removed} jour${res.removed > 1 ? "s" : ""} — retour au tarif de saison`);
      close();
      onDone(`Surcharge retirée sur ${res.removed} jours`);
    } catch (e) {
      showErr(e.message);
    }
  });

  async function save(confirmed = false) {
    clearErr();
    const rawPrice = priceInput.value.trim();
    const rawMin = minInput.value.trim();
    const body = { unitId: unit.id, from, to };
    const wd = weekdaysParam(pop);
    if (wd) body.weekdays = wd.split(",").map(Number);

    // Issue #50 côté interface : un champ vidé n'est pas un prix de 0 €.
    if (rawPrice === "" && initialPrice !== "") {
      showErr("Un prix ne peut pas être vide — pour revenir au tarif de saison, utilise « Annuler la surcharge ».");
      priceInput.focus();
      return;
    }
    if (rawPrice !== "" && (forcePrice || rawPrice !== initialPrice)) {
      const cents = toCents(rawPrice);
      if (!cents || cents <= 0) {
        showErr("Un prix doit être strictement positif — pour retirer une surcharge, utilise « Annuler la surcharge ».");
        priceInput.focus();
        return;
      }
      body.priceCents = cents;
    }
    if (rawMin !== "" && (forceMin || rawMin !== initialMin)) {
      const n = Math.floor(Number(rawMin));
      if (!Number.isFinite(n) || n < 1 || n > 60) {
        showErr("Le minimum de nuits doit être compris entre 1 et 60.");
        minInput.focus();
        return;
      }
      body.minNights = n;
    }
    if (body.priceCents == null && body.minNights == null) {
      showErr("Rien à enregistrer — modifie le prix ou le minimum de nuits.");
      return;
    }

    // Garde-fou d'écart (spec UX § 6.3) : au-delà de ±40 % du prix de fond,
    // on fait relire la phrase avant d'écrire.
    const ref = anchorDay?.fallbackPriceCents ?? anchorDay?.priceCents ?? null;
    if (!confirmed && body.priceCents != null && ref) {
      const delta = Math.round(((body.priceCents - ref) / ref) * 100);
      if (Math.abs(delta) >= 40) {
        pop.querySelector("#popConfirm").innerHTML = `<div class="note" style="margin-top:8px">
          ${esc(dfr(from))} : <b>${eur(body.priceCents)}</b> au lieu de ${eur(ref)}, soit ${delta > 0 ? "+" : ""}${delta} %.
          <div class="row" style="margin-top:6px"><div class="n"><button class="btn sm" id="popYes">Confirmer</button></div>
          <div class="n"><button class="btn o sm" id="popNo">Revoir</button></div></div></div>`;
        pop.querySelector("#popYes").onclick = () => save(true);
        pop.querySelector("#popNo").onclick = () => { pop.querySelector("#popConfirm").innerHTML = ""; priceInput.focus(); };
        pop.querySelector("#popYes").focus();
        return;
      }
    }

    try {
      const res = await api("/api/admin/rate-overrides", { method: "PATCH", body });
      const n = res.days;
      const quoi =
        body.priceCents != null && body.minNights != null ? "Prix et minimum de nuits appliqués"
        : body.priceCents != null ? "Prix appliqué"
        : "Minimum de nuits appliqué";
      const msg = `${quoi} sur ${n} jour${n > 1 ? "s" : ""}`;
      close();
      if (n > 1 && body.priceCents != null) {
        // Peindre une plage doit pouvoir se dépeindre (spec UX § 7).
        toastUndo(msg, "Annuler", async () => {
          const q = new URLSearchParams({ unit: String(unit.id), from, to });
          if (wd) q.set("weekdays", wd);
          await api(`/api/admin/rate-overrides?${q}`, { method: "DELETE" });
          toast("Plage remise au tarif de saison");
          onDone("Plage annulée");
        });
      } else {
        toast(msg);
      }
      onDone(msg);
    } catch (e) {
      // Le serveur nomme la valeur ET la borne : on affiche sa phrase telle quelle.
      showErr(e.message);
    }
  }

  (pop.querySelector("#popPrice") || pop).focus();
  pop.querySelector("#popPrice")?.select();
}

/** Filtre de jours de semaine — « tous les week-ends de la plage » en un clic.
 *  Convention de l'API : 0 = dimanche … 6 = samedi. */
function weekdayFilter(from, to) {
  const present = new Set();
  for (let d = from; d <= to; d = addDaysIso(d, 1)) present.add(dowOf(d));
  const order = [1, 2, 3, 4, 5, 6, 0];
  return `<fieldset class="wdays">
    <legend>Jours concernés</legend>
    ${order
      .filter((n) => present.has(n))
      .map(
        (n) => `<label class="wd"><input type="checkbox" class="wdBox" value="${n}" checked>${DOW_SHORT[n]}</label>`,
      )
      .join("")}
    <button type="button" class="btn o sm" id="wdAll">Tous</button>
    <button type="button" class="btn o sm" id="wdWe" title="Nuits de vendredi et de samedi, celles que le moteur tarifie en week-end">Week-ends</button>
  </fieldset>`;
}

/** `weekdays` à envoyer, ou null si tous les jours de la plage sont cochés. */
function weekdaysParam(pop) {
  const boxes = [...pop.querySelectorAll(".wdBox")];
  if (boxes.length === 0) return null;
  const checked = boxes.filter((b) => b.checked).map((b) => b.value);
  if (checked.length === 0 || checked.length === boxes.length) return null;
  return checked.join(",");
}

/** Place l'éditeur sous la cellule cliquée, sans déborder de la carte. Sur
 *  écran étroit, la CSS le repasse en bloc et cette position est ignorée. */
function place(pop, cell, holder) {
  if (!cell || window.innerWidth <= 760) return;
  const wrap = holder.closest(".rc-wrap") || holder.parentElement;
  const wrapBox = wrap.getBoundingClientRect();
  const cellBox = cell.getBoundingClientRect();
  const width = 330;
  let left = cellBox.left - wrapBox.left + cellBox.width / 2 - width / 2;
  left = Math.max(0, Math.min(left, wrapBox.width - width));
  pop.style.left = `${left}px`;
  pop.style.top = `${cellBox.bottom - wrapBox.top + 6}px`;
  pop.style.width = `${width}px`;
}

// ---------------------------------------------------------------------------
// Suggestions en un clic (#31) — trois lectures des données réelles
// ---------------------------------------------------------------------------

function buildSuggestions({ days, sold, planning, unitId, today, monthEnd }) {
  const out = [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const free = (iso) => !sold.has(iso);

  // 1. Nuits orphelines : 1 ou 2 nuits libres coincées entre deux séjours.
  const stays = planning.bookings
    .filter((b) => b.unitId === unitId)
    .map((b) => ({ checkin: b.checkin, checkout: b.checkout }))
    .sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
  for (let i = 0; i + 1 < stays.length; i++) {
    const gapFrom = stays[i].checkout;
    const gapTo = addDaysIso(stays[i + 1].checkin, -1);
    if (gapFrom > gapTo || gapFrom < today) continue;
    const nights = diffDaysIso(gapFrom, gapTo) + 1;
    if (nights > 2) continue;
    const d = byDate.get(gapFrom);
    if (!d || d.minNights == null || d.minNights <= nights) continue;
    out.push({
      title: `Nuit${nights > 1 ? "s" : ""} orpheline${nights > 1 ? "s" : ""} du ${dfr(gapFrom)}`,
      why: `${nights} nuit${nights > 1 ? "s" : ""} libre${nights > 1 ? "s" : ""} entre deux séjours, alors que le minimum est de ${d.minNights} nuits : personne ne peut réserver ce trou.`,
      action: `Descendre le minimum à ${nights} nuit${nights > 1 ? "s" : ""}`,
      from: gapFrom,
      to: gapTo,
      prefill: { minNights: nights },
    });
    if (out.length >= 1) break; // une seule proposition de ce type à la fois
  }

  // 2. Dernière minute : jours libres dans les 21 prochains jours.
  const horizon = addDaysIso(today, 21);
  const lastMinute = days.filter((d) => d.date >= today && d.date <= horizon && d.date <= monthEnd && free(d.date) && d.priceCents != null);
  if (lastMinute.length >= 2) {
    const first = lastMinute[0];
    const last = lastMinute[lastMinute.length - 1];
    const cut = Math.round(first.priceCents * 0.9);
    out.push({
      title: `Dernière minute — ${lastMinute.length} nuits encore libres d'ici le ${dfr(last.date)}`,
      why: `Remise bornée à 10 % sur ces dates proches : ${eur(first.priceCents)} − 10 % = ${eur(cut)}. Au-delà, tu vends moins cher que ton tarif de base.`,
      action: "Proposer −10 %",
      from: first.date,
      to: last.date,
      prefill: { priceCents: cut },
    });
  }

  // 3. Dates fortes : jours fériés et ponts déjà calculés par le moteur.
  const strong = days.filter((d) => d.holidayRated && d.date >= today && d.priceCents != null && d.overridePriceCents == null);
  if (strong.length > 0) {
    const up = Math.round(strong[0].priceCents * 1.15);
    out.push({
      title: `Dates fortes — ${strong.length} jour${strong.length > 1 ? "s" : ""} férié${strong.length > 1 ? "s" : ""} ou pont ce mois-ci`,
      why: `Le moteur les majore déjà. Un cran de plus se justifie sur ${dfr(strong[0].date)} : ${eur(strong[0].priceCents)} + 15 % = ${eur(up)}.`,
      action: "Proposer +15 %",
      from: strong[0].date,
      to: strong[strong.length - 1].date,
      prefill: { priceCents: up },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cartes « règles du bien » et « périodes / saisons »
// ---------------------------------------------------------------------------

function rulesCard(unit, seasons, rules, editable) {
  if (!editable) return "";
  const slots = [{ seasonId: null, name: "Tarif de base (hors périodes)" }, ...seasons.map((s) => ({ seasonId: s.id, name: s.name }))];
  return `<div class="card mb"><h3>Règles de ${esc(unit.name)}</h3>
    <div class="tbl-wrap"><table><tr><th>Période</th><th>Nuit semaine</th><th>Nuit weekend</th><th>Fériés BE <span class="tag t-ok">auto</span></th><th>Min. nuits</th><th></th></tr>
    ${slots
      .map((slot) => {
        const r = rules.find((x) => x.unitId === unit.id && x.seasonId === slot.seasonId);
        if (!r) {
          return `<tr><td>${esc(slot.name)}</td><td colspan="4" class="muted">pas de règle — le tarif de base s'applique</td>
            <td><button class="btn o sm ruleNew" data-season="${slot.seasonId ?? ""}">+ créer</button></td></tr>`;
        }
        return `<tr data-rule="${r.id}">
          <td>${esc(slot.name)}</td>
          <td><input class="inline-num rWeek" aria-label="Nuit semaine — ${esc(slot.name)}" value="${eurInput(r.priceWeekCents)}"> €</td>
          <td><input class="inline-num rWe" aria-label="Nuit weekend — ${esc(slot.name)}" value="${eurInput(r.priceWeekendCents)}"> €</td>
          <td>+ <input class="inline-num rHol" style="width:55px" aria-label="Majoration fériés %" value="${r.holidayPct}"> %</td>
          <td><input class="inline-num rMin" style="width:55px" aria-label="Minimum de nuits" value="${r.minNights}"> n</td>
          <td><button class="btn sm ruleSave">Enregistrer</button> ${slot.seasonId != null ? `<button class="btn warn sm ruleDel">Supprimer</button>` : ""}</td></tr>`;
      })
      .join("")}
    </table></div></div>`;
}

function seasonsCard(seasons, PALETTE) {
  return `<div class="card mb"><h3>Périodes / saisons du domaine (partagées entre les biens)</h3>
    <div class="row mb"><div class="n"><button class="btn sm" id="seasonNew">+ Nouvelle période</button></div>
      <div class="right muted small">Une période porte un prix de saison. Pour un ajustement d'un ou deux jours, clique directement le jour dans le calendrier.</div></div>
    <div class="tbl-wrap"><table><tr><th>Nom</th><th>Du</th><th>Au</th><th>Priorité</th><th></th></tr>
      ${seasons
        .map(
          (s, i) => `<tr data-season="${s.id}">
          <td><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${PALETTE[i % PALETTE.length]};margin-right:6px"></i><input class="sName" aria-label="Nom de la période" style="width:calc(100% - 20px)" value="${esc(s.name)}"></td>
          <td><input type="date" class="sFrom" aria-label="Début" value="${s.dateStart}"></td>
          <td><input type="date" class="sTo" aria-label="Fin" value="${s.dateEnd}"></td>
          <td><input type="number" class="sPrio inline-num" aria-label="Priorité" style="width:60px" value="${s.priority}"></td>
          <td><button class="btn sm sSave">Enregistrer</button> <button class="btn warn sm sDel">Supprimer</button></td></tr>`,
        )
        .join("") || `<tr><td colspan="5" class="muted">Aucune période — le tarif de base s'applique toute l'année.</td></tr>`}
    </table></div>
    <p class="small muted" style="margin-top:6px">En cas de chevauchement, la priorité la plus haute gagne. La majoration « fériés BE » (jours fériés belges, veilles et ponts) est calculée automatiquement.</p>
  </div>`;
}

function wireRules(body, unit, seasons, rules, sellable, reload) {
  const pid = currentPropertyId();
  const baseRule = rules.find((x) => x.unitId === unit.id && x.seasonId === null);

  body.querySelectorAll(".ruleNew").forEach((btn) => {
    btn.onclick = async () => {
      await api("/api/admin/rate-rules", {
        method: "POST",
        body: {
          unitId: unit.id,
          seasonId: btn.dataset.season ? Number(btn.dataset.season) : null,
          priceWeekCents: baseRule?.priceWeekCents ?? 10000,
          priceWeekendCents: baseRule?.priceWeekendCents ?? 12000,
          holidayPct: 15,
          minNights: baseRule?.minNights ?? 2,
        },
      });
      toast("Règle créée — ajuste les prix");
      reload();
    };
  });

  body.querySelectorAll("tr[data-rule]").forEach((tr) => {
    const id = tr.dataset.rule;
    tr.querySelector(".ruleSave").onclick = async () => {
      const week = toCents(tr.querySelector(".rWeek").value);
      if (!week) return toast("Un prix de nuit ne peut pas être vide.", true);
      try {
        await api(`/api/admin/rate-rules/${id}`, {
          method: "PATCH",
          body: {
            priceWeekCents: week,
            priceWeekendCents: toCents(tr.querySelector(".rWe").value) || week,
            holidayPct: Number(tr.querySelector(".rHol").value),
            minNights: Number(tr.querySelector(".rMin").value),
          },
        });
        toast("Tarif enregistré");
        reload();
      } catch (e) {
        toast(e.message, true);
      }
    };
    tr.querySelector(".ruleDel")?.addEventListener("click", async () => {
      if (!confirm("Supprimer cette règle ? (le tarif de base s'appliquera)")) return;
      await api(`/api/admin/rate-rules/${id}`, { method: "DELETE" });
      reload();
    });
  });

  body.querySelectorAll("tr[data-season]").forEach((tr) => {
    const id = tr.dataset.season;
    tr.querySelector(".sSave").onclick = async () => {
      await api(`/api/admin/seasons/${id}`, {
        method: "PATCH",
        body: {
          name: tr.querySelector(".sName").value,
          dateStart: tr.querySelector(".sFrom").value,
          dateEnd: tr.querySelector(".sTo").value,
          priority: Number(tr.querySelector(".sPrio").value),
        },
      });
      toast("Période enregistrée");
      reload();
    };
    tr.querySelector(".sDel").onclick = async () => {
      if (!confirm("Supprimer cette période ET ses règles tarifaires (tous biens) ?")) return;
      await api(`/api/admin/seasons/${id}`, { method: "DELETE" });
      toast("Période supprimée");
      reload();
    };
  });

  // Création de période : seul chemin de création d'une saison (spec UX § 1).
  body.querySelector("#seasonNew").onclick = () => {
    const maxPrio = Math.max(0, ...seasons.map((s) => s.priority));
    const start = state.calMonth + "-01";
    const end = addDaysIso(start, daysInMonth(state.calMonth) - 1);
    const modal = openModal(`
      <h2>Nouvelle période tarifaire <button class="x">×</button></h2>
      <p class="small muted mb">Une période s'étale sur plusieurs semaines et porte un prix de saison pour tout le domaine. Pour un ou deux jours, ferme cette fenêtre et clique le jour dans le calendrier.</p>
      <div class="formgrid mb">
        <div><label class="f" for="npName">Nom</label><input id="npName" value="Période ${dfr(start)} → ${dfr(end)}"></div>
        <div><label class="f" for="npFrom">Du</label><input type="date" id="npFrom" value="${start}"></div>
        <div><label class="f" for="npTo">Au</label><input type="date" id="npTo" value="${end}"></div>
        <div><label class="f" for="npWeek">Nuit semaine (€)</label><input id="npWeek" value="${baseRule ? eurInput(baseRule.priceWeekCents) : ""}"></div>
        <div><label class="f" for="npWe">Nuit weekend (€)</label><input id="npWe" value="${baseRule ? eurInput(baseRule.priceWeekendCents) : ""}"></div>
        <div><label class="f" for="npHol">Fériés %</label><input id="npHol" type="number" value="${baseRule ? baseRule.holidayPct : 15}"></div>
        <div><label class="f" for="npMin">Min. nuits</label><input id="npMin" type="number" value="${baseRule ? baseRule.minNights : 2}"></div>
      </div>
      <label class="wd mb"><input id="npAll" type="checkbox"> Appliquer les mêmes prix à tous les biens du domaine</label>
      <div class="row"><div class="n"><button class="btn sm" id="npCreate">Créer la période</button></div></div>
      <p class="small muted" style="margin-top:6px">Créée en priorité ${maxPrio + 1} : elle prime sur les périodes qui la chevauchent.</p>`);

    modal.querySelector("#npCreate").onclick = async () => {
      const week = toCents(modal.querySelector("#npWeek").value);
      if (!week) return toast("Prix de nuit semaine requis", true);
      const from = modal.querySelector("#npFrom").value;
      const to = modal.querySelector("#npTo").value;
      if (!from || !to || from > to) return toast("Dates de période invalides", true);
      try {
        const created = await api(`/api/admin/seasons?property=${pid}`, {
          method: "POST",
          body: { name: modal.querySelector("#npName").value, dateStart: from, dateEnd: to, priority: maxPrio + 1 },
        });
        const ruleBody = {
          seasonId: created.id,
          priceWeekCents: week,
          priceWeekendCents: toCents(modal.querySelector("#npWe").value) || week,
          holidayPct: Number(modal.querySelector("#npHol").value) || 0,
          minNights: Number(modal.querySelector("#npMin").value) || 1,
        };
        const targets = modal.querySelector("#npAll").checked
          ? sellable.filter((u) => !(u.isComposite && u.compositePricing === "sum"))
          : [unit];
        for (const t of targets) await api("/api/admin/rate-rules", { method: "POST", body: { ...ruleBody, unitId: t.id } });
        toast(`Période créée pour ${targets.length} bien${targets.length > 1 ? "s" : ""}`);
        modal.remove();
        reload();
      } catch (e) {
        toast(e.message, true);
      }
    };
  };
}

// ---------------------------------------------------------------------------
// COUCHE ANNÉE — 12 mois par bien, en une requête (spec UX § 9)
// ---------------------------------------------------------------------------

async function renderYear(body) {
  const pid = currentPropertyId();
  const year = state.calYear;
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const today = todayIso();

  const [cal, planning] = await Promise.all([
    api(`/api/admin/rate-calendar?property=${pid}&from=${from}&to=${to}`),
    api(`/api/admin/planning?property=${pid}&from=${from}&to=${to}`),
  ]);

  const grids = cal.units
    .map((entry) => {
      const u = entry.unit;
      const sold = soldNights(planning, u.id);
      // Niveaux calés sur les prix réels DE CE BIEN : un « Domaine entier » à
      // 520 € écraserait sinon l'échelle des deux maisons. On répartit sur les
      // prix DISTINCTS — un tarif qui couvre les trois quarts de l'année
      // fabriquerait sinon des paliers vides (« 180 € à 180 € »).
      const distinct = [...new Set(entry.days.map((d) => d.priceCents).filter((c) => c != null))].sort((a, b) => a - b);
      const cuts = distinct.length > 4 ? [1, 2, 3].map((i) => distinct[Math.floor((distinct.length * i) / 4)]) : [];
      const level = (c) =>
        cuts.length === 0
          ? Math.max(0, distinct.indexOf(c))
          : c < cuts[0] ? 0 : c < cuts[1] ? 1 : c < cuts[2] ? 2 : 3;
      const byDate = new Map(entry.days.map((d) => [d.date, d]));
      let rows = "";
      for (let m = 1; m <= 12; m++) {
        const ym = `${year}-${String(m).padStart(2, "0")}`;
        const n = daysInMonth(ym);
        let cellsHtml = "";
        for (let day = 1; day <= 31; day++) {
          if (day > n) { cellsHtml += `<div class="yc off" aria-hidden="true"></div>`; continue; }
          const iso = `${ym}-${String(day).padStart(2, "0")}`;
          const d = byDate.get(iso);
          const noRate = !d || d.priceCents == null;
          const cls = [
            "yc",
            noRate ? "norate" : `lv${level(d.priceCents)}`,
            sold.has(iso) ? "sold" : "",
            d?.source === "override" ? "ov" : "",
            (d?.minNights ?? 0) >= 3 ? "mn3" : "",
            iso === today ? "today" : "",
          ].filter(Boolean).join(" ");
          const title = [
            dfrLong(iso),
            noRate ? "aucun tarif — invendable" : `${eur(d.priceCents)} · ${d.source === "override" ? "fixé à la main" : d.source === "saison" ? d.seasonName || "saison" : "tarif de base"}`,
            d?.minNights ? `min ${d.minNights} nuits à l'arrivée` : "",
            sold.has(iso) ? "nuit déjà vendue" : "",
          ].filter(Boolean).join(" · ");
          cellsHtml += `<div class="${cls}" role="gridcell" ${u.editable === false ? "" : `tabindex="-1" data-date="${iso}" data-unit="${u.id}"`} title="${esc(title)}"></div>`;
        }
        rows += `<div role="row" class="yrow"><div role="rowheader" class="ym">${MONTHS_SHORT[m - 1]}</div>${cellsHtml}</div>`;
      }
      const missing = entry.days.filter((d) => d.priceCents == null).length;
      const scale =
        distinct.length === 0
          ? `<span class="muted">Aucun tarif défini sur ${year}.</span>`
          : cuts.length === 0
            ? distinct.map((c, i) => `<span><i class="lg lv${i}"></i>${euroShort(c)}</span>`).join("")
            : `<span><i class="lg lv0"></i>moins de ${euroShort(cuts[0])}</span>
               <span><i class="lg lv1"></i>de ${euroShort(cuts[0])} à ${euroShort(cuts[1])}</span>
               <span><i class="lg lv2"></i>de ${euroShort(cuts[1])} à ${euroShort(cuts[2])}</span>
               <span><i class="lg lv3"></i>${euroShort(cuts[2])} et plus</span>`;
      return `<div class="card mb">
        <h3>${esc(u.name)}${u.editable === false ? ` <span class="tag t-mut">lecture seule (somme des maisons)</span>` : ""}</h3>
        ${missing > 0 ? `<div class="note bad" style="margin-bottom:10px">${missing} jour${missing > 1 ? "s" : ""} sans tarif en ${year} — ces nuits sont invendables.</div>` : ""}
        <div class="yr-wrap"><div class="yr ${u.editable === false ? "ro" : ""}" role="grid" aria-label="Prix ${year} — ${esc(u.name)}">
          <div role="row" class="yrow"><div class="ym"></div>${Array.from({ length: 31 }, (_, i) => `<div role="columnheader" class="yh">${i + 1}</div>`).join("")}</div>
          ${rows}
        </div></div>
        <div class="rc-legend">${scale}</div>
      </div>`;
    })
    .join("");

  body.innerHTML = `
    <p class="small muted mb">Une case par nuit, colorée par niveau de prix. Survole (ou tabule) une case pour lire le détail ; clique-la pour la modifier — la saisie du mois s'ouvre sur ce jour.</p>
    ${grids || `<div class="note">Aucun bien actif sur ce domaine.</div>`}
    <div class="card">
      <h3>Légende commune</h3>
      <p class="small muted mb">Les quatre niveaux de couleur sont propres à chaque bien : ils se lisent sous sa grille.</p>
      <div class="rc-legend">
        <span><i class="lg no"></i>pas de tarif — invendable</span>
        <span><i class="lg soldy"></i>nuit déjà vendue</span>
        <span><i class="lg ovy"></i>prix fixé à la main</span>
        <span><i class="lg mn3y"></i>3 nuits minimum ou plus</span>
      </div>
    </div>`;

  body.querySelectorAll(".yc[data-date]").forEach((c) => {
    const go = () => {
      state.tarifUnit = Number(c.dataset.unit);
      state.calMonth = c.dataset.date.slice(0, 7);
      pendingEdit = c.dataset.date;
      location.hash = "#/cal/prix";
    };
    c.addEventListener("click", go);
    c.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
  // Une seule case atteignable à la tabulation par grille (grille, pas liste).
  body.querySelectorAll(".yr").forEach((g) => g.querySelector(".yc[data-date]")?.setAttribute("tabindex", "0"));
}
