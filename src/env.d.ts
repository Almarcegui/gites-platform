// Typage de l'environnement du Worker (bindings wrangler.jsonc + secrets).
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL: string;
  EMAILS_ENABLED?: string;
  // Secrets (.dev.vars en local, wrangler secret en prod) — tous optionnels :
  // absents = mode stub (paiement simulé, emails journalisés uniquement).
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ADMIN_TOKEN?: string;
  /** Refresh token API v2 Beds24 (canal OTA) — absent = intégration OFF. */
  BEDS24_REFRESH_TOKEN?: string;
  /** Clé secrète du webhook entrant Beds24 (/api/webhooks/beds24?key=…). */
  BEDS24_WEBHOOK_KEY?: string;
  /** Autorise les ÉCRITURES vers Beds24 (compte réel, pas de bac à sable).
   *  Déduit sinon de PUBLIC_BASE_URL en https:// — cf. beds24WritesAllowed(). */
  BEDS24_WRITE_ENABLED?: string;
}
