// Galerie photo des pages de gîtes et du tunnel (issue #32).
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
//
// DEUX USAGES, UN SEUL CODE. Les pages de gîtes câblent la visionneuse sur leur
// grille `[data-galerie]` ; le tunnel de réservation l'ouvre sur les photos
// d'un hébergement (`import { visionneuse } from "/galerie.js"`). Le module ne
// fait rien tout seul quand la page n'a pas de grille.

const SUPPORT =
  typeof HTMLDialogElement === "function" && typeof HTMLDialogElement.prototype.showModal === "function";

/** Visionneuse partagée. `photos` : `[{ src, alt, legende }]`.
 *  Renvoie `null` si le navigateur ne sait pas ouvrir de `<dialog>` modale —
 *  l'appelant garde alors son comportement de repli (le lien vers l'image). */
export function visionneuse(photos) {
  if (!SUPPORT || photos.length === 0) return null;

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
    index = (i + photos.length) % photos.length;
    const photo = photos[index];
    vImg.src = photo.src;
    // `alt` et la légende viennent de la base : ce sont des TEXTES, posés en
    // propriété et en nœud texte. Jamais d'innerHTML ici — une légende éditée
    // depuis le back-office ne doit pas pouvoir injecter de balise.
    vImg.alt = photo.alt ?? "";
    const position = `photo ${index + 1} sur ${photos.length}`;
    vLegende.textContent = photo.legende ? `${photo.legende} — ${position}` : position;
  }

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
  return {
    ouvrir(i) {
      montrer(i ?? 0);
      dlg.showModal();
    },
    /** Retire la boîte du document. Utile quand la grille est reconstruite :
     *  sans ça, chaque recâblage laisserait un <dialog> orphelin derrière lui.
     *  On la FERME d'abord : retirer un `<dialog>` ouvert laisse la page inerte
     *  et le focus nulle part dans plusieurs navigateurs. */
    detruire() {
      if (dlg.open) dlg.close();
      dlg.remove();
    },
  };
}

/** Visionneuse actuellement rattachée à la grille de la page, s'il y en a une. */
let vueGrille = null;

/** Câble une grille `[data-galerie]` existante sur la visionneuse. */
function cablerGrille(grille) {
  const liens = [...grille.querySelectorAll("a[href]")];
  if (liens.length === 0) return;
  vueGrille?.detruire();
  vueGrille = null;
  const vue = visionneuse(
    liens.map((lien) => ({
      src: lien.getAttribute("href"),
      // L'alt de la vignette décrit déjà la photo : le reprendre évite
      // d'entretenir deux textes alternatifs qui divergeraient.
      alt: lien.querySelector("img")?.alt ?? "",
      legende: lien.dataset.legende ?? "",
    })),
  );
  if (!vue) return;
  vueGrille = vue;
  liens.forEach((lien, i) =>
    lien.addEventListener("click", (e) => {
      // Ctrl/Cmd/clic milieu : l'utilisateur veut un nouvel onglet, pas une
      // visionneuse. On ne lui vole pas son geste.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      vue.ouvrir(i);
    }),
  );
}

/** Construit une vignette identique au HTML servi par la page. Tout passe par
 *  `setAttribute` et `textContent` : aucune donnée de la base n'est interprétée
 *  comme du HTML. */
function figure(photo, sizes) {
  const fig = document.createElement("figure");
  const a = document.createElement("a");
  a.href = photo.path;
  if (photo.caption) a.dataset.legende = photo.caption;

  const pic = document.createElement("picture");
  if (photo.webpWidths?.length) {
    const base = photo.path.replace(/\.[a-z]+$/i, "");
    const src = document.createElement("source");
    src.type = "image/webp";
    src.srcset = photo.webpWidths.map((w) => `${base}-${w}.webp ${w}w`).join(", ");
    src.sizes = sizes;
    pic.append(src);
  }
  const img = document.createElement("img");
  img.src = photo.path;
  img.alt = photo.alt ?? "";
  img.loading = "lazy";
  if (photo.width) img.width = photo.width;
  if (photo.height) img.height = photo.height;
  pic.append(img);
  a.append(pic);
  fig.append(a);

  if (photo.caption) {
    const cap = document.createElement("figcaption");
    cap.textContent = photo.caption;
    fig.append(cap);
  }
  return fig;
}

/** Rejoue l'ordre et l'éditorial du back-office par-dessus le HTML servi.
 *
 *  POURQUOI PAS UN RENDU 100 % CLIENT. La galerie est le contenu principal de
 *  la page : servie en HTML, elle s'affiche sans JavaScript, se laisse indexer,
 *  et sa plus grande image est déjà en cours de chargement quand ce script
 *  s'exécute. On ne la remplace donc que si la base dit autre chose que le
 *  HTML — le cas normal ne coûte rien à l'écran.
 */
async function resynchroniser(grille) {
  const unit = grille.dataset.galerieUnit;
  const property = grille.dataset.galerieProperty;
  if (!unit || !property) return false;
  let photos;
  try {
    const res = await fetch(
      `/api/public/photos?property=${encodeURIComponent(property)}&unit=${encodeURIComponent(unit)}`,
    );
    if (!res.ok) return false;
    ({ photos } = await res.json());
  } catch {
    // Hors ligne, API en panne : la page garde sa galerie servie en HTML.
    return false;
  }
  // Une liste VIDE est une réponse légitime : le propriétaire a retiré toutes
  // les photos. La traiter comme une panne laisserait le site montrer des
  // vignettes que le back-office dit masquées — l'inverse de ce qu'on veut.
  if (!Array.isArray(photos)) return false;

  const actuel = [...grille.querySelectorAll("a[href]")].map(
    (a) => `${a.getAttribute("href")}|${a.querySelector("img")?.alt ?? ""}|${a.dataset.legende ?? ""}`,
  );
  const voulu = photos.map((p) => `${p.path}|${p.alt ?? ""}|${p.caption ?? ""}`);
  if (actuel.length === voulu.length && actuel.every((v, i) => v === voulu[i])) return false;

  const sizes =
    grille.querySelector("source")?.getAttribute("sizes") ??
    "(max-width: 520px) 100vw, (max-width: 820px) 50vw, 337px";
  if (photos.length === 0) {
    grille.replaceChildren();
    vueGrille?.detruire();
    vueGrille = null;
    return false;
  }
  grille.replaceChildren(...photos.map((p) => figure(p, sizes)));
  return true;
}

const grille = document.querySelector("[data-galerie]");
if (grille) {
  cablerGrille(grille);
  // La resynchronisation recâble la grille : les vignettes reconstruites n'ont
  // pas les écouteurs posés ci-dessus.
  resynchroniser(grille).then((change) => {
    if (change) cablerGrille(grille);
  });
}
