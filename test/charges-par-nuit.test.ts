// Frais généraux = forfait + supplément de charges par nuit (règle du 18/10/2026).
// Chemin de l'argent de bout en bout, contre une vraie base D1 : réglage
// persisté → contexte de devis → devis → réservation créée par l'API publique
// (total et acompte) ; Beds24 ne reçoit que le forfait. Données du seed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerAdminRoutes } from "../src/api/admin";
import { registerPublicRoutes } from "../src/api/public";
import { getQuoteContext, getUnit } from "../src/db/repo";
import { quoteFromContext } from "../src/services/booking-flow";
import { buildPropertyPlan } from "../src/services/beds24-propriete";
import { addDays, todayInZone } from "../src/core/dates";
import { nlText } from "../src/core/public-i18n";

const router = new Router();
registerAdminRoutes(router);
registerPublicRoutes(router);

let t: TestDb;
let env: Env;
const ADMIN = "test-admin-token";

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN };
});
afterAll(async () => {
  await t.dispose();
});

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

/** Devis calculé depuis la base, comme le fait le site. */
async function devis(unitId: number, checkin: string, nights: number, adults = 2) {
  const checkout = addDays(checkin as never, nights);
  const ctx = await getQuoteContext(t.db, unitId, { from: checkin as never, toExclusive: checkout });
  return quoteFromContext(ctx!, { unitId, checkin: checkin as never, checkout, adults, children: 0 }, "2026-10-18" as never);
}
const fee = (q: Awaited<ReturnType<typeof devis>>) => q.lines.find((l) => l.kind === "fee");
const START = "2026-11-02";

describe("du réglage au devis (base réelle)", () => {
  it("le supplément persisté se retrouve dans le devis : 240 € pour 2 nuits, +25 € dès la 3e", async () => {
    const r = await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 2 });
    expect(r.status).toBe(200);
    const u = await getUnit(t.db, 2);
    expect([u!.cleaningFeeCents, u!.chargesExtraNightCents, u!.feeIncludedNights]).toEqual([24000, 2500, 2]);

    expect((await devis(2, START, 2)).cleaningFeeCents).toBe(24000);
    expect((await devis(2, START, 3)).cleaningFeeCents).toBe(26500);
    const q4 = await devis(2, START, 4);
    expect(q4.cleaningFeeCents).toBe(29000);
    expect(fee(q4)?.amountCents).toBe(29000);
    expect(fee(q4)?.label).toBe("Frais généraux — ménage et charges (2 nuits incluses, +25 €/nuit)");
    expect(nlText(fee(q4)!.label)).toBe("Algemene kosten — schoonmaak en lasten (2 nachten inbegrepen, +25 €/nacht)");
    expect(q4.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(q4.totalCents);
  });

  it("séjour plus court que les nuits incluses : le forfait seul, jamais de supplément négatif", async () => {
    await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 3 });
    expect((await devis(2, START, 2)).cleaningFeeCents).toBe(24000);
    expect((await devis(2, START, 3)).cleaningFeeCents).toBe(24000);
    expect((await devis(2, START, 4)).cleaningFeeCents).toBe(26500);
  });

  it("supplément décimal : 25,50 € la nuit, libellé lisible", async () => {
    await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 24000, chargesExtraNightCents: 2550, feeIncludedNights: 1 });
    const q = await devis(2, START, 3);
    expect(q.cleaningFeeCents).toBe(24000 + 2 * 2550);
    expect(fee(q)?.label).toBe("Frais généraux — ménage et charges (1 nuit incluse, +25,50 €/nuit)");
    expect(nlText(fee(q)!.label)).toBe("Algemene kosten — schoonmaak en lasten (1 nacht inbegrepen, +25,50 €/nacht)");
  });

  it("composite « somme » dont une seule maison a un supplément : 2 nuits 360 €, 4 nuits 410 €", async () => {
    // Scieur (1) : forfait 120 € sans supplément ; Scierie (2) : 240 € + 25 €/nuit après 2 nuits.
    await call("PATCH", "/api/admin/units/1", { cleaningFeeCents: 12000, chargesExtraNightCents: 0, feeIncludedNights: 2 });
    await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 2 });
    const q2 = await devis(3, START, 2, 12);
    const q4 = await devis(3, START, 4, 12);
    expect(q2.cleaningFeeCents).toBe(36000);
    expect(q4.cleaningFeeCents).toBe(41000);
    expect(fee(q4)?.label).toBe("Frais généraux — ménage et charges (2 nuits incluses, +25 €/nuit)");
  });

  it("le supplément posé sur le composite lui-même est ignoré en mode « somme »", async () => {
    await call("PATCH", "/api/admin/units/3", { chargesExtraNightCents: 9900, feeIncludedNights: 0 });
    expect((await devis(3, START, 4, 12)).cleaningFeeCents).toBe(41000);
    await call("PATCH", "/api/admin/units/3", { chargesExtraNightCents: 0, feeIncludedNights: 2 });
  });

  it("supplément à 0 : même montant à 2 ou 9 nuits, libellé historique", async () => {
    await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 9000, chargesExtraNightCents: 0, feeIncludedNights: 2 });
    for (const n of [2, 4, 9]) {
      const q = await devis(2, START, n);
      expect(q.cleaningFeeCents).toBe(9000);
      expect(fee(q)?.label).toBe("Frais généraux — ménage et charges");
    }
  });
});

describe("réservation par l'API publique : le montant débité est celui du devis", () => {
  it("total et acompte de la réservation = devis avec supplément", async () => {
    await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 2 });
    await t.db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'cgv_text', 'CGV de test')").run();
    const checkin = addDays(todayInZone(), 120);
    const checkout = addDays(checkin, 7); // 7 nuits : respecte tous les minimums du seed
    const stay = { unitId: 2, checkin, checkout, adults: 4, children: 0 };

    const quote = (await call("POST", "/api/public/quote", stay)).data.quote;
    expect(quote.cleaningFeeCents).toBe(24000 + 5 * 2500);
    expect(quote.lines.find((l: { kind: string }) => l.kind === "fee").label).toContain("2 nuits incluses, +25 €/nuit");

    const created = await call("POST", "/api/public/bookings", {
      ...stay, paymentMode: "deposit", cgvAccepted: true,
      guest: { firstName: "Jean", lastName: "Dupont", email: "jean.dupont@example.com", phone: "+32 470 00 00 00" },
    });
    expect(created.status).toBe(201);
    const row = await t.db
      .prepare("SELECT total_cents, deposit_cents, quote_json FROM bookings WHERE reference = ?1")
      .bind(created.data.reference)
      .first<{ total_cents: number; deposit_cents: number; quote_json: string }>();
    expect(row!.total_cents).toBe(quote.totalCents);
    expect(row!.deposit_cents).toBe(quote.depositCents);
    expect(JSON.parse(row!.quote_json).cleaningFeeCents).toBe(36500);
  });

  it("la fiche publique du domaine expose forfait, nuits incluses, supplément et composantes", async () => {
    const fiche = (await call("GET", "/api/public/properties/pre-more")).data;
    const scierie = fiche.units.find((u: { id: number }) => u.id === 2);
    expect([scierie.cleaningFeeCents, scierie.chargesExtraNightCents, scierie.feeIncludedNights]).toEqual([24000, 2500, 2]);
    const domaine = fiche.units.find((u: { id: number }) => u.id === 3);
    expect(domaine.compositePricing).toBe("sum");
    expect([...domaine.componentIds].sort()).toEqual([1, 2]);
  });
});

describe("Beds24 : seul le forfait fixe part", () => {
  it("avec un supplément non nul, la room porte le forfait, pas le supplément", async () => {
    await call("PATCH", "/api/admin/units/2", { cleaningFeeCents: 24000, chargesExtraNightCents: 2500, feeIncludedNights: 2 });
    const plan = await buildPropertyPlan(t.db, 1, "https://gites.example");
    const scierie = plan.rooms.find((r) => r.name === "La Scierie")!;
    expect(scierie.cleaningFee).toBe(240);
    expect(JSON.stringify(plan)).not.toMatch(/chargesExtra|feeIncluded|"cleaningFee":(265|290)/);
  });
});
