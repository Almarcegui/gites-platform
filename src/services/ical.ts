// Synchronisation iCal — export de nos périodes occupées + import des flux
// externes (Airbnb pour le Moulin, phase 3). Parser maison minimal (RFC 5545 :
// dépliage des lignes, VALUE=DATE, DTEND exclusif — comme notre checkout).

import { addDays, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { busySpans, isActiveBooking, mergeSpans } from "../core/availability";
import {
  audit,
  bookingsInWindow,
  cancelBooking,
  createBookingAtomic,
  getBookingByExternalUid,
  listFeedBookings,
  listLinks,
  reactivateBookingAtomic,
  setFeedStatus,
  updateBookingDatesAtomic,
  type FeedRow,
  type UnitRow,
} from "../db/repo";

// ---------------------------------------------------------------------------
// Export : /ical/<token>.ics — périodes occupées, blocages par liaison compris
// (si le Domaine entier est réservé, l'export de chaque maison est occupé).
// ---------------------------------------------------------------------------

export interface ExportSpan {
  checkin: IsoDate;
  checkout: IsoDate;
}

export function buildIcs(unitName: string, propertyName: string, spans: ExportSpan[], nowStamp: string): string {
  // RFC 5545 : fins de ligne CRLF. Nos lignes restent < 75 octets (pas de repli).
  const stamp = nowStamp.replace(/[-: ]/g, "").slice(0, 15) + "Z"; // 'YYYYMMDDTHHMMSSZ'
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Gites Platform//Reservations//FR",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(`${unitName} — ${propertyName}`)}`,
  ];
  for (const s of spans) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.checkin.replaceAll("-", "")}-${s.checkout.replaceAll("-", "")}@gites-platform`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${s.checkin.replaceAll("-", "")}`,
      `DTEND;VALUE=DATE:${s.checkout.replaceAll("-", "")}`,
      "SUMMARY:Réservé",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Périodes occupées d'une unité pour l'export (fenêtre glissante :
 *  30 j en arrière → 18 mois en avant), fusionnées. */
export async function exportSpansForUnit(db: D1Database, unit: UnitRow, now: Date): Promise<ExportSpan[]> {
  const today = todayInZone(now);
  const from = addDays(today, -30);
  const to = addDays(today, 540);
  const bookings = await bookingsInWindow(db, unit.propertyId, from, to);
  const links = await listLinks(db, unit.propertyId);
  const nowSql = sqlNow(now);
  const spans = busySpans(
    unit.id,
    bookings.map((b) => ({
      unitId: b.unitId,
      checkin: b.checkin,
      checkout: b.checkout,
      status: b.status,
      holdExpiresAt: b.holdExpiresAt,
    })),
    links,
    nowSql,
  );
  return mergeSpans(spans);
}

// ---------------------------------------------------------------------------
// Parse (import)
// ---------------------------------------------------------------------------

export interface IcsEvent {
  uid: string;
  dtstart: IsoDate;
  dtend: IsoDate;
  summary: string;
}

/** Parse un calendrier iCal. Ne garde que les VEVENT complets (UID + dates).
 *  Les DTEND de type DATE sont exclusifs (RFC 5545) — même convention que
 *  notre checkout, aucun ajustement nécessaire. */
export function parseIcs(text: string): IcsEvent[] {
  // Dépliage : une ligne qui commence par espace/tab continue la précédente.
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.uid && current.dtstart && current.dtend && current.dtstart < current.dtend) {
        events.push({ uid: current.uid, dtstart: current.dtstart, dtend: current.dtend, summary: current.summary ?? "" });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const rawName = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = rawName.split(";")[0]!.toUpperCase();
    if (name === "UID") current.uid = value.trim();
    if (name === "SUMMARY") current.summary = value.trim();
    if (name === "DTSTART") current.dtstart = parseIcsDate(value);
    if (name === "DTEND") current.dtend = parseIcsDate(value);
  }
  return events;
}

/** '20260810' ou '20260810T140000Z' → '2026-08-10' (la composante date). */
function parseIcsDate(value: string): IsoDate | undefined {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------
// Synchronisation d'un flux entrant
// ---------------------------------------------------------------------------

export interface SyncResult {
  feedId: number;
  imported: number;
  updated: number;
  cancelled: number;
  /** Événements disparus du flux puis réapparus (annulation levée côté canal). */
  reactivated: number;
  conflicts: string[];
  error: string | null;
  /** VEVENT annoncés par le flux mais illisibles (date/UID manquants). */
  malformed: number;
  /** Flux vide alors que des séjours actifs en dépendent → rien n'a été annulé. */
  suspicious: boolean;
}

export async function syncFeed(
  db: D1Database,
  feed: FeedRow,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<SyncResult> {
  const result: SyncResult = {
    feedId: feed.id, imported: 0, updated: 0, cancelled: 0, reactivated: 0, conflicts: [], error: null,
    malformed: 0, suspicious: false,
  };
  const today = todayInZone(now);
  const nowSql = sqlNow(now);

  let events: IcsEvent[];
  try {
    const res = await fetcher(feed.url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "gites-platform-ical-sync" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    events = parseIcs(body);
    // Un VEVENT annoncé mais non retenu = date ou UID illisible : on le compte
    // au lieu de l'ignorer en silence (un flux à moitié cassé doit se voir).
    result.malformed = Math.max(0, (body.match(/BEGIN:VEVENT/g) ?? []).length - events.length);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await setFeedStatus(db, feed.id, `erreur : ${result.error}`, nowSql);
    return result;
  }

  // On ne considère que les événements pas encore terminés.
  const relevant = events.filter((ev) => ev.dtend > today);
  const existing = await listFeedBookings(db, feed.id);
  const byUid = new Map(existing.map((b) => [b.externalUid ?? "", b]));
  const seenUids = new Set<string>();

  // GARDE DE SANITÉ (audit ECC 2026-07-30, P0).
  // `res.ok` ne suffit pas : une URL Airbnb expirée, une redirection ou une
  // page de login répondent 200 avec un corps qui ne contient aucun VEVENT.
  // La boucle d'annulation plus bas libère TOUT ce qui manque au flux — donc
  // un flux vide annulait en masse des séjours confirmés et remettait les
  // dates en vente (double occupation le jour J), en affichant « ok ».
  const activeExisting = existing.filter((b) => b.checkin >= today);
  if (relevant.length === 0 && activeExisting.length > 0) {
    result.error = `flux vide ou illisible alors que ${activeExisting.length} réservation(s) active(s) en dépendent — aucune annulation appliquée`;
    result.suspicious = true;
    await setFeedStatus(db, feed.id, `⚠️ ${result.error}`, nowSql);
    await audit(db, "cron", "ical.sync.suspicious", `feed:${feed.id}`, {
      parsedEvents: events.length,
      malformed: result.malformed,
      activeBookings: activeExisting.length,
    });
    return result;
  }

  for (const ev of relevant) {
    const extUid = `feed${feed.id}:${ev.uid}`;
    seenUids.add(extUid);
    const known = byUid.get(extUid);
    if (!known) {
      // L'événement est peut-être connu mais ANNULÉ (disparu du flux puis
      // réapparu) : listFeedBookings filtre les annulées, et une création
      // violerait l'unicité de external_uid — l'exception faisait échouer
      // TOUTE la relève du flux, à chaque passage (issue #18). On réactive
      // après revérification de disponibilité : le créneau a pu être revendu.
      const archived = await getBookingByExternalUid(db, extUid);
      if (archived) {
        const back = await reactivateBookingAtomic(db, archived.id, archived.unitId, ev.dtstart, ev.dtend, nowSql);
        if (back) {
          result.reactivated += 1;
        } else {
          result.conflicts.push(
            `${archived.reference} : réactivation ${ev.dtstart}→${ev.dtend} impossible (créneau repris depuis l'annulation)`,
          );
          await audit(db, "cron", "ical.reactivate.conflict", `booking:${archived.id}`, {
            feedId: feed.id, externalUid: extUid, reference: archived.reference,
            dtstart: ev.dtstart, dtend: ev.dtend,
          });
        }
        continue;
      }
      const created = await createBookingAtomic(db, {
        unitId: feed.unitId,
        checkin: ev.dtstart,
        checkout: ev.dtend,
        adults: 0,
        children: 0,
        status: "confirmed",
        source: "ical",
        channelLabel: feed.name,
        externalUid: extUid,
        internalNotes: ev.summary ? `iCal : ${ev.summary}` : null,
        now,
      });
      if (created.ok) {
        result.imported += 1;
      } else {
        result.conflicts.push(`${ev.dtstart}→${ev.dtend} (nouvel événement, créneau déjà pris)`);
      }
    } else if (known.checkin !== ev.dtstart || known.checkout !== ev.dtend) {
      const moved = await updateBookingDatesAtomic(db, known.id, known.unitId, ev.dtstart, ev.dtend, nowSql);
      if (moved) {
        result.updated += 1;
      } else {
        result.conflicts.push(`${known.reference} : déplacement ${ev.dtstart}→${ev.dtend} impossible (conflit)`);
      }
    }
  }

  // Événements disparus du flux = annulés côté canal → on libère, mais
  // uniquement les séjours qui n'ont pas commencé (les séjours en cours ou
  // passés sont laissés tels quels).
  for (const b of existing) {
    if (!seenUids.has(b.externalUid ?? "") && b.checkin >= today) {
      await cancelBooking(db, b.id, "ical_removed", nowSql);
      result.cancelled += 1;
    }
  }

  const statusMsg =
    result.conflicts.length > 0
      ? `⚠️ ${result.conflicts.length} conflit(s) — ${result.conflicts[0] ?? ""}`
      : result.malformed > 0
        ? `⚠️ ${result.malformed} événement(s) illisible(s) dans le flux`
        : "ok";
  await setFeedStatus(db, feed.id, statusMsg, nowSql);
  if (result.imported || result.updated || result.cancelled || result.reactivated || result.conflicts.length) {
    await audit(db, "cron", "ical.sync", `feed:${feed.id}`, result);
  }
  return result;
}
