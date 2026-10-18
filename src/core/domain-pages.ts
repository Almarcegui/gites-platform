// Pages de réservation dédiées à un domaine (/reserver/<slug>/).
// Un domaine absent de cette table se réserve par le tunnel générique
// /book/?property=<slug>. Miroir de public/book/pages.js (test : domain-pages).
export const DOMAIN_PAGES: Readonly<Record<string, string>> = {
  "pre-more": "/reserver/pre-more/",
};

/** Chemin du tunnel pour ce domaine, avec ses paramètres de reprise.
 *  Sur une page dédiée le domaine est implicite : pas de `property=`. */
export function bookingPath(slug: string, params: URLSearchParams): string {
  const page = DOMAIN_PAGES[slug];
  if (page) return `${page}?${params.toString()}`;
  const q = new URLSearchParams({ property: slug });
  for (const [k, v] of params) q.set(k, v);
  return `/book/?${q.toString()}`;
}
