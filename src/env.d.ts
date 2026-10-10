// Typage de l'environnement du Worker (bindings wrangler.jsonc + secrets).
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL: string;
  EMAILS_ENABLED?: string;
  // Secrets (.dev.vars en local, wrangler secret en prod) — tous optionnels :
  // absents = mode stub (paiement simulé, emails journalisés uniquement).
  STRIPE_SECRET_KEY?: string;
  /** Clé publique Stripe (pk_test_… / pk_live_…) — confiée au navigateur pour
   *  monter le Payment Element. Absente = repli sur Checkout hébergé. */
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** `checkout` force le retour à la page de paiement hébergée. Toute autre
   *  valeur (ou l'absence) = Payment Element intégré, le défaut. */
  STRIPE_UI?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ADMIN_TOKEN?: string;
  /** Refresh token API v2 Beds24 (canal OTA) — absent = intégration OFF. */
  BEDS24_REFRESH_TOKEN?: string;
  /** Clé secrète du webhook entrant Beds24 (/api/webhooks/beds24?key=…). */
  BEDS24_WEBHOOK_KEY?: string;
  /** Clé PUBLIQUE du widget Cloudflare Turnstile (issue #6). Exposée telle
   *  quelle par /api/public/today. Absente = anti-robot désactivé. */
  TURNSTILE_SITE_KEY?: string;
  /** Clé SECRÈTE Turnstile (`wrangler secret put`). Absente = anti-robot
   *  désactivé : les deux clés vont ensemble, cf. services/turnstile.ts. */
  TURNSTILE_SECRET_KEY?: string;
  /** Autorise les ÉCRITURES vers Beds24 (compte réel, pas de bac à sable).
   *  Déduit sinon de PUBLIC_BASE_URL en https:// — cf. beds24WritesAllowed(). */
  BEDS24_WRITE_ENABLED?: string;
  /** Adresses ou plages CIDR autorisées sur /api/admin/*, /admin/ et /admin2/
   *  (virgules ou espaces). Vide = ouvert. Cf. src/core/ip-allow.ts. */
  ADMIN_ALLOWED_IPS?: string;
  /** Dépôt des photos envoyées depuis le back-office. Fourni par
   *  node/server.mjs (dossier UPLOADS_DIR, servi sous /uploads/) ; absent sur
   *  Workers, où l'envoi répond 501. */
  UPLOADS?: UploadStore;
}

/** Écriture d'un fichier envoyé. `name` est déjà validé (hexadécimal + extension). */
interface UploadStore {
  put(name: string, bytes: Uint8Array): Promise<void>;
  /** Retire un fichier déposé (compensation quand la base refuse la ligne). */
  remove?(name: string): Promise<void>;
}
