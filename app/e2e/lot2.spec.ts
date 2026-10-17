// Parcours du lot 2 sur le serveur Node (production) et des données inventées :
// lancé par `node app/e2e/lot2-serveur.mjs`, qui prépare une base temporaire.
// Captures dans docs/captures/lot2/.
import { expect, test, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };
const shot = (name: string) => `docs/captures/lot2/${name}.png`;
const drawer = (page: Page) => page.locator(".mantine-Drawer-content");
const modal = (page: Page) => page.locator(".mantine-Modal-content");

async function login(page: Page) {
  await page.goto("/admin/");
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(process.env.PILOTE_PASSWORD ?? "");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("navigation", { name: "Menu principal" }).first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await login(page);
});

test("ménage : case « fait » en base, personne et note, lien de partage coché sans compte", async ({ page, browser }) => {
  await page.goto("/admin/#/menage");
  await expect(page.getByRole("heading", { name: "Ménage", level: 1 })).toBeVisible();
  const first = page.locator(".job").filter({ hasText: "La Scierie" }).first();
  await expect(first).toContainText("nouveaux voyageurs le jour même");
  // (dans la page : la barre latérale montre la personne connectée, « pilote »)
  await expect(page.locator(".page").getByText("Pilote")).toHaveCount(0);

  // Personne et note.
  await page.locator(".job").filter({ hasText: "La Maison du Scieur" }).first().getByRole("button", { name: /Qui s'en occupe/ }).click();
  await modal(page).getByLabel("Qui s'en occupe").fill("Martine");
  await modal(page).getByLabel("Note pour le ménage").fill("Draps dans l'armoire du palier");
  await modal(page).getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("C'est fait. Ménage mis à jour.").first()).toBeVisible();
  await expect(page.locator(".job").filter({ hasText: "Martine" })).toHaveCount(1);

  // « Fait » depuis l'écran.
  await first.getByRole("checkbox", { name: /Ménage fait/ }).click();
  await expect(first.getByRole("checkbox", { name: /Ménage fait/ })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: shot("1280-menage"), fullPage: true });

  // Lien de partage.
  await page.getByLabel("Pour qui").fill("Martine");
  await page.getByRole("button", { name: "Créer un lien" }).click();
  const url = await modal(page).getByLabel("Adresse du lien").inputValue();
  expect(url).toMatch(/\/t\/[0-9a-f]{48}$/);
  await page.screenshot({ path: shot("1280-menage-lien-cree") });
  await modal(page).getByRole("button", { name: "Fermer" }).click();

  // La personne du ménage, sur son téléphone, sans compte.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(url);
  await expect(phone.getByRole("heading", { name: "Ménage" })).toBeVisible();
  await expect(phone.locator("body")).not.toContainText("Brugmondt");
  await expect(phone.locator("body")).not.toContainText("Pirlouvet");
  const job = phone.locator(".job").filter({ hasText: "La Maison du Scieur" }).first();
  await expect(job).toContainText("Martine");
  const box = await job.getByRole("button", { name: /Marquer le ménage comme fait/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await phone.screenshot({ path: shot("390-lien-menage"), fullPage: true });
  await job.getByRole("button", { name: /Marquer le ménage comme fait/ }).click();
  await expect(phone.getByText("C'est noté : ménage fait.")).toBeVisible();
  await phone.screenshot({ path: shot("390-lien-menage-fait"), fullPage: true });
  await phone.close();

  // De retour à l'écran : coché par Martine.
  await page.reload();
  await expect(page.locator(".job").filter({ hasText: "La Maison du Scieur" }).first()).toContainText("noté par Martine");

  // Le calendrier montre la pastille.
  await page.goto("/admin/#/calendrier");
  await expect(page.locator(".mk.ok").first()).toBeVisible();
  await page.screenshot({ path: shot("1280-calendrier-pastilles") });

  // Couper le lien.
  await page.goto("/admin/#/menage");
  await page.locator(".list-row").filter({ hasText: "Martine" }).getByRole("button", { name: "Couper" }).click();
  await modal(page).getByRole("button", { name: "Couper le lien" }).click();
  await expect(page.getByText("C'est fait. Lien coupé.").first()).toBeVisible();
  const after = await browser.newPage();
  await after.goto(url);
  await expect(after.getByRole("heading", { name: "Ce lien ne marche plus" })).toBeVisible();
  await after.close();
});

test("modèles : créé dans Réglages, proposé dans Messages, supprimé", async ({ page }) => {
  await page.goto("/admin/#/reglages/modeles");
  await expect(page.getByRole("heading", { name: "Modèles de réponse" })).toBeVisible();
  // Les migrations posent un nombre de modèles de départ (4, puis 10 avec la 0037) : on compte, on ne devine pas.
  await expect(page.locator(".list-row").first()).toBeVisible();
  const before = await page.locator(".list-row").count();
  await page.getByRole("button", { name: "Nouveau modèle" }).click();
  const d = drawer(page);
  await d.getByLabel("Nom du modèle").fill("Code wifi");
  await d.getByLabel("Texte").fill("Bonjour {prenom},\n\nLe code wifi de {bien} est sur la porte du frigo.\n\n{signature}");
  await expect(d.locator(".bub")).toContainText("Bonjour Claire,");
  await page.screenshot({ path: shot("1280-reglages-modele") });
  await d.getByRole("button", { name: "Créer" }).click();
  await expect(page.getByText("C'est fait. Modèle créé.").first()).toBeVisible();
  await expect(page.locator(".list-row")).toHaveCount(before + 1);
  await page.screenshot({ path: shot("1280-reglages-modeles") });

  await page.goto("/admin/#/messages");
  await page.getByRole("button", { name: /Ombeline Vauchelard/ }).click();
  await page.getByRole("button", { name: "Code wifi" }).click();
  await expect(page.locator("#rep")).toHaveValue(/Le code wifi de .* est sur la porte du frigo/);
  await expect(page.locator("#rep")).toHaveValue(/^Bonjour Ombeline,/);
  await page.screenshot({ path: shot("1280-messages-modele") });

  await page.goto("/admin/#/reglages/modeles");
  await page.locator(".list-row").filter({ hasText: "Code wifi" }).click();
  await drawer(page).getByRole("button", { name: "Plus" }).click();
  await page.getByRole("menuitem", { name: "Supprimer le modèle" }).click();
  await page.getByRole("button", { name: "Supprimer le modèle" }).last().click();
  await expect(page.locator(".list-row")).toHaveCount(before);
});

test("recherche par téléphone dans les réservations et les clients", async ({ page }) => {
  await page.goto("/admin/#/reservations");
  await page.getByLabel("Rechercher une réservation").fill("0470 00 01 02");
  await expect(page.getByText("Brugmondt").first()).toBeVisible();
  await page.screenshot({ path: shot("1280-reservations-telephone") });
  await page.goto("/admin/#/reglages/clients");
  await page.getByLabel("Rechercher un client").fill("+32470000105");
  await expect(page.getByText("Oudewaeter").first()).toBeVisible();
});

test("mon compte : l'ancien mot de passe est exigé", async ({ page }) => {
  await page.goto("/admin/#/reglages/mon-compte");
  await expect(page.getByRole("heading", { name: "Mon compte" })).toBeVisible();
  await page.getByLabel("Mot de passe actuel").fill("pas-le-bon-mot-de-passe");
  await page.getByLabel("Nouveau mot de passe").fill("une-phrase-de-quatre-mots");
  await page.getByLabel("Le nouveau, une seconde fois").fill("une-phrase-de-quatre-mots");
  await page.getByRole("button", { name: "Changer mon mot de passe" }).click();
  await expect(page.getByText(/Le mot de passe actuel n'est pas le bon/).first()).toBeVisible();
  await page.screenshot({ path: shot("1280-mon-compte") });
});

test("photos : envoi depuis l'ordinateur, masquée tant qu'elle n'est pas décrite", async ({ page }) => {
  await page.goto("/admin/#/reglages/domaine");
  await page.locator("summary").filter({ hasText: "La Scierie" }).click();
  await page.getByRole("button", { name: "Photos" }).first().click();
  const d = drawer(page);
  await expect(d.getByText("Glissez des photos ici")).toBeVisible();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAIAAADkharWAAAAGUlEQVR4nGPce+wJAymAiSTVoxpGNQwpDQCYFwKDsN1bOgAAAABJRU5ErkJggg==",
    "base64",
  );
  await d.getByTestId("photo-file").setInputFiles({ name: "terrasse.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText(/Photo envoyée : décrivez-la/).first()).toBeVisible();
  await expect(d.getByText("Nouvelle photo : décrivez-la").first()).toBeVisible();
  await page.screenshot({ path: shot("1280-photos-envoi") });
});

test("PWA : manifeste et service worker", async ({ page }) => {
  const manifest = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifest).toBe("/admin/manifest.webmanifest");
  const res = await page.request.get(manifest!);
  expect(res.ok()).toBe(true);
  expect((await res.json()).display).toBe("standalone");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/admin/apple-touch-icon.png");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/admin\/$/);
  // Hors ligne : Aujourd'hui reste lisible depuis le cache.
  await page.goto("/admin/#/");
  await expect(page.getByRole("navigation", { name: "Menu principal" }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByText(/Hors ligne : vous voyez la dernière version/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: shot("390-aujourdhui-hors-ligne") });
  await page.context().setOffline(false);
});
