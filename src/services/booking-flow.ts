// Flux de réservation partagé entre l'API publique, l'admin (vente manuelle,
// lien de paiement) et les callbacks de paiement (webhook Stripe / stub).

import { sqlNow, type IsoDate } from "../core/dates";
import { computeQuote, type Quote } from "../core/pricing";
import {
  addPayment,
  audit,
  confirmBookingAtomic,
  findPaymentBySession,
  getBooking,
  getProperty,
  getSettings,
  incrementPromoUse,
  markPaymentStatus,
  setPaymentSession,
  type BookingRow,
  type QuoteContext,
} from "../db/repo";
import { buildVoucherEmail, queueEmail } from "./email";
import { createCheckoutSession } from "./stripe";

export interface QuoteBody {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  options?: { id: number; qty: number }[];
  promoCode?: string | null;
}

/** Construit le devis à partir du contexte D1 (sélection d'options validée
 *  contre le référentiel — un id inconnu ou inactif est ignoré). */
export function quoteFromContext(ctx: QuoteContext, body: QuoteBody, today: IsoDate): Quote {
  const selected = (body.options ?? [])
    .map((sel) => {
      const opt = ctx.options.find((o) => o.id === Number(sel.id));
      return opt ? { option: opt, qty: Number(sel.qty) || 0 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return computeQuote({
    unit: ctx.pricingUnit,
    checkin: body.checkin,
    checkout: body.checkout,
    adults: body.adults,
    children: body.children,
    today,
    seasons: ctx.seasons,
    rateRules: ctx.rateRules,
    promotions: ctx.promotions,
    promoCode: body.promoCode ?? null,
    optionsSelected: selected,
    settings: {
      depositPct: ctx.settings.depositPct,
      balanceDueDays: ctx.settings.balanceDueDays,
      touristTaxCentsPerPersonNight: ctx.settings.touristTaxCentsPerPersonNight,
      touristTaxIncludeChildren: ctx.settings.touristTaxIncludeChildren,
      cautionCents: ctx.settings.cautionCents,
    },
  });
}

/** Crée un paiement en attente + une session Stripe Checkout (ou stub) et
 *  mémorise l'id de session pour la réconciliation webhook. */
export async function startCheckout(
  db: D1Database,
  env: Env,
  booking: BookingRow,
  kind: "deposit" | "full" | "balance",
  amountCents: number,
  actor: "public" | "admin",
): Promise<{ url: string; paymentId: number }> {
  const paymentId = await addPayment(db, {
    bookingId: booking.id,
    kind,
    method: "stripe",
    amountCents,
    status: "pending",
  });
  const labelKind = kind === "deposit" ? "Arrhes" : kind === "balance" ? "Solde" : "Paiement";
  const label = `${labelKind} réservation ${booking.reference}${booking.unitName ? ` — ${booking.unitName}` : ""}`;
  const base = env.PUBLIC_BASE_URL;
  const emailParam = booking.guestEmail ? `&email=${encodeURIComponent(booking.guestEmail)}` : "";
  const session = await createCheckoutSession(env, {
    paymentId,
    reference: booking.reference,
    label,
    amountCents,
    customerEmail: booking.guestEmail ?? null,
    successUrl: `${base}/book/merci.html?ref=${encodeURIComponent(booking.reference)}${emailParam}`,
    cancelUrl: `${base}/book/annule.html?ref=${encodeURIComponent(booking.reference)}${emailParam}`,
  });
  await setPaymentSession(db, paymentId, session.id);
  await audit(db, actor, "payment.link_created", `booking:${booking.id}`, { kind, amountCents, session: session.id });
  return { url: session.url, paymentId };
}

/** Chemin commun webhook Stripe / simulateur stub. Idempotent : un même
 *  session_id traité deux fois ne confirme et n'envoie le voucher qu'une fois. */
export async function handlePaymentSuccess(
  db: D1Database,
  env: Env,
  sessionId: string,
  paymentIntent?: string | null,
): Promise<{ handled: boolean; bookingId?: number; reference?: string }> {
  const payment = await findPaymentBySession(db, sessionId);
  if (!payment) return { handled: false };
  const bookingBefore = await getBooking(db, payment.bookingId);
  if (payment.status === "succeeded") {
    return { handled: true, bookingId: payment.bookingId, reference: bookingBefore?.reference };
  }
  await markPaymentStatus(db, payment.id, "succeeded", {
    receivedAt: sqlNow(),
    stripePaymentIntent: paymentIntent ?? null,
  });
  const booking = await getBooking(db, payment.bookingId);
  if (!booking) return { handled: true, bookingId: payment.bookingId };

  if (booking.status === "pending") {
    const outcome = await confirmBookingAtomic(db, booking.id);
    if (outcome === "confirmed") {
      if (booking.promoCode && booking.propertyId != null) {
        await incrementPromoUse(db, booking.propertyId, booking.promoCode);
      }
      await audit(db, "stripe", "booking.confirmed", `booking:${booking.id}`, { sessionId, kind: payment.kind });
      // Un voucher qui casse ne doit jamais faire échouer le webhook : au retry,
      // Stripe retomberait sur un paiement déjà 'succeeded' et sortirait sans
      // jamais réessayer l'envoi. On journalise et on laisse la résa confirmée
      // (bouton « Renvoyer le voucher » disponible au back-office).
      try {
        await sendVoucher(db, env, booking.id);
      } catch (e) {
        await audit(db, "stripe", "voucher.error", `booking:${booking.id}`, {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      // Le créneau a été repris pendant que le client payait (hold expiré +
      // webhook Stripe tardif — Stripe retente jusqu'à 3 jours). Argent
      // encaissé, séjour impossible : alerte, pas une ligne de journal noyée.
      await audit(db, "stripe", "payment.orphaned", `booking:${booking.id}`, {
        sessionId,
        kind: payment.kind,
        outcome,
        reason: outcome === "conflict" ? "créneau repris pendant le paiement" : "réservation plus en attente",
      });
    }
  } else if (booking.status === "confirmed") {
    await audit(db, "stripe", "payment.received", `booking:${booking.id}`, { sessionId, kind: payment.kind });
    const after = await getBooking(db, booking.id);
    if (after && after.paidCents > after.totalCents) {
      await audit(db, "stripe", "payment.overpaid", `booking:${booking.id}`, {
        sessionId,
        paidCents: after.paidCents,
        totalCents: after.totalCents,
      });
    }
  } else {
    // Résa annulée (hold expiré par le cron, annulation manuelle) et pourtant
    // payée : même gravité que ci-dessus.
    await audit(db, "stripe", "payment.orphaned", `booking:${booking.id}`, {
      sessionId,
      kind: payment.kind,
      outcome: booking.status,
      reason: "paiement reçu sur une réservation annulée",
    });
  }
  return { handled: true, bookingId: booking.id, reference: booking.reference };
}

/** Génère et journalise (ou envoie, si activé) le voucher de confirmation. */
export async function sendVoucher(db: D1Database, env: Env, bookingId: number): Promise<boolean> {
  const booking = await getBooking(db, bookingId);
  if (!booking || !booking.guestEmail || booking.propertyId == null) return false;
  const property = await getProperty(db, booking.propertyId);
  if (!property) return false;
  const settings = await getSettings(db, booking.propertyId);
  const voucherUrl = `${env.PUBLIC_BASE_URL}/book/voucher.html?ref=${encodeURIComponent(booking.reference)}&email=${encodeURIComponent(booking.guestEmail)}`;
  const email = buildVoucherEmail({ booking, property, settings, voucherUrl });
  await queueEmail(db, env, {
    bookingId: booking.id,
    to: booking.guestEmail,
    subject: email.subject,
    bodyText: email.bodyText,
    kind: "voucher",
  });
  return true;
}
