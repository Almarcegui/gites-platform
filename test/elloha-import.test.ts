// Tests de l'import CSV elloha : parsing tolérant, dry-run sans écriture,
// import réel avec dédoublonnage et garde anti-conflit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { importElloha, parseCsv, parseFlexibleDate, parseFlexibleMoney } from "../src/services/elloha-import";
import { createBookingAtomic, listBookings, getBookingByReference } from "../src/db/repo";

let t: TestDb;
let db: D1Database;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

const NOW = new Date("2026-07-12T10:00:00Z");

const CSV = [
  "unite;arrivee;depart;nom;prenom;email;telephone;adultes;enfants;total;paye;reference",
  "La Scierie;15/10/2026;18/10/2026;Peeters;Jan;jan.peeters@example.com;+32470111111;6;0;540,00;162,00;ELL-1001",
  'la-scierie;2026-11-06;2026-11-08;"Van Damme; Fils";;;;4;2;300;300;ELL-1002',
  "Le Domaine entier;20/11/2026;22/11/2026;Mariage Dubois;;;;17;0;1180;354;ELL-1003",
].join("\n");

describe("parsing", () => {
  it("parseCsv gère les champs entre guillemets contenant le séparateur", () => {
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(4);
    expect(rows[2]?.[3]).toBe("Van Damme; Fils");
  });
  it("dates FR et ISO, montants avec virgule", () => {
    expect(parseFlexibleDate("15/10/2026")).toBe("2026-10-15");
    expect(parseFlexibleDate("2026-10-15")).toBe("2026-10-15");
    expect(parseFlexibleDate("32/13/2026")).toBeNull();
    expect(parseFlexibleMoney("1 234,56")).toBe(123456);
    expect(parseFlexibleMoney("540.00")).toBe(54000);
    expect(parseFlexibleMoney("abc")).toBeNull();
  });
});

describe("dry-run", () => {
  it("valide tout sans rien écrire, et détecte les conflits internes au fichier", async () => {
    const withInternalClash = CSV + "\nLa Scierie;16/10/2026;17/10/2026;Doublon;;;;2;0;120;0;ELL-1004";
    const result = await importElloha(db, 1, withInternalClash, true, NOW);
    expect(result.dryRun).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.conflicts).toBe(1); // ELL-1004 chevauche ELL-1001 dans le même fichier
    expect(await listBookings(db, {})).toHaveLength(0); // AUCUNE écriture
  });

  it("signale les unités inconnues et les dates illisibles", async () => {
    const bad = "unite;arrivee;depart;nom\nChalet Fantôme;15/10/2026;18/10/2026;X\nLa Scierie;n/a;18/10/2026;Y";
    const result = await importElloha(db, 1, bad, true, NOW);
    expect(result.errors).toBe(2);
    expect(result.rows[0]?.message).toContain("unité inconnue");
  });
});

describe("import réel", () => {
  it("crée les résas confirmées + paiements, avec références PM et dédoublonnage au rejeu", async () => {
    const result = await importElloha(db, 1, CSV, false, NOW);
    expect(result.imported).toBe(3);
    expect(result.errors).toBe(0);
    const bookings = await listBookings(db, {});
    expect(bookings).toHaveLength(3);
    expect(bookings.every((b) => b.status === "confirmed" && b.source === "import")).toBe(true);
    // paiement repris : Peeters a payé 162 € d'acompte via elloha
    const peeters = bookings.find((b) => b.externalUid === "elloha:ELL-1001");
    expect(peeters?.paidCents).toBe(16200);
    expect(peeters?.totalCents).toBe(54000);
    // rejouer le même fichier → tout est « déjà importé »
    const again = await importElloha(db, 1, CSV, false, NOW);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(3);
    expect(await listBookings(db, {})).toHaveLength(3);
  });

  it("respecte la liaison : l'import du Domaine échoue si une maison est déjà prise", async () => {
    const direct = await createBookingAtomic(db, {
      unitId: 2, checkin: "2026-11-20", checkout: "2026-11-22",
      adults: 4, children: 0, status: "confirmed", source: "direct", now: NOW,
    });
    expect(direct.ok).toBe(true);
    const result = await importElloha(db, 1, CSV, false, NOW);
    expect(result.imported).toBe(2);
    expect(result.conflicts).toBe(1); // le Domaine 20-22/11 est bloqué par la Scierie
    const domaine = result.rows.find((r) => r.line === 4);
    expect(domaine?.status).toBe("conflit");
    // et la résa directe est intacte
    if (direct.ok) {
      const ref = (await listBookings(db, { status: "confirmed" })).find((b) => b.unitId === 2 && b.source === "direct");
      expect(ref).toBeDefined();
      expect(await getBookingByReference(db, ref!.reference)).not.toBeNull();
    }
  });
});
