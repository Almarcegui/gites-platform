// Parcours du lot 1, un par grand écran nouveau, sur le serveur local et les
// données inventées (npm run pilote:donnees). Ils écrivent dans la D1 locale
// et remettent en place ce qu'ils créent. Captures dans docs/captures/lot1/.
import { expect, test, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };
const shot = (name: string) => `docs/captures/lot1/${name}.png`;

async function login(page: Page) {
  await page.goto("/admin/");
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(process.env.PILOTE_PASSWORD ?? "");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("navigation", { name: "Menu principal" }).first()).toBeVisible();
}

async function go(page: Page, route: string) {
  await page.goto(`/admin/#/${route}`);
}

const drawer = (page: Page) => page.locator(".mantine-Drawer-content");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
});

test("thème : clair par défaut même sur un appareil en sombre, sombre sur demande", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
  await go(page, "reglages");
  await page.getByRole("button", { name: /Sombre/ }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  await page.screenshot({ path: shot("apres-1280-reglages-sombre") });
  await page.getByRole("button", { name: /Clair/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
});

test("prix et saisons : prix de base, saison créée puis supprimée, l'année", async ({ page }) => {
  await go(page, "reglages/tarifs");
  await expect(page.getByRole("heading", { name: "Prix et saisons" })).toBeVisible();
  await page.getByRole("tab", { name: "Prix de base" }).click();
  await page.locator(".list-row").filter({ hasText: "La Scierie" }).click();
  const d = drawer(page);
  await expect(d.getByRole("heading", { name: "La Scierie" })).toBeVisible();
  const we = d.getByLabel(/Nuit du week-end/);
  const before = await we.inputValue();
  await we.fill("155");
  await page.mouse.click(10, 400); // clic à côté : la saisie n'est pas perdue
  await expect(d.getByRole("heading", { name: "La Scierie" })).toBeVisible();
  await page.screenshot({ path: shot("apres-1280-panneau-prix-de-base") });
  await d.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText(/Prix de base de La Scierie enregistré/)).toBeVisible();
  // remise en place
  await page.locator(".list-row").filter({ hasText: "La Scierie" }).click();
  await drawer(page).getByLabel(/Nuit du week-end/).fill(before);
  await drawer(page).getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText(/Prix de base de La Scierie enregistré/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Saisons" }).click();
  await page.getByRole("button", { name: "Nouvelle saison" }).click();
  await drawer(page).getByLabel("Nom").fill("Essai lot 1");
  await drawer(page).getByLabel("Première nuit").fill("2027-02-01");
  await drawer(page).getByLabel("Dernière nuit").fill("2027-02-07");
  await page.screenshot({ path: shot("apres-1280-panneau-saison") });
  await drawer(page).getByRole("button", { name: "Créer la saison" }).click();
  await expect(page.getByText(/Saison Essai lot 1 créée/)).toBeVisible();
  await page.locator(".list-row").filter({ hasText: "Essai lot 1" }).click();
  await drawer(page).getByRole("button", { name: "Plus" }).click();
  await page.getByRole("menuitem", { name: "Supprimer la saison" }).click();
  await page.getByRole("dialog", { name: /Supprimer la saison/ }).getByRole("button", { name: "Supprimer la saison" }).click();
  await expect(page.getByText("C'est fait. Saison supprimée.")).toBeVisible();

  await page.getByRole("tab", { name: "L'année" }).click();
  await expect(page.locator(".yc.lv0, .yc.lv1, .yc.lv2, .yc.lv3").first()).toBeVisible();
  await page.screenshot({ path: shot("apres-1280-tarifs-annee") });
});

test("le domaine : un seul Enregistrer, garde à la sortie", async ({ page }) => {
  await go(page, "reglages/domaine");
  const phone = page.getByLabel("Téléphone");
  const before = await phone.inputValue();
  await phone.fill("0470 00 00 99");
  await expect(page.getByText("Modifications non enregistrées.")).toBeVisible();
  await page.getByRole("navigation", { name: "Menu principal" }).first().getByRole("link", { name: "Calendrier" }).click();
  await expect(page.getByRole("dialog", { name: "Partir sans enregistrer ?" })).toBeVisible();
  await page.screenshot({ path: shot("apres-1280-domaine-garde") });
  await page.getByRole("button", { name: "Rester sur la page" }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByText(/Enregistré : coordonnées/)).toBeVisible();
  await phone.fill(before);
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByText(/Enregistré : coordonnées/).first()).toBeVisible();
});

test("plateformes : coller un code d'invitation, l'erreur dite en clair", async ({ page }) => {
  await go(page, "reglages/plateformes");
  await expect(page.getByRole("heading", { name: /Liaison/ })).toBeVisible();
  await page.getByLabel("Code d'invitation Beds24").fill("code-essai-invalide");
  await page.getByRole("button", { name: "Rétablir la liaison" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Le code n'a pas été accepté/ })).toBeVisible();
  await page.screenshot({ path: shot("apres-1280-plateformes-code") });
  await page.getByLabel("Majoration Airbnb, en pourcentage").fill("19");
  await expect(page.getByRole("button", { name: "Enregistrer les pourcentages" })).toBeVisible();
  await page.getByRole("button", { name: "Annuler les modifications" }).click();
  await expect(page.getByRole("button", { name: "Enregistrer les pourcentages" })).toHaveCount(0);
});

test("clients, paiements, chiffres, journaux : listes et panneaux", async ({ page }) => {
  await go(page, "reglages/clients");
  await page.getByLabel("Rechercher un client").fill("Oudewaeter");
  await page.locator(".list-row").filter({ hasText: "Oudewaeter" }).first().click();
  await expect(drawer(page).getByRole("heading", { name: /Oudewaeter/ })).toBeVisible();
  await page.screenshot({ path: shot("apres-1280-panneau-client") });
  await page.keyboard.press("Escape");

  await go(page, "reglages/paiements");
  await page.locator(".list-row").first().click();
  await expect(drawer(page).getByRole("button", { name: /Ouvrir la réservation/ })).toBeVisible();
  await page.screenshot({ path: shot("apres-1280-panneau-paiement") });
  await page.keyboard.press("Escape");

  await go(page, "reglages/chiffres");
  await expect(page.locator(".kpi").first()).toContainText("Remplissage");
  await expect(page.getByRole("button", { name: /Chiffres \d{4}/ })).toBeVisible();

  await go(page, "reglages/journaux");
  await page.locator(".list-row").first().click();
  await expect(drawer(page)).toBeVisible();
});

test("remises, options, comptes : créer, ouvrir, supprimer", async ({ page }) => {
  await go(page, "reglages/promotions");
  await page.getByRole("button", { name: "Nouveau code" }).click();
  await drawer(page).getByLabel("Code").fill("ESSAILOT1");
  await drawer(page).getByLabel("Remise (%)").fill("10");
  await drawer(page).getByRole("button", { name: "Créer" }).click();
  await expect(page.getByText("C'est fait. Remise créée.")).toBeVisible();
  await page.locator(".list-row").filter({ hasText: "ESSAILOT1" }).click();
  await page.screenshot({ path: shot("apres-1280-panneau-remise") });
  await drawer(page).getByRole("button", { name: "Plus" }).click();
  await page.getByRole("menuitem", { name: "Supprimer" }).click();
  await page.getByRole("dialog", { name: /Supprimer ESSAILOT1/ }).getByRole("button", { name: "Supprimer" }).click();
  await expect(page.getByText("C'est fait. Remise supprimée.")).toBeVisible();

  await go(page, "reglages/options");
  await expect(page.getByRole("heading", { name: "Options payantes" })).toBeVisible();

  await go(page, "reglages/comptes");
  await page.getByRole("button", { name: "Donner un accès" }).click();
  await page.getByLabel("Identifiant").fill("essai-lot1");
  await page.getByRole("button", { name: "Créer le compte" }).click();
  await expect(page.locator(".secret")).toHaveText(/\S{6,}/);
  await page.getByRole("button", { name: "C'est noté, fermer" }).click();
  await page.locator(".list-row").filter({ hasText: "essai-lot1" }).click();
  await page.screenshot({ path: shot("apres-1280-panneau-compte") });
  await drawer(page).getByRole("button", { name: "Couper l'accès" }).click();
  await page.getByRole("dialog", { name: /Couper l'accès/ }).getByRole("button", { name: "Couper l'accès" }).click();
  await expect(page.getByText("C'est fait. Accès coupé.")).toBeVisible();
  await page.locator(".list-row").filter({ hasText: "essai-lot1" }).click();
  await drawer(page).getByRole("button", { name: "Plus" }).click();
  await page.getByRole("menuitem", { name: "Supprimer le compte" }).click();
  await page.getByRole("dialog", { name: /Supprimer le compte/ }).getByRole("button", { name: "Supprimer le compte" }).click();
  await expect(page.getByText("C'est fait. Compte supprimé.")).toBeVisible();
});

test("registre : la saisie s'ouvre depuis la fiche (sans rien écrire)", async ({ page }) => {
  await go(page, "reservations");
  await page.locator(".list-row").first().click();
  const d = drawer(page);
  await d.getByText("Voyageurs inscrits").click();
  await d.getByRole("button", { name: /Inscrire/ }).click();
  const box = page.getByRole("dialog", { name: /Inscrire les voyageurs/ });
  await expect(box.getByRole("button", { name: "Inscrire au registre" })).toBeDisabled();
  await page.screenshot({ path: shot("apres-1280-fiche-registre") });
  await box.getByRole("button", { name: "Annuler" }).click();
});

test("téléphone : réglages et prix en feuille plein écran", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, "reglages/tarifs");
  await page.getByRole("tab", { name: "Prix de base" }).click();
  await page.locator(".list-row").filter({ hasText: "La Maison du Scieur" }).click();
  await expect(drawer(page).getByRole("heading", { name: "La Maison du Scieur" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("apres-390-panneau-prix-de-base") });
});
