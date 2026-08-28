// Issue #68 — reprendre une réservation en cours au lieu d'enfermer le client.
//
// Le blocage de créneau est posé AVANT le paiement. Un retour arrière depuis
// Stripe, et le même client qui relançait sa recherche se voyait refuser SES
// propres dates pendant 30 minutes. Le serveur le reconnaît désormais à un
// cookie signé et lui rend son hold.
//
// Ce qui est vérifié ici : le scénario de l'issue de bout en bout (dates →
// coordonnées → retour → même recherche → dates libres, devis identique, hold
// réutilisé), la libération de l'ancien hold quand le client change de dates,
// la neutralité vis-à-vis du plafond anti-abus (#6), et le fait qu'un cookie
// forgé ne donne accès à rien.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";

const router = new Router();
registerPublicRoutes(router);

let t: TestDb;
let db: D1Database;
let env: Env;

const CHECKIN = addDays(todayInZone(), 120);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = {
  firstName: "Camille",
  lastName: "Martin",
  email: "camille.martin@example.test",
  phone: "+32 470 11 22 33",
};

interface Call {
  status: number;
  data: Record<string, unknown>;
  cookie: string | null;
}

async function call(method: string, path: string, body?: unknown, cookie?: string | null): Promise<Call> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  const res = await router.handle(
    new Request(`http://test.local${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
  );
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    data: (await res.json()) as Record<string, unknown>,
    // On ne garde que la paire nom=valeur, comme le ferait un navigateur.
    cookie: setCookie ? (setCookie.split(";")[0] as string) : null,
  };
}

function bookingBody(over: Record<string, unknown> = {}) {
  return {
    unitId: 1,
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 4,
    children: 0,
    paymentMode: "deposit",
    guest: GUEST,
    cgvAccepted: true,
    ...over,
  };
}

const availability = (checkin: string, checkout: string, cookie?: string | null) =>
  call("GET", `/api/public/availability?property=pre-more&checkin=${checkin}&checkout=${checkout}&adults=4`, undefined, cookie);

const unit1 = (data: Record<string, unknown>) =>
  (data.units as { unitId: number; available: boolean; quote: { ok: boolean } | null }[]).find((u) => u.unitId === 1)!;

const countBookings = async (): Promise<number> =>
  (await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>())?.n ?? 0;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    // La signature du cookie de session dérive de ce secret (cf. hold-session).
    ADMIN_TOKEN: "test:token-de-signature",
  } as Env;
});
afterAll(async () => {
  await t.dispose();
});
beforeEach(async () => {
  for (const table of ["payments", "email_log", "audit_log", "bookings", "guests"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** Pose un hold et rend le cookie de session que le navigateur garderait. */
async function poserHold(over: Record<string, unknown> = {}): Promise<Call> {
  const res = await call("POST", "/api/public/bookings", bookingBody(over));
  expect(res.status).toBe(201);
  expect(res.cookie).toBeTruthy();
  return res;
}

describe("scénario de l'issue : retour à l'accueil puis même recherche (#68)", () => {
  it("les dates du client lui restent disponibles, avec son hold et son devis", async () => {
    const hold = await poserHold();

    // Sans cookie (autre visiteur) : le créneau est bien gelé.
    const autre = await availability(CHECKIN, CHECKOUT);
    expect(unit1(autre.data).available).toBe(false);

    // Avec son cookie : le client retrouve SES dates, et la recherche le dit.
    const sien = await availability(CHECKIN, CHECKOUT, hold.cookie);
    expect(unit1(sien.data).available).toBe(true);
    expect(unit1(sien.data).quote?.ok).toBe(true);
    expect((sien.data.ownHold as { reference: string }).reference).toBe(hold.data.reference);
  });

  it("le tunnel retrouve la réservation en cours et son devis exact", async () => {
    const hold = await poserHold();
    const { status, data } = await call("GET", "/api/public/hold?property=pre-more", undefined, hold.cookie);
    expect(status).toBe(200);
    const h = data.hold as Record<string, unknown>;
    expect(h.reference).toBe(hold.data.reference);
    expect(h.checkin).toBe(CHECKIN);
    expect(h.checkout).toBe(CHECKOUT);
    expect(h.unitSlug).toBe("maison-du-scieur");
    // Le devis rechargé est celui qui a été bloqué, au centime près.
    const stored = await db.prepare("SELECT quote_json FROM bookings WHERE reference = ?1").bind(hold.data.reference).first<{ quote_json: string }>();
    expect(h.quote).toEqual(JSON.parse(stored!.quote_json));
  });

  it("relancer la même réservation REPREND le hold : aucune ligne créée, même référence", async () => {
    const hold = await poserHold();
    const avant = await countBookings();

    const reprise = await call("POST", "/api/public/bookings", bookingBody(), hold.cookie);
    expect(reprise.status).toBe(200);
    expect(reprise.data.resumed).toBe(true);
    expect(reprise.data.reference).toBe(hold.data.reference);
    expect(reprise.data.amountDueCents).toBe(hold.data.amountDueCents);
    expect(reprise.data.holdExpiresAt).toBe(hold.data.holdExpiresAt);
    expect(await countBookings()).toBe(avant);

    // Un lien de paiement neuf est fourni ; l'ancien est soldé.
    expect(String(reprise.data.checkoutUrl)).toContain("http");
    const pendings = await db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'")
      .first<{ n: number }>();
    expect(pendings?.n).toBe(1);
  });
});

describe("changement de dates : l'ancien hold est libéré (#68)", () => {
  it("le client qui décale son séjour n'est pas bloqué par son propre créneau", async () => {
    const hold = await poserHold();
    const nouveauDebut = addDays(CHECKIN, 3); // chevauche l'ancien séjour

    const res = await call(
      "POST",
      "/api/public/bookings",
      bookingBody({ checkin: nouveauDebut, checkout: addDays(nouveauDebut, 7) }),
      hold.cookie,
    );
    expect(res.status).toBe(201);
    expect(res.data.reference).not.toBe(hold.data.reference);

    const ancien = await db
      .prepare("SELECT status, cancel_reason FROM bookings WHERE reference = ?1")
      .bind(hold.data.reference)
      .first<{ status: string; cancel_reason: string }>();
    expect(ancien?.status).toBe("cancelled");
    expect(ancien?.cancel_reason).toBe("hold_replaced");
  });

  it("un hébergement différent aux mêmes dates libère aussi l'ancien hold", async () => {
    const hold = await poserHold();
    const res = await call("POST", "/api/public/bookings", bookingBody({ unitId: 2 }), hold.cookie);
    expect(res.status).toBe(201);
    const ancien = await db
      .prepare("SELECT status FROM bookings WHERE reference = ?1")
      .bind(hold.data.reference)
      .first<{ status: string }>();
    expect(ancien?.status).toBe("cancelled");
  });
});

describe("neutralité vis-à-vis du plafond anti-abus (#6 / #68)", () => {
  it("une reprise ne consomme pas de hold supplémentaire", async () => {
    // Deux holds sur d'autres dates, puis celui qu'on reprendra : 3 au total,
    // soit exactement le plafond MAX_ACTIVE_HOLDS.
    for (const decalage of [30, 60]) {
      const res = await call(
        "POST",
        "/api/public/bookings",
        bookingBody({ checkin: addDays(CHECKIN, decalage), checkout: addDays(CHECKIN, decalage + 7) }),
      );
      expect(res.status).toBe(201);
    }
    const hold = await poserHold();

    // Une 4e réservation serait refusée…
    const trop = await call(
      "POST",
      "/api/public/bookings",
      bookingBody({ checkin: addDays(CHECKIN, 90), checkout: addDays(CHECKIN, 97) }),
    );
    expect(trop.status).toBe(429);

    // …mais reprendre la sienne passe, puisque rien de neuf n'est créé.
    const reprise = await call("POST", "/api/public/bookings", bookingBody(), hold.cookie);
    expect(reprise.status).toBe(200);
    expect(reprise.data.resumed).toBe(true);
  });
});

describe("la reprise reste bornée (#68)", () => {
  it("une boucle de reprises finit en 429 : pas de sessions de paiement à l'infini", async () => {
    const hold = await poserHold();
    let dernier = 200;
    // La création a déjà consommé une tentative ; le plafond est de 10.
    for (let i = 0; i < 12 && dernier === 200; i += 1) {
      dernier = (await call("POST", "/api/public/bookings", bookingBody(), hold.cookie)).status;
    }
    expect(dernier).toBe(429);
    const paiements = await db.prepare("SELECT COUNT(*) AS n FROM payments").first<{ n: number }>();
    expect(paiements?.n).toBeLessThanOrEqual(10);
    // Le hold n'est pas perdu pour autant : il court toujours.
    const encore = await db
      .prepare("SELECT status FROM bookings WHERE reference = ?1")
      .bind(hold.data.reference)
      .first<{ status: string }>();
    expect(encore?.status).toBe("pending");
  });
});

describe("le cookie de session ne se devine pas (#68)", () => {
  it("une signature forgée ne donne ni la disponibilité, ni la réservation", async () => {
    const hold = await poserHold();
    const reference = String(hold.data.reference);
    const forge = `gp_hold=${reference}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    const cherche = await availability(CHECKIN, CHECKOUT, forge);
    expect(unit1(cherche.data).available).toBe(false);

    const lecture = await call("GET", "/api/public/hold", undefined, forge);
    expect(lecture.data.hold).toBeNull();

    // Et la reprise n'a pas lieu : une nouvelle réservation serait tentée puis
    // refusée par l'INSERT atomique, le créneau étant tenu par le vrai client.
    const vol = await call("POST", "/api/public/bookings", bookingBody({ guest: { ...GUEST, email: "pirate@example.test" } }), forge);
    expect(vol.status).toBe(409);
  });

  it("sans ADMIN_TOKEN, la reprise est simplement désactivée (fail-closed)", async () => {
    const sansSecret = { ...env, ADMIN_TOKEN: undefined } as Env;
    const res = await router.handle(
      new Request("http://test.local/api/public/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookingBody()),
      }),
      sansSecret,
    );
    expect(res?.status).toBe(201);
    expect(res?.headers.get("set-cookie")).toBeNull();
  });
});

describe("le tunnel reprend l'étape en cours (#68)", () => {
  const JS = readFileSync(fileURLToPath(new URL("../public/book/book.js", import.meta.url)), "utf8");

  it("le chargement interroge le serveur et rouvre le bon hébergement", () => {
    expect(JS).toMatch(/\/api\/public\/hold/);
    expect(JS).toMatch(/function restoreOwnHold/);
    expect(JS).toMatch(/preferredUnit = hold\.unitSlug/);
    expect(JS).toMatch(/rememberHold\(\{ reference: hold\.reference/);
  });
});
