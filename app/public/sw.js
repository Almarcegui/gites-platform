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
const READS = /^\/api\/admin\/(properties|units|planning|settings|overview|messages|tasks|message-templates|me|rate-calendar)(\/?$|\?)|^\/api\/admin\/(bookings|guests)\/\d+$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
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
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Seules les réponses complètes et réussies sont gardées : ni une
        // erreur, ni un 401 (session expirée), ni un 403 (garde IP).
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          // Attendu par le navigateur : une écriture tardive ne recrée pas le
          // cache juste après une déconnexion.
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined));
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

self.addEventListener("message", (event) => {
  if (event.data === "vider") event.waitUntil(caches.delete(CACHE));
});
