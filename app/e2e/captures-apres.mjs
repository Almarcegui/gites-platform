// Captures « après » du lot 1, écran par écran (données inventées de
// npm run pilote:donnees). Usage : node e2e/captures-apres.mjs [route,…]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.env.GITES_URL ?? "http://127.0.0.1:8796";
const pw = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8").match(/^PILOTE_PASSWORD=(.*)$/m)?.[1]?.trim() ?? "";
const out = (n) => fileURLToPath(new URL(`../docs/captures/lot1/${n}.png`, import.meta.url));
const width = Number(process.env.W ?? 1280);
const routes = (process.argv[2] ?? ",calendrier,reservations,messages,menage,reglages,reglages/tarifs,reglages/promotions,reglages/options,reglages/clients,reglages/paiements,reglages/chiffres,reglages/plateformes,reglages/calendriers,reglages/comptes,reglages/domaine,reglages/registre,reglages/import,reglages/mise-en-route,reglages/journaux").split(",");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width, height: width < 900 ? 844 : 860 }, locale: "fr-BE", timezoneId: "Europe/Brussels", colorScheme: process.env.DARK ? "dark" : "light" });
await page.goto(`${base}/admin/`);
await page.getByLabel("Identifiant").fill("pilote");
await page.getByLabel("Mot de passe").fill(pw);
await page.getByRole("button", { name: "Se connecter" }).click();
await page.waitForTimeout(1200);
if (process.env.THEME) { await page.evaluate((v) => localStorage.setItem("gp2_theme", v), process.env.THEME); await page.reload(); }
if (process.env.SCOPE) await page.evaluate((s) => localStorage.setItem("gp2_scope", s), process.env.SCOPE);
for (const r of routes) {
  await page.goto(`${base}/admin/#/${r}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out(`apres-${width < 900 ? "390" : "1280"}-${(r || "aujourdhui").replace(/\//g, "-")}${process.env.THEME === "dark" ? "-sombre" : ""}`), fullPage: !!process.env.FULL });
}
await browser.close();
