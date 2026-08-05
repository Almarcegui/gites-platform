// Point d'entrée du Worker — routage API + export iCal + assets + cron + emails.

import { apiError, Router } from "./api/router";
import { registerPublicRoutes } from "./api/public";
import { registerAdminRoutes } from "./api/admin";
import { runScheduled } from "./services/cron";
import { buildReplyMime, parseRawEmail, processInboundEmail } from "./services/inbound-email";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // "/" sert le site vitrine (public/index.html) via les assets.
    try {
      const response = await router.handle(request, env, ctx);
      if (response) return response;
    } catch (e) {
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
      return apiError(500, "erreur interne");
    }
    // Route dynamique inconnue → 404 JSON ; le reste est servi par les assets.
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ical/")) {
      return apiError(404, "route inconnue");
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
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
