// Parcours de bout en bout de la page /reserver/pre-more/ dans un vrai navigateur.
//
//   npx tsc -p tsconfig.build.json && node node/fix-esm-imports.mjs   # une fois
//   node scripts/e2e-reserver.mjs [dossier-de-captures]
//
// Lance node/server.mjs sur un port libre avec une base SQLite TEMPORAIRE, sans
// clé Stripe (paiement simulé par /book/dev-pay.html) et sans envoi d'e-mail
// (EMAILS_ENABLED=false : tout est journalisé, rien ne part). Rien ne touche la
// production ni data/. Playwright n'est PAS une dépendance du projet : il doit
// être installé globalement (npm i -g playwright && npx playwright install chromium).
//
// Pour FR et NL, à 375 px et 1440 px : arrive sur
// /reserver/pre-more/?unit=la-scierie&property=moulin-braives (le paramètre
// property doit être ignoré), choisit une arrivée un lundi et un départ le
// mercredi, à plus de 5 jours, remplit les coordonnées, passe par le paiement
// simulé et la page Merci, puis vérifie les liens de retour (voucher, annulation).
// Sort en 1 au premier écart.
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const g = execSync("npm root -g", { encoding: "utf8" }).trim();
    return await import(pathToFileURL(createRequire(join(g, "x.js")).resolve("playwright")).href);
  }
}
const pw = await loadPlaywright();
const chromium = pw.chromium ?? pw.default.chromium;

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });

const dir = mkdtempSync(join(tmpdir(), "gites-e2e-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, [join(ROOT, "node", "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    SQLITE_PATH: join(dir, "e2e.db"),
    UPLOADS_DIR: join(dir, "uploads"),
    PUBLIC_BASE_URL: base,
    ADMIN_TOKEN: "e2e:mot-de-passe-de-test",
    EMAILS_ENABLED: "false",
    STRIPE_SECRET_KEY: "",
    STRIPE_PUBLISHABLE_KEY: "",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "ÉCHEC"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/internal/health`)).ok) return;
    } catch { /* pas encore */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("le serveur ne répond pas\n" + log);
}

const iso = (d) => d.toISOString().slice(0, 10);
/** Premier lundi à plus de 5 jours (14 pour rester hors de tout délai), départ le mercredi. */
function stayDates(semaine) {
  // Une semaine de plus à chaque parcours : la base est partagée, un séjour déjà
  // réservé rendrait l'hébergement indisponible au parcours suivant.
  let m = new Date(Date.now() + (14 + 7 * semaine) * 86400000);
  while (m.getUTCDay() !== 1) m = new Date(m.getTime() + 86400000);
  return { checkin: iso(m), checkout: iso(new Date(m.getTime() + 2 * 86400000)) };
}

async function parcours(browser, lang, width, height, semaine) {
  const tag = `${lang}-${width}`;
  const ctx = await browser.newContext({ viewport: { width, height }, locale: lang === "nl" ? "nl-BE" : "fr-BE" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const { checkin, checkout } = stayDates(semaine);

  // property=moulin-braives doit être ignoré : la page est celle du Pré Moré.
  await page.goto(`${base}/reserver/pre-more/?unit=la-scierie&lang=${lang}&property=moulin-braives`);
  await page.waitForSelector("#calGrid button.pday");
  check(`[${tag}] domaine fixé : Pré Moré malgré ?property=moulin-braives`, (await page.textContent("#propName")).includes("Pré Moré"));
  check(`[${tag}] ?property= retiré de l'adresse`, !page.url().includes("property="), page.url());
  check(`[${tag}] pas d'accueil multi-domaines`, (await page.locator("#landing").count()) === 0);
  check(`[${tag}] noindex`, (await page.getAttribute('meta[name="robots"]', "content")) === "noindex");
  check(`[${tag}] retour au site : /`, (await page.getAttribute("#backSite", "href")) === "/");
  const retour = (await page.textContent("#backSite")).trim();
  check(`[${tag}] langue ${lang} (« ${retour} »)`, lang === "nl" ? retour !== "← Retour au site" : retour === "← Retour au site");
  check(`[${tag}] pas de défilement horizontal`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  for (let i = 0; i < 3 && !(await page.locator(`button[data-date="${checkin}"]`).count()); i++) {
    await page.click("#calNext");
    await page.waitForTimeout(300);
  }
  await page.click(`button[data-date="${checkin}"]`);
  await page.click(`button[data-date="${checkout}"]`);
  await page.waitForSelector("#bPay", { timeout: 15000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `etape-coordonnees-${tag}.png`), fullPage: true });
  check(`[${tag}] hébergement du lien (unit=la-scierie) retenu`, (await page.textContent("#bookingPanel")).includes("La Scierie"));

  const email = `e2e-${tag}@example.test`;
  await page.fill("#gFirst", "Camille");
  await page.fill("#gLast", "Essai");
  await page.fill("#gEmail", email);
  await page.check("#gCgv");
  await page.click("#bPay");
  await page.waitForURL(/\/book\/dev-pay\.html/, { timeout: 20000 });
  check(`[${tag}] paiement simulé atteint`, true);
  await page.click("#pay");
  await page.waitForURL(/\/book\/merci\.html/, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  const ref = new URL(page.url()).searchParams.get("ref") ?? "";
  check(`[${tag}] page Merci, référence ${ref}`, ref.length > 3);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `merci-${tag}.png`), fullPage: true });

  // Le voucher rouvre le parcours du Pré Moré, pas /book/ sans domaine.
  const voucherHref = await page.locator('a[href*="voucher.html"]').first().getAttribute("href");
  check(`[${tag}] merci → voucher`, !!voucherHref);
  const api = await (await fetch(`${base}/api/public/bookings/${ref}?email=${encodeURIComponent(email)}`)).json();
  check(`[${tag}] réservation confirmée en base, slug du domaine exposé`, api.booking?.status === "confirmed" && api.booking?.propertySlug === "pre-more", JSON.stringify(api.booking ?? api).slice(0, 160));

  await page.goto(`${base}/book/annule.html?ref=${ref}&email=${encodeURIComponent(email)}&lang=${lang}`);
  await page.waitForFunction(() => document.getElementById("backCal")?.getAttribute("href") !== "/book/", null, { timeout: 5000 }).catch(() => {});
  check(`[${tag}] annulation → « revenir au calendrier » garde le Pré Moré`, (await page.getAttribute("#backCal", "href")) === "/reserver/pre-more/", await page.getAttribute("#backCal", "href"));

  check(`[${tag}] aucune erreur JavaScript`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

try {
  await waitUp();
  const browser = await chromium.launch();
  let semaine = 0;
  for (const lang of ["fr", "nl"]) {
    for (const [w, h] of [[375, 812], [1440, 900]]) await parcours(browser, lang, w, h, semaine++);
  }
  // Ancien lien : /book/?property=pre-more continue de fonctionner.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const old = await ctx.newPage();
  await old.goto(`${base}/book/?property=pre-more&unit=la-scierie&lang=fr`);
  await old.waitForSelector("#calGrid button.pday");
  check("ancien lien /book/?property=pre-more : toujours fonctionnel", (await old.textContent("#propName")).includes("Pré Moré"));
  await old.goto(`${base}/book/`);
  await old.waitForSelector("#landing a.domain");
  check("/book/ sans domaine : l'accueil multi-domaines reste", (await old.locator("#landing a.domain").count()) >= 2);
  await browser.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  srv.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} écart(s).` : "Parcours e2e : tout est vert.");
process.exit(failures ? 1 : 0);
