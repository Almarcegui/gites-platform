// Emails transactionnels — MODE STUB PAR DÉFAUT.
// Chaque email est journalisé dans email_log. Il n'est réellement envoyé (via
// Resend) que si EMAILS_ENABLED=true ET RESEND_API_KEY présente — c'est-à-dire
// jamais sans décision explicite de Julien.

import type { BookingRow, PropertyRow, PropertySettings } from "../db/repo";
import type { Quote, QuoteLine } from "../core/pricing";

export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const cts = String(abs % 100).padStart(2, "0");
  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${eurosStr},${cts} €`;
}

export function formatDateFr(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export interface EmailToQueue {
  bookingId?: number | null;
  to: string;
  subject: string;
  bodyText: string;
  kind: string; // 'voucher' | 'payment_link' | 'balance_reminder' | …
}

export async function queueEmail(db: D1Database, env: Env, e: EmailToQueue): Promise<void> {
  let status: "stub" | "sent" | "failed" = "stub";
  let providerId: string | null = null;
  // Sans le détail de l'échec, un voucher jamais parti était indiscernable
  // d'un envoi désactivé — et personne ne le voyait (audit ECC 2026-07-30).
  let errorDetail: string | null = null;

  if (env.EMAILS_ENABLED === "true" && env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.RESEND_FROM ?? "reservation@example.com",
          to: [e.to],
          subject: e.subject,
          text: e.bodyText,
        }),
      });
      if (res.ok) {
        status = "sent";
        providerId = ((await res.json()) as { id?: string }).id ?? null;
      } else {
        status = "failed";
        errorDetail = `HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 400)}`.trim();
      }
    } catch (err) {
      status = "failed";
      errorDetail = err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400);
    }
  }

  await db
    .prepare(
      "INSERT INTO email_log (booking_id, to_email, subject, body_text, kind, status, provider_id, error_detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(e.bookingId ?? null, e.to, e.subject, e.bodyText, e.kind, status, providerId, errorDetail)
    .run();
}

function quoteLinesText(lines: QuoteLine[]): string {
  return lines.map((l) => `  ${l.label.padEnd(52)} ${formatEur(l.amountCents).padStart(12)}`).join("\n");
}

export interface VoucherContext {
  booking: BookingRow;
  property: PropertyRow;
  settings: PropertySettings;
  voucherUrl: string;
}

/** Voucher de confirmation (après paiement de l'acompte ou du total). */
export function buildVoucherEmail(ctx: VoucherContext): { subject: string; bodyText: string } {
  const { booking: b, property, settings } = ctx;
  // Parse défensif : c'est le seul des 4 sites de lecture du devis qui vit sur
  // le chemin du webhook Stripe. Une exception ici faisait échouer le webhook
  // APRÈS confirmation ; au retry, Stripe voyait un paiement déjà 'succeeded'
  // et sortait sans jamais renvoyer le voucher (audit ECC 2026-07-30).
  let quote: Quote | null = null;
  if (b.quoteJson) {
    try {
      quote = JSON.parse(b.quoteJson) as Quote;
    } catch {
      quote = null; // le voucher part sans le détail des lignes, mais il part
    }
  }
  const persons = b.adults + b.children;
  const balance = b.totalCents - b.paidCents;

  const parts: string[] = [
    `Bonjour,`,
    ``,
    `Votre réservation est confirmée — merci !`,
    ``,
    `Référence : ${b.reference}`,
    `Hébergement : ${b.unitName ?? ""} — ${property.name}`,
    `Séjour : du ${formatDateFr(b.checkin)} (arrivée dès ${settings.checkinTime}) au ${formatDateFr(b.checkout)} (départ avant ${settings.checkoutTime})`,
    `Voyageurs : ${persons} personne${persons > 1 ? "s" : ""}${b.children > 0 ? ` (dont ${b.children} enfant${b.children > 1 ? "s" : ""})` : ""}`,
  ];
  if (quote) {
    parts.push(``, `Détail du séjour :`, quoteLinesText(quote.lines), `  ${"TOTAL".padEnd(52)} ${formatEur(quote.totalCents).padStart(12)}`);
  } else {
    parts.push(``, `Total : ${formatEur(b.totalCents)}`);
  }
  parts.push(``, `Déjà payé : ${formatEur(b.paidCents)}`);
  if (balance > 0) {
    parts.push(
      `Solde restant : ${formatEur(balance)}${b.balanceDueDate ? ` — à régler pour le ${formatDateFr(b.balanceDueDate)}` : ""}`,
    );
  } else {
    parts.push(`Votre séjour est intégralement réglé.`);
  }
  if (settings.cautionCents > 0) {
    parts.push(``, `Caution : ${formatEur(settings.cautionCents)} (empreinte ou dépôt demandé avant l'arrivée, restitué après l'état des lieux).`);
  }
  parts.push(
    ``,
    `Retrouvez votre réservation à tout moment : ${ctx.voucherUrl}`,
    ``,
    `À très bientôt,`,
    `${property.name}`,
    property.contactEmail ? `${property.contactEmail}` : ``,
    ``,
    `------------------------------------------------------------`,
    `CONDITIONS GÉNÉRALES ET CONTRAT DE LOCATION`,
    settings.cgvText || "(CGV à compléter)",
  );

  return {
    subject: `Confirmation de réservation ${b.reference} — ${property.name}`,
    bodyText: parts.join("\n"),
  };
}

/** Lien de paiement (solde ou autre) à envoyer au client. */
export function buildPaymentLinkEmail(
  b: BookingRow,
  property: PropertyRow,
  label: string,
  amountCents: number,
  payUrl: string,
): { subject: string; bodyText: string } {
  return {
    subject: `${label} — réservation ${b.reference} (${property.name})`,
    bodyText: [
      `Bonjour,`,
      ``,
      `Voici votre lien de paiement sécurisé pour la réservation ${b.reference} (${b.unitName ?? ""}, du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)}) :`,
      ``,
      `${label} : ${formatEur(amountCents)}`,
      payUrl,
      ``,
      `Le paiement s'effectue via Stripe (carte bancaire).`,
      ``,
      `À bientôt,`,
      `${property.name}`,
    ].join("\n"),
  };
}

/** Reçu de paiement (issue #37, volet b) — émis à chaque encaissement, arrhes
 *  comme solde.
 *
 *  Distinct du voucher, et pas redondant avec lui : le voucher est le document
 *  contractuel de la réservation (conditions générales comprises), envoyé une
 *  seule fois à la confirmation. Le reçu est un justificatif comptable, émis
 *  autant de fois qu'il y a d'encaissements — c'est le document qu'un client
 *  cherche quand il veut prouver ce qu'il a payé, et quand.
 *
 *  Les montants viennent de la réservation APRÈS enregistrement du paiement :
 *  `paidCents` inclut donc l'encaissement décrit ici. */
export function buildPaymentReceiptEmail(
  b: BookingRow,
  property: PropertyRow,
  payment: { kind: string; amountCents: number; receivedAt?: string | null },
): { subject: string; bodyText: string } {
  let quote: Quote | null = null;
  if (b.quoteJson) {
    try {
      quote = JSON.parse(b.quoteJson) as Quote;
    } catch {
      quote = null; // le reçu part sans le détail : les montants suffisent à justifier
    }
  }
  const label =
    payment.kind === "deposit" ? "Arrhes" : payment.kind === "balance" ? "Solde" : payment.kind === "full" ? "Paiement intégral" : "Paiement";
  const balance = Math.max(0, b.totalCents - b.paidCents);
  const persons = b.adults + b.children;

  const parts: string[] = [
    `Bonjour,`,
    ``,
    `Nous accusons réception de votre paiement. Ce message vaut justificatif.`,
    ``,
    `Référence : ${b.reference}`,
    `Hébergement : ${b.unitName ?? ""} — ${property.name}`,
    `Séjour : du ${formatDateFr(b.checkin)} au ${formatDateFr(b.checkout)} — ${persons} personne${persons > 1 ? "s" : ""}`,
  ];
  if (payment.receivedAt) parts.push(`Payé le : ${payment.receivedAt}`);
  parts.push(``, `${label} encaissé${payment.kind === "deposit" ? "es" : ""} : ${formatEur(payment.amountCents)}`);

  if (quote) {
    parts.push(``, `Détail du séjour :`, quoteLinesText(quote.lines), `  ${"TOTAL".padEnd(52)} ${formatEur(quote.totalCents).padStart(12)}`);
  } else {
    parts.push(``, `Total du séjour : ${formatEur(b.totalCents)}`);
  }

  parts.push(``, `Total déjà réglé : ${formatEur(b.paidCents)}`);
  if (balance > 0) {
    parts.push(
      `Solde restant : ${formatEur(balance)}${b.balanceDueDate ? ` — à régler pour le ${formatDateFr(b.balanceDueDate)}` : ""}`,
    );
  } else {
    parts.push(`Solde restant : aucun — votre séjour est intégralement réglé.`);
  }
  parts.push(``, `À bientôt,`, `${property.name}`, property.contactEmail ? `${property.contactEmail}` : ``);

  return {
    subject: `Reçu de paiement ${formatEur(payment.amountCents)} — réservation ${b.reference} (${property.name})`,
    bodyText: parts.join("\n"),
  };
}

/** Rappel automatique de solde (cron, à l'échéance). */
export function buildBalanceReminderEmail(b: BookingRow, property: PropertyRow): { subject: string; bodyText: string } {
  const balance = b.totalCents - b.paidCents;
  return {
    subject: `Rappel — solde de votre séjour ${b.reference} (${property.name})`,
    bodyText: [
      `Bonjour,`,
      ``,
      `Petit rappel : le solde de votre réservation ${b.reference} (${b.unitName ?? ""}, arrivée le ${formatDateFr(b.checkin)}) reste à régler.`,
      ``,
      `Solde : ${formatEur(balance)}${b.balanceDueDate ? ` — échéance le ${formatDateFr(b.balanceDueDate)}` : ""}`,
      ``,
      `Nous pouvons vous renvoyer un lien de paiement sur simple demande.`,
      ``,
      `À bientôt,`,
      `${property.name}`,
    ].join("\n"),
  };
}
