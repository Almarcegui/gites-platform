// Outillage partagé par les outils : contexte, résultats, erreurs, formats.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, NetworkError, type GitesClient, qs } from "./client.js";
import type { Confirmations } from "./confirmation.js";
import { euros, frDate, isIsoDate, nights, todayInZone } from "./dates.js";
import { logEvent } from "./log.js";
import { ResolutionError, type Referentiel } from "./referentiel.js";
import type { Booking, BookingDetail, Conflict } from "./api-types.js";

export interface Ctx {
  client: GitesClient;
  ref: Referentiel;
  confirmations: Confirmations;
  now: () => Date;
}

export class UsageError extends Error {}

export function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}
export function fail(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

/** Enveloppe commune : erreurs lisibles et actionnables, journal sans donnée. */
export function wrap<A>(tool: string, fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const started = Date.now();
    try {
      const r = await fn(args);
      logEvent("outil", { nom: tool, issue: r.isError ? "refus" : "ok", ms: Date.now() - started });
      return r;
    } catch (e) {
      logEvent("outil", { nom: tool, issue: "erreur", ms: Date.now() - started, type: e instanceof Error ? e.constructor.name : "inconnu" });
      return fail(describeError(e));
    }
  };
}

export function describeError(e: unknown): string {
  if (e instanceof UsageError || e instanceof ResolutionError) return e.message;
  if (e instanceof NetworkError) return `${e.message}. Réessayer plus tard ; vérifier GITES_URL si cela persiste.`;
  if (e instanceof ApiError) {
    const parts = [`La plateforme a refusé (${e.status}) : ${e.message}.`];
    const b = e.body ?? {};
    const conflicts = Array.isArray(b.conflicts) ? (b.conflicts as Conflict[]) : [];
    const blocks = Array.isArray(b.blocks) ? (b.blocks as { reason: string; unitName: string; checkin: string; checkout: string }[]) : [];
    for (const c of conflicts) parts.push(`- occupé par ${c.reference} (${c.unitName}) du ${frDate(c.checkin)} au ${frDate(c.checkout)}`);
    for (const k of blocks) parts.push(`- blocage « ${k.reason} » (${k.unitName}) du ${frDate(k.checkin)} au ${frDate(k.checkout)}`);
    if (Array.isArray(b.details)) parts.push(`Détail : ${(b.details as string[]).map(quoteError).join(" ; ")}`);
    return parts.join("\n");
  }
  return `Erreur inattendue du connecteur : ${e instanceof Error ? e.message : String(e)}`;
}

// --- schémas réutilisés ------------------------------------------------------

export const zDate = z
  .string()
  .refine(isIsoDate, "date attendue au format AAAA-MM-JJ (ex. 2026-06-12)");

export const zDomaine = z
  .union([z.string().min(1), z.number().int().positive()])
  .optional()
  .describe("Domaine (« Pré Moré », « Moulin de Braives » ou son id). Absent = tous les domaines.");

export const zHebergement = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe("Hébergement par nom (« La Scierie », « Maison du Scieur », « Domaine entier », « Le Moulin ») ou id.");

export const zReservation = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe("Référence de la réservation (ex. « PM-2026-004 ») ou son id numérique.");

export function checkStay(arrivee: string, depart: string): void {
  if (arrivee >= depart) throw new UsageError("la date de départ doit être postérieure à la date d'arrivée");
  if (nights(arrivee, depart) > 120) throw new UsageError("séjour de plus de 120 nuits refusé par le connecteur — vérifier les dates");
}

// --- réservations --------------------------------------------------------------

export async function findBooking(ctx: Ctx, q: string | number): Promise<BookingDetail> {
  const asNum = typeof q === "number" ? q : /^\d+$/.test(q.trim()) ? Number(q.trim()) : NaN;
  if (Number.isInteger(asNum) && asNum > 0) {
    return ctx.client.get<BookingDetail>(`/api/admin/bookings/${asNum}`);
  }
  const wanted = String(q).trim().toUpperCase();
  const { bookings } = await ctx.client.get<{ bookings: Booking[] }>(`/api/admin/bookings${qs({ search: String(q).trim(), limit: 20 })}`);
  const hit = bookings.find((b) => b.reference.toUpperCase() === wanted);
  if (!hit) {
    if (bookings.length) {
      throw new UsageError(
        `aucune réservation de référence exacte « ${q} ». Candidates : ${bookings
          .slice(0, 8)
          .map((b) => `${b.reference} (${b.guestName ?? b.channelLabel ?? "—"}, ${b.checkin})`)
          .join(", ")}`,
      );
    }
    throw new UsageError(`réservation « ${q} » introuvable (chercher d'abord avec l'outil reservations)`);
  }
  return ctx.client.get<BookingDetail>(`/api/admin/bookings/${hit.id}`);
}

export function guestLabel(b: Booking): string {
  return b.guestName || b.channelLabel || "—";
}

export function statusLabel(b: Booking, nowSql: string): string {
  if (b.status === "confirmed") return "confirmée";
  if (b.status === "cancelled") return "annulée";
  return b.holdExpiresAt && b.holdExpiresAt > nowSql ? `option jusqu'au ${b.holdExpiresAt.slice(0, 16)} UTC` : "option expirée";
}

export function bookingLine(b: Booking, nowSql: string): string {
  const balance = Math.max(0, b.totalCents - b.paidCents);
  const pers = b.adults + b.children;
  const bits = [
    `${b.reference}`,
    `${b.unitName ?? `unité ${b.unitId}`}`,
    `${frDate(b.checkin)} → ${frDate(b.checkout)} (${nights(b.checkin, b.checkout)} n.)`,
    `${guestLabel(b)}, ${pers} pers.`,
    statusLabel(b, nowSql),
  ];
  if (b.totalCents > 0) bits.push(balance > 0 ? `reste dû ${euros(balance)} / ${euros(b.totalCents)}` : `soldée (${euros(b.totalCents)})`);
  if (b.source !== "direct" && b.source !== "manual") bits.push(`via ${b.channelLabel ?? b.source}`);
  return `- ${bits.join(" — ")}`;
}

export function sqlNow(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export function today(ctx: Ctx): string {
  return todayInZone(ctx.now());
}

const QUOTE_ERRORS: Record<string, string> = {
  invalid_dates: "dates invalides",
  no_rate: "aucun tarif défini sur ces dates",
  min_nights: "séjour minimum non atteint",
  checkin_day: "arrivée non autorisée ce jour-là",
  promo_invalid: "code promo non valable",
};
export function quoteError(code: string): string {
  return QUOTE_ERRORS[code] ?? code;
}

const JOURS_LONGS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
export function checkinDaysLabel(days: number[] | null): string {
  return days && days.length ? days.map((d) => JOURS_LONGS[d] ?? String(d)).join(", ") : "";
}
