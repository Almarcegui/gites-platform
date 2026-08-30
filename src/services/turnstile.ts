// Cloudflare Turnstile — second volet de l'anti-abus du formulaire public
// (issue #6). Le premier volet (plafond de holds et de cadence, PR #56) arrête
// la boucle bête ; Turnstile arrête le script qui varie ses emails et ses IP.
//
// Principe non négociable : la fonctionnalité est ENTIÈREMENT DÉSACTIVABLE.
// Sans les deux clés, il ne se passe rien du tout — aucun script chargé côté
// tunnel, aucune vérification côté serveur, comportement identique à
// aujourd'hui. C'est ce qui permet aux tests et au développement local de
// tourner sans compte Cloudflare (CONTRIBUTING § « Comptes tiers »).
//
// Les deux clés vont ensemble :
//   TURNSTILE_SITE_KEY   — publique, exposée par /api/public/today, insérée
//                          dans le widget côté navigateur ;
//   TURNSTILE_SECRET_KEY — secrète (`wrangler secret put`), ne sort jamais du
//                          Worker.
// Une seule des deux = configuration incomplète : on considère la
// fonctionnalité éteinte plutôt que d'échouer à chaque réservation.

/** Endpoint de vérification du jeton (documentation Cloudflare Turnstile). */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Longueur maximale d'un jeton acceptée par Cloudflare. Au-delà, on refuse
 *  sans appeler l'API : c'est du remplissage, pas un jeton. */
const MAX_TOKEN_LENGTH = 2048;

/** Coupe-circuit réseau : sans lui, un ralentissement de siteverify tiendrait
 *  le visiteur en attente jusqu'au timeout global du Worker. Mieux vaut le 503
 *  explicite, qui dit quoi faire. */
const VERIFY_TIMEOUT_MS = 5000;

/** Action déclarée par le widget du tunnel — la MÊME chaîne est passée à
 *  `turnstile.render()` dans public/book/book.js. Cloudflare la scelle dans le
 *  jeton et nous la renvoie : un jeton fabriqué pour un autre formulaire du
 *  même domaine ne peut donc pas servir à réserver. */
export const TURNSTILE_ACTION = "reservation";

/** Codes d'erreur qui dénoncent une MAUVAISE CONFIGURATION de notre côté, pas
 *  un visiteur suspect : les traiter en 400 reviendrait à accuser le client
 *  d'une faute qui est la nôtre, et à masquer la panne. */
const CONFIG_ERROR_CODES = new Set(["missing-input-secret", "invalid-input-secret", "bad-request"]);

/** La vérification n'est active que si les DEUX clés sont configurées. */
export function turnstileEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY?.trim()) && Boolean(env.TURNSTILE_SECRET_KEY?.trim());
}

/** Clé publique à exposer au tunnel — `null` quand la fonctionnalité est
 *  éteinte, ce qui suffit au front pour ne charger aucun script tiers. */
export function turnstileSiteKey(env: Env): string | null {
  return turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY as string).trim() : null;
}

export type TurnstileResult =
  | { ok: true }
  | { ok: false; status: 400 | 503; code: string; message: string; codes: string[] };

/** Réponse de l'API siteverify — on ne lit que ce dont on a besoin. */
interface SiteverifyResponse {
  success?: boolean;
  action?: unknown;
  "error-codes"?: unknown;
}

function errorCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string").slice(0, 8);
}

/**
 * Vérifie un jeton Turnstile auprès de Cloudflare.
 *
 * ⚠️ Le jeton lui-même n'est **jamais** journalisé ni renvoyé : il n'apparaît
 * ni dans `audit_log`, ni dans la réponse, ni dans un `console.*`. Seuls les
 * codes d'erreur de Cloudflare (`invalid-input-response`, `timeout-or-duplicate`…)
 * remontent — ils suffisent au diagnostic et n'ont aucune valeur rejouable.
 *
 * En cas de panne du service, on refuse (fail-closed) : la protection ne se
 * désarme pas toute seule. Le refus est un 503 explicite, avec la sortie de
 * secours (nous contacter), et non un 400 qui accuserait le visiteur.
 */
export async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<TurnstileResult> {
  if (!turnstileEnabled(env)) return { ok: true };

  const value = typeof token === "string" ? token.trim() : "";
  if (!value || value.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: "captcha_missing",
      codes: [],
      message:
        "Le contrôle anti-robot n'a pas été validé. Rechargez la page, patientez le temps de la vérification, puis relancez la réservation.",
    };
  }

  const form = new URLSearchParams();
  form.set("secret", (env.TURNSTILE_SECRET_KEY as string).trim());
  form.set("response", value);
  if (ip) form.set("remoteip", ip);

  let data: SiteverifyResponse;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    const parsed: unknown = await res.json();
    // `null` est du JSON valide : sans ce garde, la lecture de `.success`
    // lèverait un TypeError et rendrait un 500 au lieu du repli prévu.
    if (!parsed || typeof parsed !== "object") throw new Error("réponse siteverify inattendue");
    data = parsed as SiteverifyResponse;
  } catch {
    // Le message d'erreur pourrait contenir l'URL appelée mais jamais le
    // jeton (il est dans le corps) : on n'en propage rien de toute façon.
    return {
      ok: false,
      status: 503,
      code: "captcha_unavailable",
      codes: ["network-error"],
      message:
        "Le contrôle anti-robot est momentanément indisponible. Réessayez dans quelques instants, ou contactez-nous : nous réservons pour vous.",
    };
  }

  if (data.success === true) {
    // L'action n'est renvoyée que si le widget en a déclaré une. On refuse
    // celle qui ne correspond pas — jamais son absence, pour ne pas dépendre
    // d'un détail de la réponse de Cloudflare.
    if (typeof data.action === "string" && data.action !== "" && data.action !== TURNSTILE_ACTION) {
      return {
        ok: false,
        status: 400,
        code: "captcha_failed",
        codes: ["action-mismatch"],
        message:
          "Le contrôle anti-robot n'a pas abouti. Rechargez la page et refaites la vérification, puis relancez la réservation.",
      };
    }
    return { ok: true };
  }

  const codes = errorCodes(data["error-codes"]);
  if (codes.some((c) => CONFIG_ERROR_CODES.has(c))) {
    return {
      ok: false,
      status: 503,
      code: "captcha_unavailable",
      codes,
      message:
        "Le contrôle anti-robot est momentanément indisponible. Réessayez dans quelques instants, ou contactez-nous : nous réservons pour vous.",
    };
  }

  return {
    ok: false,
    status: 400,
    code: "captcha_failed",
    codes,
    message:
      "Le contrôle anti-robot n'a pas abouti. Rechargez la page et refaites la vérification, puis relancez la réservation.",
  };
}
