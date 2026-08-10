// Menu de navigation mobile (issue #13).
//
// Sous 820 px, les liens de contenu quittent la barre pour un panneau déroulant
// commandé par le bouton « menu ». Avant, ils passaient simplement en
// `display:none` : les cinq pages de contenu n'étaient plus atteignables que
// depuis le pied de page, tout en bas.
//
// Chargé sur toutes les pages publiques (`<script src="/nav.js" defer>`), sans
// dépendance. Le fichier est volontairement distinct de `site.js`, qui ne sert
// que la page d'accueil (calendrier, prix, formulaire de contact) et déclenche
// des appels API dont les pages de contenu n'ont que faire.

const btn = document.getElementById("navToggle");
const panel = document.getElementById("navPanel");

if (btn && panel) {
  const isOpen = () => btn.getAttribute("aria-expanded") === "true";

  function setOpen(open) {
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Fermer le menu" : "Ouvrir le menu");
    panel.toggleAttribute("data-open", open);
  }

  function close({ giveFocusBack = false } = {}) {
    if (!isOpen()) return;
    setOpen(false);
    // Échap et clic dehors : le focus doit revenir sur le bouton, sinon il reste
    // sur un élément devenu invisible et l'utilisateur au clavier est perdu.
    if (giveFocusBack) btn.focus();
  }

  btn.addEventListener("click", () => setOpen(!isOpen()));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close({ giveFocusBack: true });
  });

  document.addEventListener("click", (e) => {
    if (!isOpen() || panel.contains(e.target) || btn.contains(e.target)) return;
    close();
  });

  // Un lien du panneau : on referme (utile pour les ancres, qui ne rechargent rien).
  panel.addEventListener("click", (e) => {
    if (e.target.closest("a")) close();
  });

  // Retour au format large : le panneau redevient la barre horizontale, l'état
  // « ouvert » n'a plus de sens et laisserait `aria-expanded` mentir.
  const wide = window.matchMedia("(min-width: 821px)");
  wide.addEventListener("change", (e) => {
    if (e.matches) close();
  });
}
