// Point d'entrée du Worker — routage API + export iCal + assets + cron + emails.

import { apiError, Router } from "./api/router";
import { registerPublicRoutes } from "./api/public";
import { registerAdminRoutes } from "./api/admin";
import { runAllScheduled } from "./jobs/scheduled";
import { adminIpCheck, adminIpGate, ipDeniedResponse, markIpDenied } from "./core/ip-allow";
import { withStandardHeaders } from "./services/http-headers";
import { buildReplyMime, parseRawEmail, processInboundEmail } from "./services/inbound-email";
import { PaymentInFlightError } from "./services/booking-flow";
import { wpRedirect } from "./services/redirects";
import { localizePublicResponse } from "./core/public-i18n";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Toute sortie du Worker passe par withStandardHeaders : sécurité et cache
    // sont posés en un seul endroit, y compris sur les erreurs et les fichiers
    // statiques du binding ASSETS (issue #22).
    const finish = (response: Response) => withStandardHeaders(response, url);
    // Anciennes adresses WordPress (issue #38) : AVANT tout le reste, pour
    // qu'une ancienne URL ne consomme ni la base ni les assets. Inactif tant
    // que le Worker ne répond pas sur le domaine définitif — cf. redirects.ts.
    const legacy = wpRedirect(url);
    if (legacy) return finish(legacy);
    // Accès administrateur fermé au public (ADMIN_ALLOWED_IPS, vide = ouvert) :
    // API admin ET écrans /admin/ et /admin2/, avant toute lecture de la base.
    // Écrans : refus immédiat. API : refus après authentification, aux humains
    // seulement (clés de service et compte « sauvegarde » exemptés, cf. guard).
    const clientIp = request.headers.get("cf-connecting-ip");
    const ipCheck = adminIpCheck(url.pathname, env.ADMIN_ALLOWED_IPS, clientIp);
    if (ipCheck === "deny") return finish(adminIpGate(url.pathname, env.ADMIN_ALLOWED_IPS, clientIp) ?? ipDeniedResponse());
    if (ipCheck === "defer") markIpDenied(request);
    // "/" sert le site vitrine (public/index.html) via les assets.
    try {
      const response = await router.handle(request, env, ctx);
      // Tunnel public en néerlandais : textes du serveur traduits à la sortie.
      if (response) return finish(await localizePublicResponse(request, response));
      // API admin hors liste qu'aucune route gardée n'a reconnue : refus.
      if (ipCheck === "defer") return finish(ipDeniedResponse());
    } catch (e) {
      // Refus métier, pas panne : un paiement est déjà parti chez la banque du
      // client. 409 avec un message lisible, aucune trace d'erreur à ouvrir.
      if (e instanceof PaymentInFlightError) return finish(apiError(409, e.message, { code: "payment_in_flight" }));
      console.error("Erreur API:", e instanceof Error ? e.stack : e);
      // Les logs Workers ne sont pas retenus par défaut : sans trace en base,
      // un webhook Stripe qui plante ne laisse rien de consultable au
      // back-office (audit ECC 2026-07-30). Le repli ne doit jamais masquer
      // la réponse 500.
      try {
        await env.DB.prepare(
          "INSERT INTO audit_log (actor, action, entity, detail) VALUES ('cron', 'unhandled.error', ?1, ?2)",
        )
          .bind(url.pathname, String(e instanceof Error ? e.stack : e).slice(0, 2000))
          .run();
      } catch (logErr) {
        console.error("audit_log indisponible:", logErr);
      }
      return finish(apiError(500, "erreur interne"));
    }
    // Route dynamique inconnue → 404 JSON ; le reste est servi par les assets.
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ical/")) {
      return finish(apiError(404, "route inconnue"));
    }
    return finish(await env.ASSETS.fetch(request));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAllScheduled(env));
  },

  // Emails entrants (Cloudflare Email Routing → ce Worker, une fois le
  // routage DNS activé — cf. README § Intégration email). Chaque mail est
  // stocké, rattaché à la résa/au client, accusé de réception si activé,
  // et transféré vers l'adresse personnelle configurée.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const raw = await new Response(message.raw).text();
    const parsed = parseRawEmail(raw);
    if (!parsed.from) parsed.from = message.from.toLowerCase();
    if (!parsed.to) parsed.to = message.to.toLowerCase();
    await processInboundEmail(env.DB, env, parsed, {
      reply: async (subject, body) => {
        const { EmailMessage } = await import("cloudflare:email");
        const mime = buildReplyMime(message.to, parsed.from, subject, body, parsed.messageId);
        await message.reply(new EmailMessage(message.to, parsed.from, mime));
      },
      forward: async (to) => {
        await message.forward(to);
      },
    });
  },
} satisfies ExportedHandler<Env>;
