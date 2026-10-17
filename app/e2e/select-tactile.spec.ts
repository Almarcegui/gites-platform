// Suggestion n° 21 : sur téléphone Android, « Nouvelle vente » depuis le calendrier,
// la liste du champ « Bien » ne se laissait pas choisir. Lancé par
// `SPEC=e2e/select-tactile.spec.ts node app/e2e/lot3-serveur.mjs` (émulation tactile 384×800).
import { expect, test, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };

test.use({
  viewport: { width: 384, height: 800 },
  hasTouch: true,
  isMobile: true,
  userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
});

async function login(page: Page) {
  await page.goto("/admin/");
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(process.env.PILOTE_PASSWORD ?? "");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("navigation", { name: "Menu principal" }).first()).toBeVisible();
}

test("Nouvelle vente au toucher : on choisit un gîte dans « Bien »", async ({ page }) => {
  await login(page);
  await page.goto("/admin/#/calendrier");
  await expect(page.getByText("Pirlouvet").first()).toBeVisible();
  await page.getByRole("button", { name: "Nouvelle vente" }).tap();
  // Au toucher, « Bien » est le sélecteur natif du téléphone (liste groupée par établissement).
  const bien = page.getByLabel("Bien", { exact: true });
  await expect(bien).toBeVisible();
  expect(await bien.evaluate((el) => el.tagName)).toBe("SELECT");
  await bien.tap();
  const nom = (await bien.locator("option:not([value=''])").first().textContent())?.trim() ?? "";
  expect(nom).not.toBe("");
  await bien.selectOption({ label: nom });
  await expect(bien.locator("option:checked")).toHaveText(nom);
  await expect(page.getByRole("button", { name: "Voir le prix" })).toBeEnabled();
});
