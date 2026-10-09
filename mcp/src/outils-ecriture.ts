// Outils d'ÉCRITURE — double geste obligatoire (voir confirmation.ts) :
//   1) appel sans `confirmer` → récapitulatif + jeton, RIEN n'est écrit ;
//   2) appel avec les mêmes paramètres, `confirmer: true` et le jeton → écriture.
//
// Hors périmètre, volontairement : annuler une réservation, rembourser,
// modifier un tarif, supprimer un client. Ces gestes restent au back-office.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, NetworkError, qs } from "./client.js";
import { stateDigest } from "./confirmation.js";
import {
  checkStay, type Ctx, describeError, fail, findBooking, guestLabel, quoteError, text, today, UsageError, wrap, zDate, zDomaine,
  zHebergement, zReservation,
} from "./commun.js";
import { addDays, euros, frDate, nights } from "./dates.js";
import { conflictLines, quoteBlockers, quoteFor } from "./outils-lecture.js";
import type { Booking, ManualBlock, Message } from "./api-types.js";
import { logEvent } from "./log.js";

const zConfirmer = z
  .boolean()
  .optional()
  .describe("Laisser vide au premier appel (récapitulatif). true seulement après accord explicite de l'utilisateur sur le récapitulatif.");
const zJeton = z.string().max(32).optional().describe("Jeton renvoyé par le récapitulatif ; obligatoire avec confirmer: true.");

const RAPPEL =
  "Ne jamais passer confirmer: true sans avoir lu ce récapitulatif à l'utilisateur et obtenu son accord explicite.";

interface Preview<D> {
  /** Texte du récapitulatif, ou du refus si `blocked`. */
  text: string;
  blocked?: boolean;
  /** Ce que l'humain approuve au-delà des paramètres : cible résolue,
   *  destinataire, montants. Recalculé à la confirmation et comparé. */
  state?: unknown;
  /** Données résolues transmises à l'exécution (celles du récapitulatif recalculé). */
  data?: D;
}

async function twoStep<D>(
  ctx: Ctx,
  tool: string,
  args: Record<string, unknown> & { confirmer?: boolean; jeton?: string },
  preview: () => Promise<Preview<D>>,
  execute: (data: D) => Promise<string>,
): Promise<CallToolResult> {
  if (args.confirmer !== true) {
    const p = await preview();
    if (p.blocked) return fail(`${p.text}\n\nRien n'a été écrit.`);
    const jeton = ctx.confirmations.issue(tool, args, p.state);
    return text(
      `RÉCAPITULATIF — rien n'a encore été écrit.\n\n${p.text}\n\n` +
        `Pour exécuter : relire ce récapitulatif à l'utilisateur ; s'il est d'accord, rappeler ${tool} avec exactement ` +
        `les mêmes paramètres, plus confirmer: true et jeton: "${jeton}" (valable 10 minutes, usage unique).`,
    );
  }
  const c = ctx.confirmations.consume(tool, args, args.jeton);
  if ("refus" in c) {
    return fail(`Refusé : ${c.refus}. Rien n'a été écrit. Rappeler ${tool} sans « confirmer » pour obtenir un récapitulatif et un nouveau jeton.`);
  }
  // Récapitulatif recalculé sur des données fraîches : si quoi que ce soit a
  // bougé depuis (prix, cible, destinataire, disponibilité), on n'écrit pas.
  ctx.ref.invalidate();
  const fresh = await preview();
  if (fresh.blocked) return fail(`${fresh.text}\n\nRien n'a été écrit (la situation a changé depuis le récapitulatif).`);
  if (stateDigest(fresh.state) !== c.state) {
    return fail(
      `Refusé : la situation a changé depuis le récapitulatif. Rien n'a été écrit. Nouvel état :\n\n${fresh.text}\n\n` +
        `Rappeler ${tool} sans « confirmer » pour obtenir un nouveau récapitulatif.`,
    );
  }
  if (ctx.elicit) {
    const ok = await ctx.elicit(`${fresh.text}\n\nConfirmer cette écriture sur la plateforme des gîtes ?`);
    if (ok === false) return fail("Annulé par l'utilisateur : rien n'a été écrit.");
  }
  try {
    const done = await execute(fresh.data as D);
    logEvent("ecriture", { nom: tool, issue: "ok" });
    return text(done);
  } catch (e) {
    logEvent("ecriture", { nom: tool, issue: "echec" });
    // Coupure, réponse illisible ou erreur serveur : la requête a pu aboutir.
    if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
      return fail(
        `${describeError(e)}\nL'écriture a PEUT-ÊTRE eu lieu : vérifier dans le back-office (planning, fiche réservation ou messages) avant de recommencer.`,
      );
    }
    return fail(`${describeError(e)}\nRien n'a été écrit par cette action.`);
  }
}

export function registerWriteTools(server: McpServer, ctx: Ctx): void {
  // --- bloquer_dates --------------------------------------------------------------
  server.registerTool(
    "bloquer_dates",
    {
      title: "Bloquer des dates",
      description:
        "Pose un blocage manuel (travaux, usage personnel…) sur un hébergement : ces nuits ne sont plus vendables, ni " +
        "sur le site ni sur les canaux, et les hébergements liés sont bloqués aussi (bloquer la Scierie bloque le " +
        "Domaine entier). Un blocage n'est pas une réservation. Deux appels : récapitulatif, puis confirmer: true + jeton. " +
        RAPPEL,
      inputSchema: {
        hebergement: zHebergement,
        arrivee: zDate.describe("Première nuit bloquée, AAAA-MM-JJ."),
        depart: zDate.describe("Jour de fin (exclu : la dernière nuit bloquée est la veille), AAAA-MM-JJ."),
        motif: z.string().min(2).max(200).describe("Motif court : « travaux », « usage familial »…"),
        confirmer: zConfirmer,
        jeton: zJeton,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap("bloquer_dates", async (args) =>
      twoStep<{ unitId: number; unitName: string }>(
        ctx,
        "bloquer_dates",
        args,
        async () => {
          checkStay(args.arrivee, args.depart);
          if (args.depart <= today(ctx)) throw new UsageError("ces dates sont passées — rien à bloquer");
          const unit = await ctx.ref.unit(args.hebergement);
          const r = await quoteFor(ctx, unit, args.arrivee, args.depart, 1, 0);
          if (!r.availability.available) {
            return { blocked: true, text: [`${unit.name} n'est pas libre du ${frDate(args.arrivee)} au ${frDate(args.depart)} :`, ...conflictLines(r)].join("\n") };
          }
          const impacted = await ctx.ref.impacted(unit.id);
          return {
            text: [
              `Bloquer ${unit.name} du ${frDate(args.arrivee)} au ${frDate(args.depart)} (${nights(args.arrivee, args.depart)} nuits) — motif : « ${args.motif.trim()} ».`,
              `Effet : ${impacted.map((u) => u.name).join(", ")} ${impacted.length > 1 ? "deviennent indisponibles" : "devient indisponible"} sur ces dates (site, iCal, Beds24).`,
            ].join("\n"),
            state: { unitId: unit.id, impacted: impacted.map((u) => u.id) },
            data: { unitId: unit.id, unitName: unit.name },
          };
        },
        async (d) => {
          const { block } = await ctx.client.post<{ block: ManualBlock }>("/api/admin/blocks", {
            unitId: d.unitId, checkin: args.arrivee, checkout: args.depart, reason: args.motif.trim(),
          });
          return `Fait : blocage n° ${block.id} posé sur ${d.unitName} du ${frDate(block.checkin)} au ${frDate(block.checkout)}. Pour le lever : debloquer_dates avec blocage_id ${block.id}.`;
        },
      ),
    ),
  );

  // --- debloquer_dates --------------------------------------------------------------
  server.registerTool(
    "debloquer_dates",
    {
      title: "Lever un blocage",
      description:
        "Lève un blocage manuel (posé par bloquer_dates ou par le back-office) : les nuits redeviennent vendables. " +
        "Désigner le blocage par `blocage_id`, ou par `hebergement` (+ `arrivee`/`depart` pour choisir parmi plusieurs). " +
        "Seuls les blocages en cours ou à venir sont visés. Ne touche jamais une réservation. Deux appels : " +
        "récapitulatif, puis confirmer: true + jeton. " +
        RAPPEL,
      inputSchema: {
        blocage_id: z.number().int().positive().optional(),
        hebergement: zHebergement.optional(),
        arrivee: zDate.optional().describe("Avec `hebergement` : blocages qui chevauchent cette période."),
        depart: zDate.optional(),
        confirmer: zConfirmer,
        jeton: zJeton,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap("debloquer_dates", async (args) =>
      twoStep<ManualBlock>(
        ctx,
        "debloquer_dates",
        args,
        async () => {
          if (args.blocage_id === undefined && args.hebergement === undefined) throw new UsageError("donner `blocage_id` ou `hebergement`");
          const t = today(ctx);
          const unit = args.hebergement !== undefined ? await ctx.ref.unit(args.hebergement) : null;
          const props = unit ? [{ id: unit.propertyId }] : await ctx.ref.propertiesFor(undefined);
          const all: ManualBlock[] = [];
          for (const p of props) {
            const { blocks } = await ctx.client.get<{ blocks: ManualBlock[] }>(`/api/admin/blocks${qs({ property: p.id, from: t, to: "2099-12-31" })}`);
            all.push(...blocks);
          }
          let hits = all;
          if (args.blocage_id !== undefined) hits = hits.filter((k) => k.id === args.blocage_id);
          if (unit) hits = hits.filter((k) => k.unitId === unit.id);
          if (args.arrivee) hits = hits.filter((k) => k.checkout > args.arrivee!);
          if (args.depart) hits = hits.filter((k) => k.checkin < args.depart!);
          if (!hits.length) throw new UsageError("aucun blocage en cours ou à venir ne correspond");
          if (hits.length > 1) {
            throw new UsageError(
              `plusieurs blocages correspondent — préciser blocage_id :\n${hits.map((k) => `- n° ${k.id} : ${k.unitName ?? k.unitId} du ${frDate(k.checkin)} au ${frDate(k.checkout)} (« ${k.reason} »)`).join("\n")}`,
            );
          }
          const k = hits[0]!;
          return {
            text: `Lever le blocage n° ${k.id} : ${k.unitName ?? k.unitId} du ${frDate(k.checkin)} au ${frDate(k.checkout)} — motif « ${k.reason} », posé par ${k.createdBy}. Ces nuits redeviendront vendables.`,
            state: { id: k.id, unitId: k.unitId, checkin: k.checkin, checkout: k.checkout },
            data: k,
          };
        },
        async (k) => {
          await ctx.client.delete<{ ok: boolean }>(`/api/admin/blocks/${k.id}`);
          return `Fait : blocage n° ${k.id} levé (${k.unitName ?? k.unitId}, ${frDate(k.checkin)} → ${frDate(k.checkout)}).`;
        },
      ),
    ),
  );

  // --- repondre_client --------------------------------------------------------------
  server.registerTool(
    "repondre_client",
    {
      title: "Répondre à un client",
      description:
        "Envoie un message de l'équipe à un client : réponse à un message reçu (`message_id`, qui passe alors en " +
        "« traité ») ou nouveau message lié à une réservation (`reservation`). Le texte part tel quel : le faire " +
        "valider mot pour mot par l'utilisateur. Le message apparaît dans le fil et sur le voucher du client ; il est " +
        "doublé par e-mail si l'envoi réel est activé sur la plateforme. Deux appels : récapitulatif, puis " +
        "confirmer: true + jeton. " +
        RAPPEL,
      inputSchema: {
        message_id: z.number().int().positive().optional().describe("Message auquel on répond (voir messages_en_attente)."),
        reservation: zReservation.optional(),
        texte: z.string().min(2).max(5000).describe("Texte exact du message, signé comme l'utilisateur le souhaite."),
        confirmer: zConfirmer,
        jeton: zJeton,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap("repondre_client", async (args) => {
      if ((args.message_id === undefined) === (args.reservation === undefined)) {
        throw new UsageError("donner soit `message_id` (réponse), soit `reservation` (nouveau message) — pas les deux");
      }
      return twoStep<{ path: string }>(
        ctx,
        "repondre_client",
        args,
        async () => {
          let t: { to: string | null; subject: string; ref: string; path: string };
          if (args.message_id !== undefined) {
            const { message: m } = await ctx.client.get<{ message: Message }>(`/api/admin/messages/${args.message_id}/thread`);
            t = {
              to: m.direction === "in" ? m.fromEmail : m.toEmail,
              subject: m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`,
              ref: m.bookingReference ? `réservation ${m.bookingReference}` : "sans réservation liée",
              path: `/api/admin/messages/${m.id}/reply`,
            };
          } else {
            const { booking: b } = await findBooking(ctx, args.reservation!);
            t = { to: b.guestEmail ?? null, subject: `Votre réservation ${b.reference}`, ref: `réservation ${b.reference} (${guestLabel(b)})`, path: `/api/admin/bookings/${b.id}/messages` };
          }
          const lines = [
            `Destinataire : ${t.to ?? "aucune adresse — le message sera seulement visible dans le fil et sur le voucher"} (${t.ref})`,
            `Objet : ${t.subject}`,
            `Texte :`,
            args.texte.trim(),
          ];
          if (args.message_id !== undefined) lines.push("", "Le message reçu passera en « traité ».");
          return { text: lines.join("\n"), state: { to: t.to, subject: t.subject, path: t.path }, data: { path: t.path } };
        },
        async (d) => {
          const r = await ctx.client.post<{ ok: boolean; id: number; delivery: string }>(d.path, { body: args.texte.trim() });
          const how =
            r.delivery === "sent" ? "e-mail envoyé" : r.delivery === "stub" ? "envoi d'e-mail simulé (envoi réel désactivé sur la plateforme) — visible dans le fil" : "pas d'e-mail (aucune adresse) — visible dans le fil";
          return `Fait : message n° ${r.id} enregistré (${how}).`;
        },
      );
    }),
  );

  // --- vente_telephone --------------------------------------------------------------
  server.registerTool(
    "vente_telephone",
    {
      title: "Vente par téléphone",
      description:
        "Crée une réservation saisie par l'équipe (vente au téléphone ou en direct), au prix du moteur tarifaire, après " +
        "vérification de la disponibilité, de la capacité et des règles de séjour. `statut` : « confirmee » (réservation " +
        "ferme, paiement hors ligne attendu) ou « option » (dates retenues pour une durée limitée, à confirmer au " +
        "back-office). Peut générer un lien de paiement Stripe à transmettre. N'envoie aucun e-mail au client. Deux " +
        "appels : récapitulatif, puis confirmer: true + jeton. " +
        RAPPEL,
      inputSchema: {
        hebergement: zHebergement,
        arrivee: zDate.describe("Jour d'arrivée, AAAA-MM-JJ."),
        depart: zDate.describe("Jour de départ, AAAA-MM-JJ."),
        adultes: z.number().int().min(1).max(30),
        enfants: z.number().int().min(0).max(30).default(0),
        client: z
          .object({
            nom: z.string().min(2).max(80),
            prenom: z.string().max(80).optional(),
            email: z.string().email().max(160).optional(),
            telephone: z.string().max(40).optional(),
            adresse: z.string().max(200).optional(),
            pays: z.string().max(60).optional(),
          })
          .describe("Coordonnées du client (le nom est obligatoire). Si l'e-mail existe déjà, la fiche client correspondante est mise à jour."),
        statut: z.enum(["confirmee", "option"]).describe("confirmee = ferme tout de suite ; option = retenue temporaire."),
        duree_option_heures: z.number().int().min(1).max(336).optional().describe("Durée de l'option (défaut 72 h). Ignoré si statut = confirmee."),
        paiement: z.enum(["arrhes", "total"]).default("arrhes").describe("Montant attendu d'abord : les arrhes ou le total."),
        lien_paiement: z.boolean().default(false).describe("true = générer un lien de paiement Stripe pour ce montant."),
        code_promo: z.string().max(40).optional(),
        notes_internes: z.string().max(1000).optional(),
        confirmer: zConfirmer,
        jeton: zJeton,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap("vente_telephone", async (args) =>
      twoStep<{ unitId: number; unitName: string }>(
        ctx,
        "vente_telephone",
        args,
        async () => {
          checkStay(args.arrivee, args.depart);
          if (args.arrivee < today(ctx)) throw new UsageError("la date d'arrivée est passée");
          const unit = await ctx.ref.unit(args.hebergement);
          if (!unit.active) return { blocked: true, text: `${unit.name} est désactivé : pas de vente possible.` };
          const persons = args.adultes + (args.enfants ?? 0);
          if (persons > unit.capacityMax) {
            return { blocked: true, text: `${unit.name} accueille ${unit.capacityMax} personnes au plus — demande pour ${persons}.` };
          }
          const r = await quoteFor(ctx, unit, args.arrivee, args.depart, args.adultes, args.enfants ?? 0, args.code_promo);
          if (!r.availability.available) {
            return { blocked: true, text: [`${unit.name} n'est pas libre du ${frDate(args.arrivee)} au ${frDate(args.depart)} :`, ...conflictLines(r)].join("\n") };
          }
          if (!r.quote.ok) return { blocked: true, text: `Séjour impossible : ${quoteBlockers(r.quote).join(" ; ")}.` };
          const q = r.quote;
          const full = args.paiement === "total" || q.balanceDueDate === null;
          const first = full ? q.totalCents : q.depositCents;
          const c = args.client;
          const contact = [c.email ? `<${c.email}>` : "(sans e-mail)", c.telephone && `tél. ${c.telephone}`, c.adresse && `adresse : ${c.adresse}`, c.pays && `pays : ${c.pays}`]
            .filter(Boolean)
            .join(", ");
          const lines = [
            `Réservation ${args.statut === "confirmee" ? "CONFIRMÉE d'office" : `en OPTION pendant ${args.duree_option_heures ?? 72} h`} : ${unit.name}, du ${frDate(args.arrivee)} au ${frDate(args.depart)} (${q.nights} nuits), ${args.adultes} adulte(s) + ${args.enfants ?? 0} enfant(s).`,
            `Client : ${[c.prenom, c.nom].filter(Boolean).join(" ")} ${contact}.`,
            `Prix : ${euros(q.totalCents)}${q.promoApplied ? ` (code ${q.promoApplied})` : ""}${q.discountCents ? `, remises comprises (−${euros(q.discountCents)})` : ""}.`,
            full
              ? `Paiement attendu : le total, ${euros(q.totalCents)}.`
              : `Paiement attendu : arrhes ${euros(first)} maintenant, solde ${euros(q.totalCents - first)} avant le ${frDate(q.balanceDueDate!)}.`,
            args.lien_paiement ? `Un lien de paiement Stripe de ${euros(first)} sera généré (à transmettre au client).` : "Pas de lien de paiement.",
          ];
          if (args.notes_internes) lines.push(`Notes internes : ${args.notes_internes}`);
          if (q.warnings.length) lines.push(`Avertissement : ${q.warnings.map(quoteError).join(", ")}.`);
          lines.push("Aucun e-mail n'est envoyé au client par cette action.");
          return {
            text: lines.join("\n"),
            state: { unitId: unit.id, capacityMax: unit.capacityMax, total: q.totalCents, first, balanceDueDate: q.balanceDueDate, promo: q.promoApplied },
            data: { unitId: unit.id, unitName: unit.name },
          };
        },
        async (d) => {
          const c = args.client;
          let r: { booking: Booking; paymentUrl: string | null };
          try {
            r = await ctx.client.post<{ booking: Booking; paymentUrl: string | null }>("/api/admin/bookings", {
              unitId: d.unitId,
              checkin: args.arrivee,
              checkout: args.depart,
              adults: args.adultes,
              children: args.enfants ?? 0,
              promoCode: args.code_promo || null,
              guest: { firstName: c.prenom, lastName: c.nom, email: c.email, phone: c.telephone, address: c.adresse, country: c.pays },
              confirmNow: args.statut === "confirmee",
              holdMinutes: args.statut === "option" ? (args.duree_option_heures ?? 72) * 60 : undefined,
              paymentMode: args.paiement === "total" ? "full" : "deposit",
              generatePaymentLink: args.lien_paiement === true,
              internalNotes: args.notes_internes,
            });
          } catch (e) {
            // Le Worker enregistre la fiche client AVANT de tenter la réservation.
            if (e instanceof ApiError && e.status === 409) {
              throw new UsageError(`${describeError(e)}\nAucune réservation créée ; la fiche client a pu être créée ou mise à jour.`);
            }
            throw e;
          }
          const b = r.booking;
          return [
            `Fait : réservation ${b.reference} (id ${b.id}) ${b.status === "confirmed" ? "confirmée" : "en option"} — ${b.unitName ?? d.unitName}, ${frDate(b.checkin)} → ${frDate(b.checkout)}, total ${euros(b.totalCents)}.`,
            r.paymentUrl ? `Lien de paiement : ${r.paymentUrl}` : args.lien_paiement ? "Lien de paiement non généré (montant trop faible ou paiement indisponible)." : "",
          ].filter(Boolean).join("\n");
        },
      ),
    ),
  );

  // --- relancer_solde --------------------------------------------------------------
  server.registerTool(
    "relancer_solde",
    {
      title: "Relancer le solde",
      description:
        "Envoie au client d'une réservation confirmée un e-mail de rappel du solde restant dû, avec son lien de paiement " +
        "(le voucher). La relance est journalisée et vaut rappel automatique. Deux appels : récapitulatif (montant, " +
        "destinataire, dernière relance), puis confirmer: true + jeton. " +
        RAPPEL,
      inputSchema: { reservation: zReservation, confirmer: zConfirmer, jeton: zJeton },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap("relancer_solde", async (args) =>
      twoStep<{ id: number; reference: string }>(
        ctx,
        "relancer_solde",
        args,
        async () => {
          const { booking: b, history } = await findBooking(ctx, args.reservation);
          const balance = b.totalCents - b.paidCents;
          if (b.status !== "confirmed") return { blocked: true, text: `${b.reference} n'est pas confirmée — pas de solde à relancer.` };
          if (!b.guestEmail) return { blocked: true, text: `${b.reference} n'a pas d'adresse e-mail client.` };
          if (balance <= 0) return { blocked: true, text: `${b.reference} est intégralement réglée.` };
          const last = history.find((h) => h.action === "email.balance_reminder");
          return {
            text: [
              `Envoyer à ${b.guestEmail} (${guestLabel(b)}) un rappel de solde de ${euros(balance)} pour ${b.reference} — ${b.unitName ?? b.unitId}, arrivée ${frDate(b.checkin)}${b.balanceDueDate ? `, échéance ${frDate(b.balanceDueDate)}` : ""}.`,
              last ? `Dernière relance manuelle : ${last.createdAt.slice(0, 16)} UTC.` : "Aucune relance manuelle à ce jour.",
            ].join("\n"),
            state: { id: b.id, to: b.guestEmail, balance, lastReminder: last?.createdAt ?? null },
            data: { id: b.id, reference: b.reference },
          };
        },
        async (d) => {
          const r = await ctx.client.post<{ ok: boolean; balanceCents: number }>(`/api/admin/bookings/${d.id}/balance-reminder`, {});
          return `Fait : rappel de solde (${euros(r.balanceCents)}) mis en file d'envoi pour ${d.reference}.`;
        },
      ),
    ),
  );
}
