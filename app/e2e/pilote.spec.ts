// Parcours minimal : connexion, Aujourd'hui à l'ordinateur (A) et au
// téléphone (B), fiche d'une réservation, popover de prix. Les captures
// (données inventées seulement) vont dans docs/captures/.
import { expect, test, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };
const shots = (name: string) => `docs/captures/${name}.png`;

async function login(page: Page) {
  await page.goto("/admin2/");
  await expect(page.getByRole("heading", { name: "Gestion des gîtes" })).toBeVisible();
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(process.env.PILOTE_PASSWORD ?? "");
  await page.getByRole("button", { name: "Se connecter" }).click();
}

test("ordinateur : Aujourd'hui, grille, fiche, popover", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await login(page);
  await expect(page.locator(".today")).toBeVisible();
  await expect(page.locator(".bar").first()).toBeVisible();
  await page.screenshot({ path: shots("A-aujourdhui-1280") });

  await page.getByRole("button", { name: /Gwenola Oudewaeter, La Maison du Scieur/ }).click();
  await expect(page.getByRole("heading", { name: "Gwenola Oudewaeter" })).toBeVisible();
  await expect(page.getByRole("link", { name: /\+32 470/ })).toHaveAttribute("href", /^tel:/);
  await page.waitForTimeout(500); // fin de l'ouverture du panneau
  await page.screenshot({ path: shots("A-fiche-1280") });
  await page.keyboard.press("Escape");

  const cell = page.locator('.pc[data-unit="2"]').nth(20);
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /^Nuit du/ })).toBeVisible();
  await page.screenshot({ path: shots("A-popover-prix-1280") });
});

test("téléphone : la journée et les semaines", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator(".day .sum")).toBeVisible();
  await expect(page.locator(".rail > li").first()).toBeVisible();
  await page.screenshot({ path: shots("B-journee-390"), fullPage: false });
  await page.getByRole("navigation", { name: "Menu principal" }).last().getByRole("link", { name: "Calendrier" }).click();
  await expect(page.getByRole("list", { name: "Étapes" })).toBeVisible();
  await page.screenshot({ path: shots("B-semaines-390") });
  await page.getByRole("navigation", { name: "Menu principal" }).last().getByRole("link", { name: "Ménage" }).click();
  await expect(page.getByText(/Pilote : « fait » est noté sur cet appareil/)).toBeVisible();
  await page.screenshot({ path: shots("B-menage-390") });
});
