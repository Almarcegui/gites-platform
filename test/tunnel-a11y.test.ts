// Issue #16 — tunnel de réservation : annoncer les changements dynamiques et
// afficher un vrai décompte du blocage de 30 min.
//
// Le tunnel est du JS sans framework, servi tel quel : ces tests vérifient
// d'une part le contrat côté API (holdExpiresAt + heure serveur, sans quoi
// aucun décompte honnête n'est possible), d'autre part la présence effective
// des attributs d'accessibilité dans les fichiers livrés — c'est ce qui casse
// en silence à la première refonte du markup.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";

/** Date d'arrivée stable : +250 jours, déplacée hors de juillet-août (minimum de nuits d'été)
 *  et sur un mardi, pour ne pas dépendre du jour où la suite tourne. */
function arriveeHorsEte(): string {
  let d = addDays(todayInZone(), 250);
  while (["07", "08"].includes(d.slice(5, 7)) || new Date(`${d}T12:00:00Z`).getUTCDay() !== 2) d = addDays(d, 1);
  return d;
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const HTML = read("public/book/index.html");
const JS = read("public/book/book.js");

describe("annonces des changements dynamiques (#16)", () => {
  it("les résultats de recherche et le récapitulatif du séjour sont des régions annoncées", () => {
    expect(/<div id="results"[^>]*aria-live="polite"/.test(HTML)).toBe(true);
    expect(/<div id="staySummary"[^>]*aria-live="polite"/.test(HTML)).toBe(true);
  });

  it("les messages d'erreur sont annoncés sans attendre (role=alert)", () => {
    expect(/<div id="searchMsg"[^>]*role="alert"/.test(HTML)).toBe(true);
    expect(/id="bookMsg"[^>]*role="alert"/.test(JS)).toBe(true);
  });

  it("le total du devis est annoncé à chaque recalcul", () => {
    expect(/id="quoteZone"[^>]*aria-live="polite"/.test(JS)).toBe(true);
  });

  it("le titre de l'étape 3 est focusable et reçoit le focus au passage automatique", () => {
    expect(/id="step3Title"[^>]*tabindex="-1"/.test(JS)).toBe(true);
    expect(JS).toMatch(/step3Title[\s\S]{0,200}focus\(/);
  });
});

describe("décompte du blocage (#16)", () => {
  let t: TestDb;
  let db: D1Database;
  let env: Env;
  const router = new Router();
  registerPublicRoutes(router);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    env = {
      DB: db,
      ASSETS: undefined as unknown as Fetcher,
      PUBLIC_BASE_URL: "http://test.local",
      EMAILS_ENABLED: "false",
    } as Env;
  });
  afterAll(async () => {
    await t.dispose();
  });

  it("la création de réservation renvoie la fin du blocage ET l'heure serveur", async () => {
    const checkin = arriveeHorsEte();
    const req = new Request("http://test.local/api/public/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        unitId: 1, checkin, checkout: addDays(checkin, 3), adults: 2, children: 0,
        paymentMode: "deposit", cgvAccepted: true,
        guest: { firstName: "Chrono", lastName: "Mètre", email: "chrono@example.com", phone: "+32 470 11 22 33" },
      }),
    });
    const res = await router.handle(req, env);
    expect(res?.status).toBe(201);
    const body = (await res!.json()) as { holdExpiresAt?: string; now?: string; holdMinutes?: number };
    // format SQL 'AAAA-MM-JJ HH:MM:SS' des deux côtés : le front peut soustraire
    expect(body.holdExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // le décompte part bien de la durée annoncée, calée sur l'horloge serveur
    const left = Date.parse(body.holdExpiresAt!.replace(" ", "T") + "Z") - Date.parse(body.now!.replace(" ", "T") + "Z");
    expect(left).toBeGreaterThan(0);
    expect(Math.round(left / 60000)).toBe(body.holdMinutes);
  });

  it("le tunnel décompte l'heure serveur et change d'affichage à l'expiration", () => {
    // la zone de décompte existe et est annoncée
    expect(/id="holdBanner"[^>]*aria-live="polite"/.test(HTML)).toBe(true);
    // décalage d'horloge : on compare à l'heure serveur, jamais à l'heure locale seule
    expect(JS).toMatch(/holdExpiresAt/);
    expect(JS).toMatch(/res\.now|serverNow/);
    // un vrai tick (pas un texte figé) et un état « expiré »
    expect(JS).toMatch(/setTimeout\([^)]*tick|setInterval/);
    expect(JS).toMatch(/expiré/i);
  });
});
