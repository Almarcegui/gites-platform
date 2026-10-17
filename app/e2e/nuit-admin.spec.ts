// Contrôle de nuit du back-office : à 375 px, aucun écran ne déborde de la page
// (Réglages › Plateformes et Comptes Stripe débordaient). Lancé par
// `SPEC=e2e/nuit-admin.spec.ts node app/e2e/lot3-serveur.mjs`.
import { expect, test, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

async function login(page: Page) {
  await page.goto("/admin/");
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(process.env.PILOTE_PASSWORD ?? "");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("navigation", { name: "Menu principal" }).first()).toBeVisible();
}

const ROUTES = ["", "calendrier", "reservations", "messages", "menage", "reglages", "reglages/tarifs", "reglages/clients", "reglages/stripe", "reglages/plateformes", "reglages/plateformes/prix", "reglages/domaine", "reglages/modeles", "reglages/options", "reglages/paiements", "reglages/comptes", "reglages/chiffres"];

for (const route of ROUTES) {
  test(`375 px : pas de débordement horizontal sur /${route}`, async ({ page }) => {
    await login(page);
    await page.goto(`/admin/#/${route}`);
    await page.waitForTimeout(1200);
    const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth }));
    expect(sw, `largeur du contenu ${sw} px pour un écran de ${w} px`).toBeLessThanOrEqual(w);
  });
}
