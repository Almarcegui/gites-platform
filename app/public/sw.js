// Service worker du back-office /admin2/ (lot 2, point 6 : PWA).
//
// Stratégie : RÉSEAU D'ABORD, toujours. Le cache ne sert qu'à afficher la
// dernière version connue quand le réseau manque (« hors ligne en lecture »),
// jamais à servir une vieille donnée quand le serveur répond.
//
// Ce qui est gardé pour le hors-ligne : l'écran lui-même (/admin2/…) et les
// lectures dont l'écran Aujourd'hui a besoin. Rien d'autre de l'API, aucune
// écriture (POST, PATCH, PUT, DELETE ne passent jamais par le cache).
// Le cache est vidé à la déconnexion (api/client.ts, logout).
const CACHE = "gites-admin2-v1";
const SHELL = ["/admin2/", "/admin2/index.html", "/admin2/manifest.webmanifest", "/admin2/icon-192.png"];
// Les fiches complètes (réservation, client) ne sont PAS gardées : elles
// portent paiements, adresses et notes. Hors ligne, Aujourd'hui se lit sans
// elles (les boutons Appeler et SMS reviennent avec le réseau).
const READS = /^\/api\/admin\/(properties|units|planning|settings|overview|messages|tasks|message-templates|me|rate-calendar)(\/?$|\?)/;
// Génération du cache : la page la fait tourner à chaque connexion,
// déconnexion et session refusée (message « vider »). Une réponse partie
// avant le changement n'est jamais écrite après lui.
let generation = 0;

// L'écran complet dès la première visite : le HTML, plus les scripts et
// feuilles de style hachés qu'il cite (lus dans index.html). Un échec fait
// échouer l'installation : pas de worker actif avec un écran incomplet.
async function precache() {
  const c = await caches.open(CACHE);
  await c.addAll(SHELL);
  const html = await (await c.match("/admin2/index.html")).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/admin2\/assets\/[^"]+)"/g)].map((m) => m[1]);
  if (assets.length) await c.addAll(assets);
  // Les polices citées par la feuille de style, au mieux (le texte reste lisible sans).
  for (const css of assets.filter((a) => a.endsWith(".css"))) {
    try {
      const text = await (await c.match(css)).text();
      const fonts = [...text.matchAll(/url\((?:"|')?(\/admin2\/assets\/[^"')]+\.woff2)/g)].map((m) => m[1]);
      await c.addAll([...new Set(fonts)]);
    } catch {
      /* polices de repli du système */
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("gites-admin2") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/admin2/")) return true;
  return READS.test(url.pathname) || READS.test(`${url.pathname}?`);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;
  const started = generation;
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Seules les réponses complètes et réussies sont gardées : ni une
        // erreur, ni un 401 (session expirée), ni un 403 (garde IP).
        if (res.ok && res.type === "basic" && started === generation) {
          const copy = res.clone();
          // Attendu par le navigateur : une écriture tardive ne recrée pas le
          // cache juste après une déconnexion.
          event.waitUntil(
            caches
              .open(CACHE)
              .then((c) => (started === generation ? c.put(req, copy) : undefined))
              .catch(() => undefined),
          );
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === "navigate") {
          const shell = (await caches.match("/admin2/index.html")) || (await caches.match("/admin2/"));
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});

// « vider » : nouvelle génération, puis seules les lectures de l'API partent
// (l'écran lui-même ne contient aucune donnée).
self.addEventListener("message", (event) => {
  if (event.data !== "vider") return;
  generation++;
  event.waitUntil(
    caches.open(CACHE).then(async (c) => {
      for (const r of await c.keys()) if (new URL(r.url).pathname.startsWith("/api/")) await c.delete(r);
    }),
  );
});
