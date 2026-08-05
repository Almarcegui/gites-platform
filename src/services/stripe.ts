// Intégration Stripe Checkout — par API REST directe (fetch), sans SDK.
//
// ⚠️ MODE TEST UNIQUEMENT (clé sk_test_…) tant que l'entité juridique qui
// encaisse n'est pas tranchée (question ouverte n° 1 du plan v1).
//
// Sans STRIPE_SECRET_KEY : MODE STUB — createCheckoutSession renvoie une URL
// locale /book/dev-pay.html qui simule le paiement (dev uniquement, la page
// appelle /api/public/dev-pay/confirm qui rejoue le chemin du webhook).

const STRIPE_API = "https://api.stripe.com/v1";

export function stripeEnabled(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.trim() !== "";
}

export interface CheckoutParams {
  paymentId: number;      // notre payments.id — la clé de réconciliation du webhook
  reference: string;      // PM-2026-001
  label: string;          // « Acompte réservation PM-2026-001 — La Scierie »
  amountCents: number;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(env: Env, p: CheckoutParams): Promise<{ id: string; url: string }> {
  if (!stripeEnabled(env)) {
    const id = `stub_${p.paymentId}`;
    const url = `${env.PUBLIC_BASE_URL}/book/dev-pay.html?session=${encodeURIComponent(id)}&ref=${encodeURIComponent(p.reference)}&amount=${p.amountCents}&label=${encodeURIComponent(p.label)}`;
    return { id, url };
  }
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][product_data][name]": p.label,
    "line_items[0][price_data][unit_amount]": String(p.amountCents),
    "line_items[0][quantity]": "1",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    // Session éphémère : alignée sur le hold de 30 min (minimum Stripe).
    expires_at: String(Math.floor(Date.now() / 1000) + 30 * 60),
    "metadata[payment_id]": String(p.paymentId),
    "metadata[reference]": p.reference,
    "payment_intent_data[description]": `${p.reference} — ${p.label}`,
  });
  if (p.customerEmail) body.set("customer_email", p.customerEmail);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Stripe checkout ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const session = (await res.json()) as { id: string; url: string };
  return { id: session.id, url: session.url };
}

/** Vérification de la signature du webhook (Stripe-Signature: t=…,v1=…).
 *  HMAC-SHA256 de `${t}.${payload}` avec le signing secret, comparaison en
 *  temps constant, tolérance d'horloge 5 min. */
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string | null,
  secret: string,
  nowMs: number = Date.now(),
  toleranceSec = 300,
): Promise<boolean> {
  if (!sigHeader) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of sigHeader.split(",")) {
    const [k = "", v = ""] = part.split("=", 2).map((x) => x.trim());
    if (k === "t") timestamp = v;
    if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`));
  const expected = toHex(new Uint8Array(mac));
  return signatures.some((sig) => timingSafeEqualHex(sig.toLowerCase(), expected));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
