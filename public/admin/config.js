// Back-office — vues de configuration (promotions, options, clients,
// paiements, canaux, synchro iCal, comptes, paramètres).
// Les tarifs vivent désormais dans calendar.js, couche « Prix » du
// calendrier unifié (#24 #25).

import {
  api, copyText, currentPropertyId, dfr, dshort, esc, eur, eurInput, openBooking, openModal,
  registerView, state, toCents, toast,
} from "./app.js";

const MODE_FR = {
  per_stay: "par séjour",
  per_night: "par nuit",
  per_person: "par personne",
  per_person_night: "par pers./nuit",
  per_unit_qty: "à la quantité",
};

export function registerConfigViews() {
  // -------------------------------------------------------------------------
  // Promotions
  // -------------------------------------------------------------------------
  registerView("promos", "Promotions", async (root) => {
    const { promotions } = await api(`/api/admin/promotions?property=${currentPropertyId()}`);
    const autos = promotions.filter((p) => p.kind !== "code");
    const codes = promotions.filter((p) => p.kind === "code");
    const KIND_FR = { long_stay: "Long séjour (≥ N nuits)", early_bird: "Early bird (≥ N jours avant)", last_minute: "Last minute (≤ N jours avant)" };

    root.innerHTML = `
      <div class="note">Règle d'empilement (défaut à valider) : la <b>meilleure remise automatique</b> s'applique seule ; un <b>code promo</b> s'ajoute ensuite. Les remises portent sur l'hébergement uniquement.</div>
      <div class="grid c2e">
        <div class="card"><h3>Remises automatiques</h3>
          <table><tr><th>Type</th><th>Libellé</th><th>Seuil</th><th>Remise %</th><th>Actif</th><th></th></tr>
          ${autos
            .map(
              (p) => `<tr data-promo="${p.id}">
              <td class="muted small">${esc(KIND_FR[p.kind] || p.kind)}</td>
              <td><input class="pLabel" value="${esc(p.label)}"></td>
              <td><input type="number" class="pThr inline-num" style="width:60px" value="${p.threshold ?? 0}"></td>
              <td><input type="number" class="pPct inline-num" style="width:60px" value="${p.discountPct ?? 0}"></td>
              <td><input type="checkbox" class="pActive" ${p.active ? "checked" : ""}></td>
              <td><button class="btn sm pSave">💾</button></td></tr>`,
            )
            .join("")}</table>
        </div>
        <div class="card"><h3>Codes promo</h3>
          <table><tr><th>Code</th><th>Remise</th><th>Validité</th><th>Usages</th><th>Actif</th><th></th></tr>
          ${codes
            .map(
              (p) => `<tr data-promo="${p.id}">
              <td><b class="mono">${esc(p.code)}</b></td>
              <td>${p.discountPct ? p.discountPct + " %" : eur(p.discountCents ?? 0)}</td>
              <td class="small">${p.validFrom ? dfr(p.validFrom) : "—"} → ${p.validUntil ? dfr(p.validUntil) : "—"}</td>
              <td>${p.uses}${p.maxUses ? " / " + p.maxUses : ""}</td>
              <td><input type="checkbox" class="pActive" ${p.active ? "checked" : ""}></td>
              <td><button class="btn sm pSave">💾</button> <button class="btn warn sm pDel">🗑</button></td></tr>`,
            )
            .join("")}</table>
          <div class="row" style="margin-top:10px">
            <div class="n"><label class="f">Code</label><input id="npCode" style="width:110px" placeholder="ETE2026"></div>
            <div class="n"><label class="f">Remise %</label><input id="npPct" type="number" class="inline-num" style="width:70px"></div>
            <div class="n"><label class="f">ou € fixe</label><input id="npFix" class="inline-num" style="width:80px" placeholder="50,00"></div>
            <div class="n"><label class="f">Jusqu'au</label><input id="npUntil" type="date"></div>
            <div class="n"><label class="f">Max usages</label><input id="npMax" type="number" class="inline-num" style="width:70px"></div>
            <div class="n"><button class="btn sm" id="npAdd">+ Créer</button></div>
          </div>
        </div>
      </div>`;

    root.querySelectorAll("tr[data-promo]").forEach((tr) => {
      const id = tr.dataset.promo;
      tr.querySelector(".pSave").onclick = async () => {
        const body = { active: tr.querySelector(".pActive").checked };
        if (tr.querySelector(".pLabel")) body.label = tr.querySelector(".pLabel").value;
        if (tr.querySelector(".pThr")) body.threshold = Number(tr.querySelector(".pThr").value);
        if (tr.querySelector(".pPct")) body.discountPct = Number(tr.querySelector(".pPct").value);
        await api(`/api/admin/promotions/${id}`, { method: "PATCH", body });
        toast("Promotion enregistrée");
      };
      tr.querySelector(".pDel")?.addEventListener("click", async () => {
        if (!confirm("Supprimer ce code promo ?")) return;
        await api(`/api/admin/promotions/${id}`, { method: "DELETE" });
        location.reload();
      });
    });
    root.querySelector("#npAdd").onclick = async () => {
      const pct = Number(root.querySelector("#npPct").value) || null;
      const fix = root.querySelector("#npFix").value ? toCents(root.querySelector("#npFix").value) : null;
      await api(`/api/admin/promotions?property=${currentPropertyId()}`, {
        method: "POST",
        body: {
          kind: "code",
          code: root.querySelector("#npCode").value,
          discountPct: pct,
          discountCents: pct ? null : fix,
          validUntil: root.querySelector("#npUntil").value || null,
          maxUses: Number(root.querySelector("#npMax").value) || null,
        },
      });
      toast("Code promo créé");
      location.reload();
    };
  });

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------
  registerView("options", "Options payantes", async (root) => {
    const { options } = await api(`/api/admin/options?property=${currentPropertyId()}`);
    root.innerHTML = `
      <div class="card">
        <table><tr><th>Option</th><th>Tarification</th><th>Prix</th><th>Unité</th><th>Qté max</th><th>Ordre</th><th>Actif</th><th></th></tr>
        ${options
          .map(
            (o) => `<tr data-opt="${o.id}">
            <td><input class="oName" value="${esc(o.name)}"></td>
            <td><select class="oMode">${Object.entries(MODE_FR).map(([v, l]) => `<option value="${v}" ${o.pricingMode === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
            <td><input class="oPrice inline-num" value="${eurInput(o.priceCents)}"> €</td>
            <td><input class="oUnit" style="width:80px" value="${esc(o.unitLabel ?? "")}"></td>
            <td><input class="oMax inline-num" style="width:60px" type="number" value="${o.maxQty ?? ""}"></td>
            <td><input class="oSort inline-num" style="width:55px" type="number" value="${o.sortOrder}"></td>
            <td><input type="checkbox" class="oActive" ${o.active ? "checked" : ""}></td>
            <td><button class="btn sm oSave">💾</button> <button class="btn warn sm oDel">🗑</button></td></tr>`,
          )
          .join("")}
        <tr><td><input id="noName" placeholder="ex. Panier petit-déjeuner"></td>
          <td><select id="noMode">${Object.entries(MODE_FR).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></td>
          <td><input id="noPrice" class="inline-num" placeholder="25,00"> €</td>
          <td><input id="noUnit" style="width:80px" placeholder="séjour"></td>
          <td><input id="noMax" class="inline-num" style="width:60px" type="number"></td>
          <td></td><td></td><td><button class="btn sm" id="noAdd">+ Ajouter</button></td></tr>
        </table>
        <p class="small muted" style="margin-top:6px">La taxe de séjour n'est pas une option : elle se règle dans Paramètres et s'ajoute automatiquement au devis.</p>
      </div>`;

    root.querySelectorAll("tr[data-opt]").forEach((tr) => {
      const id = tr.dataset.opt;
      tr.querySelector(".oSave").onclick = async () => {
        await api(`/api/admin/options/${id}`, {
          method: "PATCH",
          body: {
            name: tr.querySelector(".oName").value,
            pricingMode: tr.querySelector(".oMode").value,
            priceCents: toCents(tr.querySelector(".oPrice").value),
            unitLabel: tr.querySelector(".oUnit").value,
            maxQty: tr.querySelector(".oMax").value === "" ? null : Number(tr.querySelector(".oMax").value),
            sortOrder: Number(tr.querySelector(".oSort").value),
            active: tr.querySelector(".oActive").checked,
          },
        });
        toast("Option enregistrée");
      };
      tr.querySelector(".oDel").onclick = async () => {
        if (!confirm("Supprimer cette option ?")) return;
        await api(`/api/admin/options/${id}`, { method: "DELETE" });
        location.reload();
      };
    });
    root.querySelector("#noAdd").onclick = async () => {
      await api(`/api/admin/options?property=${currentPropertyId()}`, {
        method: "POST",
        body: {
          name: root.querySelector("#noName").value,
          pricingMode: root.querySelector("#noMode").value,
          priceCents: toCents(root.querySelector("#noPrice").value),
          unitLabel: root.querySelector("#noUnit").value,
          maxQty: root.querySelector("#noMax").value === "" ? null : Number(root.querySelector("#noMax").value),
        },
      });
      toast("Option créée");
      location.reload();
    };
  });

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------
  registerView("clients", "Clients", async (root) => {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const search = params.get("search") || "";
    const { guests } = await api(`/api/admin/guests${search ? `?search=${encodeURIComponent(search)}` : ""}`);
    root.innerHTML = `
      <div class="card">
        <div class="row mb"><div class="n" style="min-width:240px"><input id="gSearch" placeholder="nom, email…" value="${esc(search)}"></div>
          <div class="n"><button class="btn o sm" id="gGo">Rechercher</button></div></div>
        <table><tr><th>Nom</th><th>Email</th><th>Téléphone</th><th class="r">Résas</th><th class="r">Total séjours</th></tr>
        ${guests
          .map(
            (g) => `<tr class="clickable" data-guest="${g.id}">
            <td><b>${esc([g.firstName, g.lastName].filter(Boolean).join(" "))}</b>${(g.bookingsCount ?? 0) > 1 ? ' <span class="tag t-ok">fidèle</span>' : ""}</td>
            <td>${esc(g.email ?? "—")}</td><td>${esc(g.phone ?? "—")}</td>
            <td class="r">${g.bookingsCount ?? 0}</td><td class="r">${eur(g.totalSpentCents ?? 0)}</td></tr>`,
          )
          .join("") || `<tr><td colspan="5" class="muted">Aucun client.</td></tr>`}</table>
      </div>`;
    const go = () => (location.hash = `#/clients?search=${encodeURIComponent(root.querySelector("#gSearch").value.trim())}`);
    root.querySelector("#gGo").onclick = go;
    root.querySelector("#gSearch").onkeydown = (e) => e.key === "Enter" && go();
    root.querySelectorAll("[data-guest]").forEach((tr) => tr.addEventListener("click", () => openGuest(Number(tr.dataset.guest))));
  });

  async function openGuest(id) {
    const { guest: g, bookings } = await api(`/api/admin/guests/${id}`);
    const modal = openModal(`
      <h2>${esc([g.firstName, g.lastName].filter(Boolean).join(" "))} <button class="x">×</button></h2>
      <div class="formgrid mb">
        <div><label class="f">Prénom</label><input id="gFirst" value="${esc(g.firstName ?? "")}"></div>
        <div><label class="f">Nom</label><input id="gLast" value="${esc(g.lastName)}"></div>
        <div><label class="f">Email</label><input id="gEmail" value="${esc(g.email ?? "")}"></div>
        <div><label class="f">Téléphone</label><input id="gPhone" value="${esc(g.phone ?? "")}"></div>
        <div><label class="f">Adresse</label><input id="gAddr" value="${esc(g.address ?? "")}"></div>
        <div><label class="f">Pays</label><input id="gCountry" value="${esc(g.country ?? "")}"></div>
      </div>
      <div class="mb"><label class="f">Notes</label><textarea id="gNotes" rows="2">${esc(g.notes ?? "")}</textarea></div>
      <div class="row mb"><button class="btn sm" id="gSave">Enregistrer</button></div>
      <h3>Historique</h3>
      <table><tr><th>N°</th><th>Unité</th><th>Séjour</th><th class="r">Total</th><th>Statut</th></tr>
      ${bookings
        .map(
          (b) => `<tr class="clickable" data-booking="${b.id}"><td class="mono">${esc(b.reference)}</td><td>${esc(b.unitName)}</td>
          <td>${dshort(b.checkin)}→${dshort(b.checkout)}</td><td class="r">${eur(b.totalCents)}</td>
          <td><span class="tag ${b.status === "cancelled" ? "t-mut" : "t-ok"}">${b.status === "cancelled" ? "annulée" : b.status === "pending" ? "option" : "confirmée"}</span></td></tr>`,
        )
        .join("") || `<tr><td colspan="5" class="muted">Aucune réservation.</td></tr>`}</table>`);
    modal.querySelector("#gSave").onclick = async () => {
      await api(`/api/admin/guests/${id}`, {
        method: "PATCH",
        body: {
          firstName: modal.querySelector("#gFirst").value,
          lastName: modal.querySelector("#gLast").value,
          email: modal.querySelector("#gEmail").value,
          phone: modal.querySelector("#gPhone").value,
          address: modal.querySelector("#gAddr").value,
          country: modal.querySelector("#gCountry").value,
          notes: modal.querySelector("#gNotes").value,
        },
      });
      toast("Client enregistré");
    };
    modal.querySelectorAll("[data-booking]").forEach((tr) =>
      tr.addEventListener("click", () => {
        modal.remove();
        openBooking(Number(tr.dataset.booking));
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Paiements
  // -------------------------------------------------------------------------
  registerView("paiements", "Paiements", async (root) => {
    const { payments } = await api(`/api/admin/payments?property=${currentPropertyId()}`);
    const KIND_FR = { deposit: "Arrhes", balance: "Solde", full: "Total", refund: "Remboursement", manual: "Manuel" };
    const METHOD_FR = { stripe: "Stripe", transfer: "Virement", cash: "Espèces", other: "Autre" };
    root.innerHTML = `
      <div class="card">
        <table><tr><th>Date</th><th>Réservation</th><th>Type</th><th>Méthode</th><th class="r">Montant</th><th>Statut</th></tr>
        ${payments
          .map(
            (p) => `<tr>
            <td>${esc((p.receivedAt || p.createdAt).slice(0, 16).replace("T", " "))}</td>
            <td class="mono">${esc(p.bookingReference ?? String(p.bookingId))}</td>
            <td>${KIND_FR[p.kind] || p.kind}</td><td>${METHOD_FR[p.method] || p.method}</td>
            <td class="r">${eur(p.amountCents)}</td>
            <td><span class="tag ${p.status === "succeeded" ? "t-ok" : p.status === "pending" ? "t-warn" : p.outcome ? "t-mut" : "t-bad"}">${
              p.status === "succeeded" ? "encaissé"
              : p.status === "pending" ? "en attente"
              : p.outcome === "expired" ? "expirée"
              : p.outcome === "superseded" ? "remplacée"
              : p.status
            }</span></td></tr>`,
          )
          .join("") || `<tr><td colspan="6" class="muted">Aucun paiement.</td></tr>`}</table>
      </div>`;
  });

  // -------------------------------------------------------------------------
  // Synchro iCal
  // -------------------------------------------------------------------------
  registerView("ical", "Synchro iCal", async (root) => {
    const data = await api(`/api/admin/ical?property=${currentPropertyId()}`);
    const { units } = await api(`/api/admin/units?property=${currentPropertyId()}`);
    root.innerHTML = `
      <div class="note">Export : à coller dans Airbnb (« Importer un calendrier »). Import : l'URL iCal fournie par Airbnb, relevée automatiquement toutes les 15 minutes (délai de rafraîchissement côté Airbnb : ~2 h — assumé, cf. plan phase 3). En cas de conflit de dates, l'événement est refusé et une alerte apparaît sur le tableau de bord.</div>
      <div class="card mb"><h3>Nos calendriers (export → vers les canaux)</h3>
        <table><tr><th>Unité</th><th>URL d'export</th><th></th></tr>
        ${data.exports
          .map(
            (e) => `<tr><td>${esc(e.unitName)}</td><td class="mono small">${esc(e.url)}</td>
            <td><button class="btn o sm copyUrl" data-url="${esc(e.url)}">Copier</button></td></tr>`,
          )
          .join("")}</table>
        <p class="small muted" style="margin-top:6px">Les exports incluent les blocages par liaison : si le Domaine entier est réservé, les calendriers des deux maisons affichent la période comme occupée.</p>
      </div>
      <div class="card"><h3>Flux entrants (import ← depuis les canaux)</h3>
        <table><tr><th>Nom</th><th>Unité</th><th>URL</th><th>Actif</th><th>Dernier relevé</th><th>Statut</th><th></th></tr>
        ${data.feeds
          .map(
            (f) => `<tr data-feed="${f.id}">
            <td>${esc(f.name)}</td><td>${esc(f.unitName ?? "")}</td>
            <td class="mono small" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(f.url)}</td>
            <td><input type="checkbox" class="fActive" ${f.active ? "checked" : ""}></td>
            <td class="small">${f.lastSyncAt ? esc(f.lastSyncAt.slice(0, 16)) : "jamais"}</td>
            <td class="small">${f.lastStatus ? esc(f.lastStatus) : "—"}</td>
            <td><button class="btn o sm fSync">Relever</button> <button class="btn sm fSave">💾</button> <button class="btn warn sm fDel">🗑</button></td></tr>`,
          )
          .join("") || `<tr><td colspan="7" class="muted">Aucun flux — utile en phase 3 (Airbnb du Moulin).</td></tr>`}</table>
        <div class="row" style="margin-top:10px">
          <div class="n"><label class="f">Unité</label><select id="nfUnit">${units.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div>
          <div class="n" style="min-width:160px"><label class="f">Nom</label><input id="nfName" placeholder="Airbnb — Moulin"></div>
          <div style="min-width:260px"><label class="f">URL iCal</label><input id="nfUrl" placeholder="https://www.airbnb.com/calendar/ical/…"></div>
          <div class="n"><button class="btn sm" id="nfAdd">+ Ajouter</button></div>
          <div class="right n"><button class="btn o sm" id="syncAll">Tout relever maintenant</button></div>
        </div>
      </div>`;

    root.querySelectorAll(".copyUrl").forEach((b) => (b.onclick = () => copyText(b.dataset.url)));
    root.querySelector("#nfAdd").onclick = async () => {
      await api("/api/admin/ical-feeds", {
        method: "POST",
        body: { unitId: Number(root.querySelector("#nfUnit").value), name: root.querySelector("#nfName").value, url: root.querySelector("#nfUrl").value },
      });
      toast("Flux ajouté");
      location.reload();
    };
    root.querySelector("#syncAll").onclick = async () => {
      const { results } = await api("/api/admin/ical-sync", { method: "POST" });
      toast(`Relevé terminé (${results.length} flux)`);
      location.reload();
    };
    root.querySelectorAll("tr[data-feed]").forEach((tr) => {
      const id = tr.dataset.feed;
      tr.querySelector(".fSave").onclick = async () => {
        await api(`/api/admin/ical-feeds/${id}`, { method: "PATCH", body: { active: tr.querySelector(".fActive").checked } });
        toast("Flux enregistré");
      };
      tr.querySelector(".fSync").onclick = async () => {
        const { result } = await api(`/api/admin/ical-feeds/${id}/sync`, { method: "POST" });
        toast(result.error ? `Erreur : ${result.error}` : `Importés ${result.imported}, modifiés ${result.updated}, annulés ${result.cancelled}, conflits ${result.conflicts.length}`, !!result.error || result.conflicts.length > 0);
        location.reload();
      };
      tr.querySelector(".fDel").onclick = async () => {
        if (!confirm("Supprimer ce flux ? (les résas déjà importées restent)")) return;
        await api(`/api/admin/ical-feeds/${id}`, { method: "DELETE" });
        location.reload();
      };
    });
  });

  // -------------------------------------------------------------------------
  // Paramètres
  // -------------------------------------------------------------------------
  registerView("params", "Paramètres", async (root) => {
    const { property, settings, units } = await api(`/api/admin/settings?property=${currentPropertyId()}`);
    const { links } = await api(`/api/admin/units?property=${currentPropertyId()}`);
    const mutualsOf = (unitId) =>
      new Set(links.filter((l) => l.unitId === unitId).map((l) => l.blocksUnitId));
    const todos = [];
    if ((property.contactEmail ?? "").includes("TODO")) todos.push("email de contact du domaine");
    if ((settings.cgvText ?? "").includes("TODO")) todos.push("CGV / contrat de location");
    if (units.some((u) => (u.description ?? "").includes("TODO"))) todos.push("descriptions des hébergements");
    todos.push("grille tarifaire réelle et taxe de séjour (placeholders wireframe)");

    root.innerHTML = `
      <div class="note">⚠️ Valeurs à confirmer avec Julien (plan v1 § 8) : ${esc(todos.join(" · "))}.</div>
      <div class="grid c2e mb">
        <div class="card"><h3>Domaine</h3>
          <div class="formgrid">
            <div><label class="f">Nom</label><input id="prName" value="${esc(property.name)}"></div>
            <div><label class="f">Commune (taxe)</label><input id="prCommune" value="${esc(property.commune ?? "")}"></div>
            <div><label class="f">Adresse</label><input id="prAddr" value="${esc(property.address ?? "")}"></div>
            <div><label class="f">Email de contact</label><input id="prEmail" value="${esc(property.contactEmail ?? "")}"></div>
            <div><label class="f">Téléphone</label><input id="prPhone" value="${esc(property.contactPhone ?? "")}"></div>
          </div>
          <div class="row" style="margin-top:10px"><button class="btn sm" id="prSave">Enregistrer</button></div>
        </div>
        <div class="card"><h3>Paiement &amp; séjour</h3>
          <div class="formgrid">
            <div><label class="f">Arrhes (%) par défaut</label><input id="stDeposit" type="number" value="${settings.depositPct}"></div>
            <div><label class="f">Solde à J−</label><input id="stBalance" type="number" value="${settings.balanceDueDays}"></div>
            <div><label class="f">Option de paiement (min)</label><input id="stHold" type="number" value="${settings.holdMinutes}"></div>
            <div><label class="f">Taxe séjour (€/pers/nuit)</label><input id="stTax" value="${eurInput(settings.touristTaxCentsPerPersonNight)}"></div>
            <div><label class="f">Taxe : enfants inclus</label><input id="stTaxKids" type="checkbox" ${settings.touristTaxIncludeChildren ? "checked" : ""}></div>
            <div><label class="f">Arrivée dès</label><input id="stIn" value="${esc(settings.checkinTime)}"></div>
            <div><label class="f">Départ avant</label><input id="stOut" value="${esc(settings.checkoutTime)}"></div>
            <div><label class="f">Arrhes autorisées</label><input id="stAllowDep" type="checkbox" ${settings.allowDeposit ? "checked" : ""}></div>
            <div><label class="f">Paiement total autorisé</label><input id="stAllowFull" type="checkbox" ${settings.allowFullPayment ? "checked" : ""}></div>
          </div>
          <div class="row" style="margin-top:10px"><button class="btn sm" id="stSave">Enregistrer</button></div>
        </div>
      </div>
      <div class="card mb"><h3>✉️ Email — accusé de réception &amp; transfert</h3>
        <div class="row mb">
          <div class="n"><label class="f">Accusé automatique</label><input id="emAuto" type="checkbox" ${settings.autoReplyEnabled ? "checked" : ""}></div>
          <div style="min-width:260px"><label class="f">Transférer les mails entrants vers</label><input id="emFwd" value="${esc(settings.emailForwardTo)}" placeholder="ton.adresse@gmail.com"></div>
        </div>
        <div class="mb"><label class="f">Texte de l'accusé de réception ({nom} et {reference} sont remplacés)</label>
          <textarea id="emText" rows="5">${esc(settings.autoReplyText)}</textarea></div>
        <div class="row"><button class="btn sm" id="emSave">Enregistrer</button>
          <span class="small muted">L'adresse de contact publique du domaine se règle dans la carte « Domaine » ci-dessus. La réception réelle nécessite l'activation de Cloudflare Email Routing sur le domaine (runbook au README) — en attendant, tout se teste via « Messages → Simuler un email ».</span></div>
      </div>
      <div class="card mb"><h3>CGV &amp; contrat de location (jointes au voucher)</h3>
        <textarea id="stCgv" rows="6">${esc(settings.cgvText)}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="cgvSave">Enregistrer les CGV</button>
        <span class="muted small">Version 2.0 posée par la migration 0016. Texte brut : une ligne « Article N » isolée est affichée en gras dans le tunnel. L'article 4.1 renvoie au pourcentage d'arrhes de l'hébergement, réglé ci-dessous.</span></div>
      </div>
      <div class="card mb"><h3>Hébergements</h3>
        ${units
          .map((u) => {
            const partners = mutualsOf(u.id);
            const others = units.filter((x) => x.id !== u.id);
            return `<div data-unit="${u.id}" style="border-bottom:1px solid var(--line);padding:10px 0">
            <div class="row">
            <div class="n" style="min-width:160px"><label class="f">Nom ${u.isComposite ? "🔗" : ""}</label><input class="uName" value="${esc(u.name)}"></div>
            <div style="min-width:200px"><label class="f">Description publique</label><input class="uDesc" value="${esc(u.description ?? "")}"></div>
            <div class="n"><label class="f">Cap. std</label><input class="uCapB inline-num" type="number" value="${u.capacityBase}"></div>
            <div class="n"><label class="f">Cap. max</label><input class="uCapM inline-num" type="number" value="${u.capacityMax}"></div>
            <div class="n"><label class="f">Ménage (€)</label><input class="uFee inline-num" value="${eurInput(u.cleaningFeeCents ?? 0)}"></div>
            <div class="n"><label class="f">Arrhes (%)</label><input class="uDeposit inline-num" type="number" min="0" max="100" placeholder="${settings.depositPct}" value="${u.depositPct ?? ""}" title="Vide = pourcentage du domaine (${settings.depositPct} %)"></div>
            ${u.isComposite ? `<div class="n"><label class="f">Prix combiné</label><select class="uPricing">
              <option value="sum" ${u.compositePricing === "sum" ? "selected" : ""}>Somme des biens liés</option>
              <option value="own" ${u.compositePricing === "own" ? "selected" : ""}>Tarif propre</option></select></div>` : ""}
            <div class="n"><label class="f">Actif</label><input class="uActive" type="checkbox" ${u.active ? "checked" : ""}></div>
            <div class="n"><button class="btn sm uSave">💾</button></div>
            </div>
            <div class="row" style="margin-top:6px">
            <div style="min-width:280px"><label class="f">Photo (URL)</label><input class="uPhoto" value="${esc(u.photoUrl ?? "")}" placeholder="https://…jpg"></div>
            <div style="min-width:220px"><label class="f">Liaisons (résa de l'un ⇒ bloque l'autre)</label>
              <span style="display:inline-flex;gap:10px;flex-wrap:wrap;padding-top:6px">
              ${others.map((o) => `<label class="small"><input type="checkbox" class="uLink" data-target="${o.id}" ${partners.has(o.id) ? "checked" : ""}> ${esc(o.name)}</label>`).join("")}
              </span></div>
            <div class="n"><button class="btn o sm uLinksSave">💾 liaisons</button></div>
            </div>
          </div>`;
          })
          .join("")}
        <p class="small muted" style="margin-top:8px">« Prix combiné » d'un bien 🔗 : somme des biens liés (défaut, TODO_PRIX_COMBINE) ou tarif propre (règles dans Calendrier › Prix). Les frais de ménage s'ajoutent automatiquement au devis ; pour un combiné en mode somme, ils cumulent ceux des biens liés.</p>
      </div>
      <div class="card"><h3>+ Ajouter un hébergement (maison C, nouveau gîte…)</h3>
        <div class="row">
          <div class="n" style="min-width:170px"><label class="f">Nom *</label><input id="cuName" placeholder="Maison C"></div>
          <div class="n"><label class="f">Cap. std</label><input id="cuCapB" class="inline-num" type="number" value="4"></div>
          <div class="n"><label class="f">Cap. max</label><input id="cuCapM" class="inline-num" type="number" value="6"></div>
          <div class="n"><label class="f">Ménage (€)</label><input id="cuFee" class="inline-num" value="0"></div>
          <div class="n"><label class="f">Nuit sem. (€)</label><input id="cuWeek" class="inline-num" placeholder="120"></div>
          <div class="n"><label class="f">Nuit WE (€)</label><input id="cuWe" class="inline-num" placeholder="150"></div>
          <div class="n"><label class="f">Min. nuits</label><input id="cuMin" class="inline-num" type="number" value="2"></div>
        </div>
        <div class="row" style="margin-top:8px">
          <div style="min-width:240px"><label class="f">Liaisons mutuelles</label>
            <span style="display:inline-flex;gap:10px;flex-wrap:wrap;padding-top:6px">
            ${units.map((o) => `<label class="small"><input type="checkbox" class="cuLink" data-target="${o.id}"> ${esc(o.name)}</label>`).join("")}
            </span></div>
          <div class="n"><label class="f">Bien combiné 🔗</label><input id="cuComposite" type="checkbox" title="Ce bien vend plusieurs biens liés ensemble (comme le Domaine entier)"></div>
          <div class="n"><button class="btn sm" id="cuCreate">Créer le bien</button></div>
        </div>
        <p class="small muted" style="margin-top:6px">Un bien lié au « Domaine entier » le bloque (et réciproquement). Pour un futur combiné A+B+C : créer le bien, cocher « combiné », le lier aux maisons qu'il regroupe.</p>
      </div>`;

    root.querySelector("#prSave").onclick = async () => {
      await api(`/api/admin/properties/${currentPropertyId()}`, {
        method: "PATCH",
        body: {
          name: root.querySelector("#prName").value,
          commune: root.querySelector("#prCommune").value,
          address: root.querySelector("#prAddr").value,
          contactEmail: root.querySelector("#prEmail").value,
          contactPhone: root.querySelector("#prPhone").value,
        },
      });
      toast("Domaine enregistré");
    };
    root.querySelector("#stSave").onclick = async () => {
      await api(`/api/admin/settings?property=${currentPropertyId()}`, {
        method: "PUT",
        body: {
          settings: {
            deposit_pct: Number(root.querySelector("#stDeposit").value),
            balance_due_days: Number(root.querySelector("#stBalance").value),
            hold_minutes: Number(root.querySelector("#stHold").value),
            tourist_tax_cents_per_person_night: toCents(root.querySelector("#stTax").value),
            tourist_tax_include_children: root.querySelector("#stTaxKids").checked,
            checkin_time: root.querySelector("#stIn").value,
            checkout_time: root.querySelector("#stOut").value,
            allow_deposit: root.querySelector("#stAllowDep").checked,
            allow_full_payment: root.querySelector("#stAllowFull").checked,
          },
        },
      });
      toast("Paramètres enregistrés");
    };
    root.querySelector("#emSave").onclick = async () => {
      await api(`/api/admin/settings?property=${currentPropertyId()}`, {
        method: "PUT",
        body: {
          settings: {
            auto_reply_enabled: root.querySelector("#emAuto").checked,
            auto_reply_text: root.querySelector("#emText").value,
            email_forward_to: root.querySelector("#emFwd").value.trim(),
          },
        },
      });
      toast("Réglages email enregistrés");
    };
    root.querySelector("#cgvSave").onclick = async () => {
      await api(`/api/admin/settings?property=${currentPropertyId()}`, {
        method: "PUT",
        body: { settings: { cgv_text: root.querySelector("#stCgv").value } },
      });
      toast("CGV enregistrées");
    };
    root.querySelectorAll("[data-unit]").forEach((row) => {
      row.querySelector(".uSave").onclick = async () => {
        await api(`/api/admin/units/${row.dataset.unit}`, {
          method: "PATCH",
          body: {
            name: row.querySelector(".uName").value,
            description: row.querySelector(".uDesc").value,
            capacityBase: Number(row.querySelector(".uCapB").value),
            capacityMax: Number(row.querySelector(".uCapM").value),
            cleaningFeeCents: toCents(row.querySelector(".uFee").value),
            // Champ vidé → null → repli sur le pourcentage du domaine (issue #75).
            depositPct: row.querySelector(".uDeposit").value.trim() === "" ? null : Number(row.querySelector(".uDeposit").value),
            photoUrl: row.querySelector(".uPhoto").value.trim(),
            active: row.querySelector(".uActive").checked,
            ...(row.querySelector(".uPricing") ? { compositePricing: row.querySelector(".uPricing").value } : {}),
          },
        });
        toast("Hébergement enregistré");
      };
      row.querySelector(".uLinksSave").onclick = async () => {
        const partnerIds = [...row.querySelectorAll(".uLink:checked")].map((c) => Number(c.dataset.target));
        await api(`/api/admin/units/${row.dataset.unit}/links`, { method: "PUT", body: { partnerIds } });
        toast("Liaisons enregistrées — effet immédiat sur les disponibilités");
      };
    });

    root.querySelector("#cuCreate").onclick = async () => {
      const name = root.querySelector("#cuName").value.trim();
      if (name.length < 2) return toast("Nom du bien requis", true);
      const week = toCents(root.querySelector("#cuWeek").value);
      const body = {
        propertyId: currentPropertyId(),
        name,
        capacityBase: Number(root.querySelector("#cuCapB").value) || 2,
        capacityMax: Number(root.querySelector("#cuCapM").value) || 2,
        cleaningFeeCents: toCents(root.querySelector("#cuFee").value),
        isComposite: root.querySelector("#cuComposite").checked,
        compositePricing: root.querySelector("#cuComposite").checked ? "sum" : "own",
        linkedUnitIds: [...root.querySelectorAll(".cuLink:checked")].map((c) => Number(c.dataset.target)),
        ...(week ? { priceWeekCents: week, priceWeekendCents: toCents(root.querySelector("#cuWe").value) || week, minNights: Number(root.querySelector("#cuMin").value) || 2 } : {}),
      };
      const res = await api("/api/admin/units", { method: "POST", body });
      toast(`Bien créé (id ${res.id})`);
      location.reload();
    };
  });

  // ── Canaux OTA (Beds24) — le poste de pilotage : jamais besoin d'ouvrir Beds24 ──
  registerView("canaux", "Canaux OTA", async (root) => {
    const data = await api(`/api/admin/channels/overview?property=${currentPropertyId()}`);
    const mapped = data.units.filter((u) => u.beds24RoomId);
    const openConflicts = (data.conflicts || []).filter((c) => c.status === "open");
    const ignoredConflicts = (data.conflicts || []).filter((c) => c.status === "ignored");
    const statusBadge = data.configured
      ? `<span class="tag t-ok">Connecté à Beds24</span>`
      : `<span class="tag t-warn">Non configuré — aucun jeton Beds24</span>`;
    const prop = data.property;
    root.innerHTML = `
      <div class="note">Cette page pilote la distribution sur les plateformes (Airbnb, Booking, Vrbo…) via Beds24
        — <b>sans jamais ouvrir Beds24</b>, et <b>en temps réel</b> : chaque réservation, annulation ou
        changement de tarif chez nous est poussé immédiatement ; les réservations des canaux redescendent
        à la notification (webhook) — le cycle de 15 minutes n'est qu'un filet de sécurité. Prochaine
        étape (une seule fois) : créer les annonces sur les plateformes puis les relier — demandez à
        Claude de vous guider.</div>

      <div class="card mb"><h3>État de la liaison</h3>
        <p>${statusBadge} ${prop?.beds24PropertyId ? `· Propriété Beds24 <b class="mono">#${prop.beds24PropertyId}</b> (« ${esc(prop.name)} »)` : "· propriété non mappée"}
        · dernier rapatriement : <b>${data.lastPull ? esc(data.lastPull.slice(0, 16)) : "jamais"}</b></p>
        <p style="margin-top:10px">
          <button class="btn o sm" id="chkStatus">Tester la connexion</button>
          <button class="btn sm" id="doPull">⬇ Rapatrier les résas maintenant</button>
          <button class="btn sm" id="doPush">⬆ Pousser les calendriers maintenant</button>
          <span id="chanNote" class="small muted"></span></p>
        <p class="small muted" style="margin-top:6px">En local sous VPN, ces actions peuvent échouer (réseau du serveur de dev) —
          elles fonctionnent en continu une fois le site en production.</p>
        ${data.webhookUrl ? `<p class="small muted" style="margin-top:4px">Webhook temps réel (à coller dans Beds24 au déploiement — demandez à Claude) :
          <span class="mono" style="word-break:break-all">${esc(data.webhookUrl)}</span>
          <button class="btn o sm copyWebhook" style="margin-left:6px">Copier</button></p>` : ""}
      </div>

      ${data.configured ? "" : `
      <div class="card mb" style="border-left:4px solid #b45309">
        <h3>🔧 Rétablir la liaison Beds24</h3>
        <p class="small">La plateforme n'a pas (ou plus) de jeton Beds24 valide. Pour rétablir <b>sans quitter cette page</b> :</p>
        <ol class="small" style="margin:8px 0 10px 18px;line-height:1.7">
          <li>Ouvrir <a href="https://beds24.com" target="_blank" rel="noopener">beds24.com</a> → connexion → <b>Settings → Apps &amp; Integrations → API</b>.</li>
          <li>Générer un <b>invite code</b> (lecture/écriture : bookings, inventory, properties, channels — sans whitelist IP).</li>
          <li>Le coller ci-dessous — l'échange et l'enregistrement sont automatiques, aucun redéploiement.</li>
        </ol>
        <p><input id="b24code" placeholder="Code d'invitation Beds24" style="min-width:260px">
          <button class="btn sm" id="b24link">Rétablir la liaison</button>
          <span id="b24note" class="small muted"></span></p>
        <p class="small muted">En cas de doute, demandez à Claude : « rétablis la liaison Beds24 » — il vous guide pas à pas.</p>
      </div>`}

      <div class="card mb"><h3>Conflits de synchronisation ${
        openConflicts.length === 0
          ? `<span class="tag t-ok">aucun</span>`
          : `<span class="tag t-warn">${openConflicts.length} ouvert${openConflicts.length > 1 ? "s" : ""}</span>`
      }</h3>
        <p class="small muted">Ce qu'une plateforme annonce et que nous n'avons <b>pas pu refléter</b> : les dates
          restent en vente d'un côté et occupées de l'autre. Un conflit reste listé tant qu'il se reproduit, et
          disparaît de lui-même dès que la synchro ne le revoit plus — rien à cocher.</p>
        ${openConflicts.length === 0
          ? `<p class="muted">Rien à trancher : tout ce que les plateformes annoncent est reflété chez nous.</p>`
          : `<table><tr><th>Hébergement</th><th>Séjour</th><th>Ce qui bloque</th><th>Détecté</th><th class="r">Décision</th></tr>
            ${openConflicts.map((c) => `<tr>
              <td>${esc(c.unitName)}<div class="small muted">${esc(c.channelLabel || (c.source === "ical" ? "Flux iCal" : "Canal"))}</div></td>
              <td>${dshort(c.checkin)} → ${dshort(c.checkout)}</td>
              <td class="small">${esc(c.label)}</td>
              <td class="small">${esc((c.firstSeenAt || "").slice(0, 16))}<div class="muted">revu ${esc((c.lastSeenAt || "").slice(0, 16))}</div></td>
              <td class="r">
                <button class="btn o sm cPlan" data-date="${esc(c.checkin)}">Voir au planning</button>
                <button class="btn o sm cIgnore" data-id="${c.id}">Ignorer</button></td></tr>`).join("")}</table>`}
        ${ignoredConflicts.length === 0 ? "" : `
          <h4 style="margin-top:14px">Ignorés</h4>
          <table><tr><th>Hébergement</th><th>Séjour</th><th>Ce qui bloque</th><th>Motif</th><th class="r">Décision</th></tr>
          ${ignoredConflicts.map((c) => `<tr class="muted">
            <td>${esc(c.unitName)}</td><td>${dshort(c.checkin)} → ${dshort(c.checkout)}</td>
            <td class="small">${esc(c.label)}</td>
            <td class="small">${esc(c.ignoreReason || "—")}</td>
            <td class="r"><button class="btn o sm cReopen" data-id="${c.id}">Rouvrir</button></td></tr>`).join("")}</table>`}
      </div>

      <div class="card mb"><h3>Correspondance des hébergements</h3>
        <table><tr><th>Chez nous</th><th>Chez Beds24</th></tr>
        ${data.units.map((u) => `<tr><td>${esc(u.name)}</td>
          <td>${u.beds24RoomId ? `<span class="mono">room #${u.beds24RoomId}</span>` : u.isComposite ? `<span class="muted">vente directe uniquement — la liaison ferme les deux rooms automatiquement</span>` : `<span class="muted">non mappé</span>`}</td></tr>`).join("")}
        </table></div>

      <div class="card mb"><h3>Réservations venues des canaux</h3>
        ${data.channelBookings.length
          ? `<table><tr><th>Réf</th><th>Canal</th><th>Hébergement</th><th>Séjour</th><th>Client</th><th class="r">Montant</th></tr>
            ${data.channelBookings.map((b) => `<tr><td class="mono">${esc(b.reference)}</td><td>${esc(b.channelLabel ?? "—")}</td>
              <td>${esc(b.unitName ?? "")}</td><td>${dshort(b.checkin)} → ${dshort(b.checkout)}</td>
              <td>${esc(b.guestName ?? "")}</td><td class="r">${eur(b.totalCents)}</td></tr>`).join("")}</table>`
          : `<p class="muted">Aucune pour l'instant — elles apparaîtront ici (et dans Calendrier › Occupation et Ventes › Réservations) dès que les annonces seront reliées.</p>`}
      </div>

      <div class="card"><h3>Journal de synchronisation</h3>
        ${data.events.length
          ? `<table><tr><th>Quand</th><th>Action</th><th>Détail</th></tr>
            ${data.events.map((e) => `<tr><td class="small">${esc(e.createdAt.slice(0, 16))}</td>
              <td class="mono small">${esc(e.action)}</td><td class="small muted">${esc((e.detail ?? "").slice(0, 90))}</td></tr>`).join("")}</table>`
          : `<p class="muted">Encore aucun événement.</p>`}
      </div>`;

    const note = root.querySelector("#chanNote");
    root.querySelectorAll(".copyWebhook").forEach((b) => (b.onclick = () => copyText(data.webhookUrl)));

    // Conflits de synchro (issue #72) : le planning à la bonne date, et la
    // décision d'ignorer — jamais sans motif, c'est lui qui rend la décision
    // relisible dans six mois.
    root.querySelectorAll(".cPlan").forEach((b) => (b.onclick = () => {
      state.calMonth = (b.dataset.date || "").slice(0, 7);
      location.hash = "#/cal";
    }));
    const setConflict = async (id, status, reason) => {
      await api(`/api/admin/sync-conflicts/${id}`, { method: "PATCH", body: { status, reason } });
      toast(status === "ignored" ? "Conflit ignoré" : "Conflit rouvert");
      location.reload();
    };
    root.querySelectorAll(".cIgnore").forEach((b) => (b.onclick = async () => {
      const reason = (prompt("Pourquoi ignorer ce conflit ? (le motif reste affiché)") || "").trim();
      if (!reason) return;
      await setConflict(b.dataset.id, "ignored", reason);
    }));
    root.querySelectorAll(".cReopen").forEach((b) => (b.onclick = () => setConflict(b.dataset.id, "open", "")));
    root.querySelector("#chkStatus").onclick = async () => {
      note.textContent = "test en cours…";
      try {
        const s = await api("/api/admin/beds24/status");
        note.textContent = s.connected
          ? `✅ connecté — ${s.properties?.length ?? 0} propriété(s) visible(s) côté Beds24`
          : `⚠️ ${s.error ?? "échec"}`;
      } catch (e) { note.textContent = `⚠️ ${e.message}`; }
    };
    root.querySelector("#doPull").onclick = async () => {
      note.textContent = "rapatriement…";
      try {
        const r = await api("/api/admin/beds24/pull", { method: "POST", body: { propertyId: currentPropertyId() } });
        toast(`Rapatriement : ${r.imported} nouvelle(s), ${r.updated} modifiée(s), ${r.cancelled} annulée(s)`);
        location.reload();
      } catch (e) { note.textContent = `⚠️ ${e.message}`; }
    };
    root.querySelector("#doPush").onclick = async () => {
      note.textContent = "push…";
      try {
        const r = await api("/api/admin/beds24/push", { method: "POST", body: { propertyId: currentPropertyId() } });
        toast(`Calendriers poussés : ${r.pushed.map((x) => x.unitName).join(", ")}`);
        note.textContent = "";
      } catch (e) { note.textContent = `⚠️ ${e.message}`; }
    };
    const b24btn = root.querySelector("#b24link");
    if (b24btn) b24btn.onclick = async () => {
      const code = root.querySelector("#b24code").value.trim();
      const n = root.querySelector("#b24note");
      if (!code) { n.textContent = "⚠️ colle d'abord le code d'invitation"; return; }
      n.textContent = "échange du code…";
      try {
        const r = await api("/api/admin/beds24/invite-code", { method: "POST", body: { code } });
        toast(r.status?.connected ? "Liaison Beds24 rétablie ✅" : "Jeton enregistré — vérifie la connexion");
        location.reload();
      } catch (e) { n.textContent = `⚠️ ${e.message}`; }
    };
  });

  // ── Utilisateurs — les accès au back-office se gèrent ici (comptes en base) ──
  registerView("users", "Utilisateurs", async (root) => {
    const data = await api("/api/admin/users");
    const rows = data.users.map((u) => `
      <tr>
        <td><b>${esc(u.username)}</b></td>
        <td>${u.active ? `<span class="tag t-ok">actif</span>` : `<span class="tag t-warn">désactivé</span>`}</td>
        <td class="small">${u.last_login_at ? esc(u.last_login_at.slice(0, 16)) : "jamais"}</td>
        <td>${u.sessions}</td>
        <td class="r">
          <button class="btn o sm uReset" data-id="${u.id}" data-name="${esc(u.username)}">🔑 Nouveau mdp</button>
          <button class="btn o sm uToggle" data-id="${u.id}" data-name="${esc(u.username)}" data-active="${u.active}">${u.active ? "⏸ Désactiver" : "▶ Réactiver"}</button>
          <button class="btn o sm uDel" data-id="${u.id}" data-name="${esc(u.username)}">🗑 Supprimer</button>
        </td>
      </tr>`).join("");
    root.innerHTML = `
      <div class="note">Les accès au back-office se gèrent ici : création d'un compte, nouveau mot de passe,
        désactivation (immédiate — les sessions ouvertes tombent aussi). Les mots de passe sont générés par la
        plateforme (« trois-mots-nombre », dictables par téléphone) et affichés <b>une seule fois</b> —
        notez-les ou enregistrez-les dans un gestionnaire de mots de passe.</div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <h3>Comptes (${data.users.length})</h3>
          <button class="btn sm" id="uAdd">➕ Ajouter un utilisateur</button>
        </div>
        ${data.users.length
          ? `<table><tr><th>Identifiant</th><th>État</th><th>Dernière connexion</th><th>Sessions actives</th><th class="r">Actions</th></tr>${rows}</table>`
          : `<p class="muted">Aucun compte en base — les accès actuels passent par le secret serveur.</p>`}
      </div>`;

    const showPassword = (username, password, titre) => {
      const bg = openModal(`
        <h3>${titre}</h3>
        <p>Compte <b>${esc(username)}</b> — mot de passe (affiché une seule fois) :</p>
        <p class="mono" style="font-size:17px;background:#f5f5f2;padding:10px 12px;border-radius:8px;user-select:all">${esc(password)}</p>
        <p><button class="btn sm" id="pwCopy">Copier</button> <button class="btn o sm x">Fermer</button></p>`);
      bg.querySelector("#pwCopy").addEventListener("click", () => { copyText(password); toast("Copié"); });
      bg.querySelector(".x").addEventListener("click", () => location.reload());
    };

    root.querySelector("#uAdd").addEventListener("click", async () => {
      const username = prompt("Identifiant du nouveau compte (a-z, 0-9, point, tiret, underscore) :");
      if (!username) return;
      try {
        const r = await api("/api/admin/users", { method: "POST", body: { username: username.trim().toLowerCase() } });
        showPassword(r.username, r.password, "Compte créé ✅");
      } catch (e) { toast(e.message, true); }
    });
    root.querySelectorAll(".uReset").forEach((b) => (b.onclick = async () => {
      if (!confirm(`Générer un nouveau mot de passe pour « ${b.dataset.name} » ? L'ancien cessera de fonctionner immédiatement.`)) return;
      try {
        const r = await api(`/api/admin/users/${b.dataset.id}/reset-password`, { method: "POST" });
        showPassword(r.username, r.password, "Nouveau mot de passe 🔑");
      } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll(".uToggle").forEach((b) => (b.onclick = async () => {
      const activer = b.dataset.active !== "1";
      if (!activer && !confirm(`Désactiver « ${b.dataset.name} » ? Ses sessions ouvertes seront coupées.`)) return;
      try {
        await api(`/api/admin/users/${b.dataset.id}`, { method: "PATCH", body: { active: activer } });
        toast(activer ? "Compte réactivé" : "Compte désactivé");
        location.reload();
      } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll(".uDel").forEach((b) => (b.onclick = async () => {
      if (!confirm(`Supprimer définitivement le compte « ${b.dataset.name} » ?`)) return;
      try {
        await api(`/api/admin/users/${b.dataset.id}`, { method: "DELETE" });
        toast("Compte supprimé");
        location.reload();
      } catch (e) { toast(e.message, true); }
    }));
  });
}
