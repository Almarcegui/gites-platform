// Captures avant/après de la refonte de la coque (barre latérale), mêmes
// données inventées (npm run pilote:donnees), à 1280 et 1512 px de large.
// Usage : node e2e/captures-coque.mjs avant|apres   (serveur sur GITES_URL ou :8801)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const phase = process.argv[2] === "apres" ? "apres" : "avant";
const base = process.env.GITES_URL ?? "http://127.0.0.1:8801";
const pw = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8").match(/^PILOTE_PASSWORD=(.*)$/m)?.[1]?.trim() ?? "";
const out = (n) => fileURLToPath(new URL(`../docs/captures/coque/${n}.png`, import.meta.url));

const browser = await chromium.launch({ channel: "chrome" });
const widths = (process.argv[3] ?? "1280,1512").split(",").map(Number);
for (const w of widths) {
  const page = await browser.newPage({ viewport: { width: w, height: w < 1024 ? 844 : 900 }, locale: "fr-BE", timezoneId: "Europe/Brussels", colorScheme: "light" });
  await page.goto(`${base}/admin2/`);
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(pw);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForTimeout(1500);
  for (const [name, route] of [["aujourdhui", ""], ["calendrier", "calendrier"], ["reservations", "reservations"], ["reglages", "reglages"], ["prix", "reglages/tarifs"]]) {
    await page.goto(`${base}/admin2/#/${route}`);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: out(`${phase}-${w}-${name}`) });
  }
  await page.goto(`${base}/admin2/#/reservations`);
  await page.waitForTimeout(1500);
  const row = page.locator(".list-row, tbody tr").first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out(`${phase}-${w}-fiche`) });
  }
  await page.close();
}
await browser.close();
