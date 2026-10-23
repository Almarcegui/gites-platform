// Départ selon le jour (décision de Julien du 23/10/2026) : départ avant 10 h,
// sauf le dimanche, départ avant 18 h. Réglage `checkout_time_sunday`, vide =
// même heure tous les jours. Une seule fonction (src/core/checkout-time.ts),
// lue par le mail de confirmation, le PDF, les mails du séjour, la page de la
// réservation (voucher, Merci, .ics), le tunnel et le ménage. Et les CGV 3.2
// (migration 0040). Données inventées (example.*).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers/d1";
import { pdfText } from "./helpers/pdf-lire";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, dayOfWeek, todayInZone } from "../src/core/dates";
import { checkoutTimeFor } from "../src/core/checkout-time";
import { desiredCleaningTasks } from "../src/core/cleaning";
import { buildConfirmationEmail } from "../src/services/confirmation";
import { buildConfirmationPdf, cgvVersionLabel, loadConfirmationPdfContext } from "../src/services/confirmation-pdf";
import { buildStayEmail } from "../src/services/sejour-emails";
import { checkoutTimeFor as checkoutTimeForJs } from "../public/book/checkout-time.js";
import { checkoutTimeFor as checkoutTimeForApp } from "../app/src/lib/checkoutTime";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = { DB: t.db, ASSETS: undefined as unknown as Fetcher, PUBLIC_BASE_URL: "http://test.local", EMAILS_ENABLED: "false", ADMIN_TOKEN: ADMIN };
});
afterAll(async () => {
  await t.dispose();
});

async function callJson(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  if (body) headers["content-type"] = "application/json";
  const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  if (!res) throw new Error(`route non matchée : ${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}
const putSettings = (settings: Record<string, unknown>) => callJson("PUT", "/api/admin/settings?property=1", { settings });

// 25/10/2026 est un dimanche, 26/10/2026 un lundi.
const SUNDAY = "2026-10-25";
const MONDAY = "2026-10-26";
const SATURDAY = "2026-10-24";

describe("checkoutTimeFor", () => {
  const set = { checkoutTime: "10:00", checkoutTimeSunday: "18:00" };
  it("dimanche : l'heure du dimanche", () => {
    expect(checkoutTimeFor(set, SUNDAY)).toBe("18:00");
  });
  it("autre jour : l'heure commune", () => {
    expect(checkoutTimeFor(set, MONDAY)).toBe("10:00");
    expect(checkoutTimeFor(set, SATURDAY)).toBe("10:00");
  });
  it("réglage vide, blanc ou absent : la même heure tous les jours", () => {
    expect(checkoutTimeFor({ checkoutTime: "10:00", checkoutTimeSunday: "" }, SUNDAY)).toBe("10:00");
    expect(checkoutTimeFor({ checkoutTime: "10:00", checkoutTimeSunday: "  " }, SUNDAY)).toBe("10:00");
    expect(checkoutTimeFor({ checkoutTime: "10:00" }, SUNDAY)).toBe("10:00");
  });
  it("date absente ou mal formée : l'heure commune", () => {
    expect(checkoutTimeFor(set, null)).toBe("10:00");
    expect(checkoutTimeFor(set, undefined)).toBe("10:00");
    expect(checkoutTimeFor(set, "25/10/2026")).toBe("10:00");
  });
  it("les copies du tunnel (public/book/checkout-time.js) et du back-office (app/src/lib/checkoutTime.ts) répondent pareil, jour après jour", () => {
    for (const s of [set, { checkoutTime: "10:00", checkoutTimeSunday: "" }, { checkoutTime: "11:30" }]) {
      for (let i = 0; i < 14; i++) {
        const d = addDays(SATURDAY, i);
        expect(checkoutTimeForJs(s, d), `tunnel ${d} ${JSON.stringify(s)}`).toBe(checkoutTimeFor(s, d));
        expect(checkoutTimeForApp(s, d), `back-office ${d} ${JSON.stringify(s)}`).toBe(checkoutTimeFor(s, d));
      }
    }
  });
});

describe("Réglages › Le domaine : départ le dimanche", () => {
  it("vide par défaut", async () => {
    const r = await callJson("GET", "/api/admin/settings?property=1");
    expect(r.data.settings.checkoutTimeSunday).toBe("");
  });
  it("une heure HH:MM passe, une chaîne vide aussi (= même heure)", async () => {
    expect((await putSettings({ checkout_time_sunday: "18:00" })).data.settings.checkoutTimeSunday).toBe("18:00");
    expect((await putSettings({ checkout_time_sunday: "" })).data.settings.checkoutTimeSunday).toBe("");
  });
  it.each(["25:00", "18h", "abc"])("« %s » est refusé, rien n'est écrit", async (v) => {
    const before = (await callJson("GET", "/api/admin/settings?property=1")).data.settings;
    const r = await putSettings({ checkout_time_sunday: v });
    expect(r.status).toBe(400);
    expect((await callJson("GET", "/api/admin/settings?property=1")).data.settings).toEqual(before);
  });
});

describe("le ménage d'un départ du dimanche est dû à l'heure du dimanche", () => {
  it("dimanche 18:00, lundi 10:00", () => {
    const base = { unitId: 1, persons: 2, status: "confirmed", source: "manual", holdExpiresAt: null };
    const tasks = desiredCleaningTasks(
      [
        { id: 1, checkin: "2026-10-23", checkout: SUNDAY, ...base },
        { id: 2, checkin: SUNDAY, checkout: MONDAY, ...base },
      ],
      [],
      { checkinTime: "18:00", checkoutTime: "10:00", checkoutTimeSunday: "18:00" },
      "2026-10-01",
      "2026-11-01",
      "2000-01-01 00:00:00",
    );
    expect(tasks.map((x) => [x.dueDate, x.dueTime])).toEqual([[SUNDAY, "18:00"], [MONDAY, "10:00"]]);
  });
});

describe("une réservation qui se termine un dimanche", () => {
  // Un dimanche assez loin pour être libre et réservable en ligne.
  let sunday = addDays(todayInZone(), 140);
  while (dayOfWeek(sunday) !== 0) sunday = addDays(sunday, 1);
  const checkin = addDays(sunday, -2);
  let ref = "";
  let id = 0;
  const email = "claire@example.be";

  beforeAll(async () => {
    expect((await putSettings({ checkout_time: "10:00", checkout_time_sunday: "18:00" })).status).toBe(200);
    const created = await callJson("POST", "/api/public/bookings", {
      unitId: 2, checkin, checkout: sunday, adults: 2, children: 0, paymentMode: "deposit",
      guest: { firstName: "Claire", lastName: "Dubois", email, phone: "+32 470 00 00 09" },
      cgvAccepted: true,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    ref = created.data.reference as string;
    const row = await t.db.prepare("SELECT id FROM bookings WHERE reference = ?1").bind(ref).first<{ id: number }>();
    id = row!.id;
  });

  it("page de la réservation (voucher, Merci, .ics) : départ avant 18:00", async () => {
    const r = await callJson("GET", `/api/public/bookings/${encodeURIComponent(ref)}?email=${encodeURIComponent(email)}`);
    expect(r.status).toBe(200);
    expect(r.data.stay.checkoutTime).toBe("18:00");
  });

  it("fiche du domaine (tunnel) : les deux heures, le tunnel choisit selon la date", async () => {
    const r = await callJson("GET", "/api/public/properties/pre-more");
    expect(r.data.settings.checkoutTime).toBe("10:00");
    expect(r.data.settings.checkoutTimeSunday).toBe("18:00");
  });

  it("mail de confirmation, FR et NL : 18:00 le dimanche, 10:00 un autre jour", async () => {
    const ctx = (await loadConfirmationPdfContext(t.db, id))!;
    const mail = (checkout: string, lang: string) =>
      buildConfirmationEmail({ booking: { ...ctx.booking, checkout, guestLang: lang }, property: ctx.property, settings: ctx.settings, voucherUrl: "http://test.local/x", attachmentName: "Confirmation-X.pdf" });
    const fr = mail(sunday, "fr");
    expect(fr.bodyText).toContain("avant 18:00");
    expect(fr.bodyText).not.toContain("10:00");
    expect(fr.bodyHtml).toContain("avant 18:00");
    expect(mail(sunday, "nl").bodyText).toContain("voor 18:00");
    const lundi = mail(addDays(sunday, 1), "fr");
    expect(lundi.bodyText).toContain("avant 10:00");
    expect(lundi.bodyText).not.toContain("avant 18:00");
  });

  it("PDF de confirmation : départ avant 18:00", async () => {
    const ctx = (await loadConfirmationPdfContext(t.db, id))!;
    const text = pdfText(buildConfirmationPdf(ctx));
    expect(text).toContain("avant 18:00");
  });

  it("mails du séjour (J-7, J-3) : 18 h le dimanche, 10 h un autre jour", async () => {
    const ctx = (await loadConfirmationPdfContext(t.db, id))!;
    const c = { b: ctx.booking, property: ctx.property, settings: ctx.settings, voucher: "http://test.local/x" };
    for (const kind of ["stay_j7", "stay_j3"] as const) {
      expect(buildStayEmail(kind, c).bodyText).toContain("départ au plus tard à 18 h");
      expect(buildStayEmail(kind, { ...c, b: { ...c.b, guestLang: "nl" } }).bodyText).toContain("vertrek uiterlijk om 18:00");
      expect(buildStayEmail(kind, { ...c, b: { ...c.b, checkout: addDays(sunday, 1) } }).bodyText).toContain("départ au plus tard à 10 h");
    }
  });

  it("réglage vidé : le dimanche reprend l'heure commune", async () => {
    expect((await putSettings({ checkout_time_sunday: "" })).status).toBe(200);
    const r = await callJson("GET", `/api/public/bookings/${encodeURIComponent(ref)}?email=${encodeURIComponent(email)}`);
    expect(r.data.stay.checkoutTime).toBe("10:00");
  });
});

describe("CGV 3.2 (migration 0040)", () => {
  const cgvOf = async (key: string, propertyId: number) =>
    (await t.db.prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = ?2").bind(propertyId, key).first<{ value: string }>())?.value;
  const migration0040 = () =>
    readFileSync(fileURLToPath(new URL("../migrations/0040_cgv_v3_2_depart_dimanche.sql", import.meta.url)), "utf8")
      .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

  it("Pré Moré : version 3.2 du 23 octobre 2026, départ avant 10 h, le dimanche avant 18 h", async () => {
    const cgv = (await cgvOf("cgv_text", 1))!;
    expect(cgvVersionLabel(cgv)).toBe("3.2");
    expect(cgv).toContain("Version 3.2 — 23 octobre 2026.");
    expect(cgv).toContain("6. Arrivée à partir de 18 h. Départ avant 10 h, le dimanche avant 18 h, ou à l'heure indiquée lors de la réservation.");
    expect(cgv).toContain("8.1. Arrivée à partir de 18 h, départ avant 10 h, le dimanche avant 18 h, sauf accord écrit contraire. Les horaires sont lus des réglages de l'hébergement et affichés lors de la réservation.");
    expect(cgv).not.toContain("Départ avant 18 h");
    expect(cgv).not.toContain("départ avant 18 h");
  });

  it("rien d'autre ne change que les trois lignes, et la 3.1 est archivée", async () => {
    const v32 = (await cgvOf("cgv_text", 1))!.split("\n");
    const v31 = (await cgvOf("cgv_text_avant_3_2", 1))!.split("\n");
    expect(cgvVersionLabel(v31.join("\n"))).toBe("3.1");
    expect(v32).toHaveLength(v31.length);
    const changed = v32.map((l, i) => (l === v31[i] ? null : l.slice(0, 12))).filter(Boolean);
    expect(changed).toEqual(["Version 3.2 ", "6. Arrivée à", "8.1. Arrivée"]);
  });

  it("le Moulin de Braives garde la 3.1, sans archive 3.2", async () => {
    expect(cgvVersionLabel((await cgvOf("cgv_text", 2))!)).toBe("3.1");
    expect(await cgvOf("cgv_text_avant_3_2", 2)).toBeUndefined();
  });

  it("une réservation acceptée en 3.1 garde la 3.1 en annexe de son PDF", async () => {
    const created = await callJson("POST", "/api/public/bookings", {
      unitId: 2, checkin: addDays(todayInZone(), 200), checkout: addDays(todayInZone(), 203), adults: 2, children: 0, paymentMode: "deposit",
      guest: { firstName: "Alix", lastName: "Essai", email: "alix@example.test", phone: "+32 470 00 00 01" }, cgvAccepted: true,
    });
    expect(created.status).toBe(201);
    const row = (await t.db.prepare("SELECT id FROM bookings WHERE reference = ?1").bind(created.data.reference).first<{ id: number }>())!;
    const v31 = (await cgvOf("cgv_text_avant_3_2", 1))!;
    // comme une réservation d'avant la 0040 : version 3.1 enregistrée, avec la longueur du texte 3.1
    await t.db.prepare("UPDATE bookings SET cgv_version = ?2 WHERE id = ?1").bind(row.id, `v3.1+sha256:0123456789abcdef-len${v31.length}`).run();
    const ctx = (await loadConfirmationPdfContext(t.db, row.id))!;
    expect(ctx.settings.cgvText).toBe(v31);
    const text = pdfText(buildConfirmationPdf(ctx));
    expect(text).toContain("conditions générales v3.1");
    // une réservation acceptée en 3.2 a la 3.2
    await t.db.prepare("UPDATE bookings SET cgv_version = 'v3.2+sha256:0123456789abcdef-len1' WHERE id = ?1").bind(row.id).run();
    expect(cgvVersionLabel((await loadConfirmationPdfContext(t.db, row.id))!.settings.cgvText)).toBe("3.2");
  });

  it("la migration se rejoue sans rien changer", async () => {
    const cur = await cgvOf("cgv_text", 1);
    const arch = await cgvOf("cgv_text_avant_3_2", 1);
    for (const stmt of migration0040()) await t.db.prepare(stmt).run();
    expect(await cgvOf("cgv_text", 1)).toBe(cur);
    expect(await cgvOf("cgv_text_avant_3_2", 1)).toBe(arch);
  });
});
