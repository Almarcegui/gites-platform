// Galerie photo des pages de gîtes (issue #32).
//
// AMÉLIORATION PROGRESSIVE. Sans ce fichier, la galerie fonctionne déjà : chaque
// vignette est un lien vers la photo en grand. Clavier, lecteur d'écran, clic
// droit « ouvrir dans un nouvel onglet » — tout marche, y compris si le script
// échoue à charger. Ce fichier ne fait que remplacer ce comportement par une
// visionneuse superposée.
//
// POURQUOI <dialog> ET PAS UNE VISIONNEUSE MAISON. `showModal()` apporte
// gratuitement les quatre choses qu'une lightbox artisanale rate presque
// toujours : fermeture par Échap, piège à focus, inertie du reste de la page
// pour les technologies d'assistance, et retour du focus sur la vignette
// d'origine à la fermeture. Aucune bibliothèque, aucune dépendance.

const galerie = document.querySelector("[data-galerie]");
const liens = galerie ? [...galerie.querySelectorAll("a[href]")] : [];

// `HTMLDialogElement` absent = navigateur trop ancien : on laisse les liens
// faire ce qu'ils savent faire. Mieux vaut une galerie simple qu'une cassée.
if (liens.length && typeof HTMLDialogElement === "function" && HTMLDialogElement.prototype.showModal) {
  const dlg = document.createElement("dialog");
  dlg.className = "visionneuse";
  dlg.setAttribute("aria-label", "Galerie photo");
  dlg.innerHTML = `
    <img class="v-img" alt="">
    <p class="v-legende" aria-live="polite"></p>
    <div class="v-barre">
      <button type="button" class="v-prec" aria-label="Photo précédente">&lsaquo;</button>
      <button type="button" class="v-fermer">Fermer</button>
      <button type="button" class="v-suiv" aria-label="Photo suivante">&rsaquo;</button>
    </div>`;
  document.body.append(dlg);

  const vImg = dlg.querySelector(".v-img");
  const vLegende = dlg.querySelector(".v-legende");
  let index = 0;

  function montrer(i) {
    // Modulo circulaire : depuis la dernière photo, « suivante » revient à la
    // première. Une galerie de huit photos n'a pas de raison d'avoir un cul-de-sac.
    index = (i + liens.length) % liens.length;
    const lien = liens[index];
    vImg.src = lien.getAttribute("href");
    // L'alt de la vignette décrit déjà la photo : le recopier évite d'entretenir
    // deux textes alternatifs pour la même image, qui divergeraient.
    vImg.alt = lien.querySelector("img")?.alt ?? "";
    vLegende.textContent = `${lien.dataset.legende ?? ""} — photo ${index + 1} sur ${liens.length}`.trim();
  }

  liens.forEach((lien, i) =>
    lien.addEventListener("click", (e) => {
      // Ctrl/Cmd/clic milieu : l'utilisateur veut un nouvel onglet, pas une
      // visionneuse. On ne lui vole pas son geste.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      montrer(i);
      dlg.showModal();
    })
  );

  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      montrer(index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      montrer(index - 1);
    }
    // Échap est géré nativement par <dialog>.
  });

  dlg.querySelector(".v-prec").addEventListener("click", () => montrer(index - 1));
  dlg.querySelector(".v-suiv").addEventListener("click", () => montrer(index + 1));
  dlg.querySelector(".v-fermer").addEventListener("click", () => dlg.close());

  // Clic sur le fond : `event.target` vaut le <dialog> lui-même, jamais un de
  // ses enfants — c'est ce qui distingue le fond du contenu.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });

  // Rien à nettoyer à la fermeture : `montrer()` pose la nouvelle source AVANT
  // `showModal()`, donc l'ancienne photo n'a jamais l'occasion d'apparaître.
  // Vider `src` à la fermeture forcerait au contraire un nouveau décodage à
  // chaque réouverture de la même photo.
}
