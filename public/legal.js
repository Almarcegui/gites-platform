// Pages légales (issue #9) : tout ce qui peut changer est lu depuis l'API
// publique, rien n'est écrit en dur dans le HTML.
//
// Même principe que `prix.js` et `arrhes.js` : une valeur figée dans une page
// finit toujours par mentir. Ici trois familles de cibles :
//
//   data-contact-email="<slug>"     adresse de contact du domaine
//                                   (`properties.contact_email`, réglée dans
//                                   le back-office). Tant qu'aucune adresse
//                                   n'est fournie, le serveur renvoie null et
//                                   la page renvoie au formulaire de contact —
//                                   jamais un placeholder.
//   data-contact-phone="<slug>"     téléphone du domaine, s'il existe.
//   data-registration="<slug>/<unit-slug>"
//                                   ligne « Numéro d'enregistrement » d'un
//                                   hébergement. Le champ n'existe pas encore
//                                   côté base (issue #10) : la ligne reste
//                                   masquée (`hidden`) tant que la fiche ne
//                                   porte pas de `registrationNumber`. Le jour
//                                   où le champ est exposé par l'API, la ligne
//                                   apparaît sans toucher au HTML.
//   data-cgv="<slug>"               conditions générales du domaine, rendues
//                                   par le MÊME module que le tunnel
//                                   (`/book/cgv.js`) depuis la MÊME source
//                                   (`cgvText` de la fiche domaine) : ce qui
//                                   est publié ici est exactement ce qui est
//                                   accepté à la réservation.
//
// Le repli du HTML est toujours lisible tel quel : « via le formulaire de
// contact du site », ligne masquée, « Conditions générales momentanément
// indisponibles ».

import { cgvHtml } from "/book/cgv.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fiches = new Map(); // slug → promesse de fiche domaine, une requête par domaine

function fiche(slug) {
  if (!fiches.has(slug)) {
    fiches.set(
      slug,
      fetch(`/api/public/properties/${encodeURIComponent(slug)}`).then((res) => {
        if (!res.ok) throw new Error(`fiche ${res.status}`);
        return res.json();
      }),
    );
  }
  return fiches.get(slug);
}

/** Une adresse exploitable : non vide et pas un placeholder de seed. */
const adresseUtilisable = (v) => typeof v === "string" && v.trim() !== "" && !/^TODO_/i.test(v.trim());

// --- adresse e-mail et téléphone de contact ---------------------------------
for (const cible of document.querySelectorAll("[data-contact-email]")) {
  fiche(cible.dataset.contactEmail)
    .then(({ property }) => {
      if (!adresseUtilisable(property?.contactEmail)) return; // repli HTML conservé
      const email = property.contactEmail.trim();
      const a = document.createElement("a");
      a.href = `mailto:${email}`;
      a.textContent = email;
      cible.replaceChildren(a);
    })
    .catch(() => {});
}

for (const cible of document.querySelectorAll("[data-contact-phone]")) {
  fiche(cible.dataset.contactPhone)
    .then(({ property }) => {
      if (!adresseUtilisable(property?.contactPhone)) return;
      // Le téléphone suit l'e-mail (ou son repli) sur la même ligne, cliquable.
      const tel = property.contactPhone.trim();
      const a = document.createElement("a");
      a.href = `tel:${tel.replace(/[^+\d]/g, "")}`;
      a.textContent = tel;
      cible.replaceChildren(document.createTextNode(" · "), a);
      cible.hidden = false;
    })
    .catch(() => {});
}

// --- numéro d'enregistrement par hébergement (masqué tant qu'absent) --------
for (const cible of document.querySelectorAll("[data-registration]")) {
  const [slug, unitSlug] = String(cible.dataset.registration).split("/");
  fiche(slug)
    .then(({ units }) => {
      const unit = (units ?? []).find((u) => u.slug === unitSlug);
      const numero = unit?.registrationNumber;
      if (!adresseUtilisable(numero)) return; // reste masqué (absent, vide ou TODO_)
      const valeur = cible.querySelector("[data-registration-value]") ?? cible;
      valeur.textContent = numero.trim();
      cible.hidden = false;
    })
    .catch(() => {});
}

// --- conditions générales (même source et même rendu que le tunnel) ---------
for (const cible of document.querySelectorAll("[data-cgv]")) {
  fiche(cible.dataset.cgv)
    .then(({ cgvText, units }) => {
      if (typeof cgvText !== "string" || !cgvText.trim()) {
        cible.innerHTML = "<p>Conditions générales momentanément indisponibles.</p>";
        return;
      }
      // Comme dans le tunnel et sur le voucher : le pourcentage d'arrhes de
      // l'article 4.1 est propre à chaque hébergement et lu des réglages.
      const arrhes = (units ?? [])
        .filter((u) => typeof u.depositPct === "number")
        .map((u) => `<p class="cgv-h"><b>Pour ${esc(u.name)}, le pourcentage d'arrhes de l'article 4.1 est de ${u.depositPct} %.</b></p>`)
        .join("");
      cible.innerHTML = cgvHtml(cgvText) + arrhes;
    })
    .catch(() => {
      cible.innerHTML = "<p>Conditions générales momentanément indisponibles.</p>";
    });
}

// --- sélecteur de domaine de la page conditions générales -------------------
const onglets = [...document.querySelectorAll("[data-cgv-tab]")];
if (onglets.length) {
  const panneaux = [...document.querySelectorAll("[data-cgv-panel]")];
  const choisir = (slug) => {
    for (const o of onglets) {
      const actif = o.dataset.cgvTab === slug;
      o.setAttribute("aria-selected", String(actif));
      o.tabIndex = actif ? 0 : -1;
    }
    for (const p of panneaux) p.hidden = p.dataset.cgvPanel !== slug;
    // L'URL suit l'onglet, comme dans le tunnel : la page reste partageable.
    const url = new URL(location.href);
    url.searchParams.set("property", slug);
    history.replaceState(null, "", url);
  };
  for (const o of onglets) o.addEventListener("click", () => choisir(o.dataset.cgvTab));
  // Flèches gauche/droite entre les onglets (pattern ARIA tabs) : sans cela,
  // le second onglet (tabindex -1) est inaccessible au clavier.
  onglets[0].parentElement.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = onglets.indexOf(document.activeElement);
    if (i < 0) return;
    const suivant = onglets[(i + (e.key === "ArrowRight" ? 1 : onglets.length - 1)) % onglets.length];
    choisir(suivant.dataset.cgvTab);
    suivant.focus();
    e.preventDefault();
  });
  // Deep-link ?property=<slug>, comme le tunnel ; Pré Moré par défaut.
  const demande = new URLSearchParams(location.search).get("property");
  choisir(onglets.some((o) => o.dataset.cgvTab === demande) ? demande : onglets[0].dataset.cgvTab);
}
