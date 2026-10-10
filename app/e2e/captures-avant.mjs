// Captures « avant » du lot 1 : l'ancien écran /admin/ et le pilote /admin/,
// sur les mêmes données inventées (npm run pilote:donnees). Usage :
//   node e2e/captures-avant.mjs        (serveur local sur GITES_URL ou :8796)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.env.GITES_URL ?? "http://127.0.0.1:8796";
const pw = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8").match(/^PILOTE_PASSWORD=(.*)$/m)?.[1]?.trim() ?? "";
const out = (n) => fileURLToPath(new URL(`../docs/captures/lot1/${n}.png`, import.meta.url));

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "fr-BE", timezoneId: "Europe/Brussels", colorScheme: "light" });
await page.goto(`${base}/admin/`);
await page.getByLabel("Identifiant").fill("pilote");
await page.getByLabel("Mot de passe").fill(pw);
await page.getByRole("button", { name: "Se connecter" }).click();
await page.waitForTimeout(1500);
await page.evaluate(() => localStorage.setItem("gp_property", "1"));
const old = (process.argv[2] ?? "dash,cal,cal/prix,cal/annee,resa,clients,paiements,stats,messages,promos,options,canaux,ical,users,params,startup").split(",");
for (const r of old) {
  await page.goto(`${base}/admin/#/${r}`);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: out(`avant-ancien-${r.replace("/", "-")}`), fullPage: true });
}
const neu = ["", "calendrier", "reservations", "messages", "menage", "reglages"];
for (const r of neu) {
  await page.goto(`${base}/admin/#/${r}`);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: out(`avant-pilote-${r || "aujourdhui"}`), fullPage: false });
}
await browser.close();
