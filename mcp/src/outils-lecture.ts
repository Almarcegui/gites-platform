// Outils de LECTURE : aucun ne modifie la plateforme.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { qs } from "./client.js";
import {
  bookingLine, checkStay, checkinDaysLabel, type Ctx, describeError, findBooking, guestLabel, quoteError, sqlNow, text, today,
  UsageError, wrap, zDate, zDomaine, zHebergement, zReservation,
} from "./commun.js";
import { addDays, euros, frDate, nights, type Periode, periodWindow } from "./dates.js";
import type { Booking, Message, Overview, Quote, QuoteResponse } from "./api-types.js";
import type { Unit } from "./referentiel.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SOURCES: Record<string, string> = { direct: "site (réservation en ligne)", manual: "saisie de l'équipe", ical: "calendrier iCal", import: "import" };

const PERIODES = ["aujourdhui", "demain", "ce_week_end", "week_end_prochain", "7_jours", "30_jours"] as const;

async function bookingsOverlapping(ctx: Ctx, domaine: string | number | undefined, du: string, au: string): Promise<Booking[]> {
  const out: Booking[] = [];
  for (const p of await ctx.ref.propertiesFor(domaine)) {
    // Filtres du Worker : checkout > from ET checkin < to. Décalés d'un jour
    // pour garder les départs du premier jour et les arrivées du dernier.
    const { bookings } = await ctx.client.get<{ bookings: Booking[] }>(
      `/api/admin/bookings${qs({ property: p.id, from: addDays(du, -1), to: addDays(au, 1), limit: 1000 })}`,
    );
    out.push(...bookings);
  }
  return out;
}

function quoteSummary(q: Quote): string {
  const parts = [`total ${euros(q.totalCents)} pour ${q.nights} nuit${q.nights > 1 ? "s" : ""}`];
  const detail = [`hébergement ${euros(q.accommodationCents)}`];
  if (q.discountCents) detail.push(`remises −${euros(q.discountCents)}`);
  if (q.cleaningFeeCents) detail.push(`ménage ${euros(q.cleaningFeeCents)}`);
  if (q.optionsCents) detail.push(`options ${euros(q.optionsCents)}`);
  if (q.taxCents) detail.push(`taxe ${euros(q.taxCents)}`);
  parts.push(`(${detail.join(", ")})`);
  const pay =
    q.balanceDueDate === null
      ? `paiement intégral à la réservation`
      : `arrhes ${q.depositPct} % : ${euros(q.depositCents)} à la réservation, solde ${euros(q.balanceCents)} avant le ${frDate(q.balanceDueDate)}`;
  const lines = [parts.join(" "), pay];
  if (q.cautionCents) lines.push(`caution ${euros(q.cautionCents)}`);
  if (q.promoApplied) lines.push(`code promo appliqué : ${q.promoApplied}`);
  if (q.warnings.length) lines.push(`avertissements : ${q.warnings.map(quoteError).join(", ")}`);
  return lines.join(" ; ");
}

export function quoteBlockers(q: Quote): string[] {
  return q.errors.map((e) => {
    if (e === "min_nights") return `séjour minimum ${q.minNights} nuits sur ces dates`;
    if (e === "checkin_day") return `arrivée non autorisée ce jour-là (jours d'arrivée permis : ${checkinDaysLabel(q.checkinDays) || "voir tarifs"})`;
    return quoteError(e);
  });
}

export function conflictLines(r: QuoteResponse): string[] {
  return r.availability.conflicts.map(
    (c) =>
      `  · ${c.status === "blocked" ? `blocage « ${c.reference} »` : c.reference} — ${c.unitName}${c.viaLink ? " (liaison)" : ""} du ${frDate(c.checkin)} au ${frDate(c.checkout)}`,
  );
}

export async function quoteFor(ctx: Ctx, unit: Unit, arrivee: string, depart: string, adults: number, children: number, promo?: string): Promise<QuoteResponse> {
  return ctx.client.post<QuoteResponse>("/api/admin/quote", {
    unitId: unit.id, checkin: arrivee, checkout: depart, adults, children, promoCode: promo || null,
  });
}

async function candidateUnits(ctx: Ctx, hebergement: string | number | undefined, domaine: string | number | undefined, persons = 0): Promise<Unit[]> {
  if (hebergement !== undefined) return [await ctx.ref.unit(hebergement)];
  const props = new Set((await ctx.ref.propertiesFor(domaine)).map((p) => p.id));
  const { units } = await ctx.ref.load();
  return units.filter((u) => u.active && props.has(u.propertyId) && u.capacityMax >= persons);
}

export function registerReadTools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    "arrivees_departs",
    {
      title: "Arrivées et départs",
      description:
        "Qui arrive et qui part sur une période (réservations confirmées, plus les options en cours). " +
        "Répond à « qui arrive ce week-end ? », « des départs demain ? ». Le week-end va du vendredi au lundi. " +
        "Donner soit `periode`, soit `du`/`au` (inclus) ; par défaut les 7 prochains jours. " +
        "Renvoie, par jour, l'hébergement, le client, le nombre de personnes, la référence et le reste dû.",
      inputSchema: {
        periode: z.enum(PERIODES).optional().describe("Raccourci de période (ignoré si `du` est donné)."),
        du: zDate.optional().describe("Premier jour inclus, AAAA-MM-JJ."),
        au: zDate.optional().describe("Dernier jour inclus, AAAA-MM-JJ (défaut : `du`)."),
        domaine: zDomaine,
      },
      annotations: READ,
    },
    wrap("arrivees_departs", async ({ periode, du, au, domaine }) => {
      const t = today(ctx);
      const win = du ? { du, au: au ?? du } : periodWindow((periode ?? "7_jours") as Periode, t);
      if (win.au < win.du) throw new UsageError("`au` doit être postérieur ou égal à `du`");
      if (nights(win.du, win.au) > 92) throw new UsageError("période limitée à 3 mois");
      const nowSql = sqlNow(ctx.now());
      const all = await bookingsOverlapping(ctx, domaine, win.du, win.au);
      const live = all.filter((b) => b.status === "confirmed" || (b.status === "pending" && !!b.holdExpiresAt && b.holdExpiresAt > nowSql));
      const arrivals = live.filter((b) => b.checkin >= win.du && b.checkin <= win.au).sort((a, b) => a.checkin.localeCompare(b.checkin));
      const departures = live.filter((b) => b.checkout >= win.du && b.checkout <= win.au).sort((a, b) => a.checkout.localeCompare(b.checkout));
      const staying = live.filter((b) => b.checkin < win.du && b.checkout > win.au);
      const head = `Du ${frDate(win.du)} au ${frDate(win.au)} (aujourd'hui : ${frDate(t)}).`;
      const out = [head, "", `Arrivées (${arrivals.length}) :`];
      out.push(...(arrivals.length ? arrivals.map((b) => bookingLine(b, nowSql)) : ["- aucune"]));
      out.push("", `Départs (${departures.length}) :`);
      out.push(...(departures.length ? departures.map((b) => bookingLine(b, nowSql)) : ["- aucun"]));
      if (staying.length) out.push("", `Séjours en cours sur toute la période (${staying.length}) :`, ...staying.map((b) => bookingLine(b, nowSql)));
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "disponibilite",
    {
      title: "Disponibilité",
      description:
        "Dit si un hébergement est libre entre deux dates, en tenant compte des liaisons (le Domaine entier occupe " +
        "les deux maisons et inversement), des blocages manuels et des options en cours. Sans `hebergement`, teste " +
        "tous les hébergements actifs. Signale aussi les règles de séjour (minimum de nuits, jour d'arrivée). " +
        "`depart` = jour du départ (la nuit précédente est la dernière occupée).",
      inputSchema: {
        arrivee: zDate.describe("Jour d'arrivée, AAAA-MM-JJ."),
        depart: zDate.describe("Jour de départ, AAAA-MM-JJ."),
        hebergement: zHebergement.optional(),
        domaine: zDomaine,
      },
      annotations: READ,
    },
    wrap("disponibilite", async ({ arrivee, depart, hebergement, domaine }) => {
      checkStay(arrivee, depart);
      const units = await candidateUnits(ctx, hebergement, domaine);
      const n = nights(arrivee, depart);
      const out = [`Du ${frDate(arrivee)} au ${frDate(depart)} (${n} nuit${n > 1 ? "s" : ""}) :`];
      for (const u of units) {
        const r = await quoteFor(ctx, u, arrivee, depart, 1, 0);
        if (r.availability.available) {
          const rules = quoteBlockers(r.quote);
          out.push(`- ${u.name} : LIBRE${rules.length ? ` — mais ${rules.join(" ; ")}` : ""}`);
        } else {
          out.push(`- ${u.name} : OCCUPÉ`, ...conflictLines(r));
        }
      }
      if (arrivee < today(ctx)) out.push("", "Attention : la date d'arrivée est passée.");
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "devis",
    {
      title: "Devis",
      description:
        "Calcule le prix d'un séjour avec le moteur tarifaire de la plateforme (saisons, surcharges, remises, ménage, " +
        "arrhes et date du solde) et dit si c'est vendable (disponibilité). Sans `hebergement`, chiffre tous les " +
        "hébergements actifs dont la capacité suffit. N'écrit rien : pour réserver, utiliser vente_telephone.",
      inputSchema: {
        arrivee: zDate.describe("Jour d'arrivée, AAAA-MM-JJ."),
        depart: zDate.describe("Jour de départ, AAAA-MM-JJ."),
        adultes: z.number().int().min(1).max(30).describe("Nombre d'adultes (au moins 1)."),
        enfants: z.number().int().min(0).max(30).default(0).describe("Nombre d'enfants."),
        hebergement: zHebergement.optional(),
        code_promo: z.string().max(40).optional().describe("Code promo éventuel."),
        domaine: zDomaine,
      },
      annotations: READ,
    },
    wrap("devis", async ({ arrivee, depart, adultes, enfants, hebergement, code_promo, domaine }) => {
      checkStay(arrivee, depart);
      const persons = adultes + (enfants ?? 0);
      const units = await candidateUnits(ctx, hebergement, domaine, hebergement === undefined ? persons : 0);
      if (!units.length) return text(`Aucun hébergement actif n'accueille ${persons} personnes.`);
      const out = [`Devis du ${frDate(arrivee)} au ${frDate(depart)}, ${adultes} adulte(s) + ${enfants ?? 0} enfant(s) :`];
      for (const u of units) {
        if (persons > u.capacityMax) {
          out.push(`- ${u.name} : capacité dépassée (${persons} pers. pour ${u.capacityMax} max.)`);
          continue;
        }
        const r = await quoteFor(ctx, u, arrivee, depart, adultes, enfants ?? 0, code_promo);
        const dispo = r.availability.available ? "disponible" : "NON DISPONIBLE";
        if (!r.quote.ok) {
          out.push(`- ${u.name} : pas de prix — ${quoteBlockers(r.quote).join(" ; ")} (${dispo})`);
        } else {
          out.push(`- ${u.name} (${dispo}) : ${quoteSummary(r.quote)}`);
        }
        if (!r.availability.available) out.push(...conflictLines(r));
      }
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "fiche_reservation",
    {
      title: "Fiche réservation",
      description:
        "Fiche complète d'une réservation : séjour, client et coordonnées, montants (total, payé, reste dû, échéance), " +
        "paiements, e-mails envoyés, historique des actions et notes. Accepte la référence (PM-2026-004) ou l'id.",
      inputSchema: { reservation: zReservation },
      annotations: READ,
    },
    wrap("fiche_reservation", async ({ reservation }) => {
      const { booking: b, payments, emails, history } = await findBooking(ctx, reservation);
      const nowSql = sqlNow(ctx.now());
      const balance = Math.max(0, b.totalCents - b.paidCents);
      const out = [
        `${b.reference} (id ${b.id}) — ${b.status === "confirmed" ? "confirmée" : b.status === "cancelled" ? "ANNULÉE" : "option"}`,
        `Hébergement : ${b.unitName ?? b.unitId}`,
        `Séjour : ${frDate(b.checkin)} → ${frDate(b.checkout)} (${nights(b.checkin, b.checkout)} nuits), ${b.adults} adulte(s) + ${b.children} enfant(s)`,
        `Client : ${guestLabel(b)}${b.guestEmail ? ` <${b.guestEmail}>` : " (pas d'e-mail)"}`,
        `Origine : ${SOURCES[b.source] ?? b.source}${b.channelLabel ? ` (${b.channelLabel})` : ""}, créée le ${b.createdAt.slice(0, 10)}`,
        `Montants : total ${euros(b.totalCents)}, payé ${euros(b.paidCents)}, reste dû ${euros(balance)}${b.balanceDueDate ? ` (échéance ${frDate(b.balanceDueDate)})` : ""}`,
      ];
      if (b.status === "pending") out.push(`Option : ${b.holdExpiresAt && b.holdExpiresAt > nowSql ? `active jusqu'au ${b.holdExpiresAt} UTC` : "expirée"}`);
      if (b.status === "cancelled") out.push(`Annulée le ${b.cancelledAt ?? "?"}${b.cancelReason ? ` — ${b.cancelReason}` : ""}`);
      if (b.promoCode) out.push(`Code promo : ${b.promoCode}`);
      if (b.guestNotes) out.push(`Note du client : ${b.guestNotes}`);
      if (b.internalNotes) out.push(`Notes internes : ${b.internalNotes}`);
      out.push("", `Paiements (${payments.length}) :`);
      out.push(
        ...(payments.length
          ? payments.map((p) => `- ${(p.receivedAt ?? p.createdAt).slice(0, 10)} ${p.kind} ${p.method} ${euros(p.amountCents)} — ${p.status}${p.outcome ? ` (${p.outcome})` : ""}`)
          : ["- aucun"]),
      );
      out.push("", `E-mails (${emails.length}) :`);
      out.push(...(emails.length ? emails.slice(0, 10).map((e) => `- ${e.createdAt.slice(0, 16)} ${e.kind} — ${e.status} — « ${e.subject} »`) : ["- aucun"]));
      if (history.length) {
        out.push("", "Historique (récent d'abord) :");
        out.push(...history.slice(0, 10).map((h) => `- ${h.createdAt.slice(0, 16)} ${h.action}`));
      }
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "reservations",
    {
      title: "Réservations",
      description:
        "Liste de réservations filtrée : période (a_venir, en_cours, passees), statut, recherche par nom, e-mail ou " +
        "référence, fenêtre de dates (séjours qui chevauchent du/au). Triée par date d'arrivée. Pour le détail d'une " +
        "réservation, utiliser fiche_reservation.",
      inputSchema: {
        periode: z.enum(["a_venir", "en_cours", "passees"]).optional(),
        statut: z.enum(["confirmee", "option", "annulee"]).optional(),
        recherche: z.string().min(2).max(80).optional().describe("Nom, prénom, e-mail ou référence (recherche partielle)."),
        du: zDate.optional().describe("Séjours qui se terminent après ce jour."),
        au: zDate.optional().describe("Séjours qui commencent avant ce jour."),
        domaine: zDomaine,
        limite: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ,
    },
    wrap("reservations", async ({ periode, statut, recherche, du, au, domaine, limite }) => {
      const period = periode === "a_venir" ? "upcoming" : periode === "en_cours" ? "current" : periode === "passees" ? "past" : undefined;
      const status = statut === "confirmee" ? "confirmed" : statut === "option" ? "pending" : statut === "annulee" ? "cancelled" : undefined;
      const prop = await ctx.ref.property(domaine);
      const { bookings } = await ctx.client.get<{ bookings: Booking[] }>(
        `/api/admin/bookings${qs({ property: prop?.id, period, status, search: recherche, from: du, to: au, limit: limite })}`,
      );
      const nowSql = sqlNow(ctx.now());
      if (!bookings.length) return text("Aucune réservation ne correspond.");
      const lim = limite ?? 20;
      return text([`${bookings.length} réservation(s)${bookings.length >= lim ? ` (limite ${lim} atteinte — affiner ou augmenter « limite »)` : ""} :`, ...bookings.map((b) => bookingLine(b, nowSql))].join("\n"));
    }),
  );

  server.registerTool(
    "messages_en_attente",
    {
      title: "Messages clients en attente",
      description:
        "Messages des clients (e-mails, formulaire) non encore traités, du plus récent au plus ancien, avec un extrait. " +
        "Avec `message_id`, renvoie le fil complet de la conversation (pour préparer une réponse avec repondre_client).",
      inputSchema: {
        message_id: z.number().int().positive().optional().describe("Id d'un message : renvoie tout son fil."),
        domaine: zDomaine,
        limite: z.number().int().min(1).max(50).default(15),
      },
      annotations: READ,
    },
    wrap("messages_en_attente", async ({ message_id, domaine, limite }) => {
      if (message_id) {
        const { message, thread } = await ctx.client.get<{ message: Message; thread: Message[] }>(`/api/admin/messages/${message_id}/thread`);
        const out = [
          `Fil du message ${message.id} — « ${message.subject} »${message.bookingReference ? ` (réservation ${message.bookingReference})` : ""} — statut : ${message.status}`,
        ];
        for (const m of thread) {
          const who = m.direction === "in" ? `${m.fromName ?? ""} <${m.fromEmail}>`.trim() : `équipe → ${m.toEmail ?? "fil seulement"}`;
          out.push("", `[${m.receivedAt.slice(0, 16)}] ${who}${m.id === message.id ? "  ← message visé" : ""}`, clip(m.bodyText, 1500));
        }
        return text(out.join("\n"));
      }
      const prop = await ctx.ref.property(domaine);
      const r = await ctx.client.get<{ messages: Message[]; note?: string }>(`/api/admin/messages${qs({ property: prop?.id, status: "nouveau" })}`);
      if (r.note) return text(`Messagerie indisponible : ${r.note}`);
      const list = r.messages.slice(0, limite ?? 15);
      if (!list.length) return text("Aucun message client en attente.");
      const out = [`${r.messages.length} message(s) en attente${r.messages.length > list.length ? ` (${list.length} affichés)` : ""} :`];
      for (const m of list) {
        out.push(
          `- id ${m.id} — ${m.receivedAt.slice(0, 16)} — ${m.fromName ?? ""} <${m.fromEmail}> — « ${m.subject} »${m.bookingReference ? ` — résa ${m.bookingReference}` : ""}`,
          `  ${clip(m.bodyText.replace(/\s+/g, " "), 280)}`,
        );
      }
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "paiements_en_attente",
    {
      title: "Paiements en attente",
      description:
        "Soldes restant dus sur les réservations confirmées (séjours à venir, en cours, ou terminés depuis moins de " +
        "90 jours), triés par échéance, avec les retards signalés. Répond à « où en sont les paiements ? ». " +
        "Pour relancer un client, utiliser relancer_solde.",
      inputSchema: { domaine: zDomaine, en_retard_seulement: z.boolean().default(false) },
      annotations: READ,
    },
    wrap("paiements_en_attente", async ({ domaine, en_retard_seulement }) => {
      const t = today(ctx);
      const due: (Booking & { balance: number; overdue: boolean })[] = [];
      for (const p of await ctx.ref.propertiesFor(domaine)) {
        const { bookings } = await ctx.client.get<{ bookings: Booking[] }>(
          `/api/admin/bookings${qs({ property: p.id, status: "confirmed", from: addDays(t, -90), limit: 1000 })}`,
        );
        for (const b of bookings) {
          const balance = b.totalCents - b.paidCents;
          if (balance <= 0) continue;
          const overdue = (!!b.balanceDueDate && b.balanceDueDate <= t) || b.checkin <= t;
          if (en_retard_seulement && !overdue) continue;
          due.push({ ...b, balance, overdue });
        }
      }
      if (!due.length) return text(en_retard_seulement ? "Aucun solde en retard." : "Aucun solde en attente.");
      due.sort((a, b) => (a.balanceDueDate ?? a.checkin).localeCompare(b.balanceDueDate ?? b.checkin));
      const total = due.reduce((s, b) => s + b.balance, 0);
      const late = due.filter((b) => b.overdue);
      const out = [
        `${due.length} solde(s) dû(s), total ${euros(total)} — dont ${late.length} en retard (${euros(late.reduce((s, b) => s + b.balance, 0))}). Aujourd'hui : ${frDate(t)}.`,
      ];
      for (const b of due) {
        out.push(
          `- ${b.overdue ? "EN RETARD " : ""}${b.reference} — ${b.unitName ?? b.unitId} — ${guestLabel(b)} — arrivée ${frDate(b.checkin)} — reste ${euros(b.balance)} / ${euros(b.totalCents)}${b.balanceDueDate ? ` — échéance ${frDate(b.balanceDueDate)}` : ""}${b.guestEmail ? "" : " — pas d'e-mail"}`,
        );
      }
      return text(out.join("\n"));
    }),
  );

  server.registerTool(
    "sante",
    {
      title: "Santé de la plateforme",
      description:
        "État de marche : la plateforme répond-elle, le traitement planifié (cron) tourne-t-il, et par domaine les " +
        "signaux de la carte Santé du back-office (paiements orphelins, trop-perçus, e-mails en échec, erreurs, " +
        "synchro Beds24 figée, flux iCal en erreur, dérives lentes) ainsi que les options en cours et les messages non lus.",
      inputSchema: { domaine: zDomaine },
      annotations: READ,
    },
    wrap("sante", async ({ domaine }) => {
      const out: string[] = [];
      try {
        const { status, body: pub } = await ctx.client.publicGet<{ ok: boolean; lastCronAt: string | null; cronAgeMinutes: number | null }>("/api/public/health");
        const age = pub?.cronAgeMinutes ?? null;
        out.push(
          `Plateforme : ${status === 200 && pub?.ok ? "en ligne" : `EN PANNE (sonde publique HTTP ${status})`} — ${ctx.client.host}`,
          `Dernier passage du cron : ${pub?.lastCronAt ? `${pub.lastCronAt} UTC (il y a ${age} min)${age != null && age > 30 ? " — EN RETARD" : ""}` : "jamais enregistré"}`,
        );
      } catch (e) {
        out.push(`Plateforme : sonde publique en échec (${e instanceof Error ? e.message : String(e)})`);
      }
      let props: Awaited<ReturnType<typeof ctx.ref.propertiesFor>>;
      try {
        props = await ctx.ref.propertiesFor(domaine);
      } catch (e) {
        out.push("", `Back-office : inaccessible — ${describeError(e)}`);
        return text(out.join("\n"));
      }
      for (const p of props) {
        let o: Overview;
        try {
          o = await ctx.client.get<Overview>(`/api/admin/overview${qs({ property: p.id })}`);
        } catch (e) {
          out.push("", `${p.name} : santé illisible — ${describeError(e)}`);
          continue;
        }
        const h = o.health;
        out.push("", `${o.property.name} : ${h.ok ? "santé OK" : "à surveiller"}`);
        if (h.orphanPayments.length) out.push(`- paiements reçus sur réservation non confirmée : ${h.orphanPayments.map((x) => `${x.reference} ${euros(x.amountCents)}`).join(", ")}`);
        if (h.overpaidBookings.length) out.push(`- trop-perçus (remboursement à traiter au back-office) : ${h.overpaidBookings.map((x) => `${x.reference} ${euros(x.overpaidCents)}`).join(", ")}`);
        if (h.failedEmails.length) out.push(`- e-mails en échec : ${h.failedEmails.length} (${h.failedEmails.slice(0, 5).map((x) => `${x.kind}${x.reference ? ` ${x.reference}` : ""}`).join(", ")})`);
        if (h.recentErrors.length) out.push(`- erreurs récentes : ${h.recentErrors.slice(0, 5).map((x) => `${x.action} (${x.createdAt.slice(0, 16)})`).join(", ")}`);
        if (h.beds24Stale) out.push(`- synchro Beds24 figée depuis ${h.beds24StaleHours} h (risque de double réservation)`);
        for (const d of h.drift) out.push(`- ${d.label} : ${d.detail}`);
        if (o.alerts.feedAlerts.length) out.push(`- flux iCal en erreur : ${o.alerts.feedAlerts.map((f) => `${f.name} (${f.status})`).join(", ")}`);
        if (o.alerts.activeHolds.length) out.push(`- options en cours : ${o.alerts.activeHolds.map((x) => `${x.reference} ${x.unitName}`).join(", ")}`);
        if (o.alerts.overdueBalances.length) out.push(`- soldes en retard : ${o.alerts.overdueBalances.length} (voir paiements_en_attente)`);
        if (o.alerts.newEmails) out.push(`- messages clients non traités : ${o.alerts.newEmails} (voir messages_en_attente)`);
      }
      return text(out.join("\n"));
    }),
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… [tronqué]` : s;
}
