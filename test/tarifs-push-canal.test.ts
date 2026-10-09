// Issue #31, dernier point — « appliquer le prix conseillé au canal concerné ».
//
// Les bornes de prix et le prix conseillé sont livrés (PR #62), les suggestions
// en un clic aussi (PR #63) : il restait à pouvoir APPLIQUER le prix conseillé.
// Un prix par canal ne se stocke nulle part, et le seul endroit où un prix part
// vers une place de marché est le calendrier poussé à Beds24. C'est donc là que
// la majoration s'applique — le prix de vente directe n'est jamais modifié.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { buildCalendarPush } from "../src/services/beds24-sync";
import { CHANNEL_MARKUPS_KEY, PUSH_CHANNEL_KEY } from "../src/core/price-guardrails";
import { addDays, todayInZone } from "../src/core/dates";
import { zeroUnitRules } from "./helpers/rate-rules";

const router = new Router();
registerAdminRoutes(router);

const ADMIN_USER = "julie";
const ADMIN = `${ADMIN_USER}:motdepasse-test`;
const SCIEUR = 1; // La Maison du Scieur — mappée sur une room Beds24 dans le seed

// Fenêtre très en avant. Elle peut tomber dans une saison du seed selon le
// jour : les tests y posent une surcharge, qui prime sur toute saison.
const FROM = addDays(todayInZone(), 300);

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = {
    DB: t.db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
  };
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  await t.db.prepare("DELETE FROM rate_overrides").run();
  await t.db.prepare("DELETE FROM audit_log").run();
  await t.db
    .prepare("DELETE FROM app_settings WHERE key IN (?1, ?2)")
    .bind(CHANNEL_MARKUPS_KEY, PUSH_CHANNEL_KEY)
    .run();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route ${method} ${path} introuvable`);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

/** Pose un prix connu (200,00 €) sur trois jours, pour que le prix poussé soit
 *  vérifiable au centime plutôt que déduit des règles de saison. */
async function poseCentDeuxCents(): Promise<void> {
  const res = await call("PATCH", "/api/admin/rate-overrides", {
    unitId: SCIEUR,
    from: FROM,
    to: addDays(FROM, 2),
    priceCents: 20000,
  });
  expect(res.status).toBe(200);
}

/** Prix poussé (en euros) pour La Maison du Scieur sur la fenêtre posée. */
async function prixPousses(): Promise<(number | undefined)[]> {
  const rooms = await buildCalendarPush(t.db, 1, FROM, 3);
  const scieur = rooms.find((r) => r.unitName.includes("Scieur"));
  expect(scieur).toBeDefined();
  return scieur!.calendar.map((span) => span.price1);
}

describe("état par défaut — rien ne change tant qu'aucun canal n'est appliqué", () => {
  it("le push envoie le prix de vente directe", async () => {
    await poseCentDeuxCents();
    expect(await prixPousses()).toEqual([200]);
    const { data } = await call("GET", "/api/admin/channel-markups");
    expect(data.pushChannel).toBeNull();
    expect(data.pushMarkupPct).toBe(0);
    expect(data.example).toEqual({ directCents: 20000, pushedCents: 20000 });
  });
});

describe("appliquer un canal", () => {
  it("majore les prix poussés, sans toucher au prix de vente directe", async () => {
    await poseCentDeuxCents();
    const applied = await call("POST", "/api/admin/channel-markups/apply", { channel: "airbnb" });
    expect(applied.status).toBe(200);
    expect(applied.data.pushChannel).toBe("airbnb");
    expect(applied.data.pushMarkupPct).toBe(18);
    expect(applied.data.example).toEqual({ directCents: 20000, pushedCents: 23600 });

    // 200 € × 1,18 = 236 € sur les plateformes…
    expect(await prixPousses()).toEqual([236]);
    // … et 200 € en vente directe : la surcharge en base n'a pas bougé.
    const row = await t.db
      .prepare("SELECT price_cents AS p FROM rate_overrides WHERE unit_id = ?1 AND date = ?2")
      .bind(SCIEUR, FROM)
      .first<{ p: number }>();
    expect(row?.p).toBe(20000);
  });

  it("le retire aussi vite : channel null rend le prix direct", async () => {
    await poseCentDeuxCents();
    await call("POST", "/api/admin/channel-markups/apply", { channel: "airbnb" });
    expect(await prixPousses()).toEqual([236]);

    const cleared = await call("POST", "/api/admin/channel-markups/apply", { channel: null });
    expect(cleared.status).toBe(200);
    expect(cleared.data.pushChannel).toBeNull();
    expect(await prixPousses()).toEqual([200]);
  });

  it("refuse un canal inconnu, en nommant ceux qui existent", async () => {
    const res = await call("POST", "/api/admin/channel-markups/apply", { channel: "leboncoin" });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain("leboncoin");
    expect(String(res.data.error)).toContain("airbnb");
    const state = await call("GET", "/api/admin/channel-markups");
    expect(state.data.pushChannel).toBeNull();
  });

  it("un canal invalide dans le PUT ne laisse pas la moitié du réglage posée", async () => {
    // La liste des canaux est écrite AVANT le canal de référence : si la
    // validation de ce dernier venait après, un refus laisserait une liste
    // modifiée en base et un message d'erreur — le pire des deux mondes.
    const res = await call("PUT", "/api/admin/channel-markups", {
      channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 42 }],
      pushChannel: "leboncoin",
    });
    expect(res.status).toBe(400);
    const stored = await t.db
      .prepare("SELECT value FROM app_settings WHERE key = ?1")
      .bind(CHANNEL_MARKUPS_KEY)
      .first<{ value: string }>();
    expect(stored).toBeNull();
    const state = await call("GET", "/api/admin/channel-markups");
    expect((state.data.channels as { markupPct: number }[])[0]?.markupPct).toBe(18);
  });

  it("donne l'exemple chiffré de chaque canal, calculé côté serveur", async () => {
    const { data } = await call("GET", "/api/admin/channel-markups");
    expect(data.examples).toEqual([
      { channel: "airbnb", label: "Airbnb", markupPct: 18, suggestedCents: 23600 },
      { channel: "booking", label: "Booking.com", markupPct: 18, suggestedCents: 23600 },
      { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15, suggestedCents: 23000 },
    ]);
  });

  it("journalise la décision — qui, quel canal, quel taux", async () => {
    await call("POST", "/api/admin/channel-markups/apply", { channel: "booking" });
    const row = await t.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'pricing.push_channel'")
      .first<{ detail: string }>();
    expect(row?.detail).toContain("booking");
    expect(row?.detail).toContain("18");
    expect(row?.detail).toContain(ADMIN_USER);
  });
});

describe("cohérence avec le reste de la tarification", () => {
  it("un canal retiré de la configuration cesse de majorer — jamais de majoration fantôme", async () => {
    await poseCentDeuxCents();
    await call("POST", "/api/admin/channel-markups/apply", { channel: "abritel" });
    expect(await prixPousses()).toEqual([230]); // 200 € × 1,15

    // Le propriétaire refait sa liste de canaux sans Abritel.
    const res = await call("PUT", "/api/admin/channel-markups", {
      channels: [{ channel: "airbnb", label: "Airbnb", markupPct: 18 }],
    });
    expect(res.status).toBe(200);
    expect(res.data.pushChannel).toBeNull();
    expect(await prixPousses()).toEqual([200]);
  });

  it("un simple ajustement de pourcentage ne débranche pas le canal appliqué", async () => {
    await poseCentDeuxCents();
    await call("POST", "/api/admin/channel-markups/apply", { channel: "airbnb" });
    const res = await call("PUT", "/api/admin/channel-markups", {
      channels: [
        { channel: "airbnb", label: "Airbnb", markupPct: 20 },
        { channel: "booking", label: "Booking.com", markupPct: 18 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.pushChannel).toBe("airbnb");
    expect(res.data.pushMarkupPct).toBe(20);
    expect(await prixPousses()).toEqual([240]); // 200 € × 1,20
  });

  it("la majoration ne ressuscite pas un prix nul : rien n'est poussé", async () => {
    await call("POST", "/api/admin/channel-markups/apply", { channel: "airbnb" });
    // Toutes les règles de l'unité, saisons comprises : FROM (J+300) peut
    // tomber dans une saison du seed selon le jour (août 2027 vu du 09/10/2026).
    const restore = await zeroUnitRules(t.db, SCIEUR);
    try {
      for (const price of await prixPousses()) expect(price).toBeUndefined();
    } finally {
      await restore();
    }
  });

  it("le prix conseillé dit lequel des canaux est appliqué", async () => {
    const avant = await call("GET", "/api/admin/suggested-prices?priceCents=20000");
    expect(avant.data.pushChannel).toBeNull();
    expect(avant.data.channels).toEqual([
      { channel: "airbnb", label: "Airbnb", markupPct: 18, suggestedCents: 23600 },
      { channel: "booking", label: "Booking.com", markupPct: 18, suggestedCents: 23600 },
      { channel: "abritel", label: "Abritel / Vrbo", markupPct: 15, suggestedCents: 23000 },
    ]);

    await call("POST", "/api/admin/channel-markups/apply", { channel: "booking" });
    const apres = await call("GET", "/api/admin/suggested-prices?priceCents=20000");
    expect(apres.data.pushChannel).toBe("booking");
  });

  it("le plafond de l'hébergement borne la saisie directe, pas le prix dérivé", async () => {
    // 200 € est dans les bornes ; 236 € les dépasse. C'est voulu : le plafond
    // protège contre la faute de frappe à la saisie, il ne décide pas du prix
    // affiché sur une place de marché.
    expect((await call("PATCH", `/api/admin/units/${SCIEUR}`, { priceMinCents: 10000, priceMaxCents: 21000 })).status).toBe(200);
    await poseCentDeuxCents();
    await call("POST", "/api/admin/channel-markups/apply", { channel: "airbnb" });
    expect(await prixPousses()).toEqual([236]);
    await call("PATCH", `/api/admin/units/${SCIEUR}`, { priceMinCents: null, priceMaxCents: null });
  });
});
