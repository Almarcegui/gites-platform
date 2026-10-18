// Pages de réservation dédiées à un domaine (/reserver/<slug>/).
// Un domaine absent de cette table se réserve par le tunnel générique
// /book/?property=<slug> (c'est le cas du Moulin de Braives pour l'instant).
// Miroir TypeScript : src/core/domain-pages.ts (un test vérifie qu'ils concordent).
export const DOMAIN_PAGES = {
  "pre-more": "/reserver/pre-more/",
};

/** Adresse où (re)commencer une réservation pour ce domaine. */
export function bookingPage(slug) {
  if (!slug) return "/book/";
  return DOMAIN_PAGES[slug] ?? `/book/?property=${encodeURIComponent(slug)}`;
}
