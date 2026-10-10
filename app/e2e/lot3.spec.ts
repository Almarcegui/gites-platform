// Parcours du lot 3 sur le serveur Node (production) et des données inventées :
// lancé par `node app/e2e/lot3-serveur.mjs`, qui prépare une base temporaire.
//  - captures de l'aide « Comment ça marche » (public/aide/, servies sous /admin2/aide/) ;
//  - promotions Airbnb et prix par plateforme (écritures Beds24 fermées ici) ;
//  - carte « Avis » d'Aujourd'hui ;
//  - écran et tunnel de réservation en néerlandais ;
//  - la page d'aide elle-même.
// Captures du lot dans docs/captures/lot3/, à 1280 de large.
import { expect, test, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };
const shot = (name: string) => `docs/captures/lot3/${name}.png`;
const aide = (name: string) => `public/aide/${name}.png`;

test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/admin2/");
  await page.getByLabel("Identifiant").fill("pilote");
  await page.getByLabel("Mot de passe").fill(process.env.PILOTE_PASSWORD ?? "");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("navigation", { name: "Menu principal" }).first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
});

test("captures de l'aide : Aujourd'hui, calendrier, vente, ménage, messages", async ({ page }) => {
  await expect(page.getByLabel("La journée")).toBeVisible();
  await expect(page.locator(".reviews-strip")).toBeVisible();
  await page.screenshot({ path: aide("aujourdhui") });

  await page.goto("/admin2/#/calendrier");
  await expect(page.getByText("Pirlouvet").first()).toBeVisible();
  await page.screenshot({ path: aide("calendrier") });

  await page.getByRole("button", { name: "Nouvelle vente" }).click();
  await expect(page.locator(".mantine-Drawer-content, .mantine-Modal-content").first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: aide("vente") });
  await page.keyboard.press("Escape");

  await page.goto("/admin2/#/menage");
  await expect(page.getByRole("heading", { name: "Ménage", level: 1 })).toBeVisible();
  await page.screenshot({ path: aide("menage") });

  await page.goto("/admin2/#/messages");
  await expect(page.getByText("Chaise haute").first()).toBeVisible();
  await page.screenshot({ path: aide("messages") });
});

test("promotions Airbnb : aperçu chiffré, enregistrement, envoi fermé sans Beds24", async ({ page }) => {
  await page.goto("/admin2/#/reglages/plateformes");
  await page.getByRole("link", { name: "Régler les promotions et les prix par plateforme" }).click();
  await expect(page.getByRole("heading", { name: "Promotions Airbnb et prix par plateforme", level: 1 })).toBeVisible();
  const apercu = page.getByTestId("apercu");
  await expect(apercu).toContainText("Un séjour de 7 nuits à 1 400 € part à");
  const weekly = page.getByLabel("7 nuits et plus");
  await weekly.fill("10");
  await expect(apercu).toContainText("− 10 % pour 7 nuits");
  await page.getByRole("button", { name: "Enregistrer les promotions" }).click();
  await expect(page.getByText("C'est fait. Promotions enregistrées, pas encore envoyées.").first()).toBeVisible();
  // Sans liaison Beds24 (ni écritures ouvertes) : rien ne part, l'écran dit pourquoi.
  await expect(page.getByRole("button", { name: "Envoyer à Airbnb" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Donner à chaque plateforme son prix" })).toBeDisabled();
  await expect(page.getByText(/La liaison avec Beds24 n'est pas en place/).first()).toBeVisible();
  await page.screenshot({ path: shot("1280-promotions-airbnb"), fullPage: true });
});

test("Aujourd'hui : carte Avis, note moyenne, alerte sous 4, lien vers Beds24", async ({ page }) => {
  const strip = page.locator(".reviews-strip");
  await expect(strip).toContainText("4,2 / 5");
  await expect(strip).toContainText("1 avis sous 4 sans réponse");
  await expect(strip.getByRole("link", { name: "Répondre dans Beds24" })).toHaveAttribute("href", /beds24\.com/);
  await page.screenshot({ path: shot("1280-aujourdhui-avis") });
});

test("néerlandais : l'écran bascule dans Réglages et le reste après rechargement", async ({ page }) => {
  await page.goto("/admin2/#/reglages");
  await page.getByRole("button", { name: "Nederlands" }).click();
  await expect(page.getByRole("heading", { name: "Instellingen", level: 1 })).toBeVisible();
  await page.screenshot({ path: shot("1280-instellingen-nl"), fullPage: true });
  await page.goto("/admin2/#/");
  await page.reload();
  await expect(page.getByLabel("De dag")).toBeVisible();
  await expect(page.getByText("Komen aan").first()).toBeVisible();
  await page.screenshot({ path: shot("1280-vandaag-nl") });
  await page.goto("/admin2/#/reglages/aide");
  await expect(page.getByRole("heading", { name: "Hoe het werkt", level: 1 })).toBeVisible();
  await page.goto("/admin2/#/reglages");
  await page.getByRole("button", { name: "Français" }).click();
  await expect(page.getByRole("heading", { name: "Réglages", level: 1 })).toBeVisible();
});

test("tunnel public en néerlandais : sélecteur, textes, formulaire ; FR par défaut", async ({ page, browser }) => {
  const day = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const q = `property=pre-more&checkin=${day(60)}&checkout=${day(67)}&adults=2`;
  await page.goto(`/book/?${q}&lang=nl`);
  await expect(page.locator("#propSub")).toHaveText("Rechtstreeks reserveren — beveiligde betaling, zonder account");
  await expect(page.locator("#steps")).toContainText("2. Accommodatie");
  await expect(page.locator("html")).toHaveAttribute("lang", "nl-BE");
  const reserve = page.getByRole("button", { name: "Reserveren" }).first();
  await expect(reserve).toBeVisible();
  await expect(page.locator("#results")).toContainText("schoonmaak en lasten inbegrepen");
  await reserve.click();
  await expect(page.getByLabel("Voornaam")).toBeVisible();
  await expect(page.locator("#quoteZone")).toContainText("Totaal");
  // Lignes calculées traduites (le nom d'une remise, saisi par le propriétaire, reste tel quel).
  await expect(page.locator("#quoteZone")).toContainText("nachten week aan");
  await expect(page.locator("#quoteZone")).toContainText("Voorschot van");
  await expect(page.locator("#quoteZone")).not.toContainText("tarif de base");
  await page.screenshot({ path: shot("1280-tunnel-nl"), fullPage: true });
  // Le sélecteur ramène au français, et le choix reste.
  await page.locator("#langSwitch").getByText("FR").click();
  await expect(page.locator("#propSub")).toHaveText("Réservation directe — paiement sécurisé, sans création de compte");
  // Un navigateur néerlandophone, sans choix : néerlandais d'office.
  const nl = await browser.newContext({ locale: "nl-BE", viewport: { width: 1280, height: 800 } });
  const p2 = await nl.newPage();
  await p2.goto(`${process.env.GITES_URL}/book/?property=pre-more`);
  await expect(p2.locator("#propSub")).toHaveText("Rechtstreeks reserveren — beveiligde betaling, zonder account");
  await nl.close();
});

test("aide « Comment ça marche » : ouverte depuis Réglages, illustrée", async ({ page }) => {
  await page.goto("/admin2/#/reglages");
  await page.getByRole("link", { name: /Comment ça marche/ }).click();
  await expect(page.getByRole("heading", { name: "Comment ça marche", level: 1 })).toBeVisible();
  for (const h of ["Une journée type", "Le calendrier", "Vendre par téléphone", "Le ménage", "Les messages", "Ce qui se fait tout seul", "Qui appeler"]) {
    await expect(page.getByRole("heading", { name: h, level: 2 })).toBeVisible();
  }
  // Les captures sont celles que le premier test vient de refaire (servies après
  // un nouveau `npm run build`) : chacune doit se charger.
  const imgs = page.locator(".help-shot img");
  await expect(imgs).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await imgs.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(() => imgs.nth(i).evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await page.screenshot({ path: shot("1280-aide"), fullPage: true });
});
