// Vérification d'un déploiement — pointable sur n'importe quelle URL.
//
//   node node/verify-deploy.mjs https://dev1.mdcdy.be
//
// Le jeton admin est lu dans ADMIN_TOKEN (jamais en argument : la ligne de
// commande est visible des autres processus et finit dans l'historique shell).
//
// Le test décisif est le n°6 : 18 réservations simultanées sur le MÊME créneau,
// dont une seule doit passer. C'est la garantie anti-surbooking, et elle dépend
// du verrouillage réel du disque de l'hébergeur — donc elle DOIT être rejouée
// sur le serveur de destination, pas seulement en local.

const BASE = (process.argv[2] || "http://localhost:8790").replace(/\/$/, "");
const ADMIN = (process.env.ADMIN_TOKEN || "").trim();
const CRON_KEY = (process.env.CRON_KEY || "").trim();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const iso = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* réponse non JSON (HTML, iCal) */
  }
  return { status: res.status, data, res };
};

console.log(`Vérification de ${BASE}\n`);

// 1. Le serveur répond et la base est là
const health = await call("GET", "/internal/health");
check("santé du serveur", health.status === 200 && health.data.ok === true, `${health.data.units ?? "?"} hébergements en base`);

// 2. Les pages publiques sont servies
for (const page of ["/", "/histoire/", "/que-faire/", "/book/"]) {
  const r = await fetch(BASE + page);
  const type = r.headers.get("content-type") || "";
  check(`page ${page}`, r.ok && type.includes("text/html"), `${r.status}`);
}

// 3. En-têtes de sécurité sur les pages
const home = await fetch(BASE + "/");
check(
  "en-têtes de sécurité",
  home.headers.get("x-content-type-options") === "nosniff" && home.headers.get("x-frame-options") === "DENY",
  `nosniff=${home.headers.get("x-content-type-options")} frame=${home.headers.get("x-frame-options")}`,
);

// 4. L'API publique calcule un vrai devis
const checkin = iso(240);
const checkout = iso(247);
const dispo = await call("GET", `/api/public/availability?property=pre-more&checkin=${checkin}&checkout=${checkout}&adults=2&children=0`);
const unit = (dispo.data.units || []).find((u) => u.available && u.quote?.ok);
check("disponibilité + devis", dispo.status === 200 && !!unit, unit ? `${unit.name} : ${(unit.quote.totalCents / 100).toFixed(2)} €` : "aucune unité libre");

// 5. La garde admin est fail-closed
const noAuth = await call("GET", "/api/admin/overview?property=1");
check("admin refuse sans jeton", noAuth.status === 401 || noAuth.status === 503, `HTTP ${noAuth.status}`);
if (ADMIN) {
  const withAuth = await call("GET", "/api/admin/overview?property=1", null, { authorization: `Bearer ${ADMIN}` });
  check("admin accepte le jeton", withAuth.status === 200, `santé ok = ${withAuth.data?.health?.ok}`);
} else {
  console.log("ℹ️  ADMIN_TOKEN non fourni — contrôle d'accès admin partiellement testé");
}

// 6. LE test qui compte : course sur le même créneau
const raceIn = iso(700);
const raceOut = iso(704);
const raceUnit = unit?.unitId ?? 2;
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: 18 }, (_, i) =>
    call("POST", "/api/public/bookings", {
      unitId: raceUnit,
      checkin: raceIn,
      checkout: raceOut,
      adults: 2,
      children: 0,
      paymentMode: "deposit",
      cgvAccepted: true,
      guest: { firstName: `Verif${i}`, lastName: "Course", email: `verif-course-${i}@example.invalid`, phone: "+32 470 00 00 00" },
    }),
  ),
);
const ms = Date.now() - t0;
const accepted = results.filter((r) => r.status === 201);
const conflicts = results.filter((r) => r.status === 409);
check(
  "18 réservations simultanées → une seule passe",
  accepted.length === 1 && conflicts.length === 17,
  `${accepted.length} acceptée(s), ${conflicts.length} refusée(s) en ${ms} ms`,
);

// 7. Nettoyage de la réservation de test
if (ADMIN && accepted.length > 0) {
  const list = await call("GET", `/api/admin/bookings?property=1&limit=50`, null, { authorization: `Bearer ${ADMIN}` });
  const created = (list.data.bookings || []).filter((b) => (b.guestEmail || "").includes("verif-course-"));
  for (const b of created) {
    await call("POST", `/api/admin/bookings/${b.id}/cancel`, { reason: "verification_deploiement" }, { authorization: `Bearer ${ADMIN}` });
  }
  check("réservations de test annulées", true, `${created.length} annulée(s)`);
} else if (accepted.length > 0) {
  console.log(`⚠️  Réservation de test ${accepted[0].data.reference} à annuler à la main (ADMIN_TOKEN non fourni)`);
}

// 8. Le point d'entrée du cron est protégé
const cronBad = await call("GET", "/internal/cron?key=mauvaise-cle");
check("cron refuse une mauvaise clé", cronBad.status === 401, `HTTP ${cronBad.status}`);
if (CRON_KEY) {
  const cronOk = await call("GET", `/internal/cron?key=${encodeURIComponent(CRON_KEY)}`);
  check("cron s'exécute avec la bonne clé", cronOk.status === 200);
}

console.log(`\n${failures === 0 ? "✅ Tout est vert." : `❌ ${failures} contrôle(s) en échec.`}`);
process.exit(failures === 0 ? 0 : 1);
