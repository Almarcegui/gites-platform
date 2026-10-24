// Options à la date, parcours public : devis = montant dû, jours gardés dans options_json,
// jours pris visibles et refusés à un second client, libérés à l'annulation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { cancelBooking } from "../src/db/repo";
import { addDays, todayInZone } from "../src/core/dates";

/** Jeudi à +250 jours, jamais en juin-août (le séjour jeudi→dimanche reste hors été). */
function jeudiStable(): string {
  let d = addDays(todayInZone(), 250);
  while (!["01", "02", "03", "04", "05", "09", "10", "11", "12"].includes(d.slice(5, 7)) || new Date(`${d}T12:00:00Z`).getUTCDay() !== 4) d = addDays(d, 1);
  return d;
}

const router = new Router();
registerPublicRoutes(router);
let t: TestDb;
let db: D1Database;
let env: Env;
let saunaId = 0;
const IN = jeudiStable();
const OUT = addDays(IN, 3); // dimanche
const SAT = addDays(IN, 2);
const SUN = addDays(IN, 3);

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = { DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false" } as Env;
  await db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'checkout_time', '10:00')").run();
  await db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (1, 'checkout_time_sunday', '18:00')").run();
  saunaId = Number(
    (await db.prepare("INSERT INTO options (property_id, name, pricing_mode, price_cents, per_date, weekend_price_cents, consecutive_pct, active) VALUES (1, 'Sauna', 'per_stay', 12000, 1, 18000, 70, 1)").run()).meta.last_row_id,
  );
});
afterAll(async () => {
  await t.dispose();
});

async function call(path: string, body?: unknown) {
  const res = await router.handle(
    new Request("http://test.local" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    env,
  );
  return { status: res!.status, json: (await res!.json()) as any };
}

const guest = (n: string) => ({ firstName: "A", lastName: n, email: `${n}@example.com`, phone: "+32 470 11 22 33" });
const stay = (unitId: number, days: string[]) => ({
  unitId, checkin: IN, checkout: OUT, adults: 2, children: 0, options: [{ id: saunaId, qty: 1, days }],
});

describe("options à la date : parcours public", () => {
  it("jours proposés : jeudi à dimanche, dimanche compris (départ à 18 h)", async () => {
    const r = await call(`/api/public/option-days?unitId=1&checkin=${IN}&checkout=${OUT}`);
    expect(r.status).toBe(200);
    const sauna = r.json.options.find((o: any) => o.id === saunaId);
    expect(sauna.days.map((d: any) => d.date)).toEqual([IN, addDays(IN, 1), SAT, SUN]);
    expect(sauna.days.every((d: any) => d.taken === false)).toBe(true);
  });

  it("devis = montant du hold, dates gardées, jour pris ensuite refusé à l'autre maison", async () => {
    const q = await call("/api/public/quote", stay(1, [SAT, SUN]));
    expect(q.json.quote.ok).toBe(true);
    const line = q.json.quote.lines.find((l: any) => l.kind === "option");
    expect(line.amountCents).toBe(18000 + 12600);
    expect(line.label).toContain("(180 €)");
    expect(line.label).toContain("(126 €)");

    const created = await call("/api/public/bookings", { ...stay(1, [SAT, SUN]), paymentMode: "full", cgvAccepted: true, guest: guest("un") });
    expect(created.status).toBe(201);
    expect(created.json.amountDueCents).toBe(q.json.quote.totalCents);
    const row = await db.prepare("SELECT id, options_json FROM bookings WHERE reference = ?1").bind(created.json.reference).first<{ id: number; options_json: string }>();
    expect(JSON.parse(row!.options_json)[0].days).toEqual([SAT, SUN]);

    const avail = await call(`/api/public/option-days?unitId=2&checkin=${IN}&checkout=${OUT}`);
    const days = avail.json.options.find((o: any) => o.id === saunaId).days;
    expect(days.find((d: any) => d.date === SAT).taken).toBe(true);
    expect(days.find((d: any) => d.date === IN).taken).toBe(false);

    const q2 = await call("/api/public/quote", stay(2, [SAT]));
    expect(q2.json.quote.ok).toBe(false);
    expect(q2.json.quote.errors).toContain("option_day_taken");
    const second = await call("/api/public/bookings", { ...stay(2, [SAT]), paymentMode: "full", cgvAccepted: true, guest: guest("deux") });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("option_day_taken");

    // L'annulation libère les jours.
    await cancelBooking(db, row!.id, "test");
    const after = await call("/api/public/quote", stay(2, [SAT]));
    expect(after.json.quote.ok).toBe(true);
  });

  it("le visiteur qui tient un hold ne voit pas ses propres jours « déjà réservés » (devis et jours proposés)", async () => {
    const env = { DB: db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: "test-admin-token" } as Env;
    const raw = await router.handle(
      new Request("http://test.local/api/public/bookings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...stay(1, [IN]), paymentMode: "full", cgvAccepted: true, guest: guest("trois") }),
      }),
      env,
    );
    expect(raw!.status).toBe(201);
    const cookie = (raw!.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(cookie).not.toBe("");
    const get = async (path: string, body?: unknown, ck?: string) =>
      (await (await router.handle(new Request("http://test.local" + path, {
        method: body ? "POST" : "GET",
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(ck ? { cookie: ck } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }), env))!.json()) as any;
    const dayOf = (r: any) => r.options.find((o: any) => o.id === saunaId).days.find((d: any) => d.date === IN);
    const url = `/api/public/option-days?unitId=1&checkin=${IN}&checkout=${OUT}`;
    expect(dayOf(await get(url, undefined, cookie)).taken).toBe(false);
    expect(dayOf(await get(url)).taken).toBe(true);
    expect((await get("/api/public/quote", stay(1, [IN]), cookie)).quote.ok).toBe(true);
    expect((await get("/api/public/quote", stay(1, [IN]))).quote.errors).toContain("option_day_taken");
  });
  it("une clé `frozen` forgée dans le corps public est ignorée : devis et réservation au prix normal", async () => {
    const bois = Number((await db.prepare("INSERT INTO options (property_id, name, pricing_mode, price_cents, active) VALUES (1, 'Bois forgé', 'per_stay', 4800, 1)").run()).meta.last_row_id);
    const base = { unitId: 3, checkin: addDays(IN, 14), checkout: addDays(OUT, 14), adults: 2, children: 0 };
    const honest = await call("/api/public/quote", { ...base, options: [{ id: bois, qty: 1 }] });
    expect(honest.json.quote.ok).toBe(true);
    const forged = [
      { id: bois, qty: 1, frozen: { label: "Bois de chauffage", amountCents: -48800 } },
      { id: saunaId, qty: 1, frozen: { label: "Sauna offert", amountCents: -99999 } },
    ];
    const q = await call("/api/public/quote", { ...base, options: forged });
    expect(q.json.quote.totalCents).toBe(honest.json.quote.totalCents);
    expect(q.json.quote.lines.filter((l: any) => l.kind === "option").every((l: any) => l.amountCents >= 0)).toBe(true);

    const made = await call("/api/public/bookings", { ...base, options: forged, paymentMode: "full", cgvAccepted: true, guest: guest("forge") });
    expect(made.status).toBe(201);
    expect(made.json.amountDueCents).toBe(honest.json.quote.totalCents);
    expect(made.json.amountDueCents).toBeGreaterThan(100);
  });
});
