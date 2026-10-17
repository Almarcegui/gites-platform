// Synchronisation SORTANTE vers Beds24 : notre moteur est la source de vérité,
// Beds24 reçoit des états calculés (jamais de logique métier chez lui).
//
// Pour chaque unité mappée (units.beds24_room_id) on pousse, jour par jour :
//   numAvail  = 0/1 depuis isUnitFree — la liaison Scieur/Scierie/Domaine est
//               donc reflétée automatiquement (Domaine réservé chez nous →
//               les deux rooms Beds24 passent à 0 sans configuration Beds24) ;
//   price1    = notre prix nuit (rateCalendar, surcharges par jour comprises),
//               en euros, MAJORÉE de la majoration du canal de référence quand
//               le propriétaire en a choisi un (issue #31) ; jamais poussé si
//               le prix direct est nul ou négatif ;
//   minStay   = notre min-nuits du jour.
// Les jours consécutifs identiques sont regroupés en plages (payload compact).
//
// Déclenchement : cron 15 min (fenêtre glissante) + endpoint admin de push
// manuel. ⚠️ Dev local : les fetch sortants du Worker échouent sous VPN Emeria
// (cf. README § Beds24) — utiliser scripts/beds24_push_calendar.py ; en prod
// Cloudflare, ce module fonctionne tel quel.

import { addDays, isIsoDate, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { blocksAsSpans, isUnitFree } from "../core/availability";
import { rateCalendar, type UnitPricingInfo } from "../core/pricing";
import {
  audit,
  bookingsInWindow,
  cancelBooking,
  createBookingAtomic,
  getBookingByExternalUid,
  listBeds24Bookings,
  reactivateBookingAtomic,
  listLinks,
  manualBlocksInWindow,
  listRateRules,
  listRateOverridesForProperty,
  listSeasons,
  listUnits,
  moveBookingAtomic,
  updateBookingDatesAtomic,
  updateSettings,
  upsertGuest,
  type UnitRow,
} from "../db/repo";
import {
  CHANNEL_MARKUPS_KEY,
  parseChannelMarkups,
  parsePushChannel,
  pushedPriceCents,
  pushMarkupPct,
  PUSH_CHANNEL_KEY,
} from "../core/price-guardrails";
import { beds24UnitScope } from "../core/sync-conflicts";
import {
  NETWORK_RETRY_DELAYS_MS,
  beds24Configured,
  beds24Fetch,
  beds24Sleep,
  isBeds24NetworkError,
  withNetworkRetry,
} from "./beds24";
import { parsePriceLinking, PRICE_LINKING_KEY } from "../core/channel-promotions";
import { closeSeenSyncConflicts, closeUnseenSyncConflicts, noteSyncConflict } from "./sync-conflicts";
import { getSetting, setSetting } from "./settings";

export interface CalendarSpan {
  from: IsoDate;
  to: IsoDate;
  numAvail: number;
  price1?: number;
  minStay?: number;
}

/** Canal de référence dont la majoration s'applique aux prix poussés, et son
 *  taux. `channel: null` = on pousse le prix de vente directe (état par défaut,
 *  et comportement historique). Résolu au moment du push, jamais mis en cache :
 *  un changement de réglage doit se voir au push suivant. */
export interface PushMarkup {
  channel: string | null;
  label: string | null;
  pct: number;
}

export async function resolvePushMarkup(db: D1Database): Promise<PushMarkup> {
  // Prix dérivés actifs (lot 3) : le calendrier part au prix DIRECT, Beds24
  // applique la majoration de chaque plateforme (priceRules.priceLinking).
  // Majorer aussi ici compterait la commission deux fois.
  if (parsePriceLinking(await getSetting(db, PRICE_LINKING_KEY)).enabled) return { channel: null, label: null, pct: 0 };
  const channels = parseChannelMarkups(await getSetting(db, CHANNEL_MARKUPS_KEY));
  const channel = parsePushChannel(await getSetting(db, PUSH_CHANNEL_KEY), channels);
  return {
    channel,
    label: channels.find((c) => c.channel === channel)?.label ?? null,
    pct: pushMarkupPct(channels, channel),
  };
}

/** Jours → plages compactes aux valeurs identiques. */
export function compactSpans(
  days: { date: IsoDate; numAvail: number; price1?: number; minStay?: number }[],
): CalendarSpan[] {
  const spans: CalendarSpan[] = [];
  for (const d of days) {
    const last = spans[spans.length - 1];
    if (
      last &&
      last.numAvail === d.numAvail &&
      last.price1 === d.price1 &&
      last.minStay === d.minStay &&
      addDays(last.to, 1) === d.date
    ) {
      last.to = d.date;
    } else {
      spans.push({ from: d.date, to: d.date, numAvail: d.numAvail, price1: d.price1, minStay: d.minStay });
    }
  }
  return spans;
}

/** Calcule les plages à pousser pour toutes les unités mappées d'une propriété. */
export async function buildCalendarPush(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  days: number,
  /** Majoration déjà résolue par l'appelant — évite de relire le réglage deux
   *  fois quand le push la connaît déjà. */
  known?: PushMarkup,
): Promise<{ roomId: number; unitName: string; calendar: CalendarSpan[] }[]> {
  const to = addDays(from, days);
  const markup = known ?? (await resolvePushMarkup(db));
  const [units, links, seasons, rules, overrides, rows, blocks] = await Promise.all([
    listUnits(db, propertyId),
    listLinks(db, propertyId),
    listSeasons(db, propertyId),
    listRateRules(db, propertyId),
    listRateOverridesForProperty(db, propertyId, from, to),
    bookingsInWindow(db, propertyId, from, to),
    manualBlocksInWindow(db, propertyId, from, to),
  ]);
  const now = sqlNow();
  // Les blocages manuels ferment le stock poussé aux OTA exactement comme une
  // réservation : sans eux, Airbnb et Booking vendraient des nuits de travaux.
  const spans = [
    ...rows.map((b) => ({
      unitId: b.unitId, checkin: b.checkin, checkout: b.checkout,
      status: b.status, holdExpiresAt: b.holdExpiresAt,
    })),
    ...blocksAsSpans(blocks),
  ];
  const active = units.filter((u) => u.active);
  const physicalIds = new Set(active.filter((u) => !u.isComposite).map((u) => u.id));
  const toPricingUnit = (u: UnitRow): UnitPricingInfo => ({
    id: u.id,
    name: u.name,
    compositePricing: u.isComposite ? u.compositePricing : "own",
    cleaningFeeCents: u.cleaningFeeCents,
    components: u.isComposite
      ? links
          .filter((l) => l.unitId === u.id && physicalIds.has(l.blocksUnitId))
          .map((l) => {
            const c = active.find((x) => x.id === l.blocksUnitId);
            return { id: l.blocksUnitId, name: c?.name ?? "", cleaningFeeCents: c?.cleaningFeeCents ?? 0 };
          })
      : [],
  });

  const out = [];
  for (const u of active) {
    if (!u.beds24RoomId) continue;
    const rates = rateCalendar(toPricingUnit(u), from, to, seasons, rules, overrides);
    const days_ = rates.map((r) => ({
      date: r.date,
      numAvail: isUnitFree(u.id, r.date, addDays(r.date, 1), spans, links, now) ? 1 : 0,
      // Dernier filet avant les OTA : un prix nul ou négatif n'est jamais
      // poussé. Les écritures sont bornées côté API (issue #50), mais une
      // règle héritée du temps où le POST tolérait 0 traverserait sinon
      // jusqu'à Airbnb et Booking. Sans price1, Beds24 garde le prix en place.
      // La majoration s'applique APRÈS ce filet, sur un prix déjà validé : elle
      // ne peut donc ni ressusciter un prix nul, ni en inventer un. Elle n'est
      // pas non plus bornée par units.price_max_cents — ce plafond borne ce que
      // le propriétaire SAISIT en vente directe, pas le prix dérivé qu'on
      // affiche sur une place de marché.
      price1:
        r.priceCents != null && r.priceCents > 0 ? pushedPriceCents(r.priceCents, markup.pct) / 100 : undefined,
      minStay: r.minNights ?? undefined,
    }));
    out.push({ roomId: u.beds24RoomId, unitName: u.name, calendar: compactSpans(days_) });
  }
  return out;
}

/** Pousse les calendriers vers Beds24. Fenêtre par défaut : 400 jours. */
export async function pushCalendars(
  db: D1Database,
  env: Env,
  propertyId: number,
  days = 400,
  /** Attentes entre essais (tests). */
  opts: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ pushed: { roomId: number; unitName: string; spans: number }[]; markup: PushMarkup }> {
  if (!(await beds24Configured(env))) throw new Error("Beds24 non configuré");
  const markup = await resolvePushMarkup(db);
  // Panne RÉSEAU : on attend, puis on RECONSTRUIT le calendrier depuis la base
  // avant de renvoyer. Rejouer l'ancien corps risquerait d'écraser un push plus
  // récent (réservation prise entre-temps) par un état périmé ; reconstruit, le
  // corps est l'état absolu courant (disponibilité, prix, séjour minimum par
  // plage de dates), et deux envois successifs donnent le même résultat.
  const rooms = await withNetworkRetry(
    async () => {
      const built = await buildCalendarPush(db, propertyId, todayInZone(), days, markup);
      const body = built.map((r) => ({ roomId: r.roomId, calendar: r.calendar }));
      if (body.length > 0) await beds24Fetch(env, "/inventory/rooms/calendar", { method: "POST", body });
      return built;
    },
    true,
    opts.delaysMs ?? NETWORK_RETRY_DELAYS_MS,
    opts.sleep ?? beds24Sleep,
    isBeds24NetworkError,
  );
  // `markup` est remonté pour que l'écran « Plateformes » puisse dire, après un
  // push manuel, CE QUI a été envoyé — le prix direct ou le prix majoré.
  return { pushed: rooms.map((r) => ({ roomId: r.roomId, unitName: r.unitName, spans: r.calendar.length })), markup };
}

// ---------------------------------------------------------------------------
// Synchronisation ENTRANTE : les réservations des canaux OTA (via Beds24)
// descendent dans notre base — même mécanique éprouvée que l'import iCal
// (nouveau / déplacé / annulé / conflit → journal), mais avec les données
// riches de l'API (nom, email, téléphone, montant, canal).
// external_uid = 'beds24:<bookingId>' ; source = 'ical' (résa d'un canal
// externe synchronisé — choix documenté au README, pas de refonte du CHECK).
// ---------------------------------------------------------------------------

export interface Beds24Booking {
  id: number;
  roomId: number;
  status: string; // 'new' | 'confirmed' | 'request' | 'cancelled' | 'black' | …
  arrival: string;
  departure: string;
  numAdult?: number;
  numChild?: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  price?: number | null;
  channel?: string | null;     // 'airbnb', 'booking', …
  apiSource?: string | null;
  referer?: string | null;
}

export interface ChannelSyncResult {
  imported: number;
  updated: number;
  cancelled: number;
  /** Résas annulées côté canal puis rouvertes, réactivées chez nous. */
  reactivated: number;
  /** Résas déplacées vers un AUTRE logement côté canal (issue #19) — comptées
   *  à part des simples changements de dates, l'écart étant plus grave : deux
   *  calendriers faux au lieu d'un. */
  relocated: number;
  skipped: number;
  conflicts: string[];
  /** Conflits d'un passage précédent qui ne se reproduisent plus (issue #72). */
  resolvedConflicts: number;
  /** Résas dont le traitement a échoué — le pull continue quand même. */
  errors: string[];
}

const ACTIVE_STATUSES = new Set(["new", "confirmed", "request"]);

function channelLabel(b: Beds24Booking): string {
  const raw = (b.channel ?? b.apiSource ?? b.referer ?? "").toString().trim();
  if (!raw) return "Canal Beds24";
  const known: Record<string, string> = {
    airbnb: "Airbnb", booking: "Booking.com", bookingcom: "Booking.com",
    expedia: "Expedia", vrbo: "Vrbo", direct: "Beds24 direct",
  };
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  return known[key] ?? `${raw} (Beds24)`;
}

/** Applique une liste de résas Beds24 à notre base. Pur (pas de réseau) → testé.
 *
 *  `fullSweep` dit si la liste est l'ÉTAT COMPLET de la source sur le périmètre
 *  (rapatriement quotidien) ou une simple fenêtre incrémentale : de cela dépend
 *  ce qu'on a le droit de conclure sur les conflits qui n'y figurent pas. */
export async function applyChannelBookings(
  db: D1Database,
  bookings: Beds24Booking[],
  roomToUnit: Map<number, number>,
  now: Date = new Date(),
  options: { fullSweep?: boolean } = {},
): Promise<ChannelSyncResult> {
  const result: ChannelSyncResult = {
    imported: 0, updated: 0, cancelled: 0, reactivated: 0, relocated: 0, skipped: 0,
    conflicts: [], resolvedConflicts: 0, errors: [],
  };
  const nowSql = sqlNow(now);
  const today = todayInZone(now);
  const existing = await listBeds24Bookings(db);
  const byUid = new Map(existing.map((b) => [b.externalUid ?? "", b]));
  // Une détection non écrite interdit toute fermeture sur ce passage.
  const register = { ok: true };

  for (const b of bookings) {
    // Une résa qui casse ne doit JAMAIS emporter le rapatriement des autres :
    // sinon une seule ligne fautive gelait tout le flux du domaine, à chaque
    // passage du cron, jusqu'à intervention manuelle (issue #18).
    try {
      await applyOneChannelBooking(db, b, roomToUnit, byUid, result, { now, nowSql, today, register });
    } catch (e) {
      result.errors.push(`beds24:${b.id} : ${e instanceof Error ? e.message : String(e)}`);
      await audit(db, "cron", "beds24.booking.error", `beds24:${b.id}`, {
        error: e instanceof Error ? e.message : String(e),
        arrival: b.arrival,
        departure: b.departure,
      });
    }
  }

  // Conflits refermés (issue #72), et seulement ceux dont ce passage peut
  // réellement conclure quelque chose :
  //   · fenêtre INCRÉMENTALE → uniquement les résas que la fenêtre a rapportées
  //     et qui ne conflictent plus. Refermer tout ce qui n'a pas été revu y
  //     serait faux : après un déblocage forcé du curseur, la résa fautive sort
  //     de la fenêtre alors que le conflit tient toujours, et la première résa
  //     sans rapport effacerait l'alerte ;
  //   · rapatriement COMPLET → l'état de la source fait foi, ce qui n'y est
  //     plus a disparu pour de bon.
  // Dans les deux cas, une détection qui n'a pas pu être écrite gèle la
  // fermeture : sinon la panne effacerait le conflit qu'elle empêche de noter.
  if (register.ok) {
    const seenUids = bookings.map((b) => `beds24:${b.id}`);
    for (const unitId of new Set(roomToUnit.values())) {
      const scope = beds24UnitScope(unitId);
      result.resolvedConflicts += options.fullSweep
        ? await closeUnseenSyncConflicts(db, scope, nowSql)
        : await closeSeenSyncConflicts(db, scope, seenUids, nowSql);
    }
  }
  return result;
}

/** Traitement d'UNE résa canal. Extrait pour que l'appelant puisse isoler les
 *  échecs ligne par ligne. */
async function applyOneChannelBooking(
  db: D1Database,
  b: Beds24Booking,
  roomToUnit: Map<number, number>,
  byUid: Map<string, { id: number; unitId: number; reference: string; checkin: IsoDate; checkout: IsoDate }>,
  result: ChannelSyncResult,
  clock: { now: Date; nowSql: string; today: IsoDate; register: { ok: boolean } },
): Promise<void> {
  const { now, nowSql, today, register } = clock;
  const unitId = roomToUnit.get(b.roomId);
  const extUid = `beds24:${b.id}`;
  const known = byUid.get(extUid);
  if (!unitId) {
    result.skipped += 1;
    return;
  }
  if (!isIsoDate(b.arrival) || !isIsoDate(b.departure) || b.arrival >= b.departure) {
    result.skipped += 1;
    return;
  }

  if (!ACTIVE_STATUSES.has(b.status)) {
    // annulée (ou statut inconnu) côté canal → libérer si pas commencée
    if (known && known.checkin >= today) {
      if (await cancelBooking(db, known.id, `canal:${b.status}`, nowSql)) result.cancelled += 1;
    }
    return;
  }

  if (!known) {
    if (b.departure <= today) return; // séjour déjà terminé : rien à créer

    // La résa est peut-être connue mais ANNULÉE (rouverte côté canal) : elle
    // n'apparaît pas dans la liste de réconciliation, et une création
    // violerait l'unicité de external_uid. On réactive au lieu d'insérer,
    // après revérification de disponibilité — le créneau a pu être revendu.
    const archived = await getBookingByExternalUid(db, extUid);
    if (archived) {
      const back = await reactivateBookingAtomic(db, archived.id, archived.unitId, b.arrival, b.departure, nowSql);
      if (back) {
        result.reactivated += 1;
      } else {
        const label = `${archived.reference} : réactivation ${b.arrival}→${b.departure} impossible (créneau repris depuis l'annulation)`;
        result.conflicts.push(label);
        register.ok = (await noteSyncConflict(db, {
          source: "beds24", scope: beds24UnitScope(archived.unitId), kind: "reactivate",
          unitId: archived.unitId, checkin: b.arrival, checkout: b.departure, externalUid: extUid,
          bookingReference: archived.reference, channelLabel: channelLabel(b), label,
        }, nowSql)) && register.ok;
        await audit(db, "cron", "beds24.reactivate.conflict", `booking:${archived.id}`, {
          externalUid: extUid,
          reference: archived.reference,
          arrival: b.arrival,
          departure: b.departure,
        });
      }
      return;
    }

    const lastName = (b.lastName ?? "").trim() || channelLabel(b);
    const guestId = await upsertGuest(db, {
      email: (b.email ?? "").trim() || null,
      firstName: (b.firstName ?? "").trim() || null,
      lastName,
      phone: (b.phone ?? "").trim() || null,
    });
    const created = await createBookingAtomic(db, {
      unitId,
      checkin: b.arrival,
      checkout: b.departure,
      adults: Math.max(0, Math.floor(b.numAdult ?? 0)),
      children: Math.max(0, Math.floor(b.numChild ?? 0)),
      status: "confirmed",
      source: "ical",
      channelLabel: channelLabel(b),
      externalUid: extUid,
      guestId,
      totalCents: b.price != null ? Math.round(b.price * 100) : 0,
      internalNotes: `Résa ${channelLabel(b)} rapatriée de Beds24 (#${b.id})`,
      now,
    });
    if (created.ok) {
      result.imported += 1;
    } else {
      const label = `beds24:${b.id} ${b.arrival}→${b.departure} : créneau déjà pris localement`;
      result.conflicts.push(label);
      register.ok = (await noteSyncConflict(db, {
        source: "beds24", scope: beds24UnitScope(unitId), kind: "import", unitId,
        checkin: b.arrival, checkout: b.departure, externalUid: extUid,
        channelLabel: channelLabel(b), label,
      }, nowSql)) && register.ok;
    }
  } else if (known.unitId !== unitId) {
    // CHANGEMENT DE LOGEMENT (issue #19). La comparaison ne portait que sur les
    // dates : une résa basculée d'une maison à l'autre côté canal restait chez
    // nous sur l'ancienne. Résultat, DEUX calendriers faux — l'ancien bloqué
    // pour rien, le nouveau toujours en vente alors qu'il est occupé — sans le
    // moindre signalement. On le traite comme un déplacement, avec la même
    // vérification atomique de disponibilité, sur le logement de destination.
    const relocated = await moveBookingAtomic(db, known.id, unitId, b.arrival, b.departure, nowSql);
    if (relocated) {
      result.relocated += 1;
      await audit(db, "cron", "beds24.booking.relocated", `booking:${known.id}`, {
        externalUid: extUid, reference: known.reference,
        fromUnitId: known.unitId, toUnitId: unitId,
        arrival: b.arrival, departure: b.departure,
      });
    } else {
      const label = `${known.reference} : changement de logement (${known.unitId} → ${unitId}) ${b.arrival}→${b.departure} impossible (créneau occupé à destination)`;
      result.conflicts.push(label);
      register.ok = (await noteSyncConflict(db, {
        source: "beds24", scope: beds24UnitScope(unitId), kind: "relocate", unitId,
        checkin: b.arrival, checkout: b.departure, externalUid: extUid,
        bookingReference: known.reference, channelLabel: channelLabel(b), label,
      }, nowSql)) && register.ok;
      await audit(db, "cron", "beds24.relocate.conflict", `booking:${known.id}`, {
        externalUid: extUid, reference: known.reference,
        fromUnitId: known.unitId, toUnitId: unitId,
        arrival: b.arrival, departure: b.departure,
      });
    }
  } else if (known.checkin !== b.arrival || known.checkout !== b.departure) {
    const moved = await updateBookingDatesAtomic(db, known.id, known.unitId, b.arrival, b.departure, nowSql);
    if (moved) {
      result.updated += 1;
    } else {
      const label = `${known.reference} : déplacement ${b.arrival}→${b.departure} impossible (conflit)`;
      result.conflicts.push(label);
      register.ok = (await noteSyncConflict(db, {
        source: "beds24", scope: beds24UnitScope(known.unitId), kind: "move", unitId: known.unitId,
        checkin: b.arrival, checkout: b.departure, externalUid: extUid,
        bookingReference: known.reference, channelLabel: channelLabel(b), label,
      }, nowSql)) && register.ok;
    }
  }
}

/** État du curseur bloqué, en `app_settings` (aucune migration — issue #19). */
export function cursorBlockedKey(propertyId: number): string {
  return `beds24_cursor_blocked:${propertyId}`;
}

/** Au-delà de ce délai, un curseur bloqué est débloqué de force : un conflit
 *  qui demande un arbitrage humain (double vente réelle) peut durer des
 *  semaines, et chaque pull re-téléchargerait une fenêtre toujours plus large.
 *  Le rapatriement complet quotidien reste le filet qui couvre l'horizon. */
export const MAX_CURSOR_HOLD_DAYS = 3;

/** N'avance le curseur QUE si le lot est passé sans conflit ni erreur.
 *
 *  Avant (issue #19), `updateSettings` s'exécutait inconditionnellement : une
 *  résa refusée pour conflit sortait de la fenêtre `modifiedFrom` au pull
 *  suivant et n'était donc PLUS JAMAIS réessayée — l'écart devenait définitif.
 *  Le curseur retenu fait re-passer le même lot à chaque tick, jusqu'à ce que
 *  le conflit se résolve (annulation côté canal, arbitrage manuel). */
async function advanceCursorIfClean(
  db: D1Database,
  propertyId: number,
  next: string,
  result: ChannelSyncResult,
  now: Date,
): Promise<void> {
  const key = cursorBlockedKey(propertyId);
  const raw = await getSetting(db, key);
  const held = raw ? (JSON.parse(raw) as { since?: string }) : null;
  const clean = result.conflicts.length === 0 && result.errors.length === 0;

  if (clean) {
    await updateSettings(db, propertyId, { beds24_last_pull: next });
    if (held) {
      await setSetting(db, key, "");
      await audit(db, "cron", "beds24.cursor.resumed", `property:${propertyId}`, { heldSince: held.since ?? null });
    }
    return;
  }

  const sinceSql = held?.since ?? sqlNow(now);
  const heldMs = now.getTime() - Date.parse(sinceSql.replace(" ", "T") + "Z");
  const expired = Number.isFinite(heldMs) && heldMs > MAX_CURSOR_HOLD_DAYS * 86_400_000;

  if (expired) {
    await updateSettings(db, propertyId, { beds24_last_pull: next });
    await setSetting(db, key, "");
    await audit(db, "cron", "beds24.cursor.forced", `property:${propertyId}`, {
      heldSince: sinceSql, conflicts: result.conflicts.slice(0, 5), errors: result.errors.slice(0, 5),
    });
    return;
  }

  await setSetting(db, key, JSON.stringify({ since: sinceSql, conflicts: result.conflicts.slice(0, 5) }));
  if (!held) {
    // Journalisé au BASCULEMENT seulement : le cron passe 96 fois par jour, un
    // signalement par passage noierait le journal au lieu de l'alimenter.
    await audit(db, "cron", "beds24.cursor.held", `property:${propertyId}`, {
      since: sinceSql, conflicts: result.conflicts.slice(0, 5), errors: result.errors.slice(0, 5),
    });
  }
}

/** Pull des résas depuis Beds24 (curseur modifiedFrom en settings) + apply. */
export async function pullBeds24Bookings(
  db: D1Database,
  env: Env,
  propertyId: number,
  beds24PropertyId: number,
  now: Date = new Date(),
): Promise<ChannelSyncResult> {
  if (!(await beds24Configured(env))) throw new Error("Beds24 non configuré");
  // curseur de pull incrémental (clé libre du key-value settings, hors SettingsRow typé)
  const raw = await db
    .prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'beds24_last_pull'")
    .bind(propertyId)
    .first<{ value: string }>();
  const query: Record<string, string> = { propertyId: String(beds24PropertyId), includeGuests: "true" };
  if (raw?.value) {
    query.modifiedFrom = raw.value;
  } else {
    query.arrivalFrom = todayInZone(now); // premier pull : toutes les résas futures
  }
  const res = await beds24Fetch<{ data?: Beds24Booking[] }>(env, "/bookings", { query });
  const units = await listUnits(db, propertyId);
  const roomToUnit = new Map(units.filter((u) => u.beds24RoomId != null).map((u) => [u.beds24RoomId as number, u.id]));
  const result = await applyChannelBookings(db, res.data ?? [], roomToUnit, now);
  // curseur : maintenant - 10 min de marge (horloges + latence Beds24)
  const next = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await advanceCursorIfClean(db, propertyId, next, result, now);
  if (
    result.imported || result.updated || result.cancelled || result.reactivated ||
    result.conflicts.length || result.errors.length
  ) {
    await audit(db, "cron", "beds24.pull", `property:${propertyId}`, result);
  }
  return result;
}

/** Push TEMPS RÉEL, non bloquant : appelé à chaque mutation du stock ou des
 *  tarifs (résa publique, vente/annulation/déplacement admin, saisons, règles).
 *  Avec ctx (Workers) : ctx.waitUntil — la réponse part sans attendre le push.
 *  Sans ctx (tests) : await inline. Sans token : no-op silencieux.
 *  Le cron 15 min reste le filet de sécurité (holds expirés, échecs réseau). */
export function triggerBeds24Push(
  db: D1Database,
  env: Env,
  execCtx: ExecutionContext | undefined,
  propertyId: number,
): Promise<void> | undefined {
  const run = async (): Promise<void> => {
    if (!(await beds24Configured(env))) return; // no-op silencieux sans jeton
    try {
      const { pushed } = await pushCalendars(db, env, propertyId);
      await audit(db, "event", "beds24.push", `property:${propertyId}`, { rooms: pushed.length, trigger: "temps réel" });
    } catch (e) {
      await audit(db, "event", "beds24.push.error", `property:${propertyId}`, {
        trigger: "temps réel",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  if (execCtx) {
    execCtx.waitUntil(run());
    return undefined;
  }
  return run();
}

/** Push temps réel pour TOUTES les propriétés mappées — mutations tarifaires
 *  (saisons, règles) dont la propriété n'est pas sous la main. */
export async function triggerBeds24PushAll(
  db: D1Database,
  env: Env,
  execCtx: ExecutionContext | undefined,
): Promise<void> {
  if (!(await beds24Configured(env))) return;
  const { listProperties } = await import("../db/repo");
  const properties = await listProperties(db);
  for (const p of properties) {
    if (p.beds24PropertyId != null) triggerBeds24Push(db, env, execCtx, p.id);
  }
}
