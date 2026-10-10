// Une seule adresse pour l'écran d'administration (décision de Julien du
// 10/10/2026) : /admin/ sert le nouvel écran (app/). Les anciennes adresses
// renvoient vers lui par une redirection permanente :
//   - /admin2 et tout ce qui est dessous (adresse du pilote) → /admin/ ;
//   - /admin/login.html (connexion de l'ancien écran) → /admin/#/connexion.
// Le navigateur garde le fragment (#/calendrier) d'une adresse redirigée qui
// n'en porte pas : /admin2/#/calendrier mène à /admin/#/calendrier.
// Utilisé par le Worker (src/index.ts) et par le serveur Node (node/server.mjs).

/** L'adresse vers laquelle rediriger, ou null si le chemin n'est pas concerné. */
export function adminAddressRedirect(pathname: string): string | null {
  const p = pathname.toLowerCase();
  if (p === "/admin2" || p.startsWith("/admin2/")) return "/admin/";
  if (p === "/admin/login.html") return "/admin/#/connexion";
  if (p === "/admin") return "/admin/";
  return null;
}

/** Réponse 301 correspondante (cache court : une redirection permanente mise
 *  en cache trop longtemps est difficile à défaire). */
export function adminRedirectResponse(pathname: string): Response | null {
  const to = adminAddressRedirect(pathname);
  if (!to) return null;
  return new Response(null, { status: 301, headers: { location: to, "cache-control": "public, max-age=3600" } });
}
