// Back-office Gestion Gîtes — SPA vanilla (zéro framework).
// app.js : socle (état, client API, helpers UI, routeur) + vues de pilotage.
// Les vues de configuration vivent dans config.js.

import { stayBadge } from "./badges.js";
import { registerCalendarView } from "./calendar.js";
import { registerConfigViews } from "./config.js";

// ---------------------------------------------------------------------------
// État global & client API
// ---------------------------------------------------------------------------

export const state = {
  propertyId: Number(localStorage.getItem("gp_property") || 0), // 0 = tous les domaines
  properties: [],
  token: localStorage.getItem("gp_token") || "",
  session: localStorage.getItem("gp_session") || "",
  user: localStorage.getItem("gp_user") || "",
  // Un seul mois pour les trois couches du calendrier : passer d'Occupation à
  // Prix ne doit plus changer de mois sous les pieds (spec UX, variante B).
  calMonth: null, // 'YYYY-MM'
  calYear: null,
  statsYear: null,
  tarifUnit: null,
};

/** Les vues qui exigent un domaine précis retombent sur le premier. */
export function currentPropertyId() {
  return state.propertyId || state.properties[0]?.id || 1;
}

export function authHeaders() {
  // Session de 30 jours (comptes en base) — le mot de passe n'est jamais conservé.
  if (state.session) return { authorization: `Bearer session:${state.session}` };
  if (!state.token) return {};
  // Accès de secours (secret) : « identifiant:motdepasse », ou jeton nu historique.
  const bearer = state.user ? `${state.user}:${state.token}` : state.token;
  return { authorization: `Bearer ${bearer}` };
}

export function clearAuth() {
  for (const k of ["gp_session", "gp_token", "gp_user"]) localStorage.removeItem(k);
  state.session = "";
  state.token = "";
  state.user = "";
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    // Session absente, expirée ou révoquée → page de connexion.
    clearAuth();
    window.location.href = "login.html";
    throw new Error("non autorisé");
  }
  if (res.status === 503) {
    const data = await res.json().catch(() => ({}));
    if (String(data.error || "").includes("ADMIN_TOKEN")) {
      // Verrou pas encore activé côté serveur : l'expliquer au lieu d'une page vide.
      window.location.href = "login.html?verrou=inactif";
    }
    throw new Error(data.error || "erreur 503");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `erreur ${res.status}`);
  return data;
}

export async function downloadCsv(path, filename) {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) return toast("Export impossible", true);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Helpers de formatage & DOM
// ---------------------------------------------------------------------------

export const eur = (cents) =>
  (cents / 100).toLocaleString("fr-BE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
export const eurInput = (cents) => (cents / 100).toFixed(2);
export const toCents = (v) => Math.round(parseFloat(String(v).replace(",", ".").replace(/\s/g, "")) * 100) || 0;
export const dfr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
export const dshort = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function todayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
export function diffDaysIso(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
const DOW = ["D", "L", "M", "M", "J", "V", "S"];
export const dowLetter = (iso) => DOW[new Date(iso + "T12:00:00Z").getUTCDay()];
export const isWeekendDay = (iso) => [0, 6].includes(new Date(iso + "T12:00:00Z").getUTCDay());

export function toast(message, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " err" : "");
  el.textContent = message;
  document.getElementById("toastRoot").appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3500);
  return el;
}

/** Message avec une action de rattrapage — « peindre » 60 jours de prix doit
 *  pouvoir se dépeindre en un clic (spec UX § 7). L'action reste offerte
 *  `seconds` secondes, puis le message s'efface comme les autres. */
export function toastUndo(message, label, onUndo, seconds = 10) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span></span> <button type="button" class="undo"></button>`;
  el.querySelector("span").textContent = message;
  const btn = el.querySelector("button");
  btn.textContent = label;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await onUndo();
    } finally {
      el.remove();
    }
  };
  document.getElementById("toastRoot").appendChild(el);
  setTimeout(() => el.remove(), seconds * 1000);
  return el;
}

// --- modales : une seule fonction, donc une seule correction d'accessibilité --

/** Éléments qu'on peut atteindre au clavier, dans l'ordre du document. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

let modalSeq = 0;
let modalDepth = 0;

/** Boîte de dialogue modale — accessible par construction (issue #15).
 *  Les 8 modales du back-office passent par ici : `role="dialog"`,
 *  `aria-modal`, `aria-labelledby` sur le titre, focus déplacé à l'ouverture
 *  puis piégé, Échap pour fermer, focus rendu au déclencheur, page figée
 *  derrière. `bg.remove()` est réécrit pour que les fermetures déjà écrites
 *  aux quatre coins du back-office déclenchent le même nettoyage. */
export function openModal(html) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
  const box = bg.querySelector(".modal");

  // Le titre nomme la boîte. Le libellé est isolé du bouton « × » pour que le
  // nom accessible soit « Réf — La Scierie », pas « Réf — La Scierie Fermer ».
  const h = box.querySelector("h2");
  if (h) {
    const id = `modalTitle${++modalSeq}`;
    const label = document.createElement("span");
    label.id = id;
    for (const node of [...h.childNodes]) {
      if (node.nodeType === 1 && node.classList.contains("x")) continue;
      label.appendChild(node);
    }
    h.insertBefore(label, h.firstChild);
    box.setAttribute("aria-labelledby", id);
  }
  const closeBtn = box.querySelector(".x");
  if (closeBtn) {
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("aria-label", "Fermer");
  }

  const close = () => {
    if (!bg.isConnected) return;
    Element.prototype.remove.call(bg);
    modalDepth = Math.max(0, modalDepth - 1);
    if (modalDepth === 0) document.body.classList.remove("modal-open");
    // Le focus revient d'où il venait, sinon il retombe sur <body> et le
    // parcours au clavier repart du haut de la page.
    if (opener && opener.isConnected) opener.focus();
  };
  bg.remove = close;

  bg.addEventListener("click", (e) => {
    if (e.target === bg) close();
  });
  closeBtn?.addEventListener("click", close);
  bg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    // Piège de tabulation : la liste est recalculée à chaque fois, le contenu
    // des modales change en cours de route (zone de paiement, résultats…).
    const items = focusableIn(box);
    if (items.length === 0) {
      e.preventDefault();
      box.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  document.getElementById("modalRoot").appendChild(bg);
  modalDepth += 1;
  document.body.classList.add("modal-open");
  // Le premier champ utile plutôt que la croix de fermeture : la boîte s'ouvre
  // pour être remplie, pas pour être refermée.
  const target = box.querySelector("[autofocus]") || focusableIn(box).find((el) => el !== closeBtn) || closeBtn || box;
  target.focus();
  return bg;
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast("Copié dans le presse-papiers"),
    () => toast("Copie impossible", true),
  );
}

export function bookingTag(b, today = todayIso(), movement = null) {
  if (b.status === "cancelled") return `<span class="tag t-mut">Annulée</span>`;
  // Où en est le séjour (issue #53) — préfixe le badge financier plutôt que de
  // le remplacer : « arrive demain » et « solde dû » sont deux informations
  // qu'on veut lire ensemble, pas l'une à la place de l'autre. `movement`
  // restreint la lecture à l'arrivée ou au départ (tableau de bord).
  const when = stayBadge(b, today, movement);
  if (b.status === "pending") return `${when}<span class="tag t-warn">Option (paiement)</span>`;
  if (b.source === "ical") return `${when}<span class="tag t-chan">${esc(b.channelLabel || "Canal externe")}</span>`;
  // Un départ du jour n'est pas encore « Terminée » : le ménage reste à faire
  // et le solde reste encaissable. On laisse donc passer au badge financier.
  if (b.checkout <= today && !when) return `<span class="tag t-mut">Terminée</span>`;
  const balance = b.totalCents - b.paidCents;
  if (b.totalCents > 0 && balance <= 0) return `${when}<span class="tag t-ok">Soldée</span>`;
  if (b.paidCents > 0) return `${when}<span class="tag t-warn">Solde dû ${eur(balance)}</span>`;
  if (b.totalCents > 0) return `${when}<span class="tag t-bad">Impayée</span>`;
  return `${when}<span class="tag t-mut">—</span>`;
}

const SOURCE_FR = { direct: "Site", manual: "Manuelle", ical: "iCal", import: "Import" };
export const sourceFr = (s) => SOURCE_FR[s] || s;

// ---------------------------------------------------------------------------
// Routeur & topbar
// ---------------------------------------------------------------------------

const VIEWS = {};
export function registerView(name, title, render) {
  VIEWS[name] = { title, render };
}

/** Navigation « variante B » (#25) : cinq entrées, trois compteurs, un
 *  deuxième niveau contextuel. Le tri est celui de la fréquence d'usage
 *  réelle, pas celui de la nature technique de l'écran — « Clients » et
 *  « Paiements » quittent la Configuration pour rejoindre Ventes. */
const NAV = [
  { id: "aujourdhui", label: "Aujourd'hui", badge: "today", items: [{ route: "dash", label: "Aujourd'hui" }] },
  {
    id: "calendrier",
    label: "Calendrier",
    items: [
      { route: "cal", label: "Occupation" },
      { route: "cal/prix", label: "Prix" },
      { route: "cal/annee", label: "Année" },
    ],
  },
  {
    id: "ventes",
    label: "Ventes",
    badge: "sales",
    items: [
      { route: "resa", label: "Réservations" },
      { route: "clients", label: "Clients" },
      { route: "paiements", label: "Paiements" },
      { route: "stats", label: "Statistiques" },
    ],
  },
  { id: "messages", label: "Messages", badge: "messages", items: [{ route: "messages", label: "Messages" }] },
  {
    id: "reglages",
    label: "Réglages",
    items: [
      { route: "promos", label: "Remises" },
      { route: "options", label: "Options" },
      { route: "canaux", label: "Plateformes" },
      { route: "ical", label: "Synchro iCal" },
      { route: "users", label: "Comptes" },
      { route: "params", label: "Domaine" },
      { route: "startup", label: "Mise en route" },
    ],
  },
];

/** Adresses historiques : « Planning » et « Tarifs & saisons » sont devenus
 *  deux couches du calendrier unifié. Les favoris continuent de marcher —
 *  ils atterrissent sur la couche correspondante, jamais sur une vue morte. */
const ALIASES = { plan: "cal", tarifs: "cal/prix" };

const badges = { today: 0, sales: 0, messages: 0 };

const $main = () => document.getElementById("main");

export function setPageTitle(title) {
  document.getElementById("pageTitle").textContent = title;
}

/** Dessine les deux niveaux et renvoie l'entrée courante — son libellé sert
 *  aussi de titre de page, pour que le menu et l'écran disent le même mot. */
function renderNav(route) {
  const group = NAV.find((g) => g.items.some((i) => i.route === route)) || NAV[0];
  const nav1 = document.getElementById("nav1");
  nav1.innerHTML = NAV.map((g) => {
    const n = g.badge ? badges[g.badge] : 0;
    return `<a href="#/${g.items[0].route}" class="${g.id === group.id ? "on" : ""}"${g.id === group.id ? ' aria-current="page"' : ""}>${esc(g.label)}${
      n > 0 ? ` <b class="badge" aria-label="${n} à traiter">${n}</b>` : ""
    }</a>`;
  }).join("");

  const current = group.items.find((i) => i.route === route) || group.items[0];
  const nav2 = document.getElementById("nav2");
  if (group.items.length < 2) {
    nav2.innerHTML = "";
    nav2.hidden = true;
    return current;
  }
  nav2.hidden = false;
  nav2.innerHTML =
    `<span class="lvl2-label">${esc(group.label)} ›</span>` +
    group.items
      .map(
        (i) =>
          `<a href="#/${i.route}" class="${i.route === route ? "on" : ""}"${i.route === route ? ' aria-current="page"' : ""}>${esc(i.label)}</a>`,
      )
      .join("");
  return current;
}

async function navigate() {
  const raw = (location.hash.replace(/^#\//, "") || "dash").split("?")[0];
  if (ALIASES[raw]) {
    location.replace(`#/${ALIASES[raw]}`); // relance navigate() via hashchange
    return;
  }
  const [name, sub = ""] = raw.split("/");
  const view = VIEWS[name] || VIEWS.dash;
  const entry = renderNav(VIEWS[name] ? raw : "dash");
  setPageTitle(entry?.label || view.title);
  $main().innerHTML = `<div class="card muted">Chargement…</div>`;
  try {
    await view.render($main(), sub);
  } catch (e) {
    $main().innerHTML = `<div class="note bad">Erreur : ${esc(e.message)}</div>`;
  }
}

function renderPropertySwitch() {
  const el = document.getElementById("propertySwitch");
  const entries = [{ id: 0, name: "Tous" }, ...state.properties];
  el.innerHTML = entries
    .map((p) => `<a data-pid="${p.id}" class="${p.id === state.propertyId ? "on" : ""}">${esc(p.name)}</a>`)
    .join(" · ");
  el.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      state.propertyId = Number(a.dataset.pid);
      localStorage.setItem("gp_property", String(state.propertyId));
      state.tarifUnit = null;
      renderPropertySwitch();
      refreshBadges();
      navigate();
    }),
  );
  const prop = state.properties.find((p) => p.id === state.propertyId);
  document.getElementById("publicLink").href = prop ? `/book/?property=${encodeURIComponent(prop.slug)}` : "/book/";
}

/** Compteurs des trois entrées à pastille (#25) : ce qui attend une action.
 *  Silencieux en cas d'échec — un compteur absent ne doit jamais empêcher
 *  d'ouvrir une vue. */
export async function refreshBadges() {
  const targets = state.propertyId === 0 ? state.properties : state.properties.filter((p) => p.id === state.propertyId);
  const next = { today: 0, sales: 0, messages: 0 };
  try {
    const all = await Promise.all(targets.map((p) => api(`/api/admin/overview?property=${p.id}`)));
    for (const d of all) {
      const a = d.alerts || {};
      const h = d.health || {};
      next.today +=
        (a.overdueBalances?.length || 0) + (a.feedAlerts?.length || 0) +
        (h.orphanPayments?.length || 0) + (h.overpaidBookings?.length || 0) +
        (h.failedEmails?.length || 0) + (h.beds24Stale ? 1 : 0) +
        (h.drift?.length || 0);
      next.sales += (a.activeHolds?.length || 0) + (d.kpis?.balanceDueCount || 0);
      next.messages += a.newEmails || 0;
    }
  } catch {
    return; // compteurs indisponibles : la navigation reste utilisable
  }
  Object.assign(badges, next);
  renderNav((location.hash.replace(/^#\//, "") || "dash").split("?")[0]);
}

// ---------------------------------------------------------------------------
// VUE — Mise en route (checklist légale & technique, une page)
// ---------------------------------------------------------------------------

registerView("startup", "Mise en route", async (root) => {
  const { items } = await api("/api/admin/checklist");
  const STATUS = {
    a_faire: ["À faire", "t-bad"], en_cours: ["En cours", "t-warn"],
    fait: ["Fait", "t-ok"], verifie: ["Vérifié ✓", "t-ok"], n_a: ["Sans objet", "t-mut"],
  };
  const OWNER = { papa: "Papa", julien: "Julien", claude: "Claude" };
  const isDone = (s) => ["fait", "verifie", "n_a"].includes(s);
  const done = items.filter((i) => isDone(i.status)).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const sections = [];
  for (const it of items) {
    let s = sections.find((x) => x.name === it.section);
    if (!s) { s = { name: it.section, items: [] }; sections.push(s); }
    s.items.push(it);
  }

  root.innerHTML = `
    <div class="note">
      <b>Décisions actées (18/07)</b> : garantie = <b>arrhes</b> (conservées si le locataire annule — pas de caution) ·
      exploitation = <b>père en personne physique</b> (pas d'entité TVA) · <b>un seul site</b>, hébergement portable ·
      informations de rareté <b>factuelles et sobres</b> uniquement (jamais de marketing agressif).
    </div>
    <div class="card mb">
      <div class="row"><div><b>${done} / ${items.length}</b> éléments réglés</div>
        <div style="flex:2;background:#EEECE6;border-radius:6px;height:12px;align-self:center"><div style="width:${pct}%;background:var(--accent);height:12px;border-radius:6px"></div></div>
        <div class="n muted small">${pct} %</div></div>
    </div>
    ${sections
      .map(
        (s) => `<div class="card mb"><h3>${esc(s.name)} <span class="muted">(${s.items.filter((i) => isDone(i.status)).length}/${s.items.length})</span></h3>
        <table>${s.items
          .map(
            (i) => `<tr data-check="${i.id}" style="${isDone(i.status) ? "opacity:.6" : ""}">
            <td style="width:120px"><select class="ckStatus">${Object.entries(STATUS)
              .map(([v, [l]]) => `<option value="${v}" ${i.status === v ? "selected" : ""}>${l}</option>`)
              .join("")}</select></td>
            <td style="width:64px"><span class="tag ${i.owner === "claude" ? "t-ok" : i.owner === "julien" ? "t-chan" : "t-warn"}">${OWNER[i.owner]}</span></td>
            <td><b>${esc(i.label)}</b>${i.url ? ` <a href="${esc(i.url)}" target="_blank" rel="noopener">↗</a>` : ""}
              <div class="small muted">${esc(i.note ?? "")}</div></td>
            <td style="width:210px"><input class="ckNote" placeholder="n° obtenu, date, remarque…"></td>
          </tr>`,
          )
          .join("")}</table></div>`,
      )
      .join("")}
    <p class="small muted">« Fait » = démarche accomplie · « Vérifié ✓ » = confirmé pièce en main. Les éléments Claude se règlent automatiquement dès que leurs prérequis (jetons, clés, numéros) sont fournis.</p>`;

  root.querySelectorAll("tr[data-check]").forEach((tr) => {
    const id = tr.dataset.check;
    tr.querySelector(".ckStatus").addEventListener("change", async (e) => {
      await api(`/api/admin/checklist/${id}`, { method: "PATCH", body: { status: e.target.value } });
      toast("Checklist mise à jour");
      navigate();
    });
    const noteInput = tr.querySelector(".ckNote");
    noteInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      const extra = noteInput.value.trim();
      if (!extra) return;
      const current = items.find((x) => x.id === Number(id))?.note ?? "";
      await api(`/api/admin/checklist/${id}`, { method: "PATCH", body: { note: (current ? current + " — " : "") + extra } });
      toast("Note enregistrée");
      navigate();
    });
  });
});

// ---------------------------------------------------------------------------
// VUE — Tableau de bord
// ---------------------------------------------------------------------------

registerView("dash", "Tableau de bord", async (root) => {
  if (state.propertyId === 0) return renderDashAll(root);
  const data = await api(`/api/admin/overview?property=${state.propertyId}`);
  const k = data.kpis;
  const occDelta = Math.round((k.occupancyPct - k.occupancyPrevPct) * 10) / 10;
  const revDelta = k.revenuePrevCents > 0 ? Math.round(((k.revenueCents - k.revenuePrevCents) / k.revenuePrevCents) * 100) : null;
  const monthName = new Date(data.today + "T12:00:00Z").toLocaleDateString("fr-BE", { month: "long" });

  const movRows = data.movements
    .map(
      (m) => `<tr class="clickable" data-booking="${m.id}">
        <td>${m.kind === "arrivée" ? "→" : "←"} ${m.kind === "arrivée" ? dshort(m.checkin) : dshort(m.checkout)}</td>
        <td>${esc(m.unitName)}</td><td>${esc(m.guestName || "—")}</td><td>${m.persons}</td>
        <td>${bookingTag({ ...m, source: "direct" }, data.today, m.kind === "arrivée" ? "arrival" : "departure")}</td></tr>`,
    )
    .join("");

  const alerts = [];
  for (const b of data.alerts.overdueBalances) {
    alerts.push(`<tr><td>⚠️ Solde en retard</td><td>${esc(b.guestName || b.reference)} — ${eur(b.balanceCents)} (échéance ${dfr(b.balanceDueDate)})</td></tr>`);
  }
  for (const l of data.alerts.linkAlerts) {
    alerts.push(`<tr><td>🔗 Liaison active</td><td>Résa « ${esc(l.unitName)} » ${dshort(l.checkin)}–${dshort(l.checkout)} → ${esc(l.blocked.join(" + "))} bloqués</td></tr>`);
  }
  for (const f of data.alerts.feedAlerts) {
    alerts.push(`<tr><td>📡 Flux iCal</td><td>${esc(f.name)} : ${esc(f.status)}</td></tr>`);
  }
  for (const h of data.alerts.activeHolds) {
    alerts.push(`<tr><td>⏳ Option en cours</td><td>${esc(h.reference)} — ${esc(h.unitName)} (expire ${esc((h.holdExpiresAt || "").slice(11, 16))} UTC)</td></tr>`);
  }
  if (data.alerts.newEmails > 0) {
    alerts.push(`<tr class="clickable" onclick="location.hash='#/messages'"><td>✉️ Messages</td><td>${data.alerts.newEmails} message(s) client à traiter</td></tr>`);
  }
  if (alerts.length === 0) alerts.push(`<tr><td colspan="2" class="muted">Rien à signaler.</td></tr>`);

  // --- Carte « Santé » : ce qui échoue en coulisses sans que personne ne le
  //     voie (paiement encaissé sans séjour, email de voucher jamais parti,
  //     synchro Beds24 figée, erreur technique). Audit ECC du 2026-07-30.
  const h = data.health || {};
  const santeRows = [];
  for (const p of h.orphanPayments || []) {
    santeRows.push(`<tr class="clickable" data-booking="${p.bookingId}"><td><span class="tag t-warn">Paiement</span></td>
      <td><b>${esc(p.reference)}</b> — encaissé ${eur(p.amountCents)} mais la réservation est « ${esc(p.bookingStatus)} ». À traiter aujourd'hui (rembourser ou reloger).</td></tr>`);
  }
  for (const o of h.overpaidBookings || []) {
    santeRows.push(`<tr class="clickable" data-booking="${o.bookingId}"><td><span class="tag t-warn">Trop-perçu</span></td>
      <td><b>${esc(o.reference)}</b> — encaissé ${eur(o.overpaidCents)} de plus que le total dû. À rembourser (deux sessions de paiement ont pu aboutir).</td></tr>`);
  }
  for (const m of h.failedEmails || []) {
    santeRows.push(`<tr><td><span class="tag t-warn">Email</span></td>
      <td>Envoi « ${esc(m.kind)} » échoué vers ${esc(m.toEmail)}${m.errorDetail ? ` <span class="muted small">(${esc(m.errorDetail)})</span>` : ""} — le client n'a rien reçu.</td></tr>`);
  }
  if (h.beds24Stale) {
    santeRows.push(`<tr class="clickable" onclick="location.hash='#/canaux'"><td><span class="tag t-warn">Beds24</span></td>
      <td>Aucun rapatriement depuis ${h.beds24StaleHours} h — les calendriers OTA peuvent vendre des dates déjà prises.</td></tr>`);
  }
  for (const e of h.recentErrors || []) {
    santeRows.push(`<tr><td><span class="tag t-mut">Technique</span></td>
      <td>${esc(e.action)}${e.entity ? ` <span class="muted small">${esc(e.entity)}</span>` : ""} — ${esc((e.createdAt || "").slice(0, 16))}</td></tr>`);
  }
  // Dérives LENTES (issue #71) : rien n'a échoué, il ne se passe simplement
  // plus rien. Chaque signal porte le lien de l'écran où on agit (issue #48).
  for (const d of h.drift || []) {
    santeRows.push(`<tr class="clickable" data-goto="${esc(d.href)}"><td><span class="tag t-warn">${esc(d.label)}</span></td>
      <td>${esc(d.detail)}</td></tr>`);
  }

  root.innerHTML = `
    <div class="grid c4 mb">
      <div class="card kpi"><div class="l">Occupation ${esc(monthName)}</div><div class="v">${k.occupancyPct} %</div>
        <div class="d ${occDelta >= 0 ? "up" : "down"}">${occDelta >= 0 ? "▲ +" : "▼ "}${occDelta} pts vs N-1</div></div>
      <div class="card kpi"><div class="l">Revenus ${esc(monthName)}</div><div class="v">${eur(k.revenueCents)}</div>
        <div class="d ${revDelta == null ? "muted" : revDelta >= 0 ? "up" : "down"}">${revDelta == null ? "pas de N-1" : (revDelta >= 0 ? "▲ +" : "▼ ") + revDelta + " %"}</div></div>
      <div class="card kpi"><div class="l">Prochaine arrivée</div>
        <div class="v">${k.nextArrival ? esc(dowLetter(k.nextArrival.checkin)) + " " + dshort(k.nextArrival.checkin) : "—"}</div>
        <div class="d">${k.nextArrival ? esc(k.nextArrival.unitName) + " · " + k.nextArrival.persons + " p." : "aucune résa à venir"}</div></div>
      <div class="card kpi"><div class="l">À encaisser (soldes)</div><div class="v">${eur(k.balanceDueTotalCents)}</div>
        <div class="d">${k.balanceDueCount > 0 ? `<span class="tag t-warn">${k.balanceDueCount} dossier${k.balanceDueCount > 1 ? "s" : ""}</span>` : `<span class="tag t-ok">à jour</span>`}</div></div>
    </div>
    <div class="grid c2">
      <div class="card">
        <h3>Arrivées &amp; départs — 7 jours</h3>
        <table><tr><th>Mouvement</th><th>Unité</th><th>Client</th><th>Pers.</th><th>Statut</th></tr>
        ${movRows || `<tr><td colspan="5" class="muted">Aucun mouvement cette semaine.</td></tr>`}</table>
      </div>
      <div class="card"><h3>Alertes</h3><table>${alerts.join("")}</table></div>
    </div>
    <div class="card mt">
      <h3>Santé du système ${santeRows.length === 0 ? `<span class="tag t-ok">tout va bien</span>` : `<span class="tag t-warn">${santeRows.length} point(s) à voir</span>`}</h3>
      ${
        santeRows.length === 0
          ? `<p class="muted small">Paiements, envois d'emails et synchronisation des canaux : rien d'anormal dans les dernières 24 h.</p>`
          : `<table>${santeRows.join("")}</table>`
      }
    </div>`;
  root.querySelectorAll("[data-booking]").forEach((tr) => tr.addEventListener("click", () => openBooking(Number(tr.dataset.booking))));
  root.querySelectorAll("[data-goto]").forEach((tr) =>
    tr.addEventListener("click", () => {
      location.hash = tr.dataset.goto;
    }),
  );
});

// --- Tableau de bord « Tous les domaines » : tous mes biens d'un coup d'œil --

async function renderDashAll(root) {
  const today = todayIso();
  const horizon = addDaysIso(today, 90);
  const perProperty = await Promise.all(
    state.properties.map(async (p) => {
      const [units, planning, overview] = await Promise.all([
        api(`/api/admin/units?property=${p.id}`),
        api(`/api/admin/planning?property=${p.id}&from=${today}&to=${horizon}`),
        api(`/api/admin/overview?property=${p.id}`),
      ]);
      return { property: p, units: units.units, planning, overview };
    }),
  );

  // une carte par bien : photo, prochaine résa (ou blocage par liaison)
  const cards = [];
  const allMovements = [];
  const allAlerts = [];
  for (const { property, units, planning, overview } of perProperty) {
    for (const u of units.filter((x) => x.active)) {
      const own = planning.bookings
        .filter((b) => b.unitId === u.id && b.checkout > today)
        .sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
      const blocks = planning.blocks
        .filter((b) => b.unitId === u.id && b.checkout > today)
        .sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
      const next = own[0];
      const nextBlock = blocks[0];
      let nextLine = `<span class="tag t-ok">libre 90 j</span>`;
      if (next && (!nextBlock || next.checkin <= nextBlock.checkin)) {
        const current = next.checkin <= today;
        nextLine = `${current ? "En cours" : "Prochaine"} : <b>${dshort(next.checkin)}→${dshort(next.checkout)}</b> · ${esc(next.guestName)}`;
      } else if (nextBlock) {
        nextLine = `Bloqué (liaison) ${dshort(nextBlock.checkin)}→${dshort(nextBlock.checkout)} <span class="muted small">${esc(nextBlock.sourceReference)}</span>`;
      }
      cards.push(`<div class="bien" data-goto="${property.id}">
        <div class="ph" ${u.photoUrl ? `style="background-image:url('${esc(u.photoUrl)}')"` : ""}>${u.photoUrl ? "" : "photo"}</div>
        <div class="bd"><b>${esc(u.name)} ${u.isComposite ? "🔗" : ""}</b>
          <span class="sub">${esc(property.name)} · ${u.capacityBase}${u.capacityMax > u.capacityBase ? "-" + u.capacityMax : ""} p.</span>
          <div class="next">${nextLine}</div></div>
      </div>`);
    }
    allMovements.push(...overview.movements.map((m) => ({ ...m, propertyName: property.name })));
    const a = overview.alerts;
    for (const b of a.overdueBalances) allAlerts.push(`⚠️ ${esc(property.name)} — solde en retard ${esc(b.reference)} (${eur(b.balanceCents)})`);
    for (const f of a.feedAlerts) allAlerts.push(`📡 ${esc(property.name)} — flux ${esc(f.name)} : ${esc(f.status)}`);
  }

  root.innerHTML = `
    <h3>Mes biens</h3>
    <div class="biens mb">${cards.join("")}</div>
    <div class="grid c2">
      <div class="card"><h3>Arrivées &amp; départs — 7 jours (tous domaines)</h3>
        <table><tr><th>Mouvement</th><th>Domaine</th><th>Unité</th><th>Client</th><th>Pers.</th></tr>
        ${allMovements
          .map((m) => `<tr class="clickable" data-booking="${m.id}"><td>${m.kind === "arrivée" ? "→" : "←"} ${m.kind === "arrivée" ? dshort(m.checkin) : dshort(m.checkout)}</td>
            <td class="muted">${esc(m.propertyName)}</td><td>${esc(m.unitName)}</td><td>${esc(m.guestName || "—")}</td><td>${m.persons}</td></tr>`)
          .join("") || `<tr><td colspan="5" class="muted">Aucun mouvement cette semaine.</td></tr>`}</table>
      </div>
      <div class="card"><h3>Alertes</h3>
        ${allAlerts.length ? `<table>${allAlerts.map((a) => `<tr><td>${a}</td></tr>`).join("")}</table>` : `<p class="muted small">Rien à signaler.</p>`}
      </div>
    </div>`;
  root.querySelectorAll("[data-booking]").forEach((tr) => tr.addEventListener("click", () => openBooking(Number(tr.dataset.booking))));
  root.querySelectorAll("[data-goto]").forEach((c) =>
    c.addEventListener("click", () => {
      state.propertyId = Number(c.dataset.goto);
      localStorage.setItem("gp_property", String(state.propertyId));
      location.hash = "#/cal";
      location.reload();
    }),
  );
}

// ---------------------------------------------------------------------------
// Couche « Occupation » du calendrier (ex-vue Planning, #25)
// ---------------------------------------------------------------------------

/** Grille des réservations du mois, une ligne par bien. Le mois et sa
 *  navigation appartiennent maintenant au calendrier unifié : cette fonction
 *  ne rend que le corps de la couche. */
export async function renderOccupation(root, monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  const nbDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const nextMonth = addDaysIso(monthStart, nbDays);
  const today = todayIso();

  // « Tous » → un planning par domaine, empilés
  const targets = state.propertyId === 0 ? state.properties : state.properties.filter((p) => p.id === state.propertyId);
  const dataSets = await Promise.all(
    targets.map(async (p) => ({
      property: p,
      data: await api(`/api/admin/planning?property=${p.id}&from=${monthStart}&to=${nextMonth}`),
    })),
  );

  // en-tête des jours
  let header = "<div></div>";
  for (let d = 0; d < nbDays; d++) {
    const iso = addDaysIso(monthStart, d);
    const cls = iso === today ? "today" : isWeekendDay(iso) ? "we" : "";
    header += `<div class="h ${cls}">${dowLetter(iso)}${d + 1}</div>`;
  }

  // une ligne par unité : barres (résas), hachures (blocages), cellules libres.
  // Les cellules libres portent unité + date : c'est ce qui permet de tirer
  // une plage à la souris pour poser un blocage manuel (issue #74).
  function rowFor(unit, data) {
    const segs = [];
    for (const b of data.bookings.filter((x) => x.unitId === unit.id)) {
      const start = Math.max(0, diffDaysIso(monthStart, b.checkin));
      const end = Math.min(nbDays, diffDaysIso(monthStart, b.checkout));
      if (end <= start) continue;
      segs.push({ start, span: end - start, type: "booking", b });
    }
    for (const blk of data.blocks.filter((x) => x.unitId === unit.id)) {
      const start = Math.max(0, diffDaysIso(monthStart, blk.checkin));
      const end = Math.min(nbDays, diffDaysIso(monthStart, blk.checkout));
      if (end <= start) continue;
      segs.push({ start, span: end - start, type: "block", blk });
    }
    for (const mb of (data.manualBlocks || []).filter((x) => x.unitId === unit.id)) {
      const start = Math.max(0, diffDaysIso(monthStart, mb.checkin));
      const end = Math.min(nbDays, diffDaysIso(monthStart, mb.checkout));
      if (end <= start) continue;
      segs.push({ start, span: end - start, type: "manual", mb });
    }
    segs.sort((a, b2) => a.start - b2.start);

    const freeCell = (index) => {
      const iso = addDaysIso(monthStart, index);
      return `<div class="cell ${isWeekendDay(iso) ? "we" : ""}" data-unit="${unit.id}" data-date="${iso}"></div>`;
    };

    let html = `<div class="u">${esc(unit.name)}${unit.isComposite ? ' <span class="muted">🔗</span>' : ""}</div>`;
    let cursor = 0;
    for (const s of segs) {
      // Deux segments peuvent se recouvrir sur une ligne combinée (une résa sur
      // une maison et un blocage sur l'autre bloquent tous deux le Domaine).
      // Sans ce rognage, le curseur reculerait et TOUTE la ligne se décalerait
      // d'un jour ou plus (contre-review Gemini, 2026-08-28).
      if (s.start < cursor) {
        s.span -= cursor - s.start;
        s.start = cursor;
        if (s.span <= 0) continue;
      }
      for (; cursor < s.start; cursor++) html += freeCell(cursor);
      if (s.type === "booking") {
        const b = s.b;
        const cls = b.status === "pending" ? "pending" : b.source === "ical" ? "channel" : b.isComposite ? "composite" : "";
        const label = `${b.guestName} · ${b.persons}p` + (b.paidState === "acompte" || b.paidState === "impayée" ? ` · ${b.paidState === "acompte" ? "solde dû" : "impayée"}` : "");
        html += `<div class="bar ${cls}" style="grid-column: span ${s.span}" title="${esc(b.reference)} — ${dfr(b.checkin)} → ${dfr(b.checkout)}" data-booking="${b.id}">${esc(label)}</div>`;
      } else if (s.type === "manual") {
        const mb = s.mb;
        html += `<div class="mblk" style="grid-column: span ${s.span}" title="Bloqué — ${esc(mb.reason)} (${dfr(mb.checkin)} → ${dfr(mb.checkout)}${mb.createdBy ? ", " + esc(mb.createdBy) : ""})">
          <span class="mblk-t">${esc(mb.reason)}</span>
          <button type="button" class="mblk-x" data-unblock="${mb.id}" title="Lever ce blocage" aria-label="Lever le blocage : ${esc(mb.reason)}">×</button>
        </div>`;
      } else {
        html += `<div class="blk" style="grid-column: span ${s.span}" title="Bloqué par liaison — ${esc(s.blk.sourceReference)}"></div>`;
      }
      cursor = s.start + s.span;
    }
    for (; cursor < nbDays; cursor++) html += freeCell(cursor);
    return html;
  }

  const grids = dataSets
    .map(
      ({ property, data }) => `
      ${dataSets.length > 1 ? `<h3 style="margin:14px 0 8px">${esc(property.name)}</h3>` : ""}
      <div class="plan-wrap"><div class="plan" style="grid-template-columns:170px repeat(${nbDays},minmax(24px,1fr))">
        ${header}
        ${data.units.filter((u) => u.active).map((u) => rowFor(u, data)).join("")}
      </div></div>`,
    )
    .join("");

  root.innerHTML = `
    <div class="note">Les lignes combinées (🔗, ex. <b>Domaine entier</b>) sont calculées : elles se bloquent dès qu'un bien lié est réservé, et réciproquement. Aucune action manuelle.</div>
    <div class="card">
      <div class="row mb"><div class="right n"><button class="btn sm" id="newSale">+ Nouvelle vente (tél.)</button></div></div>
      <p class="small muted mb">Glisse sur des jours libres pour <b>bloquer</b> des dates (travaux, usage personnel). Un blocage se lève en cliquant sa croix.</p>
      ${grids}
      <div class="legend">Libre <i style="background:#EFF3EC"></i> Réservé <i style="background:var(--accent)"></i>
        Résa combinée <i style="background:var(--accent2)"></i> Option en cours <i style="background:repeating-linear-gradient(45deg,var(--accent),var(--accent) 4px,#4a7a5c 4px,#4a7a5c 8px)"></i>
        Canal externe (iCal) <i style="background:var(--chan)"></i> Bloqué par liaison <i class="blk" style="border:1px solid #ccc"></i>
        Blocage manuel <i class="mblk-key"></i></div>
    </div>`;

  root.querySelector("#newSale").onclick = () => openNewSale();
  root.querySelectorAll("[data-booking]").forEach((el) => el.addEventListener("click", () => openBooking(Number(el.dataset.booking))));

  // --- lever un blocage en un clic
  root.querySelectorAll("[data-unblock]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await api(`/api/admin/blocks/${Number(btn.dataset.unblock)}`, { method: "DELETE" });
        toast("Blocage levé — les dates redeviennent vendables.");
        navigate();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, true);
      }
    }),
  );

  wireBlockSelection(root, dataSets);
}

/** Sélection d'une plage de jours libres sur une ligne du planning, pour poser
 *  un blocage manuel. Contrainte volontaire : la sélection ne franchit ni une
 *  réservation ni un blocage — on ne peut donc pas dessiner une plage que le
 *  serveur refusera à coup sûr. La vérité reste l'insertion atomique : ce
 *  geste ne fait que PROPOSER des dates (issue #74). */
function wireBlockSelection(root, dataSets) {
  const unitName = new Map();
  for (const { data } of dataSets) for (const u of data.units) unitName.set(u.id, u.name);

  let unitId = null;
  let anchor = null;
  let head = null;
  const cells = [...root.querySelectorAll(".cell[data-date]")];
  const range = () => (anchor <= head ? [anchor, head] : [head, anchor]);

  // Jours libres par hébergement : seules les cellules vides en portent un.
  // C'est ce qui permet d'arrêter la sélection AVANT une réservation, plutôt
  // que de laisser dessiner une plage que le serveur refusera.
  const freeDays = new Map();
  for (const c of cells) {
    const u = Number(c.dataset.unit);
    if (!freeDays.has(u)) freeDays.set(u, new Set());
    freeDays.get(u).add(c.dataset.date);
  }

  /** Dernier jour atteignable depuis l'ancre sans franchir une nuit occupée. */
  const clamp = (target) => {
    const free = freeDays.get(unitId);
    const step = target >= anchor ? 1 : -1;
    let last = anchor;
    for (let d = anchor; step > 0 ? d <= target : d >= target; d = addDaysIso(d, step)) {
      if (!free || !free.has(d)) break;
      last = d;
    }
    return last;
  };

  const paint = () => {
    const [a, b] = anchor ? range() : [null, null];
    for (const c of cells) {
      const on = a != null && Number(c.dataset.unit) === unitId && c.dataset.date >= a && c.dataset.date <= b;
      c.classList.toggle("sel", on);
    }
  };
  const reset = () => { unitId = null; anchor = null; head = null; paint(); };

  for (const cell of cells) {
    cell.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      unitId = Number(cell.dataset.unit);
      anchor = cell.dataset.date;
      head = anchor;
      paint();
    });
    cell.addEventListener("mouseenter", () => {
      if (anchor == null || Number(cell.dataset.unit) !== unitId) return;
      head = clamp(cell.dataset.date);
      paint();
    });
  }

  const finish = () => {
    if (anchor == null) return;
    const [from, toInclusive] = range();
    const unit = unitId;
    reset();
    openBlockDates(unit, unitName.get(unit) || `Unité ${unit}`, from, toInclusive);
  };
  if (blockDragRelease) document.removeEventListener("mouseup", blockDragRelease);
  blockDragRelease = finish;
  document.addEventListener("mouseup", blockDragRelease);
}

/** Un seul écouteur de relâchement pour toute la session, remplacé à chaque
 *  rendu — sinon ils s'empilent d'un mois à l'autre. */
let blockDragRelease = null;

/** Poser un blocage : motif obligatoire, dates rappelées en clair. Le départ
 *  est exclusif comme partout ailleurs (dernière nuit + 1). */
function openBlockDates(unitId, unitName, from, toInclusive) {
  const checkout = addDaysIso(toInclusive, 1);
  const nights = diffDaysIso(from, checkout);
  const modal = openModal(`
    <h2>Bloquer des dates <button class="x">×</button></h2>
    <div class="note"><b>${esc(unitName)}</b> — du ${dfr(from)} au ${dfr(checkout)}
      (${nights} nuit${nights > 1 ? "s" : ""}). Ces dates ne seront plus vendables, ici comme sur les canaux externes.
      Un blocage n'est pas une réservation : il n'entre ni dans les statistiques de vente, ni dans les relances.</div>
    <label class="f" for="blkReason">Motif</label>
    <input id="blkReason" list="blkReasons" placeholder="travaux, usage personnel, entretien…" maxlength="200">
    <datalist id="blkReasons">
      <option value="Travaux"></option><option value="Usage personnel"></option>
      <option value="Entretien"></option><option value="Ménage approfondi"></option>
    </datalist>
    <div class="row" style="margin-top:12px">
      <div class="right n"><button class="btn" id="blkGo">Bloquer ces dates</button></div>
    </div>`);
  const input = modal.querySelector("#blkReason");
  input.focus();
  const go = modal.querySelector("#blkGo");
  go.onclick = async () => {
    const reason = input.value.trim();
    if (reason.length < 2) return toast("Indique un motif — c'est ce qu'on relit six mois plus tard.", true);
    // Sans ce verrou, un double-clic pose deux blocages : le second échoue en
    // conflit avec le premier, et l'utilisateur voit une erreur incompréhensible.
    go.disabled = true;
    try {
      await api("/api/admin/blocks", { method: "POST", body: { unitId, checkin: from, checkout, reason } });
      modal.remove();
      toast(`Bloqué : ${unitName}, ${dfr(from)} → ${dfr(checkout)}.`);
      navigate();
    } catch (e) {
      go.disabled = false;
      toast(e.message, true);
    }
  };
}

// ---------------------------------------------------------------------------
// VUE — Réservations (+ fiche résa + nouvelle vente)
// ---------------------------------------------------------------------------

/** Les quatre périodes de la liste des réservations (issue #51), dans l'ordre
 *  d'affichage. `all` ne filtre rien — c'est le refuge de la recherche. */
const RESA_PERIODS = [
  ["upcoming", "À venir", "Aucune arrivée à venir."],
  ["current", "En cours", "Personne sur place aujourd’hui."],
  ["past", "Passées", "Aucun séjour passé."],
  ["all", "Toutes", "Aucune réservation."],
];

registerView("resa", "Réservations", async (root) => {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const status = params.get("status") || "";
  const search = params.get("search") || "";
  // Défaut : « à venir », pour que la vue réponde à « qui arrive bientôt ? »
  // sans un clic. Exception : une recherche cherche dans TOUT l'historique —
  // sinon taper une référence de l'an dernier ne renvoie rien.
  const known = RESA_PERIODS.some(([k]) => k === params.get("period"));
  const period = known ? params.get("period") : search ? "all" : "upcoming";
  const q = new URLSearchParams({ property: String(state.propertyId) });
  if (status) q.set("status", status);
  if (search) q.set("search", search);
  if (period !== "all") q.set("period", period);
  const data = await api(`/api/admin/bookings?${q}`);
  // Le jour de référence vient du serveur (fuseau Europe/Brussels) : c'est lui
  // qui a filtré, l'horloge du poste ne doit pas dire autre chose.
  const today = data.today || todayIso();
  const empty = RESA_PERIODS.find(([k]) => k === period)?.[2] ?? "Aucune réservation.";

  root.innerHTML = `
    <div class="card">
      <div class="row mb">
        <div class="n" style="min-width:220px"><label class="f">Recherche</label>
          <input id="fSearch" placeholder="référence, nom, email…" value="${esc(search)}"></div>
        <div class="n"><label class="f">Statut</label>
          <select id="fStatus">
            <option value="">Tous</option>
            <option value="confirmed" ${status === "confirmed" ? "selected" : ""}>Confirmées</option>
            <option value="pending" ${status === "pending" ? "selected" : ""}>Options en cours</option>
            <option value="cancelled" ${status === "cancelled" ? "selected" : ""}>Annulées</option>
          </select></div>
        <div class="n"><button class="btn o sm" id="exportCsv">Export CSV</button></div>
        <div class="n"><button class="btn o sm" id="importElloha">Importer elloha</button></div>
        <div class="right n"><button class="btn" id="newSale">+ Nouvelle vente (tél.)</button></div>
      </div>
      <div class="chips" role="group" aria-label="Période">
        ${RESA_PERIODS.map(
          ([key, label]) =>
            `<button type="button" class="chip${key === period ? " on" : ""}" data-period="${key}"
              aria-pressed="${key === period}">${label}</button>`,
        ).join("")}
        <span class="small muted" style="margin-left:auto">Triées par date d’arrivée${period === "upcoming" || period === "current" ? " (la plus proche en tête)" : " (la plus récente en tête)"}</span>
      </div>
      <table>
        <tr><th>N°</th><th>Unité</th><th>Séjour</th><th>Client</th><th class="r">Total</th><th class="r">Payé</th><th>Statut</th><th>Source</th></tr>
        ${data.bookings
          .map(
            (b) => `<tr class="clickable" data-booking="${b.id}">
          <td class="mono">${esc(b.reference)}</td><td>${esc(b.unitName)}</td>
          <td>${dshort(b.checkin)}→${dshort(b.checkout)}</td>
          <td>${esc(b.guestName || b.channelLabel || "—")}</td>
          <td class="r">${b.totalCents ? eur(b.totalCents) : "—"}</td>
          <td class="r">${b.paidCents ? eur(b.paidCents) : "—"}</td>
          <td>${bookingTag(b, today)}</td><td class="muted">${sourceFr(b.source)}</td></tr>`,
          )
          .join("") || `<tr><td colspan="8" class="muted">${esc(empty)}</td></tr>`}
      </table>
    </div>`;

  const apply = (nextPeriod = period) => {
    const s = root.querySelector("#fSearch").value.trim();
    const st = root.querySelector("#fStatus").value;
    const p = new URLSearchParams();
    p.set("period", nextPeriod);
    if (st) p.set("status", st);
    if (s) p.set("search", s);
    location.hash = `#/resa?${p}`;
  };
  // La recherche porte sur TOUT l'historique — chercher une référence de l'an
  // dernier depuis « à venir » ne doit pas renvoyer une liste vide. Elle
  // bascule donc sur « Toutes », et l'effacer ramène à la vue de travail par
  // défaut. Règle sans état caché : l'URL dit toujours ce qui est affiché.
  const applySearch = () => apply(root.querySelector("#fSearch").value.trim() ? "all" : "upcoming");
  root.querySelectorAll("[data-period]").forEach((b) => (b.onclick = () => apply(b.dataset.period)));
  root.querySelector("#fStatus").onchange = () => apply();
  root.querySelector("#fSearch").onkeydown = (e) => e.key === "Enter" && applySearch();
  root.querySelector("#newSale").onclick = () => openNewSale();
  root.querySelector("#exportCsv").onclick = () => downloadCsv(`/api/admin/bookings.csv?property=${state.propertyId}`, "reservations.csv");
  root.querySelector("#importElloha").onclick = () => openEllohaImport();
  root.querySelectorAll("[data-booking]").forEach((tr) => tr.addEventListener("click", () => openBooking(Number(tr.dataset.booking))));
});

/** Modifier une réservation sans annuler-recréer (issue #73).
 *
 *  Le geste le plus fréquent au téléphone : « on décale d'une semaine »,
 *  « finalement on prend l'autre maison », « ce n'est pas le bon prénom ».
 *  Il imposait d'annuler puis de recréer, donc de perdre les paiements reçus
 *  et la preuve d'acceptation des CGV.
 *
 *  Deux temps, volontairement : on RECALCULE d'abord (le nouveau montant et
 *  l'écart avec le déjà-payé s'affichent), on valide ensuite. Personne ne doit
 *  découvrir un nouveau prix après coup.
 */
async function openEditBooking(b, onDone) {
  const { units } = await api(`/api/admin/units?property=${b.propertyId}`);
  const sellable = units.filter((u) => u.active);
  // `guestName` est la concaténation prénom + nom : on la redécoupe au premier
  // espace, et un nom d'un seul mot reste un NOM (jamais un prénom).
  const parts = String(b.guestName || "").trim().split(/\s+/).filter(Boolean);
  const firstName = parts.length > 1 ? parts[0] : "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : (parts[0] ?? "");

  const modal = openModal(`
    <h2>Modifier ${esc(b.reference)} <button class="x">×</button></h2>
    <div class="note">Les paiements reçus (${eur(b.paidCents)}) et la preuve d'acceptation des CGV sont conservés.
      Le créneau d'origine n'est libéré que si le nouveau est libre — sinon rien ne bouge.</div>
    <div class="row mb">
      <div class="n"><label class="f" for="edUnit">Hébergement</label>
        <select id="edUnit">${sellable
          .map((u) => `<option value="${u.id}" ${u.id === b.unitId ? "selected" : ""}>${esc(u.name)}</option>`)
          .join("")}</select></div>
      <div class="n"><label class="f" for="edIn">Arrivée</label><input type="date" id="edIn" value="${esc(b.checkin)}"></div>
      <div class="n"><label class="f" for="edOut">Départ</label><input type="date" id="edOut" value="${esc(b.checkout)}"></div>
      <div class="n"><label class="f" for="edAd">Adultes</label><input type="number" min="1" id="edAd" class="inline-num" value="${b.adults}"></div>
      <div class="n"><label class="f" for="edCh">Enfants</label><input type="number" min="0" id="edCh" class="inline-num" value="${b.children}"></div>
    </div>
    <div class="row mb">
      <div class="n"><label class="f" for="edFirst">Prénom</label><input id="edFirst" value="${esc(firstName)}"></div>
      <div class="n"><label class="f" for="edLast">Nom</label><input id="edLast" value="${esc(lastName)}"></div>
      <div class="n"><label class="f" for="edMail">Email</label><input id="edMail" value="${esc(b.guestEmail || "")}"></div>
    </div>
    <div id="edQuote" class="mb"></div>
    <div class="row">
      <div class="n"><button class="btn o sm" id="edCalc">Recalculer le devis</button></div>
      <div class="n"><button class="btn sm" id="edSave" disabled>Valider la modification</button></div>
    </div>`);

  const $ = (sel) => modal.querySelector(sel);
  const stay = () => ({
    unitId: Number($("#edUnit").value),
    checkin: $("#edIn").value,
    checkout: $("#edOut").value,
    adults: Number($("#edAd").value),
    children: Number($("#edCh").value),
  });
  const changedStay = () => {
    const s = stay();
    return s.unitId !== b.unitId || s.checkin !== b.checkin || s.checkout !== b.checkout
      || s.adults !== b.adults || s.children !== b.children;
  };

  // Toute retouche du séjour invalide le devis affiché : on ne valide jamais
  // sur un montant calculé pour d'autres dates.
  for (const sel of ["#edUnit", "#edIn", "#edOut", "#edAd", "#edCh"]) {
    $(sel).addEventListener("change", () => {
      $("#edSave").disabled = changedStay();
      if (changedStay()) $("#edQuote").innerHTML = `<div class="note">Dates ou hébergement modifiés — recalcule le devis avant de valider.</div>`;
    });
  }

  $("#edCalc").onclick = async () => {
    const s = stay();
    if (!s.checkin || !s.checkout || s.checkin >= s.checkout) return toast("Dates invalides", true);
    try {
      const { quote, availability } = await api("/api/admin/quote", { method: "POST", body: { ...s, bookingId: b.id } });
      const delta = (quote.ok ? quote.totalCents : 0) - b.paidCents;
      const conflictRows = (availability.conflicts || [])
        .map((c) => `<li>${esc(c.unitName)} — ${esc(c.reference)} (${dfr(c.checkin)} → ${dfr(c.checkout)})</li>`)
        .join("");
      $("#edQuote").innerHTML = `
        ${availability.available ? "" : `<div class="note bad"><b>Créneau indisponible.</b><ul>${conflictRows}</ul></div>`}
        ${quote.ok ? `<table class="quote">
            ${quote.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="r">${eur(l.amountCents)}</td></tr>`).join("")}
            <tr class="tot"><td>Nouveau total</td><td class="r">${eur(quote.totalCents)}</td></tr>
            <tr><td>Déjà payé (conservé)</td><td class="r">${eur(b.paidCents)}</td></tr>
            <tr class="tot"><td>${delta >= 0 ? "Solde à encaisser" : "Avoir à rembourser (à faire à la main)"}</td>
                <td class="r">${eur(Math.abs(delta))}</td></tr>
          </table>` : `<div class="note bad">Devis impossible : ${esc((quote.errors || []).join(", "))}</div>`}`;
      $("#edSave").disabled = !(quote.ok && availability.available);
    } catch (e) {
      toast(e.message, true);
    }
  };

  $("#edSave").onclick = async () => {
    const save = $("#edSave");
    save.disabled = true;
    try {
      const res = await api(`/api/admin/bookings/${b.id}`, {
        method: "PATCH",
        body: {
          ...stay(),
          guest: {
            firstName: $("#edFirst").value,
            lastName: $("#edLast").value,
            email: $("#edMail").value,
          },
        },
      });
      toast(
        res.refundCents > 0
          ? `Modifiée — avoir de ${eur(res.refundCents)} à rembourser à la main.`
          : res.balanceCents > 0
            ? `Modifiée — solde à encaisser : ${eur(res.balanceCents)}.`
            : "Modifiée — rien à régler.",
      );
      modal.remove();
      onDone();
    } catch (e) {
      save.disabled = false;
      toast(e.message, true);
    }
  };

  // Le devis d'ouverture décrit l'état actuel : on part de quelque chose.
  $("#edCalc").click();
}

// --- Import elloha (phase 2) — CSV collé, simulation d'abord ----------------

function openEllohaImport() {
  const modal = openModal(`
    <h2>Importer les réservations elloha <button class="x">×</button></h2>
    <div class="note">Colle ici l'export CSV des réservations FUTURES du compte elloha.
      En-têtes attendus : <span class="mono">unite;arrivee;depart;nom;prenom;email;telephone;adultes;enfants;total;paye;reference</span>
      — le format réel de l'export elloha sera calé au moment de la phase 2 (TODO_FORMAT_ELLOHA).
      La simulation ne modifie rien ; l'import réel utilise les mêmes garde-fous anti-conflit que le reste de la plateforme.</div>
    <textarea id="impCsv" rows="8" placeholder="unite;arrivee;depart;nom;..."></textarea>
    <div class="row" style="margin-top:10px">
      <div class="n"><button class="btn o sm" id="impDry">1. Tester (simulation)</button></div>
      <div class="n"><button class="btn sm" id="impReal" disabled>2. Importer réellement</button></div>
    </div>
    <div id="impResult" style="margin-top:12px"></div>`);

  const run = async (dryRun) => {
    const csv = modal.querySelector("#impCsv").value;
    if (!csv.trim()) return toast("Colle d'abord le CSV", true);
    const { result } = await api(`/api/admin/import/elloha?property=${currentPropertyId()}`, {
      method: "POST",
      body: { csv, dryRun },
    });
    const TAG = { importé: "t-ok", ok_simulé: "t-ok", conflit: "t-bad", "déjà_importé": "t-mut", erreur: "t-bad" };
    modal.querySelector("#impResult").innerHTML = `
      <div class="note">${dryRun ? "Simulation" : "Import réel"} : ${result.imported} ok · ${result.conflicts} conflit(s) · ${result.skipped} déjà importé(s) · ${result.errors} erreur(s) sur ${result.total} ligne(s).</div>
      <table><tr><th>Ligne</th><th>Statut</th><th>Détail</th></tr>
      ${result.rows.map((r) => `<tr><td>${r.line}</td><td><span class="tag ${TAG[r.status] || "t-mut"}">${esc(r.status)}</span></td>
        <td class="small">${esc(r.reference || "")} ${esc(r.message || "")}</td></tr>`).join("")}</table>`;
    modal.querySelector("#impReal").disabled = !dryRun || result.errors > 0 || result.total === 0;
    if (!dryRun) {
      toast(`Import terminé : ${result.imported} réservation(s) créée(s)`);
      navigate();
    }
  };
  modal.querySelector("#impDry").onclick = () => run(true).catch((e) => toast(e.message, true));
  modal.querySelector("#impReal").onclick = () => run(false).catch((e) => toast(e.message, true));
}

/** Journal d'audit → phrase lisible. Ce qui n'est pas listé ici s'affiche tel
 *  quel : mieux vaut une ligne technique qu'une ligne manquante. */
const HISTORY_FR = {
  "booking.confirmed": "Réservation confirmée (paiement en ligne)",
  "booking.confirm_manual": "Confirmée à la main",
  "booking.confirm_conflict": "Confirmation refusée — créneau repris",
  "booking.cancel": "Annulée",
  "booking.create": "Réservée en ligne par le client",
  "booking.create_manual": "Créée en vente manuelle",
  "booking.dates_updated": "Dates déplacées",
  "booking.modify": "Réservation modifiée (dates / hébergement)",
  "booking.modify_conflict": "Modification refusée — créneau déjà pris",
  "booking.modify_guest": "Coordonnées du client corrigées",
  "email.abandon_reminder": "Relance de réservation abandonnée",
  "email.balance_reminder": "Relance du solde envoyée",
  "email.inbound": "Email entrant rattaché",
  "email.voucher_resent": "Voucher renvoyé",
  "message.booking": "Message du client depuis son voucher",
  "message.reply": "Réponse envoyée au client",
  "payment.link_created": "Lien de paiement créé",
  "payment.manual": "Encaissement enregistré à la main",
  "payment.received": "Paiement reçu",
  "payment.expired": "Session de paiement expirée",
  "payment.expire_failed": "⚠️ Session non fermée chez Stripe — à vérifier",
  "payment.orphaned": "⚠️ Paiement orphelin — à traiter",
  "payment.overpaid": "⚠️ Trop-perçu",
  "voucher.error": "⚠️ Échec d'envoi du voucher",
  "receipt.error": "⚠️ Échec d'envoi du reçu",
};

/** « par qui » : l'auteur réel quand la route le trace (`detail.par`),
 *  sinon l'acteur brut (cron, stripe, public…). */
function historyWho(entry) {
  let par = null;
  try {
    par = entry.detail ? JSON.parse(entry.detail).par : null;
  } catch { /* detail non JSON : on retombe sur l'acteur */ }
  return par || entry.actor;
}

export async function openBooking(id) {
  const { booking: b, payments, emails, history, quote } = await api(`/api/admin/bookings/${id}`);
  const delta = b.totalCents - b.paidCents;
  const balance = Math.max(0, delta);
  // Un trop-perçu ne doit pas disparaître derrière un « solde : 0 € » : après
  // une modification à la baisse, c'est un avoir à rembourser à la main.
  const refund = Math.max(0, -delta);
  const quoteRows = quote?.lines
    ? quote.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="r">${eur(l.amountCents)}</td></tr>`).join("") +
      `<tr class="tot"><td>Total</td><td class="r">${eur(b.totalCents)}</td></tr>`
    : `<tr><td class="muted">Pas de devis enregistré</td><td class="r">${eur(b.totalCents)}</td></tr>`;
  const payRows = payments
    .map(
      (p) => `<tr><td>${esc((p.receivedAt || p.createdAt).slice(0, 10))}</td><td>${esc(p.kind)}</td><td>${esc(p.method)}</td>
      <td class="r">${eur(p.amountCents)}</td><td><span class="tag ${p.status === "succeeded" ? "t-ok" : p.status === "pending" ? "t-warn" : p.outcome ? "t-mut" : "t-bad"}">${p.outcome === "expired" ? "expirée" : p.outcome === "superseded" ? "remplacée" : esc(p.status)}</span></td></tr>`,
    )
    .join("");
  // Historique : le journal d'audit de la réservation, fusionné avec les envois
  // d'emails. Répond à « qui a relancé le solde, et quand ? » (issue #69).
  const historyRows = [
    ...(history || []).map((h) => ({
      at: h.createdAt,
      what: HISTORY_FR[h.action] || h.action,
      who: historyWho(h),
    })),
    ...(emails || []).map((e) => ({
      at: e.createdAt,
      what: `✉️ ${e.kind} → ${e.toEmail}${e.status === "sent" ? "" : ` (${e.status})`}`,
      who: "système",
    })),
  ]
    .sort((x, y) => (x.at < y.at ? 1 : -1))
    .map(
      (r) => `<tr><td class="small">${esc(r.at.slice(0, 16).replace("T", " "))}</td>
        <td>${esc(r.what)}</td><td class="small muted">${esc(r.who)}</td></tr>`,
    )
    .join("");

  const modal = openModal(`
    <h2>${esc(b.reference)} — ${esc(b.unitName)} ${bookingTag(b)} <button class="x">×</button></h2>
    <div class="formgrid mb">
      <div><label class="f">Séjour</label><b>${dfr(b.checkin)} → ${dfr(b.checkout)}</b></div>
      <div><label class="f">Voyageurs</label><b>${b.adults} adulte${b.adults > 1 ? "s" : ""}${b.children ? ` + ${b.children} enfant${b.children > 1 ? "s" : ""}` : ""}</b></div>
      <div><label class="f">Client</label><b>${esc(b.guestName || "—")}</b><div class="small muted">${esc(b.guestEmail || "")}</div></div>
      <div><label class="f">Source</label><b>${sourceFr(b.source)}${b.channelLabel ? " · " + esc(b.channelLabel) : ""}</b></div>
      <div><label class="f">Payé / Total</label><b>${eur(b.paidCents)} / ${eur(b.totalCents)}</b></div>
      <div><label class="f">${refund > 0 ? "À rembourser" : "Solde"}</label><b${refund > 0 ? ' style="color:var(--warn)"' : ""}>${eur(refund > 0 ? refund : balance)}</b>${
        refund > 0
          ? `<div class="small muted">trop-perçu — remboursement à faire à la main</div>`
          : b.balanceDueDate ? `<div class="small muted">échéance ${dfr(b.balanceDueDate)}</div>` : ""
      }</div>
    </div>
    ${b.guestNotes ? `<div class="note">Message du client : ${esc(b.guestNotes)}</div>` : ""}
    <div class="grid c2e mb">
      <div><h3>Devis</h3><table class="quote">${quoteRows}</table></div>
      <div><h3>Paiements</h3><table>${payRows || `<tr><td class="muted">Aucun paiement.</td></tr>`}</table>
        <div id="payZone" class="mb" style="margin-top:10px"></div>
      </div>
    </div>
    <div class="mb"><label class="f">Notes internes</label><textarea id="notes" rows="2">${esc(b.internalNotes || "")}</textarea></div>
    <div class="mb"><h3>Historique</h3>
      <table>${historyRows || `<tr><td class="muted">Rien à afficher.</td></tr>`}</table></div>
    <div class="row">
      ${b.status !== "cancelled" ? `<button class="btn o sm" id="btnEdit">Modifier</button>` : ""}
      ${b.status === "pending" ? `<button class="btn sm" id="btnConfirm">Confirmer (paiement reçu hors ligne)</button>` : ""}
      ${b.status !== "cancelled" ? `<button class="btn o sm" id="btnPay">+ Paiement manuel</button>` : ""}
      ${b.status !== "cancelled" && balance > 0 ? `<button class="btn o sm" id="btnLink">Lien de paiement (${eur(balance)})</button>` : ""}
      ${b.guestEmail && b.status === "confirmed" && balance > 0 ? `<button class="btn o sm" id="btnRelance">Relancer le solde (${eur(balance)})</button>` : ""}
      ${b.guestEmail && b.status === "confirmed" ? `<button class="btn o sm" id="btnVoucher">Renvoyer le voucher</button>` : ""}
      <button class="btn o sm" id="btnMsg">💬 Message au client</button>
      <button class="btn o sm" id="btnNotes">Enregistrer les notes</button>
      ${b.status !== "cancelled" ? `<button class="btn warn sm right" id="btnCancel">Annuler la réservation</button>` : ""}
    </div>`);

  modal.querySelector("#btnEdit")?.addEventListener("click", () => openEditBooking(b, () => { modal.remove(); openBooking(id); }));

  modal.querySelector("#btnNotes").onclick = async () => {
    await api(`/api/admin/bookings/${id}`, { method: "PATCH", body: { internalNotes: modal.querySelector("#notes").value } });
    toast("Notes enregistrées");
  };
  modal.querySelector("#btnMsg").onclick = () => {
    const sub = openModal(`
      <h2>Message à ${esc(b.guestName || "ce client")} <button class="x">×</button></h2>
      <p class="small muted">Visible immédiatement sur son voucher · envoyé par email quand l'envoi est activé.</p>
      <textarea id="bmText" rows="4" placeholder="Bonjour ${esc(b.guestName || "")}, …"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="bmSend">Envoyer</button></div>`);
    sub.querySelector("#bmSend").onclick = async () => {
      const text = sub.querySelector("#bmText").value.trim();
      if (text.length < 2) return toast("Message vide", true);
      const res = await api(`/api/admin/bookings/${id}/messages`, { method: "POST", body: { body: text } });
      toast(res.delivery === "sent" ? "Message envoyé (email parti)" : "Message publié sur le voucher du client");
      sub.remove();
    };
  };
  modal.querySelector("#btnConfirm")?.addEventListener("click", async () => {
    await api(`/api/admin/bookings/${id}/confirm`, { method: "POST", body: { sendVoucher: false } });
    toast("Réservation confirmée");
    modal.remove();
    navigate();
  });
  modal.querySelector("#btnCancel")?.addEventListener("click", async () => {
    const reason = prompt("Motif d'annulation ?", "annulation client");
    if (reason === null) return;
    const res = await api(`/api/admin/bookings/${id}/cancel`, { method: "POST", body: { reason } });
    toast(res.note || "Réservation annulée — le créneau est libéré");
    modal.remove();
    navigate();
  });
  modal.querySelector("#btnRelance")?.addEventListener("click", async () => {
    const res = await api(`/api/admin/bookings/${id}/balance-reminder`, { method: "POST" });
    toast(`Relance du solde (${eur(res.balanceCents)}) journalisée — envoi réel selon configuration email`);
    modal.remove();
    openBooking(id); // l'historique doit montrer la relance qu'on vient de faire
  });
  modal.querySelector("#btnVoucher")?.addEventListener("click", async () => {
    await api(`/api/admin/bookings/${id}/resend-voucher`, { method: "POST" });
    toast("Voucher (re)journalisé — envoi réel selon configuration email");
  });
  modal.querySelector("#btnLink")?.addEventListener("click", async () => {
    const { url } = await api(`/api/admin/bookings/${id}/payment-link`, { method: "POST", body: {} });
    modal.querySelector("#payZone").innerHTML = `<div class="note">Lien de paiement : <span class="mono copy">${esc(url)}</span></div>`;
    modal.querySelector("#payZone .copy").onclick = () => copyText(url);
  });
  modal.querySelector("#btnPay")?.addEventListener("click", () => {
    modal.querySelector("#payZone").innerHTML = `
      <div class="row">
        <div><label class="f">Montant (€)</label><input id="payAmount" class="inline-num" value="${eurInput(balance)}"></div>
        <div><label class="f">Méthode</label><select id="payMethod">
          <option value="transfer">Virement</option><option value="cash">Espèces</option><option value="other">Autre</option></select></div>
        <div><label class="f">Note</label><input id="payNote" placeholder="ex. virement reçu 12/07"></div>
        <div class="n"><button class="btn sm" id="paySave">Encaisser</button></div>
      </div>`;
    modal.querySelector("#paySave").onclick = async () => {
      const amount = toCents(modal.querySelector("#payAmount").value);
      if (!amount) return toast("Montant invalide", true);
      await api(`/api/admin/bookings/${id}/payments`, {
        method: "POST",
        body: { kind: balance > 0 && amount >= balance ? "balance" : "manual", method: modal.querySelector("#payMethod").value, amountCents: amount, note: modal.querySelector("#payNote").value },
      });
      toast("Paiement enregistré");
      modal.remove();
      openBooking(id);
    };
  });
}

// --- Nouvelle vente (résa téléphone) ---------------------------------------

export async function openNewSale() {
  const { units } = await api(`/api/admin/units?property=${currentPropertyId()}`);
  const propData = await api(`/api/admin/options?property=${currentPropertyId()}`);
  const options = propData.options.filter((o) => o.active);
  const today = todayIso();

  const modal = openModal(`
    <h2>Nouvelle vente (téléphone) <button class="x">×</button></h2>
    <div class="row mb">
      <div><label class="f">Hébergement</label><select id="nsUnit">
        ${units.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div>
      <div><label class="f">Arrivée</label><input type="date" id="nsIn" min="${today}"></div>
      <div><label class="f">Départ</label><input type="date" id="nsOut" min="${today}"></div>
      <div class="n"><label class="f">Adultes</label><input type="number" id="nsAd" value="2" min="1" class="inline-num"></div>
      <div class="n"><label class="f">Enfants</label><input type="number" id="nsCh" value="0" min="0" class="inline-num"></div>
    </div>
    <div class="row mb">
      ${options
        .map(
          (o) => `<div class="n"><label class="f">${esc(o.name)} (${eur(o.priceCents)}${o.unitLabel ? "/" + esc(o.unitLabel) : ""})</label>
          ${o.pricingMode === "per_unit_qty" ? `<input type="number" min="0" max="${o.maxQty ?? 99}" value="0" class="inline-num nsOpt" data-oid="${o.id}">` : `<input type="checkbox" class="nsOpt" data-oid="${o.id}">`}</div>`,
        )
        .join("")}
      <div class="n"><label class="f">Code promo</label><input id="nsPromo" style="width:120px"></div>
      <div class="n"><button class="btn o sm" id="nsQuote">Calculer le devis</button></div>
    </div>
    <div id="nsQuoteZone" class="mb"></div>
    <h3>Client</h3>
    <div class="formgrid mb">
      <div><label class="f">Prénom</label><input id="nsFirst"></div>
      <div><label class="f">Nom *</label><input id="nsLast"></div>
      <div><label class="f">Email</label><input id="nsEmail" type="email" placeholder="facultatif"></div>
      <div><label class="f">Téléphone</label><input id="nsPhone"></div>
    </div>
    <div class="row mb">
      <div class="n"><label class="f">Statut</label><select id="nsConfirm">
        <option value="1">Confirmée d'office</option><option value="0">Option (72 h)</option></select></div>
      <div class="n"><label class="f">Paiement</label><select id="nsMode">
        <option value="deposit">Arrhes</option><option value="full">Total</option></select></div>
      <div class="n"><label class="f">Lien de paiement</label><input type="checkbox" id="nsLink" checked></div>
      <div><label class="f">Note interne</label><input id="nsNote" placeholder="ex. résa tél. 12/07"></div>
    </div>
    <div class="row"><button class="btn" id="nsCreate" disabled>Créer la réservation</button><span class="muted small" id="nsHint">Calcule d'abord le devis.</span></div>
    <div id="nsResult"></div>`);

  const collectOptions = () =>
    [...modal.querySelectorAll(".nsOpt")]
      .map((el) => ({ id: Number(el.dataset.oid), qty: el.type === "checkbox" ? (el.checked ? 1 : 0) : Number(el.value) || 0 }))
      .filter((o) => o.qty > 0);

  const collectBody = () => ({
    unitId: Number(modal.querySelector("#nsUnit").value),
    checkin: modal.querySelector("#nsIn").value,
    checkout: modal.querySelector("#nsOut").value,
    adults: Number(modal.querySelector("#nsAd").value),
    children: Number(modal.querySelector("#nsCh").value),
    options: collectOptions(),
    promoCode: modal.querySelector("#nsPromo").value.trim() || null,
  });

  // « Créer » n'est ouvert que par un devis À JOUR sur un créneau LIBRE
  // (issue #70). `quoted` mémorise l'empreinte exacte du devis affiché :
  // dès qu'un champ qui change le prix ou la disponibilité bouge, l'empreinte
  // ne correspond plus et le bouton se referme. Les champs client (nom, email,
  // note…) n'entrent pas dans l'empreinte : ils ne changent ni l'un ni l'autre.
  let quoted = null;
  let created = false;
  const lockCreate = (hint) => {
    quoted = null;
    modal.querySelector("#nsCreate").disabled = true;
    modal.querySelector("#nsHint").textContent = hint;
  };
  const onQuoteFieldChange = () => {
    if (quoted === null) return;
    if (JSON.stringify(collectBody()) !== quoted) lockCreate("Un champ a changé — recalcule le devis avant de créer.");
  };
  modal.addEventListener("input", onQuoteFieldChange);
  modal.addEventListener("change", onQuoteFieldChange);

  const conflictLine = (c) =>
    `${esc(c.reference)} — ${esc(c.unitName)}, ${dfr(c.checkin)} → ${dfr(c.checkout)}` +
    `${c.status === "pending" ? " (option en cours)" : ""}${c.viaLink ? " — blocage par liaison" : ""}`;

  modal.querySelector("#nsQuote").onclick = async () => {
    const body = collectBody();
    if (!body.checkin || !body.checkout) return toast("Choisis les dates", true);
    const signature = JSON.stringify(body);
    try {
      const { quote, availability } = await api("/api/admin/quote", { method: "POST", body });
      const zone = modal.querySelector("#nsQuoteZone");
      if (!quote.ok) {
        zone.innerHTML = `<div class="note bad">Devis impossible : ${quote.errors.includes("min_nights") ? `minimum ${quote.minNights} nuits sur ces dates` : esc(quote.errors.join(", "))}</div>`;
        lockCreate("Devis impossible sur ces dates.");
        return;
      }
      // Disponibilité annoncée AVANT le clic — au téléphone, découvrir le
      // conflit au moment de créer, c'est le découvrir devant le client.
      const avail = availability || { available: true, conflicts: [] };
      const availBlock = avail.available
        ? `<div class="note ok">✅ Créneau libre pour cet hébergement (liaisons comprises).</div>`
        : `<div class="note bad"><b>Créneau indisponible</b> — déjà pris par :<ul style="margin:6px 0 0 18px">${(avail.conflicts || [])
            .map((c) => `<li>${conflictLine(c)}</li>`)
            .join("")}</ul></div>`;
      zone.innerHTML = `${availBlock}
        <table class="quote">${quote.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="r">${eur(l.amountCents)}</td></tr>`).join("")}
        <tr class="tot"><td>Total${quote.balanceDueDate ? ` — arrhes ${eur(quote.depositCents)}, solde ${dfr(quote.balanceDueDate)}` : " (paiement intégral)"}</td><td class="r">${eur(quote.totalCents)}</td></tr></table>
        ${quote.warnings.includes("promo_invalid") ? `<div class="note bad">Code promo invalide — devis calculé sans le code.</div>` : ""}`;
      if (!avail.available) {
        lockCreate("Créneau indisponible — change les dates ou l'hébergement.");
        return;
      }
      if (created) {
        lockCreate("Réservation déjà créée — ferme la fenêtre pour en saisir une autre.");
        return;
      }
      quoted = signature;
      modal.querySelector("#nsCreate").disabled = false;
      modal.querySelector("#nsHint").textContent = "";
    } catch (e) {
      toast(e.message, true);
    }
  };

  modal.querySelector("#nsCreate").onclick = async () => {
    const lastName = modal.querySelector("#nsLast").value.trim();
    if (lastName.length < 2) return toast("Nom du client requis", true);
    // Ceinture et bretelles : si l'empreinte a bougé entre le dernier
    // recalcul et le clic, on refuse plutôt que de vendre un devis périmé.
    if (quoted === null || JSON.stringify(collectBody()) !== quoted) {
      lockCreate("Le devis n'est plus à jour — recalcule-le.");
      return toast("Recalcule le devis avant de créer", true);
    }
    const body = {
      ...collectBody(),
      guest: {
        firstName: modal.querySelector("#nsFirst").value,
        lastName,
        email: modal.querySelector("#nsEmail").value.trim(),
        phone: modal.querySelector("#nsPhone").value,
      },
      confirmNow: modal.querySelector("#nsConfirm").value === "1",
      paymentMode: modal.querySelector("#nsMode").value,
      generatePaymentLink: modal.querySelector("#nsLink").checked,
      internalNotes: modal.querySelector("#nsNote").value,
    };
    // Verrou de soumission : sans lui, un double-clic part deux fois et la
    // base rejette la seconde en 409 — un conflit fabriqué de toutes pièces.
    modal.querySelector("#nsCreate").disabled = true;
    try {
      const res = await api("/api/admin/bookings", { method: "POST", body });
      const b = res.booking;
      modal.querySelector("#nsResult").innerHTML = `<div class="note" style="margin-top:12px">
        ✅ Réservation <b>${esc(b.reference)}</b> créée (${esc(b.status === "confirmed" ? "confirmée" : "option 72 h")}).
        ${res.paymentUrl ? `<br>Lien de paiement : <span class="mono copy">${esc(res.paymentUrl)}</span>` : ""}</div>`;
      modal.querySelector("#nsResult .copy")?.addEventListener("click", () => copyText(res.paymentUrl));
      created = true;
      lockCreate("Réservation créée.");
      toast(`Réservation ${b.reference} créée`);
    } catch (e) {
      // Échec de création — typiquement le 409 de l'INSERT atomique, quelqu'un
      // ayant pris le créneau entre le devis et le clic. Laisser « Créneau
      // libre » à l'écran ferait mentir la page et inviterait à recliquer :
      // on referme et on force le recalcul, qui nommera le conflit.
      lockCreate("Création refusée — recalcule le devis pour voir l'état réel du créneau.");
      toast(e.message, true);
    }
  };
}

// ---------------------------------------------------------------------------
// VUE — Messages (emails entrants)
// ---------------------------------------------------------------------------

registerView("messages", "Messages", async (root) => {
  const q = state.propertyId ? `?property=${state.propertyId}` : "";
  const { messages, note } = await api(`/api/admin/messages${q}`);
  const statusTag = (e) => {
    if (e.status === "traité") return `<span class="tag t-mut">traité</span>`;
    return `<span class="tag t-warn">nouveau</span>`;
  };
  root.innerHTML = `
    ${note ? `<div class="note bad">${esc(note)}</div>` : ""}
    <div class="note">Les échanges clients vivent ici : questions du <b>formulaire public</b> (💬), du <b>voucher</b> des clients, et <b>emails</b> (✉️, une fois Email Routing activé). Tu réponds depuis la plateforme — la réponse s'affiche immédiatement sur le voucher du client, et part aussi par email quand l'envoi est activé. Réglages accusé/transfert dans <a href="#/params">Paramètres</a>.</div>
    <div class="card">
      <div class="row mb"><div class="right n"><button class="btn o sm" id="simMail">✉️ Simuler un email entrant</button></div></div>
      <table><tr><th>Reçu</th><th></th><th>De</th><th>Sujet</th><th>Résa liée</th><th>Statut</th><th></th></tr>
      ${messages
        .map(
          (e) => `<tr class="clickable" data-mail="${e.id}">
          <td class="small">${esc(e.receivedAt.slice(0, 16))}</td>
          <td>${e.channel === "form" ? "💬" : "✉️"}</td>
          <td>${esc(e.fromName || e.fromEmail)}</td>
          <td>${esc(e.subject)}</td>
          <td class="mono">${esc(e.bookingReference ?? "—")}</td>
          <td>${statusTag(e)}${e.autoReplied ? ' <span class="tag t-ok">accusé ✓</span>' : ""}${e.forwarded ? ' <span class="tag t-ok">transféré ✓</span>' : ""}</td>
          <td>${e.status === "nouveau" ? `<button class="btn o sm mailDone" data-id="${e.id}">✓ traité</button>` : ""}</td></tr>`,
        )
        .join("") || `<tr><td colspan="7" class="muted">Aucun message.</td></tr>`}
      </table>
    </div>`;

  root.querySelectorAll(".mailDone").forEach((b) =>
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await api(`/api/admin/messages/${b.dataset.id}`, { method: "PATCH", body: { status: "traité" } });
      toast("Message marqué traité");
      navigate();
    }),
  );
  root.querySelectorAll("[data-mail]").forEach((tr) =>
    tr.addEventListener("click", () => openThread(Number(tr.dataset.mail))),
  );
  root.querySelector("#simMail").onclick = () => {
    const modal = openModal(`
      <h2>Simuler un email entrant <button class="x">×</button></h2>
      <div class="formgrid mb">
        <div><label class="f">De (email)</label><input id="simFrom" value="client.test@example.com"></div>
        <div><label class="f">Nom</label><input id="simName" value="Client Test"></div>
        <div><label class="f">Sujet</label><input id="simSubject" value="Question sur ma réservation"></div>
      </div>
      <div class="mb"><label class="f">Message</label><textarea id="simText" rows="4">Bonjour, est-il possible d'arriver vers 20h ? Merci !</textarea></div>
      <button class="btn sm" id="simGo">Injecter</button>`);
    modal.querySelector("#simGo").onclick = async () => {
      const { result } = await api("/api/admin/dev-inbound-email", {
        method: "POST",
        body: {
          from: modal.querySelector("#simFrom").value,
          fromName: modal.querySelector("#simName").value,
          subject: modal.querySelector("#simSubject").value,
          text: modal.querySelector("#simText").value,
        },
      });
      toast(result.autoReplied ? "Email injecté — accusé de réception simulé" : "Email injecté");
      modal.remove();
      navigate();
    };
  };
});

// --- fil de conversation (bulles) + réponse depuis la plateforme -------------

export async function openThread(messageId) {
  const { message, thread } = await api(`/api/admin/messages/${messageId}/thread`);
  const bubbles = thread
    .map(
      (m) => `<div class="bubble ${m.direction === "in" ? "in" : "out"}">
        <div class="who">${m.direction === "in" ? esc(m.fromName || m.fromEmail) : "Équipe"} · ${esc(m.receivedAt.slice(0, 16))} ${m.channel === "form" ? "💬" : "✉️"}</div>
        ${esc(m.bodyText)}
        ${m.direction === "out" ? `<div class="via">${m.delivery === "sent" ? "envoyé par email ✓" : m.delivery === "stub" ? "visible sur le voucher · email en attente d'activation" : "visible sur le voucher"}</div>` : ""}
      </div>`,
    )
    .join("");
  const modal = openModal(`
    <h2>${esc(message.fromName || message.fromEmail)} ${message.bookingReference ? `· <span class="mono">${esc(message.bookingReference)}</span>` : ""} <button class="x">×</button></h2>
    <div class="thread" id="threadZone">${bubbles || '<p class="muted small">Aucun message.</p>'}</div>
    <div><label class="f">Répondre via la plateforme</label>
      <textarea id="thReply" rows="3" placeholder="Ta réponse au client…"></textarea></div>
    <div class="row" style="margin-top:8px">
      <button class="btn sm" id="thSend">Envoyer la réponse</button>
      ${message.bookingId ? `<button class="btn o sm" id="thBooking">Voir la réservation</button>` : ""}
      ${message.status === "nouveau" ? `<button class="btn o sm" id="thDone">✓ Marquer traité sans répondre</button>` : ""}
      <span class="muted small right">La réponse apparaît sur le voucher du client${message.channel === "email" ? " et partira par email une fois l'envoi activé" : ""}.</span>
    </div>`);
  const zone = modal.querySelector("#threadZone");
  zone.scrollTop = zone.scrollHeight;
  modal.querySelector("#thSend").onclick = async () => {
    const body = modal.querySelector("#thReply").value.trim();
    if (body.length < 2) return toast("Réponse vide", true);
    const res = await api(`/api/admin/messages/${messageId}/reply`, { method: "POST", body: { body } });
    toast(res.delivery === "sent" ? "Réponse envoyée (email parti)" : "Réponse publiée — visible sur le voucher du client");
    modal.remove();
    navigate();
  };
  modal.querySelector("#thBooking")?.addEventListener("click", () => {
    modal.remove();
    openBooking(message.bookingId);
  });
  modal.querySelector("#thDone")?.addEventListener("click", async () => {
    await api(`/api/admin/messages/${messageId}`, { method: "PATCH", body: { status: "traité" } });
    modal.remove();
    toast("Message marqué traité");
    navigate();
  });
}

// ---------------------------------------------------------------------------
// VUE — Statistiques
// ---------------------------------------------------------------------------

/** Cartes de DÉCISION (issue #36) : délai de réservation, entonnoir de
 *  conversion, recherches sans réponse. Sobres et sans graphique superflu — ce
 *  sont trois chiffres à lire, pas un tableau de bord à contempler.
 *
 *  Une distinction porte tout le reste : « — » signifie « pas de donnée »,
 *  jamais « zéro ». Afficher 0 % là où le journal est encore vide ferait
 *  chercher une panne de conversion là où il n'y a qu'une mesure qui démarre. */
function decisionCards(data, year) {
  const lt = data.leadTime;
  const funnel = data.funnel;
  const searches = data.searches;
  if (!lt || !funnel || !searches) return "";

  const pct = (v) => (v == null ? `<span class="muted">—</span>` : `${String(v).replace(".", ",")} %`);
  const jours = (v) => `${String(v).replace(".", ",")} j`;

  const leadMonths = lt.byMonth.filter((m) => m.count > 0);
  const leadRows = leadMonths.length
    ? leadMonths
        .map(
          (m) => `<tr><td>${esc(m.label)}</td><td class="r">${m.count}</td>
            <td class="r">${jours(m.avgDays)}</td><td class="r">${jours(m.medianDays)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">Aucune réservation confirmée en ${year}.</td></tr>`;
  const leadUnits = lt.byUnit
    .map((u) => `<tr><td>${esc(u.label)}</td><td class="r">${u.count}</td><td class="r">${jours(u.medianDays)}</td></tr>`)
    .join("");

  const maxStep = Math.max(1, ...funnel.steps.map((s) => s.count));
  const funnelRows = funnel.steps
    .map(
      (s) => `<tr${s.key === funnel.biggestDropKey ? ' class="drop"' : ""}>
        <td>${esc(s.label)}${s.key === funnel.biggestDropKey ? ' <span class="tag t-warn">plus forte perte</span>' : ""}</td>
        <td class="r">${s.count}</td>
        <td class="r">${pct(s.fromPreviousPct)}</td>
        <td><span class="fbar" style="width:${Math.round((s.count / maxStep) * 100)}%"></span></td></tr>`,
    )
    .join("");

  const emptyRows = searches.topEmpty.length
    ? searches.topEmpty
        .map(
          (g) => `<tr><td>${dfr(g.checkin)} → ${dfr(g.checkout)}</td><td class="r">${g.nights} n</td>
            <td class="r">${g.maxPersons} p.</td><td class="r"><b>${g.count}</b></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">Aucune recherche restée sans réponse.</td></tr>`;

  return `
    <div class="grid c2" style="margin-top:14px">
      <div class="card"><h3>Délai de réservation ${year}</h3>
        <div class="row mb">
          <div class="n"><span class="muted small">Moyenne</span> <b>${lt.count ? jours(lt.avgDays) : "—"}</b></div>
          <div class="n"><span class="muted small">Médiane</span> <b>${lt.count ? jours(lt.medianDays) : "—"}</b></div>
          <div class="n muted small">${lt.count} réservation${lt.count > 1 ? "s" : ""}</div>
        </div>
        <table><tr><th>Mois d'arrivée</th><th class="r">Résas</th><th class="r">Moyenne</th><th class="r">Médiane</th></tr>
          ${leadRows}</table>
        ${leadUnits ? `<table style="margin-top:10px"><tr><th>Hébergement</th><th class="r">Résas</th><th class="r">Médiane</th></tr>${leadUnits}</table>` : ""}
        <p class="small muted" style="margin-top:8px">Écart entre la date de réservation et la date d'arrivée.
        La médiane compte autant que la moyenne : une seule réservation posée deux ans à l'avance suffit à tirer la moyenne.
        Les délais négatifs (résas importées) sont exclus.</p>
      </div>

      <div class="card"><h3>Entonnoir de conversion ${year}</h3>
        <table><tr><th>Étape</th><th class="r">Volume</th><th class="r">Passage</th><th></th></tr>
          ${funnelRows}</table>
        <p class="small muted" style="margin-top:8px">Recherche → réservation confirmée :
          <b>${pct(funnel.overallPct)}</b>.
          Seules les réservations directes comptent : une résa venue d'un canal OTA n'a jamais traversé le tunnel.
          « — » signifie « pas encore de donnée », pas « zéro ».</p>
      </div>
    </div>

    <div class="card" style="margin-top:14px"><h3>Ce que les clients cherchent sans le trouver</h3>
      <div class="row mb">
        <div class="n"><span class="muted small">Recherches</span> <b>${searches.total}</b></div>
        <div class="n"><span class="muted small">Sans réponse</span> <b>${searches.empty}</b></div>
        <div class="n"><span class="muted small">Part</span> <b>${String(searches.emptyPct).replace(".", ",")} %</b></div>
      </div>
      <table><tr><th>Dates demandées</th><th class="r">Nuits</th><th class="r">Personnes</th><th class="r">Demandes</th></tr>
        ${emptyRows}</table>
      <p class="small muted" style="margin-top:8px">Journal anonyme : dates, nombre de personnes, résultat.
      Aucune donnée identifiante n'est enregistrée — ni adresse IP, ni e-mail, ni identifiant de session.</p>
    </div>`;
}

registerView("stats", "Statistiques", async (root) => {
  if (!state.statsYear) state.statsYear = Number(todayIso().slice(0, 4));
  const year = state.statsYear;
  const data = await api(`/api/admin/stats?property=${currentPropertyId()}&year=${year}`);
  const cur = data.current;
  const prev = data.previous;

  const delta = (a, b, unit, digits = 0) => {
    if (b == null) return `<span class="muted">—</span>`;
    const d = Math.round((a - b) * 10 ** digits) / 10 ** digits;
    return `<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲ +" : "▼ "}${d}${unit}</span>`;
  };
  const monthLetters = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const maxOcc = Math.max(10, ...cur.months.map((m) => m.occupancyPct));

  root.innerHTML = `
    <div class="row mb">
      <div class="n"><button class="btn o sm" id="prevY">◀</button> <b>${year}</b> <button class="btn o sm" id="nextY">▶</button>
        <span class="muted small">vs ${year - 1}</span></div>
      <div class="right n">
        <button class="btn o sm" id="csvStats">Export CSV stats</button>
        <button class="btn o sm" id="csvResa">Export CSV réservations</button></div>
    </div>
    <div class="grid c4 mb">
      <div class="card kpi"><div class="l">Occupation annuelle</div><div class="v">${cur.occupancyPct} %</div>
        <div class="d">${delta(cur.occupancyPct, prev.occupancyPct, " pts", 1)}</div></div>
      <div class="card kpi"><div class="l">Revenus cumulés</div><div class="v">${eur(cur.revenueCents)}</div>
        <div class="d">${prev.revenueCents > 0 ? delta(Math.round(((cur.revenueCents - prev.revenueCents) / prev.revenueCents) * 100), 0, " %") : '<span class="muted">pas de N-1</span>'}</div></div>
      <div class="card kpi"><div class="l">Prix moyen / nuit</div><div class="v">${eur(cur.adrCents)}</div>
        <div class="d">${delta(Math.round(cur.adrCents / 100), Math.round(prev.adrCents / 100), " €")}</div></div>
      <div class="card kpi"><div class="l">Durée moyenne</div><div class="v">${String(cur.avgStayNights).replace(".", ",")} n</div>
        <div class="d">${delta(cur.avgStayNights, prev.avgStayNights, "", 1)}</div></div>
    </div>
    <div class="grid c2">
      <div class="card"><h3>Occupation mensuelle (%)</h3>
        <div class="bars">
          ${cur.months
            .map(
              (m, i) => `<div class="${m.occupancyPct >= 75 ? "hi" : ""}" style="height:${Math.max(2, (m.occupancyPct / maxOcc) * 100)}%">
              <b>${m.occupancyPct > 0 ? m.occupancyPct : ""}</b><span>${monthLetters[i]}</span></div>`,
            )
            .join("")}
        </div>
      </div>
      <div class="card"><h3>Répartition par unité</h3>
        <table><tr><th>Unité</th><th class="r">Nuits</th><th class="r">Revenus</th></tr>
        ${cur.perUnit.map((u) => `<tr><td>${esc(u.name)}</td><td class="r">${u.nights}</td><td class="r">${eur(u.revenueCents)}</td></tr>`).join("") ||
          `<tr><td colspan="3" class="muted">Aucune réservation confirmée en ${year}.</td></tr>`}
        <tr><td><b>Total</b> <span class="muted small">(${cur.bookingsCount} résa${cur.bookingsCount > 1 ? "s" : ""})</span></td>
          <td class="r"><b>${cur.soldNights}</b></td><td class="r"><b>${eur(cur.revenueCents)}</b></td></tr></table>
        <p class="small muted" style="margin-top:8px">Occupation = nuits occupées des maisons physiques (une résa « Domaine entier » occupe ses deux maisons). ADR = revenus / nuits vendues.</p>
      </div>
    </div>
    ${decisionCards(data, year)}`;

  root.querySelector("#prevY").onclick = () => { state.statsYear = year - 1; navigate(); };
  root.querySelector("#nextY").onclick = () => { state.statsYear = year + 1; navigate(); };
  root.querySelector("#csvStats").onclick = () => downloadCsv(`/api/admin/stats.csv?property=${currentPropertyId()}&year=${year}`, `stats-${year}.csv`);
  root.querySelector("#csvResa").onclick = () => downloadCsv(`/api/admin/bookings.csv?property=${state.propertyId}`, "reservations.csv");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

registerCalendarView();
registerConfigViews();

window.addEventListener("hashchange", navigate);

document.getElementById("logout")?.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch {
    /* la session est peut-être déjà morte — on nettoie quand même */
  }
  clearAuth();
  window.location.href = "login.html";
});
if (state.user) {
  const who = document.getElementById("whoami");
  if (who) who.textContent = ` (${state.user})`;
}

(async function boot() {
  try {
    const { properties } = await api("/api/admin/properties");
    state.properties = properties;
    if (!properties.some((p) => p.id === state.propertyId)) state.propertyId = properties[0]?.id ?? 1;
    renderPropertySwitch();
  } catch (e) {
    document.getElementById("main").innerHTML = `<div class="note bad">API injoignable : ${esc(e.message)}</div>`;
    return;
  }
  navigate();
  refreshBadges();
})();
