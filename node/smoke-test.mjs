// Test de fumée du serveur Node (la production chez Infomaniak).
//
//   npm run build && node node/smoke-test.mjs
//
// Lance node/server.mjs sur un port libre, avec une base SQLite et un dossier
// de photos TEMPORAIRES (rien ne touche data/ ni ../gites-data), puis vérifie
// par de vraies requêtes HTTP : santé, garde fail-closed, connexion, ménage,
// modèles, envoi et service d'une photo, lien de partage, garde par adresse IP.
// Sort en 1 au premier écart. Aucune donnée réelle.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADMIN = "fumee:mot-de-passe-de-fumee";

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

function start(port, dir, extra = {}) {
  const child = spawn(process.execPath, [join(ROOT, "node", "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SQLITE_PATH: join(dir, "smoke.db"),
      UPLOADS_DIR: join(dir, "uploads"),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ADMIN_TOKEN: ADMIN,
      EMAILS_ENABLED: "false",
      CRON_KEY: "cle-de-fumee",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, log: () => log };
}

async function waitUp(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/internal/health`);
      if (r.ok) return;
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("le serveur ne répond pas");
}

/** Requête brute (fetch refuse TRACE) : rend le code HTTP. */
function rawRequest(port, method, path) {
  return new Promise((res, rej) => {
    const r = httpRequest({ host: "127.0.0.1", port, method, path }, (resp) => {
      resp.resume();
      resp.on("end", () => res(resp.statusCode));
    });
    r.on("error", rej);
    r.end();
  });
}

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "ok  " : "ÉCHEC"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

function png(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

const dir = mkdtempSync(join(tmpdir(), "gites-fumee-"));
const servers = [];
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = start(port, dir);
  servers.push(srv);
  await waitUp(base);
  const auth = { authorization: `Bearer ${ADMIN}` };

  check("santé", (await fetch(`${base}/internal/health`)).ok);
  check("admin sans jeton : 401", (await fetch(`${base}/api/admin/units`)).status === 401);
  check("admin avec jeton : 200", (await fetch(`${base}/api/admin/units?property=1`, { headers: auth })).status === 200);
  check("écran /admin/ servi ou absent proprement", [200, 404].includes((await fetch(`${base}/admin/`)).status));
  const moved = await fetch(`${base}/admin2/`, { redirect: "manual" });
  check("ancienne adresse : 301 vers /admin/", moved.status === 301 && moved.headers.get("location") === "/admin/");

  const tasks = await fetch(`${base}/api/admin/tasks`, { headers: auth });
  check("ménage : GET /api/admin/tasks", tasks.status === 200, String(tasks.status));
  const tpl = await (await fetch(`${base}/api/admin/message-templates`, { headers: auth })).json();
  check("modèles : au moins les quatre modèles d'origine (0037 en ajoute)", tpl.templates?.length >= 4, JSON.stringify(tpl).slice(0, 120));
  check("cron : /internal/cron", (await fetch(`${base}/internal/cron?key=cle-de-fumee`)).status === 200);

  const form = new FormData();
  form.set("file", new File([png(1200, 800)], "x.png", { type: "image/png" }));
  form.set("alt", "Photo de fumée, la terrasse");
  const up = await fetch(`${base}/api/admin/units/1/photos/upload`, { method: "POST", headers: auth, body: form });
  const upBody = await up.json();
  check("photo : envoi 201", up.status === 201, JSON.stringify(upBody));
  if (upBody.path) {
    const served = await fetch(`${base}${upBody.path}`);
    check("photo : servie sous /uploads/", served.status === 200 && served.headers.get("content-type") === "image/png");
  }
  check("photo : traversée refusée", (await fetch(`${base}/uploads/..%2Fsmoke.db`)).status === 404);
  const malformed = await fetch(`${base}/%c0`);
  check("adresse mal encodée (/%c0) : 400 « adresse invalide »", malformed.status === 400 && (await malformed.text()) === "adresse invalide", String(malformed.status));
  const malformedApi = await fetch(`${base}/ical/%c0`);
  check("adresse mal encodée sur une route dynamique (/ical/%c0) : 400", malformedApi.status === 400, String(malformedApi.status));
  check("adresse mal encodée : rien dans unhandled.error", !srv.log().includes("[erreur]"), srv.log().slice(-200));

  // Audit de sécurité du 17/10 : méthode TRACE (500 + ligne d'erreur en base à
  // chaque appel anonyme), CSP bloquante de l'écran, en-têtes « cf-… » forgés.
  const trace = await rawRequest(port, "TRACE", "/api/public/today");
  check("méthode TRACE : 405, sans erreur journalisée", trace === 405 && !srv.log().includes("[erreur]"), `${trace} ${srv.log().slice(-200)}`);
  const adminPage = await fetch(`${base}/admin/`);
  if (adminPage.status === 200) {
    check("écran /admin/ : CSP bloquante, sans script en ligne", /script-src 'self'(;|$)/.test(adminPage.headers.get("content-security-policy") ?? ""), adminPage.headers.get("content-security-policy") ?? "absente");
  }
  check("site public : CSP en observation", (await fetch(`${base}/`)).headers.get("content-security-policy-report-only")?.includes("default-src 'self'") === true);
  // Page de réservation dédiée au Pré Moré (/reserver/pre-more/) : servie depuis
  // un sous-dossier, domaine fixé par la page, intégrable en iframe comme /book/
  // (et seulement elles : le reste du site reste en DENY).
  const reserver = await fetch(`${base}/reserver/pre-more/`);
  const reserverHtml = await reserver.text();
  check("réservation Pré Moré : /reserver/pre-more/ servie", reserver.status === 200 && reserverHtml.includes('<body data-property="pre-more">'), String(reserver.status));
  check("réservation Pré Moré : sans slash final, servie aussi", (await fetch(`${base}/reserver/pre-more`)).status === 200);
  check("réservation Pré Moré : iframe autorisée (pas de x-frame-options)", reserver.headers.get("x-frame-options") === null);
  check("réservation Pré Moré : le reste du site refuse l'iframe", (await fetch(`${base}/`)).headers.get("x-frame-options") === "DENY" && (await fetch(`${base}/la-scierie/`)).headers.get("x-frame-options") === "DENY");
  check("tunnel /book/ : iframe toujours autorisée", (await fetch(`${base}/book/`)).headers.get("x-frame-options") === null);
  // Cf-Connecting-IP forgé : le serveur le remplace par l'adresse vue. Six
  // questions « depuis six adresses » viennent en fait de la même : la sixième
  // tombe sur le plafond par adresse.
  const ask = (i) => fetch(`${base}/api/public/contact`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${i}` },
    body: JSON.stringify({ property: "pre-more", name: "Fumée", email: `fumee${i}@example.com`, message: "Question de fumée" }),
  });
  // Ce serveur-ci n'a pas TRUST_PROXY et reçoit tout de 127.0.0.1 : c'est le
  // cas « Caddy sans TRUST_PROXY ». L'adresse de bouclage n'est pas posée, les
  // plafonds par adresse ne s'appliquent pas (sinon communs à tout le site).
  const asked = [];
  for (let i = 1; i <= 6; i++) asked.push((await ask(i)).status);
  check("bouclage sans TRUST_PROXY : pas de plafond commun à tous les visiteurs", asked.every((st) => st === 201), asked.join(","));
  check("bouclage sans TRUST_PROXY : avertissement au démarrage et à la première requête", srv.log().includes("TRUST_PROXY ≠ true") && srv.log().includes("requêtes reçues de 127.0.0.1 sans TRUST_PROXY"), srv.log().slice(-300));
  for (let i = 7; i <= 8; i++) await ask(i);
  const auditRows = await (await fetch(`${base}/api/admin/audit?limit=500`, { headers: auth })).json();
  const notes = JSON.stringify(auditRows).split("config.trust_proxy_absent").length - 1;
  check("bouclage sans TRUST_PROXY : une seule ligne d'audit", notes === 1, String(notes));
  const huge = new Uint8Array(10 * 1024 * 1024);
  const tooBig = await fetch(`${base}/api/admin/units/1/photos/upload`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: huge }).catch(() => null);
  check("photo : corps de 10 Mo refusé (413)", !tooBig || tooBig.status === 413, String(tooBig?.status));

  const tar = await fetch(`${base}/api/admin/export-uploads.tar`, { headers: auth });
  const tarBytes = new Uint8Array(await tar.arrayBuffer());
  check("photos : archive .tar servie (1 fichier)", tar.status === 200 && tar.headers.get("x-gites-files") === "1" && tarBytes.length >= 2048, `${tar.status} ${tar.headers.get("x-gites-files")}`);

  const link = await (await fetch(`${base}/api/admin/task-links`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ label: "Fumée" }) })).json();
  const page = await fetch(link.url);
  check("lien de partage : page publique", page.status === 200 && (await page.text()).includes("Ménage"));

  // Cf-Access-Jwt-Assertion forgé, sur un serveur SANS ADMIN_TOKEN : la garde
  // l'aurait pris pour une authentification Cloudflare Access (accès complet,
  // export de la base compris). Devant Node, l'en-tête est retiré.
  const portNu = await freePort();
  const baseNu = `http://127.0.0.1:${portNu}`;
  const srvNu = start(portNu, dir, { ADMIN_TOKEN: "", SQLITE_PATH: join(dir, "smoke-nu.db") });
  servers.push(srvNu);
  await waitUp(baseNu);
  const forged = await fetch(`${baseNu}/api/admin/users`, { headers: { "cf-access-jwt-assertion": "jeton-invente" } });
  check("Cf-Access-Jwt-Assertion forgé sans ADMIN_TOKEN : refusé", forged.status === 401, String(forged.status));
  const forgedExport = await fetch(`${baseNu}/api/admin/export.sqlite`, { headers: { "cf-access-jwt-assertion": "jeton-invente" } });
  check("Cf-Access-Jwt-Assertion forgé : pas d'export de la base", forgedExport.status === 401, String(forgedExport.status));

  // Garde IP : un second serveur, fermé à tout sauf 10.9.9.9.
  const port2 = await freePort();
  const base2 = `http://127.0.0.1:${port2}`;
  const srv2 = start(port2, dir, { ADMIN_ALLOWED_IPS: "10.9.9.9", SQLITE_PATH: join(dir, "smoke2.db") });
  servers.push(srv2);
  await waitUp(base2);
  const denied = await fetch(`${base2}/api/admin/units`, { headers: auth });
  check("garde IP : 403 sur /api/admin", denied.status === 403);
  check("garde IP : 403 sur /admin/", (await fetch(`${base2}/admin/`)).status === 403);
  check("garde IP : X-Forwarded-For ignoré sans TRUST_PROXY", (await fetch(`${base2}/api/admin/units`, { headers: { ...auth, "x-forwarded-for": "10.9.9.9" } })).status === 403);
  check("garde IP : le public reste ouvert", (await fetch(`${base2}/internal/health`)).ok);

  // Garde IP aux humains seulement (lot 3) : un troisième serveur derrière un
  // « proxy » (TRUST_PROXY), qui n'admet que 10.9.9.9.
  const port3 = await freePort();
  const base3 = `http://127.0.0.1:${port3}`;
  const srv3 = start(port3, dir, { ADMIN_ALLOWED_IPS: "10.9.9.9", TRUST_PROXY: "true", SQLITE_PATH: join(dir, "smoke3.db") });
  servers.push(srv3);
  await waitUp(base3);
  const from = (ip) => ({ "x-forwarded-for": ip });
  // Avec TRUST_PROXY : l'adresse vient de X-Forwarded-For (posé par Caddy) ; un
  // Cf-Connecting-IP forgé ne change rien. Six questions « depuis six adresses »
  // viennent de la même : la sixième tombe sur le plafond par adresse.
  const askVia = (i) => fetch(`${base3}/api/public/contact`, {
    method: "POST",
    headers: { "content-type": "application/json", ...from("198.51.100.42"), "cf-connecting-ip": `203.0.113.${i}` },
    body: JSON.stringify({ property: "pre-more", name: "Fumée", email: `proxy${i}@example.com`, message: "Question de fumée" }),
  });
  const askedVia = [];
  for (let i = 1; i <= 6; i++) askedVia.push((await askVia(i)).status);
  check("Cf-Connecting-IP forgé ignoré : plafond de contact par adresse réelle", askedVia.slice(0, 5).every((st) => st === 201) && askedVia[5] === 429, askedVia.join(","));
  const otherVisitor = await fetch(`${base3}/api/public/contact`, { method: "POST", headers: { "content-type": "application/json", ...from("198.51.100.43") }, body: JSON.stringify({ property: "pre-more", name: "Fumée", email: "autre@example.com", message: "Question de fumée" }) });
  check("TRUST_PROXY : un autre visiteur n'est pas touché par le plafond du premier", otherVisitor.status === 201, String(otherVisitor.status));
  const json = { "content-type": "application/json" };
  const key = await (await fetch(`${base3}/api/admin/service-keys`, { method: "POST", headers: { ...auth, ...from("10.9.9.9"), ...json }, body: JSON.stringify({ name: "fumee-mac" }) })).json();
  check("garde IP : clé de service créée depuis la liste", typeof key.key === "string", JSON.stringify(key).slice(0, 120));
  const svc = { authorization: `Bearer svc:${key.key}` };
  check("garde IP : clé svc: acceptée hors liste", (await fetch(`${base3}/api/admin/units?property=1`, { headers: { ...svc, ...from("1.2.3.4") } })).status === 200);
  check("garde IP : humain refusé hors liste", (await fetch(`${base3}/api/admin/units?property=1`, { headers: { ...auth, ...from("1.2.3.4") } })).status === 403);
  check("lien de partage : refusé à une clé svc:", (await fetch(`${base3}/api/admin/task-links`, { method: "POST", headers: { ...svc, ...from("10.9.9.9"), ...json }, body: JSON.stringify({ label: "Fumée" }) })).status === 403);
  const backup = await (await fetch(`${base3}/api/admin/users`, { method: "POST", headers: { ...auth, ...from("10.9.9.9"), ...json }, body: JSON.stringify({ username: "sauvegarde" }) })).json();
  check("compte sauvegarde créé", typeof backup.password === "string", JSON.stringify(backup).slice(0, 120));
  const py = "/opt/homebrew/bin/python3";
  if (existsSync(py) && backup.password) {
    // La vraie sauvegarde de nuit, contre ce serveur, depuis une adresse hors liste.
    const sav = join(dir, "sauvegardes");
    mkdirSync(sav, { recursive: true });
    const ids = join(dir, "sauvegarde.env");
    writeFileSync(ids, `GITES_URL=${base3}\nGITES_USER=sauvegarde\nGITES_PASSWORD=${backup.password}\n`);
    chmodSync(ids, 0o600);
    const run = spawnSync(py, [join(ROOT, "scripts", "sauvegarde_nuit.py"), "--cible", "infomaniak", "--origine", "manuel"], {
      env: { ...process.env, GITES_SAUVEGARDE_ENV: ids, GITES_SAUVEGARDES: sav, GITES_SAUVEGARDE_JOURNAL: join(dir, "journal.log") },
      encoding: "utf-8",
      timeout: 60_000,
    });
    const out = `${run.stdout}${run.stderr}`;
    const saved = existsSync(sav) ? readdirSync(sav) : [];
    check("sauvegarde de nuit hors liste : base + photos", run.status === 0 && saved.some((n) => n.endsWith("-gites-infomaniak.sqlite")) && saved.some((n) => n.endsWith("-gites-infomaniak-photos.tar")) && out.includes("photos : 1 photo(s)"), out.slice(0, 400));
  } else {
    console.log("—    sauvegarde de nuit : python3 de Homebrew absent, essai sauté");
  }
} catch (e) {
  failures++;
  console.error("ÉCHEC", e);
  for (const s of servers) console.error(s.log());
} finally {
  for (const s of servers) s.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} écart(s).` : "\nFumée : tout est vert.");
process.exit(failures ? 1 : 0);
