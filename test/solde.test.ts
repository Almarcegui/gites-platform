// Issues #67 et #69 — le solde : payable en libre-service par le client,
// relançable en un clic côté propriétaire, et sessions de paiement mortes
// nettoyées automatiquement.
//
// La définition de fini des deux issues tient en quatre preuves, et ce sont les
// quatre premiers tests : le parcours complet acompte → solde → « soldé », le
// non-double-crédit sur rejeu, la relance journalisée avec son auteur, et la
// session abandonnée qui cesse d'apparaître « en attente ».
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, sqlNow, todayInZone } from "../src/core/dates";
import { PAYMENT_SESSION_TTL_MINUTES, runScheduled } from "../src/services/cron";
import { handlePaymentSuccess } from "../src/services/booking-flow";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "test-admin-token";
const NOW = new Date("2026-08-10T09:00:00Z");
const CHECKIN = addDays(todayInZone(NOW), 120);
const CHECKOUT = addDays(CHECKIN, 7);
const GUEST = { firstName: "Camille", lastName: "Testeur", email: "camille.testeur@example.com", phone: "+32 470 00 00 00" };

let t: TestDb;
let db: D1Database;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  env = {
    DB: db,
    ASSETS: undefined as unknown as Fetcher,
    PUBLIC_BASE_URL: "http://test.local",
    EMAILS_ENABLED: "false",
    ADMIN_TOKEN: ADMIN,
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

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const auth = path.startsWith("/api/admin") ? { authorization: `Bearer ${ADMIN}` } : {};
  const req = new Request(`http://test.local${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...auth } : { ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await router.handle(req, env);
  if (!res) throw new Error(`route non matchée : ${method} ${path}`);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

const sessionOf = (checkoutUrl: unknown) => new URL(String(checkoutUrl)).searchParams.get("session")!;

/** Réservation directe (unité 2 — La Scierie) payée à l'acompte : l'état
 *  exact dans lequel un client ouvre son voucher pour régler le solde. */
async function bookAndPayDeposit(): Promise<{ reference: string; bookingId: number; depositCents: number }> {
  const created = await call("POST", "/api/public/bookings", {
    unitId: 2,
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 4,
    children: 0,
    paymentMode: "deposit",
    cgvAccepted: true,
    guest: GUEST,
  });
  expect(created.status).toBe(201);
  const reference = String(created.data.reference);
  await call("POST", "/api/public/dev-pay/confirm", { session: sessionOf(created.data.checkoutUrl) });
  const row = await db.prepare("SELECT id FROM bookings WHERE reference = ?1").bind(reference).first<{ id: number }>();
  return { reference, bookingId: row!.id, depositCents: Number(created.data.amountDueCents) };
}

const voucher = (reference: string, email = GUEST.email) =>
  call("GET", `/api/public/bookings/${reference}?email=${encodeURIComponent(email)}`);

describe("issue #67 — le client paie son solde depuis le voucher", () => {
  it("parcours complet : acompte → solde → réservation soldée", async () => {
    const { reference, depositCents } = await bookAndPayDeposit();

    // Après l'acompte : confirmée, un solde ouvert, l'échéance annoncée.
    const afterDeposit = (await voucher(reference)).data.booking as Record<string, number | string>;
    expect(afterDeposit.status).toBe("confirmed");
    expect(afterDeposit.paidCents).toBe(depositCents);
    const balanceCents = afterDeposit.balanceCents as number;
    expect(balanceCents).toBeGreaterThan(0);
    expect(Number(afterDeposit.paidCents) + balanceCents).toBe(afterDeposit.totalCents);

    // Le bouton « Payer le solde » ouvre une session pour le montant restant…
    const pay = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    expect(pay.status).toBe(200);
    expect(pay.data.kind).toBe("balance");
    expect(pay.data.amountCents).toBe(balanceCents);
    expect(String(pay.data.checkoutUrl)).toContain("/book/dev-pay.html?session=");

    // …et le retour de paiement renvoie sur le VOUCHER, pas sur merci.html :
    // la réservation était déjà confirmée, il n'y a rien à « confirmer ».
    const paid = await call("POST", "/api/public/dev-pay/confirm", { session: sessionOf(pay.data.checkoutUrl) });
    expect(paid.status).toBe(200);
    expect(String(paid.data.redirect)).toContain("/book/voucher.html?ref=");

    // Voucher soldé.
    const after = (await voucher(reference)).data.booking as Record<string, number | string>;
    expect(after.balanceCents).toBe(0);
    expect(after.paidCents).toBe(after.totalCents);

    // Reçu de paiement du solde journalisé (canal email existant, mode stub).
    const emails = (await call("GET", "/api/admin/email-log")).data.emails as { kind: string; status: string }[];
    expect(emails.filter((e) => e.kind === "payment_receipt")).toHaveLength(2); // arrhes + solde

    // Plus rien à payer : le bouton disparaît côté serveur aussi.
    const again = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    expect(again.status).toBe(400);
  });

  it("non-double-crédit : un webhook rejoué n'encaisse le solde qu'une fois", async () => {
    const { reference } = await bookAndPayDeposit();
    const pay = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    const session = sessionOf(pay.data.checkoutUrl);

    await call("POST", "/api/public/dev-pay/confirm", { session });
    const once = (await voucher(reference)).data.booking as Record<string, number>;

    // Rejeu du même chemin, deux fois : Stripe retente jusqu'à 3 jours.
    await call("POST", "/api/public/dev-pay/confirm", { session });
    await handlePaymentSuccess(db, env, session, "pi_stub");

    const twice = (await voucher(reference)).data.booking as Record<string, number>;
    expect(twice.paidCents).toBe(once.paidCents);
    expect(twice.paidCents).toBe(twice.totalCents);
    expect(twice.balanceCents).toBe(0);

    // Un seul paiement de solde en base, un seul reçu envoyé.
    const rows = await db
      .prepare("SELECT status FROM payments WHERE stripe_session_id = ?1")
      .bind(session)
      .all<{ status: string }>();
    expect(rows.results).toHaveLength(1);
    const receipts = await db
      .prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'payment_receipt'")
      .first<{ n: number }>();
    expect(receipts?.n).toBe(2); // arrhes + solde, pas trois
  });

  it("garde l'authentification du voucher : référence seule ne suffit pas", async () => {
    const { reference } = await bookAndPayDeposit();
    expect((await call("POST", `/api/public/bookings/${reference}/pay`, { email: "autre@example.com" })).status).toBe(404);
    expect((await call("POST", `/api/public/bookings/${reference}/pay`, {})).status).toBe(404);
  });

  it("une nouvelle demande de paiement solde la session précédente", async () => {
    const { reference, bookingId } = await bookAndPayDeposit();
    await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    const rows = await db
      .prepare("SELECT status, kind FROM payments WHERE booking_id = ?1 ORDER BY id")
      .bind(bookingId)
      .all<{ status: string; kind: string }>();
    // arrhes encaissées, 1re session de solde fermée, 2e en attente
    expect(rows.results.map((r) => `${r.kind}:${r.status}`)).toEqual([
      "deposit:succeeded",
      "balance:failed",
      "balance:pending",
    ]);
    // …et la fermée porte sa raison : dans l'admin, elle ne doit pas se lire
    // comme un refus de carte.
    const payments = (await call("GET", "/api/admin/payments")).data.payments as { outcome: string | null }[];
    expect(payments.filter((p) => p.outcome === "superseded")).toHaveLength(1);
  });
});

describe("issue #69 — relance du solde et sessions expirées", () => {
  it("« Relancer le solde » : email journalisé + trace d'historique avec son auteur", async () => {
    const { reference, bookingId } = await bookAndPayDeposit();

    const res = await call("POST", `/api/admin/bookings/${bookingId}/balance-reminder`);
    expect(res.status).toBe(200);
    expect(res.data.balanceCents).toBeGreaterThan(0);
    // Le lien transmis est celui du voucher : il ne périme pas, contrairement
    // à une session de checkout.
    expect(String(res.data.payUrl)).toContain(`/book/voucher.html?ref=${reference}`);

    // 1. Journalisée dans le canal email existant.
    const mail = await db
      .prepare("SELECT to_email, body_text, status FROM email_log WHERE booking_id = ?1 AND kind = 'balance_reminder'")
      .bind(bookingId)
      .first<{ to_email: string; body_text: string; status: string }>();
    expect(mail?.to_email).toBe(GUEST.email);
    expect(mail?.status).toBe("stub"); // aucun envoi réel sans clé
    expect(mail?.body_text).toContain(String(res.data.payUrl));

    // 2. Visible dans l'historique de la fiche, avec sa date et son auteur.
    const fiche = await call("GET", `/api/admin/bookings/${bookingId}`);
    const history = fiche.data.history as { action: string; detail: string | null; createdAt: string }[];
    const relance = history.find((h) => h.action === "email.balance_reminder");
    expect(relance).toBeTruthy();
    expect(relance!.createdAt).toBeTruthy();
    expect(JSON.parse(relance!.detail ?? "{}").par).toBe("admin"); // ADMIN_TOKEN nu → identité de secours

    // 3. Aucune session de paiement « en attente » créée par la relance.
    const pendings = await db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?1 AND status = 'pending'")
      .bind(bookingId)
      .first<{ n: number }>();
    expect(pendings?.n).toBe(0);
  });

  it("refuse de relancer une réservation soldée, non confirmée ou sans email", async () => {
    const { reference, bookingId } = await bookAndPayDeposit();
    const pay = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    await call("POST", "/api/public/dev-pay/confirm", { session: sessionOf(pay.data.checkoutUrl) });
    expect((await call("POST", `/api/admin/bookings/${bookingId}/balance-reminder`)).status).toBe(400);

    await db.prepare("UPDATE bookings SET status = 'pending' WHERE id = ?1").bind(bookingId).run();
    expect((await call("POST", `/api/admin/bookings/${bookingId}/balance-reminder`)).status).toBe(400);
    expect((await call("POST", "/api/admin/bookings/999999/balance-reminder")).status).toBe(404);
  });

  it("une relance manuelle dispense le cron de son rappel automatique", async () => {
    const { bookingId } = await bookAndPayDeposit();
    // Échéance dépassée : sans la relance manuelle, le cron enverrait le sien.
    await db
      .prepare("UPDATE bookings SET balance_due_date = ?2 WHERE id = ?1")
      .bind(bookingId, todayInZone(NOW))
      .run();

    await call("POST", `/api/admin/bookings/${bookingId}/balance-reminder`);
    await runScheduled(env, NOW, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);

    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM email_log WHERE booking_id = ?1 AND kind = 'balance_reminder'")
      .bind(bookingId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("session de paiement abandonnée : marquée expirée par le cron, plus « en attente »", async () => {
    const { reference, bookingId } = await bookAndPayDeposit();
    const pay = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    const session = sessionOf(pay.data.checkoutUrl);

    // Le client ferme l'onglet. On vieillit la session au-delà de sa durée de vie.
    const old = sqlNow(new Date(NOW.getTime() - (PAYMENT_SESSION_TTL_MINUTES + 10) * 60_000));
    await db.prepare("UPDATE payments SET created_at = ?2 WHERE stripe_session_id = ?1").bind(session, old).run();

    const before = (await call("GET", "/api/admin/payments")).data.payments as { status: string; outcome: string | null }[];
    expect(before.filter((p) => p.status === "pending")).toHaveLength(1);

    await runScheduled(env, NOW, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);

    const after = (await call("GET", "/api/admin/payments")).data.payments as { status: string; outcome: string | null }[];
    expect(after.filter((p) => p.status === "pending")).toHaveLength(0);
    expect(after.filter((p) => p.outcome === "expired")).toHaveLength(1);

    // Tracée sur la fiche réservation, comme le fait le webhook Stripe.
    const fiche = await call("GET", `/api/admin/bookings/${bookingId}`);
    const history = fiche.data.history as { action: string }[];
    expect(history.some((h) => h.action === "payment.expired")).toBe(true);

    // Un second passage ne rejournalise rien : seules les lignes RÉELLEMENT
    // modifiées sont journalisées (`meta.changes`), sinon un webhook qui
    // aboutit entre le SELECT et l'UPDATE ferait écrire un « expiré » faux.
    await runScheduled(env, NOW, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    const expiredAudits = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.expired'")
      .first<{ n: number }>();
    expect(expiredAudits?.n).toBe(1);

    // Le solde reste payable : un nouveau clic ouvre une session fraîche.
    expect((await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email })).status).toBe(200);
  });

  it("un webhook tardif sur une session expirée reste honoré, sans double crédit", async () => {
    const { reference } = await bookAndPayDeposit();
    const pay = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    const session = sessionOf(pay.data.checkoutUrl);
    const old = sqlNow(new Date(NOW.getTime() - (PAYMENT_SESSION_TTL_MINUTES + 10) * 60_000));
    await db.prepare("UPDATE payments SET created_at = ?2 WHERE stripe_session_id = ?1").bind(session, old).run();
    await runScheduled(env, NOW, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);

    // Le client avait bel et bien payé : Stripe finit par nous le dire.
    await handlePaymentSuccess(db, env, session, "pi_stub");
    const once = (await voucher(reference)).data.booking as Record<string, number>;
    expect(once.balanceCents).toBe(0);

    // Et un second passage ne recrédite rien.
    await handlePaymentSuccess(db, env, session, "pi_stub");
    const twice = (await voucher(reference)).data.booking as Record<string, number>;
    expect(twice.paidCents).toBe(once.paidCents);
  });

  it("deux sessions pour le même solde : la première est fermée, et un paiement dessus ne passe pas inaperçu", async () => {
    // Le scénario multi-onglets : le client clique deux fois « Payer le solde ».
    const { reference, bookingId } = await bookAndPayDeposit();
    const first = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    const second = await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email });
    const s1 = sessionOf(first.data.checkoutUrl);
    const s2 = sessionOf(second.data.checkoutUrl);
    expect(s1).not.toBe(s2);

    // 1. La première session est fermée dès l'ouverture de la seconde. En
    //    production, `checkout/sessions/{id}/expire` la ferme AUSSI chez
    //    Stripe — c'est ça qui empêche réellement le second paiement ; en mode
    //    stub il n'y a pas de session distante, seul l'état local est visible.
    const p1 = await db
      .prepare("SELECT status, note FROM payments WHERE stripe_session_id = ?1")
      .bind(s1)
      .first<{ status: string; note: string | null }>();
    expect(p1?.status).toBe("failed");
    expect(p1?.note).toBe("session remplacée par une nouvelle");
    // Le simulateur refuse d'ailleurs de rejouer une session fermée sans bruit.
    expect((await call("GET", `/api/public/dev-pay/info?session=${encodeURIComponent(s1)}`)).data.status).toBe("failed");

    // 2. Le client paie la seconde : la réservation est soldée, pile.
    await call("POST", "/api/public/dev-pay/confirm", { session: s2 });
    const soldee = (await voucher(reference)).data.booking as Record<string, number>;
    expect(soldee.balanceCents).toBe(0);
    expect(soldee.overpaidCents).toBe(0);

    // 3. Filet de sécurité : si la première aboutissait malgré tout (course
    //    entre le paiement et l'expiration), l'argent est encaissé — mais le
    //    trop-perçu est CRIÉ, pas avalé.
    await handlePaymentSuccess(db, env, s1, "pi_stub");
    const trop = (await voucher(reference)).data.booking as Record<string, number>;
    expect(trop.paidCents).toBeGreaterThan(trop.totalCents);
    expect(trop.overpaidCents).toBeGreaterThan(0);
    expect(trop.balanceCents).toBe(0);

    const audits = await db
      .prepare("SELECT action FROM audit_log WHERE entity = ?1")
      .bind(`booking:${bookingId}`)
      .all<{ action: string }>();
    expect(audits.results.map((a) => a.action)).toContain("payment.overpaid");

    // …et remonté dans la carte « Santé » du tableau de bord, pas seulement
    // dans un journal que personne ne lit.
    const health = (await call("GET", "/api/admin/overview?property=1")).data.health as {
      ok: boolean;
      overpaidBookings: { reference: string; overpaidCents: number }[];
    };
    expect(health.ok).toBe(false);
    expect(health.overpaidBookings.map((o) => o.reference)).toContain(reference);
    expect(health.overpaidBookings[0]!.overpaidCents).toBeGreaterThan(0);
  });

  it("le nettoyage ne touche pas les encaissements manuels ni les sessions récentes", async () => {
    const { reference, bookingId } = await bookAndPayDeposit();
    await call("POST", `/api/public/bookings/${reference}/pay`, { email: GUEST.email }); // session fraîche
    await call("POST", `/api/admin/bookings/${bookingId}/payments`, {
      kind: "manual",
      method: "transfer",
      amountCents: 1000,
      note: "virement reçu",
    });

    await runScheduled(env, NOW, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);

    const rows = await db
      .prepare("SELECT status, method FROM payments WHERE booking_id = ?1 ORDER BY id")
      .bind(bookingId)
      .all<{ status: string; method: string }>();
    expect(rows.results.map((r) => `${r.method}:${r.status}`)).toEqual([
      "stripe:succeeded", // arrhes
      "stripe:pending", // session de moins de 35 min : intacte
      "transfer:succeeded", // encaissement manuel : jamais concerné
    ]);
  });
});
