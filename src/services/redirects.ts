// Redirections permanentes depuis l'ancien site WordPress (issue #38).
//
// PRINCIPE — ce module est PRÊT mais INACTIF, et c'est volontaire.
//
// Une redirection 301 est mise en cache par les navigateurs et par Google pour
// une durée qu'on ne maîtrise plus une fois qu'elle est partie. La poser trop
// tôt, sur le domaine de test, graverait des correspondances fausses dans des
// caches qu'on ne peut pas purger. La règle d'activation est donc factuelle et
// ne demande aucun réglage : les redirections ne s'appliquent QUE lorsque le
// Worker répond sur l'un des hôtes de FINAL_HOSTS, c'est-à-dire les hôtes de
// l'ancien WordPress lui-même. Tant que le site vit sur l'adresse Hetzner
// (178-105-145-191.sslip.io) ou en local, `resolveWpRedirect` peut renvoyer une cible, `wpRedirect` ne renvoie
// rien.
//
// C'est aussi la seule situation où ces redirections ont un sens : une ancienne
// adresse WordPress n'arrive chez nous que le jour où ce Worker répond à la
// place du WordPress, sur le même nom de domaine.
//
// CE QUI RESTE À FAIRE AVANT LA BASCULE (dépend du propriétaire, cf. issue) :
// exporter la liste des pages indexées depuis la Search Console de l'ancien
// site et compléter WP_REDIRECTS. Les correspondances ci-dessous couvrent ce
// qui est établi (les deux pages renommées, les quatre sous-pages et les
// dix recettes de /recettes/) ; l'export est le seul inventaire exhaustif.

/** Hôtes sur lesquels les redirections deviennent actives — c'est-à-dire les
 *  hôtes de l'ancien WordPress, qui pointeront un jour sur ce Worker.
 *
 *  Le domaine définitif n'est pas encore tranché (issue #12, décision D5, et
 *  lesgitesdupremore.be appartient au père de Julien). Si un autre nom est
 *  retenu, c'est ICI et nulle part ailleurs qu'il s'ajoute. */
export const FINAL_HOSTS: readonly string[] = ["lesgitesdupremore.be", "www.lesgitesdupremore.be"];

/** Chemins jamais redirigés, quoi qu'il arrive : l'application elle-même.
 *  Ceinture et bretelles — aucune correspondance ci-dessous ne les vise, mais
 *  une future entrée mal collée ne doit pas pouvoir casser le tunnel. */
const NEVER_REDIRECT = ["/api/", "/ical/", "/book/", "/reserver/", "/admin/", "/img/"];

/** Correspondances exactes, en chemin NORMALISÉ (minuscules, sans slash final).
 *  Clé = ancienne adresse WordPress · valeur = adresse actuelle. */
export const WP_REDIRECTS: Readonly<Record<string, string>> = {
  // --- les deux pages renommées (nommément citées dans l'issue #38) ---------
  "/les-activites": "/que-faire/",
  "/ce-quil-faut-savoir": "/infos-pratiques/",

  // --- les quatre sous-pages rapatriées (issue #29) ------------------------
  // Sur le WordPress elles vivaient sous « Les activités » ; elles sont
  // désormais à la racine. Les adresses racine actuelles ne sont PAS listées
  // ici : elles existent déjà et doivent répondre 200, pas 301.
  "/les-activites/le-bain-chaud": "/le-bain-chaud/",
  "/les-activites/le-sauna": "/le-sauna/",
  "/les-activites/le-four-a-pain": "/le-four-a-pain/",
  "/les-activites/les-promenades": "/les-promenades/",

  // --- les recettes (issue #57) -------------------------------------------
  // Les dix articles du WordPress vivent maintenant sur /recettes/, une page
  // unique à ancres. Chaque ancienne adresse tombe donc sur SA recette, pas en
  // haut de page — c'est le seul intérêt d'une 301 sur un article.
  // `/recettes` n'est PAS listée ici : c'est désormais une page du site, elle
  // doit répondre 200. Trois articles n'avaient pour adresse que leur
  // identifiant WordPress (`/450`, `/448`, `/446`) — vérifié sur l'API REST du
  // site le 30/08/2026, c'est bien leur permalien public.
  "/les-recettes": "/recettes/",
  "/waterzooi": "/recettes/#waterzooi",
  "/la-carbonnade-flamande": "/recettes/#carbonnade-flamande",
  "/dinde-en-daube": "/recettes/#dinde-en-daube",
  "/agneau": "/recettes/#agneau",
  "/recettes-de-viandes-en-croute": "/recettes/#viandes-en-croute",
  "/filets-de-truites-en-papillotes-sur-lit-de-legumes": "/recettes/#truites-en-papillotes",
  "/450": "/recettes/#truite-au-vin-jaune",
  "/448": "/recettes/#tartare-de-truite",
  "/446": "/recettes/#truite-au-barbecue",
  "/truite-farcie": "/recettes/#truite-farcie",
  "/le-pain": "/le-four-a-pain/",
  "/la-pizza": "/le-four-a-pain/",

  // --- pages conservées mais dont le WordPress portait une autre adresse ---
  "/un-peu-d-histoire": "/histoire/",
  "/un-peu-dhistoire": "/histoire/",
  "/la-propriete-2": "/la-propriete/", // suffixe « -2 » typique d'un doublon WP
};

/** Règles par PRÉFIXE, évaluées après échec des correspondances exactes.
 *  Elles couvrent les gabarits d'archives WordPress (`/category/…`, `/tag/…`)
 *  et les sous-pages restées inconnues : chacune atterrit sur la page la plus
 *  proche du sujet, jamais sur une 404. L'ordre compte — le plus spécifique
 *  d'abord. */
export const WP_PREFIX_REDIRECTS: readonly { prefix: string; to: string }[] = [
  // archives de catégories : les slugs connus du WordPress vers leur page
  { prefix: "/category/activites", to: "/que-faire/" },
  { prefix: "/category/recettes", to: "/recettes/" },
  { prefix: "/category/cuisine", to: "/recettes/" },
  { prefix: "/category/promenades", to: "/les-promenades/" },
  { prefix: "/category/histoire", to: "/histoire/" },
  // toute autre archive (catégorie, étiquette, auteur, archive mensuelle) :
  // l'accueil, faute de meilleure cible — c'est le comportement attendu d'un
  // renvoi d'archive, et il n'invente pas de correspondance de contenu.
  { prefix: "/category", to: "/" },
  { prefix: "/tag", to: "/" },
  { prefix: "/author", to: "/" },
  // sous-pages d'activités non listées ci-dessus
  { prefix: "/les-activites", to: "/que-faire/" },
  // PAS de règle sur « /recettes » : c'est maintenant une page du site, et une
  // règle par préfixe attraperait aussi le chemin exact — la page se
  // redirigerait vers elle-même à travers /que-manger/.
];

/** Anciennes adresses SOUPÇONNÉES mais non confirmées : elles attendent
 *  l'export Search Console et ne sont volontairement PAS appliquées. Publier
 *  une 301 vers une page qui ne correspond pas est pire qu'une 404 — la 404 se
 *  corrige, la 301 se cache pendant des mois. */
export const WP_A_CONFIRMER: readonly string[] = [
  "/nos-gites",
  "/les-gites",
  "/tarifs",
  "/reservation",
  "/contact",
  "/galerie",
  "/livre-d-or",
];

/** Normalise un chemin pour la comparaison : minuscules, sans slash final
 *  (sauf la racine), sans `/index.html` ni `/index.php` hérités du WordPress. */
export function normalizeWpPath(pathname: string): string {
  let p = pathname.toLowerCase();
  p = p.replace(/\/index\.(html?|php)$/, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

/** Cible d'une ancienne adresse, ou null si aucune règle ne s'applique.
 *  Fonction PURE : elle ne dit rien de l'activation (cf. `wpRedirect`). */
export function resolveWpRedirect(pathname: string): string | null {
  const p = normalizeWpPath(pathname);
  if (p === "/") return null; // l'accueil n'a pas changé d'adresse
  if (NEVER_REDIRECT.some((prefix) => `${p}/`.startsWith(prefix))) return null;

  const exact = WP_REDIRECTS[p];
  if (exact) return exact;

  for (const rule of WP_PREFIX_REDIRECTS) {
    if (p === rule.prefix || p.startsWith(`${rule.prefix}/`)) return rule.to;
  }
  return null;
}

/** Vrai si le Worker répond sur l'hôte définitif (donc à la place du
 *  WordPress). Le port éventuel est ignoré. */
export function wpRedirectsActive(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return FINAL_HOSTS.includes(host);
}

/** Réponse 301 à servir, ou null s'il n'y a rien à rediriger (ou si l'on n'est
 *  pas encore sur le domaine définitif). La chaîne de requête est conservée :
 *  elle ne coûte rien et préserve les paramètres de campagne. */
export function wpRedirect(url: URL): Response | null {
  if (!wpRedirectsActive(url)) return null;
  const target = resolveWpRedirect(url.pathname);
  if (target === null) return null;
  const location = url.search ? `${target}${url.search}` : target;
  return new Response(null, {
    status: 301,
    headers: {
      location,
      // Une 301 est déjà définitive côté navigateur ; ce cache borné laisse la
      // possibilité de corriger une correspondance fautive en moins d'un jour
      // sur les intermédiaires qui le respectent.
      "cache-control": "public, max-age=86400",
    },
  });
}
