// Signaux de DÉRIVE LENTE (issue #71) — pur, déterministe, sans I/O.
//
// La carte « Santé » du tableau de bord (src/db/repo.ts, healthSignals) ne voit
// que ce qui casse franchement : un paiement orphelin, un email en échec, une
// erreur journalisée. Elle dit « tout va bien » pendant qu'un flux Airbnb ne
// répond plus, qu'une saison s'est terminée sans successeur, qu'un client
// attend sa réponse depuis trois jours ou que le traitement planifié est mort.
// Ces quatre pannes-là sont silencieuses : rien n'échoue, il ne se passe
// simplement plus rien.
//
// Chaque signal porte le lien de l'écran où on agit — la convention des alertes
// cliquables du tableau de bord (issue #48).
//
// Les quatre détecteurs sont volontairement séparés et purs : ils prennent des
// données déjà lues, jamais une base. Le rassemblement SQL vit dans
// src/db/repo.ts (collectDriftInput).

import { addDays, type IsoDate } from "./dates";
import { rateCalendar, type RateOverride, type RateRule, type Season, type UnitPricingInfo } from "./pricing";

/** Seuils. Volontairement exportés : les tests s'y accrochent plutôt que de
 *  recopier des constantes, et un réglage futur n'a qu'un seul endroit à changer. */
export const ICAL_STALE_HOURS = 24;
export const MESSAGE_UNANSWERED_HOURS = 48;
export const CRON_SILENT_MINUTES = 30;
export const RATE_HORIZON_DAYS = 90;

export type DriftKind = "ical_stale" | "unit_no_rate" | "message_unanswered" | "cron_silent";

export interface DriftSignal {
  kind: DriftKind;
  /** Étiquette courte de la colonne de gauche, façon carte « Santé ». */
  label: string;
  /** Une phrase, en français, qui dit ce qui dérive et depuis quand. */
  detail: string;
  /** Écran où l'on agit — route à hash du back-office (issue #48). */
  href: string;
}

/** Horodatage SQLite UTC ('YYYY-MM-DD HH:MM:SS') → millisecondes, ou null.
 *  Sans le 'Z', Date.parse invite le fuseau local du runtime. */
function parseSqlUtc(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const parsed = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(parsed) ? null : parsed;
}

function hoursSince(ts: string | null | undefined, now: Date): number | null {
  const ms = parseSqlUtc(ts);
  return ms == null ? null : (now.getTime() - ms) / 3_600_000;
}

/** 12,4 h → « 12 h » · 49,8 h → « 2 jours » — on parle à un hôtelier, pas à une sonde. */
function humanAge(hours: number): string {
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} jours`;
}

/** '2026-09-14' → '14/09/2026'. */
function frDate(iso: IsoDate): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------
// 1. Flux iCal muet
// ---------------------------------------------------------------------------

export interface FeedState {
  id: number;
  name: string;
  unitName?: string | null;
  active: boolean;
  /** Dernier relevé réussi ou non — format sqlNow, null si jamais relevé. */
  lastSyncAt: string | null;
  /** Création du flux : sert de point de départ quand il n'a jamais été relevé,
   *  sinon un flux ajouté il y a deux minutes s'annoncerait déjà en dérive. */
  createdAt?: string | null;
}

/** Flux actifs sans relevé depuis plus de 24 h. Un flux inactif est un choix,
 *  pas une dérive : on l'ignore. */
export function detectStaleFeeds(feeds: readonly FeedState[], now: Date = new Date()): DriftSignal[] {
  const out: DriftSignal[] = [];
  for (const f of feeds) {
    if (!f.active) continue;
    const reference = f.lastSyncAt ?? f.createdAt ?? null;
    const age = hoursSince(reference, now);
    if (age == null || age <= ICAL_STALE_HOURS) continue;
    const where = f.unitName ? ` (${f.unitName})` : "";
    out.push({
      kind: "ical_stale",
      label: "Flux iCal",
      detail: f.lastSyncAt
        ? `« ${f.name} »${where} — aucun relevé depuis ${humanAge(age)}. Le canal peut vendre des dates déjà prises.`
        : `« ${f.name} »${where} — jamais relevé depuis son ajout, il y a ${humanAge(age)}.`,
      href: "#/ical",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Unité active sans tarif applicable sur les 90 prochains jours
// ---------------------------------------------------------------------------

export interface UnitRateTarget {
  active: boolean;
  pricingUnit: UnitPricingInfo;
}

/** Une unité active dont tout ou partie des 90 prochains jours n'est couvert par
 *  aucun tarif : ni surcharge, ni règle de saison, ni tarif de base. Le moteur
 *  de devis répond `no_rate` sur ces dates — l'unité est invendable, en ligne
 *  comme au téléphone, et rien ne le dit. */
export function detectUnitsWithoutRate(
  units: readonly UnitRateTarget[],
  from: IsoDate,
  seasons: readonly Season[],
  rateRules: readonly RateRule[],
  rateOverrides: readonly RateOverride[] = [],
  horizonDays: number = RATE_HORIZON_DAYS,
): DriftSignal[] {
  const to = addDays(from, horizonDays);
  const out: DriftSignal[] = [];
  for (const u of units) {
    if (!u.active) continue;
    const days = rateCalendar(u.pricingUnit, from, to, [...seasons], [...rateRules], rateOverrides);
    const uncovered = days.filter((d) => d.priceCents == null);
    if (uncovered.length === 0) continue;
    const first = uncovered[0]!.date;
    out.push({
      kind: "unit_no_rate",
      label: "Tarifs",
      detail:
        uncovered.length === days.length
          ? `« ${u.pricingUnit.name} » n'a aucun tarif applicable sur les ${horizonDays} prochains jours : impossible à vendre.`
          : `« ${u.pricingUnit.name} » — ${uncovered.length} des ${horizonDays} prochains jours sans tarif applicable, à partir du ${frDate(first)}.`,
      href: "#/tarifs",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Message client sans réponse depuis plus de 48 h
// ---------------------------------------------------------------------------

export interface MessageState {
  id: number;
  direction: "in" | "out";
  status: "nouveau" | "traité";
  receivedAt: string; // format sqlNow
  fromName?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  bookingId?: number | null;
  bookingReference?: string | null;
  guestId?: number | null;
}

/** Clé de fil : la même que celle du back-office — la réservation d'abord,
 *  le client ensuite, l'adresse email en dernier recours.
 *
 *  Sur cette dernière, l'adresse du CLIENT est celle qui identifie le fil :
 *  `from_email` pour un entrant, `to_email` pour notre réponse. Sans cette
 *  bascule, une réponse à un email non rattaché (ni résa ni client connu)
 *  ouvrirait un fil à notre propre adresse et laisserait la question du client
 *  éternellement « sans réponse ». */
function threadKey(m: MessageState): string {
  if (m.bookingId) return `booking:${m.bookingId}`;
  if (m.guestId) return `guest:${m.guestId}`;
  const address = (m.direction === "out" ? m.toEmail : m.fromEmail) ?? "";
  // Sans la moindre attache, chaque message est son propre fil : les agglomérer
  // sous une clé vide ferait passer une seule réponse pour la réponse à tous.
  return address ? `email:${address.toLowerCase()}` : `orphelin:${m.id}`;
}

/** Fils dont le dernier message est un message CLIENT, toujours marqué
 *  « nouveau », vieux de plus de 48 h. Une réponse de l'équipe postérieure
 *  ferme le fil, et un message passé en « traité » aussi : on répond parfois au
 *  téléphone, et cette action-là doit compter. */
export function detectUnansweredMessages(messages: readonly MessageState[], now: Date = new Date()): DriftSignal[] {
  const threads = new Map<string, MessageState[]>();
  for (const m of messages) {
    const key = threadKey(m);
    const list = threads.get(key);
    if (list) list.push(m);
    else threads.set(key, [m]);
  }

  const out: DriftSignal[] = [];
  for (const list of threads.values()) {
    const sorted = [...list].sort((a, b) =>
      a.receivedAt === b.receivedAt ? a.id - b.id : a.receivedAt < b.receivedAt ? -1 : 1,
    );
    const last = sorted[sorted.length - 1];
    if (!last || last.direction !== "in" || last.status === "traité") continue;
    const age = hoursSince(last.receivedAt, now);
    if (age == null || age <= MESSAGE_UNANSWERED_HOURS) continue;
    const who = last.fromName || last.fromEmail || "un client";
    const ref = last.bookingReference ? ` (${last.bookingReference})` : "";
    out.push({
      kind: "message_unanswered",
      label: "Message",
      detail: `${who}${ref} attend une réponse depuis ${humanAge(age)}.`,
      href: "#/messages",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Cron muet
// ---------------------------------------------------------------------------

/** Le traitement planifié écrit son battement de cœur EN TÊTE de chaque tick
 *  (`cron_last_run` dans app_settings, issue #21). Passé 30 min — deux ticks
 *  manqués sur un cron aux 15 minutes — plus rien ne tourne : ni import iCal,
 *  ni rappel de solde, ni synchro des canaux.
 *
 *  `null` (jamais tourné) n'est PAS une dérive : c'est l'état normal d'une mise
 *  en service toute fraîche, et `/api/public/health` fait déjà le même choix. */
export function detectSilentCron(lastCronAt: string | null, now: Date = new Date()): DriftSignal[] {
  const ms = parseSqlUtc(lastCronAt);
  if (ms == null) return [];
  const minutes = (now.getTime() - ms) / 60_000;
  if (minutes <= CRON_SILENT_MINUTES) return [];
  const age = minutes < 120 ? `${Math.floor(minutes)} min` : humanAge(minutes / 60);
  return [
    {
      kind: "cron_silent",
      label: "Traitement planifié",
      detail: `Aucun passage depuis ${age} — imports iCal, rappels de solde et synchro des canaux sont à l'arrêt. Relève les flux à la main en attendant.`,
      href: "#/ical",
    },
  ];
}

// ---------------------------------------------------------------------------
// Rassemblement
// ---------------------------------------------------------------------------

export interface DriftInput {
  feeds: readonly FeedState[];
  units: readonly UnitRateTarget[];
  today: IsoDate;
  seasons: readonly Season[];
  rateRules: readonly RateRule[];
  rateOverrides: readonly RateOverride[];
  messages: readonly MessageState[];
  lastCronAt: string | null;
}

/** Les quatre signaux, dans l'ordre où ils comptent pour l'exploitation :
 *  ce qui vend faux d'abord, ce qui fait attendre un client ensuite. */
export function detectDrift(input: DriftInput, now: Date = new Date()): DriftSignal[] {
  return [
    ...detectStaleFeeds(input.feeds, now),
    ...detectUnitsWithoutRate(input.units, input.today, input.seasons, input.rateRules, input.rateOverrides),
    ...detectUnansweredMessages(input.messages, now),
    ...detectSilentCron(input.lastCronAt, now),
  ];
}
