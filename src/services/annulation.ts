// Annulation d'une réservation et sort de l'argent (CGV v3, articles 4 et 5).
//
// Règle (décision de Julien, 12/10/2026) :
//  - le LOCATAIRE annule : les arrhes restent acquises au propriétaire (5.2) ;
//    ce qui a été payé au-delà des arrhes (le solde) est remboursé dans les
//    14 jours, par Stripe quand il a été payé par Stripe ;
//  - le PROPRIÉTAIRE annule : le locataire reçoit le double des arrhes (5.3,
//    art. 1590 de l'ancien Code civil) — tout ce qu'il a payé lui est rendu
//    (Stripe), plus une indemnité égale aux arrhes. L'indemnité ne passe PAS par
//    Stripe (un remboursement ne peut dépasser l'encaissé) : elle est signalée
//    comme virement à faire à la main ;
//  - option non payée : rien à rembourser ;
//  - réservation d'un canal (Airbnb, Booking) ou importée : aucun mouvement
//    d'argent par nous.
//
// Ce fichier calcule le plan (pur : lit la base, n'écrit rien) puis exécute les
// remboursements Stripe. Les montants sont des cents entiers, jamais d'arrondi.

import { sqlNow } from "../core/dates";
import { addPayment, audit, listPayments, markPaymentStatus, type BookingRow, type PaymentRow } from "../db/repo";
import { createRefund, paymentIntentRefundedCents, stripeEnabled, type StripeConfig } from "./stripe";

export type AnnulationPar = "locataire" | "proprietaire";

export interface StripeRefundLine {
  /** Paiement d'origine (payments.id) et son PaymentIntent. */
  paymentId: number;
  paymentIntent: string;
  amountCents: number;
}

export interface CancellationPlan {
  par: AnnulationPar;
  mode: "canal" | "sans_paiement" | "arrhes";
  /** Net déjà payé (paiements réussis moins remboursements déjà faits). */
  paidCents: number;
  /** Arrhes de la réservation (bookings.deposit_cents). */
  arrhesCents: number;
  /** Arrhes conservées par le propriétaire (annulation du locataire). */
  keptCents: number;
  /** Total à rendre sur ce qui a été payé = Stripe + à la main. */
  refundCents: number;
  /** Part rendue par Stripe, ligne par paiement d'origine. */
  stripeRefunds: StripeRefundLine[];
  stripeRefundCents: number;
  /** Part à rendre à la main (virement/espèces payés, ou Stripe sans clé). */
  manualRefundCents: number;
  /** Indemnité du propriétaire (double des arrhes) : virement à faire à la main. */
  indemnityCents: number;
  note: string;
}

const isStripeChannel = (b: BookingRow) => b.source === "ical" || b.source === "import";

/** Calcule le plan d'annulation. N'écrit rien. */
export async function planCancellation(
  db: D1Database,
  cfg: StripeConfig,
  booking: BookingRow,
  par: AnnulationPar,
): Promise<CancellationPlan> {
  const base = {
    par, paidCents: 0, arrhesCents: booking.depositCents, keptCents: 0, refundCents: 0,
    stripeRefunds: [] as StripeRefundLine[], stripeRefundCents: 0, manualRefundCents: 0, indemnityCents: 0,
  };
  if (isStripeChannel(booking)) {
    const canal = booking.channelLabel ?? (booking.source === "import" ? "l'ancien système" : "le canal");
    return {
      ...base, mode: "canal",
      note: `Réservation venue de ${canal} : aucun mouvement d'argent de notre part. Remboursement et indemnité éventuels se règlent sur ${canal}.`,
    };
  }

  const payments = await listPayments(db, { bookingId: booking.id });
  const paid = payments.filter((p) => p.status === "succeeded" && p.kind !== "refund" && p.amountCents > 0);
  const paidNet = Math.max(0, booking.paidCents);
  if (paidNet <= 0 || paid.length === 0) {
    return { ...base, mode: "sans_paiement", note: "Rien n'a été payé : rien à rembourser." };
  }

  // Les arrhes que le propriétaire a réellement reçues (jamais plus que le payé).
  const arrhesRecues = Math.min(paidNet, Math.max(0, booking.depositCents));
  const kept = par === "locataire" ? arrhesRecues : 0;
  const refund = paidNet - kept;
  const indemnity = par === "proprietaire" ? arrhesRecues : 0;

  // Déjà rendu par Stripe par PaymentIntent (lignes réussies ET en cours : la
  // ligne en cours réserve sa part, une ligne échouée ne compte pas).
  const refundedByIntent = new Map<string, number>();
  for (const r of payments) {
    if (r.kind === "refund" && (r.status === "succeeded" || r.status === "pending") && r.stripePaymentIntent) {
      refundedByIntent.set(r.stripePaymentIntent, (refundedByIntent.get(r.stripePaymentIntent) ?? 0) + Math.abs(r.amountCents));
    }
  }

  // On rend d'abord les derniers paiements, hors arrhes : les arrhes restent
  // en dernier dans la file, donc intactes pour le locataire.
  const order = [...paid].sort((a, b) => Number(a.kind === "deposit") - Number(b.kind === "deposit") || b.id - a.id);
  let need = refund;
  const stripeLines: StripeRefundLine[] = [];
  let manual = 0;
  for (const p of order) {
    if (need <= 0) break;
    const intent = intentOf(p);
    const already = intent ? (refundedByIntent.get(intent) ?? 0) : 0;
    const room = Math.max(0, p.amountCents - already);
    const take = Math.min(room, need);
    if (take <= 0) continue;
    if (p.method === "stripe" && intent && stripeEnabled(cfg)) {
      stripeLines.push({ paymentId: p.id, paymentIntent: intent, amountCents: take });
      refundedByIntent.set(intent, already + take);
    } else {
      manual += take;
    }
    need -= take;
  }
  manual += need; // reliquat que les plafonds n'ont pas pu placer : à la main, jamais perdu

  const stripeSum = stripeLines.reduce((s, l) => s + l.amountCents, 0);
  return {
    ...base, mode: "arrhes", paidCents: paidNet, keptCents: kept, refundCents: refund,
    stripeRefunds: stripeLines, stripeRefundCents: stripeSum, manualRefundCents: manual, indemnityCents: indemnity,
    note: planNote(par, kept, refund, manual, indemnity),
  };
}

/** PaymentIntent d'un paiement : la colonne dédiée, sinon la référence `pi_…` de session. */
function intentOf(p: PaymentRow): string | null {
  if (p.stripePaymentIntent?.startsWith("pi_")) return p.stripePaymentIntent;
  if (p.stripeSessionId?.startsWith("pi_")) return p.stripeSessionId;
  return null;
}

function planNote(par: AnnulationPar, kept: number, refund: number, manual: number, indemnity: number): string {
  const parts: string[] = [];
  if (par === "locataire") parts.push(`Annulation par le locataire : les arrhes (${eurTxt(kept)}) restent acquises au propriétaire.`);
  else parts.push("Annulation par le propriétaire : tout ce qui a été payé est rendu, plus une indemnité égale aux arrhes (double des arrhes, art. 5.3 des CGV).");
  if (refund > 0) parts.push(`Remboursement de ${eurTxt(refund)} dans les 14 jours.`);
  if (manual > 0) parts.push(`Dont ${eurTxt(manual)} à rendre à la main (paiement hors Stripe ou Stripe non disponible).`);
  if (indemnity > 0) parts.push(`Indemnité de ${eurTxt(indemnity)} à virer à la main : Stripe ne rembourse pas plus que l'encaissé.`);
  return parts.join(" ");
}

function eurTxt(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

export interface RefundOutcome {
  refundPaymentId: number;
  paymentId: number;
  amountCents: number;
  status: "succeeded" | "failed" | "pending";
  stripeRefundId?: string;
  error?: string;
}

/** Exécute les remboursements Stripe du plan. Une ligne `payments` (kind
 *  `refund`, montant NÉGATIF pour que `paid_cents` baisse) est créée `pending`
 *  AVANT l'appel Stripe ; son id fait l'Idempotency-Key. Un échec ne bloque
 *  rien : la ligne passe `failed` et se rejoue (`replayRefund`). */
export async function executeRefunds(
  db: D1Database,
  cfg: StripeConfig,
  booking: BookingRow,
  lines: StripeRefundLine[],
): Promise<RefundOutcome[]> {
  const out: RefundOutcome[] = [];
  for (const l of lines) {
    const rowId = await addPayment(db, {
      bookingId: booking.id, kind: "refund", method: "stripe", amountCents: -l.amountCents, status: "pending",
      stripePaymentIntent: l.paymentIntent, note: `remboursement du paiement #${l.paymentId}`,
    });
    out.push(await runRefund(db, cfg, booking.reference, rowId, l.paymentId, l.paymentIntent, l.amountCents, `gp-refund-${rowId}`));
  }
  return out;
}

async function runRefund(
  db: D1Database, cfg: StripeConfig, reference: string, rowId: number, paymentId: number,
  intent: string, amountCents: number, idempotencyKey: string,
): Promise<RefundOutcome> {
  try {
    const r = await createRefund(cfg, { paymentIntent: intent, amountCents, idempotencyKey, reference });
    // Stripe accepte aussi `pending` (Bancontact) : l'argent est en route, la ligne compte.
    const failed = r.status === "failed" || r.status === "canceled";
    await markPaymentStatus(db, rowId, failed ? "failed" : "succeeded", {
      receivedAt: sqlNow(), note: `remboursement du paiement #${paymentId} — Stripe ${r.id} (${r.status})`,
    });
    return { refundPaymentId: rowId, paymentId, amountCents, status: failed ? "failed" : "succeeded", stripeRefundId: r.id, ...(failed ? { error: `Stripe : ${r.status}` } : {}) };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    await markPaymentStatus(db, rowId, "failed", { note: `remboursement du paiement #${paymentId} — échec : ${error}` });
    return { refundPaymentId: rowId, paymentId, amountCents, status: "failed", error };
  }
}

/** Rejoue un remboursement `failed`. Avant de renvoyer l'ordre, on demande à
 *  Stripe ce qui est déjà remboursé : une réponse perdue (délai d'attente) peut
 *  cacher un remboursement en fait passé, et le rejouer avec une autre clé
 *  rembourserait deux fois — en mangeant les arrhes. En cas de doute (Stripe
 *  injoignable), on ne rejoue pas. */
export async function replayRefund(
  db: D1Database, cfg: StripeConfig, booking: BookingRow, refundPaymentId: number,
): Promise<RefundOutcome> {
  const rows = await listPayments(db, { bookingId: booking.id });
  const row = rows.find((r) => r.id === refundPaymentId && r.kind === "refund");
  if (!row || row.status !== "failed" || !row.stripePaymentIntent) throw new Error("remboursement introuvable ou pas en échec");
  const amount = Math.abs(row.amountCents);
  const intent = row.stripePaymentIntent;
  const remote = await paymentIntentRefundedCents(cfg, intent);
  if (remote === null) throw new Error("Stripe injoignable : impossible de vérifier ce qui est déjà remboursé, on ne rejoue pas");
  const others = rows
    .filter((r) => r.kind === "refund" && r.id !== row.id && r.stripePaymentIntent === intent && (r.status === "succeeded" || r.status === "pending"))
    .reduce((s, r) => s + Math.abs(r.amountCents), 0);
  const paymentId = Number(/#(\d+)/.exec(row.note ?? "")?.[1] ?? 0);
  if (remote >= others + amount) {
    // Déjà passé chez Stripe malgré l'échec constaté ici : on aligne la ligne.
    await markPaymentStatus(db, row.id, "succeeded", { receivedAt: sqlNow(), note: `remboursement du paiement #${paymentId} — déjà remboursé chez Stripe (vérifié au rejeu)` });
    await audit(db, "admin", "refund.replay_already_done", `booking:${booking.id}`, { refundPayment: row.id });
    return { refundPaymentId: row.id, paymentId, amountCents: amount, status: "succeeded" };
  }
  await markPaymentStatus(db, row.id, "pending", { note: `remboursement du paiement #${paymentId} — rejeu` });
  const attempt = Date.now().toString(36);
  const outcome = await runRefund(db, cfg, booking.reference, row.id, paymentId, intent, amount, `gp-refund-${row.id}-r${attempt}`);
  await audit(db, "admin", "refund.replay", `booking:${booking.id}`, outcome);
  return outcome;
}
