// Import des agendas Google du père de Julien (POST /api/admin/import/agenda-google).
//
// Les deux agendas Google (« location maison du scieur », « location scierie »)
// sont LA base des réservations. Ils sont déjà branchés comme flux iCal entrants,
// mais le flux public ne donne que « Busy » : la synchronisation crée des
// réservations sans nom. Le script du Mac (scripts/importer_agenda_google.py)
// lit l'export complet des événements, en déduit client, paiements, statut, et
// envoie ici une ligne par événement. Ce module :
//
//   - COMPLÈTE la réservation `ical` du même UID (feed<id>:<UID>) si la synchro
//     l'a déjà créée — nom, e-mail, personnes, montants, paiements, notes — sans
//     la recréer ni toucher à ses dates (la synchro en reste maîtresse) ;
//   - sinon la CRÉE comme réservation `ical` de ce flux avec cet UID, par le même
//     INSERT atomique que tout le reste : syncFeed la reconnaît ensuite ;
//   - pose un BLOCAGE MANUEL pour la famille et les usages de papa (pas une
//     vente : rien dans les statistiques), rattaché à l'UID (migration 0028) ;
//   - garde ANNULÉES les annulées, avec un motif que syncFeed ne rouvre pas.
//
// Idempotent : un deuxième passage ne crée rien, n'ajoute aucun paiement en
// double (chaque paiement porte une note-clé) et ne réécrit pas les notes.
// Jamais d'e-mail au client : aucune échéance de solde n'est posée (le rappel de
// solde du cron ne part que sur une échéance), aucun voucher n'est envoyé.

import { isIsoDate, sqlNow, type IsoDate } from "../core/dates";
import {
  addPayment,
  audit,
  blockingBookings,
  blockingManualBlocks,
  cancelBooking,
  createBookingAtomic,
  createManualBlockAtomic,
  getBookingByExternalUid,
  getManualBlockByExternalUid,
  getUnit,
  insertCancelledBooking,
  reactivateBookingAtomic,
  type BookingRow,
  type FeedRow,
  type UnitRow,
} from "../db/repo";
import { AGENDA_BLOCK_REASON, AGENDA_CANCEL_REASON } from "./ical";

export const MAX_AGENDA_EVENTS = 500;
const NOTE_MARKER = "— Import agenda Google";
const PAYMENT_METHODS = new Set(["transfer", "cash", "other"]);

export type AgendaStatut = "confirmee" | "annulee" | "blocage";

export interface AgendaPaiement {
  cents: number;
  date: IsoDate | null;
  methode: "transfer" | "cash" | "other";
}

export interface AgendaEvenement {
  uid: string;
  checkin: IsoDate;
  checkout: IsoDate;
  nom: string | null;
  email: string | null;
  telephone: string | null;
  personnes: number | null;
  totalCents: number | null;
  paiements: AgendaPaiement[];
  notes: string;
  statut: AgendaStatut;
  motif: string | null;
}

export type AgendaAction = "creee" | "completee" | "annulee" | "blocage" | "ignoree";

export interface AgendaLigneResultat {
  uid: string;
  statut: string;
  action: AgendaAction;
  reference?: string;
  blockId?: number;
  raison?: string;
  avertissements?: string[];
}

export interface AgendaImportResult {
  essai: boolean;
  unitId: number;
  feedId: number;
  creees: number;
  completees: number;
  annulees: number;
  blocages: number;
  ignorees: number;
  lignes: AgendaLigneResultat[];
}

// ---------------------------------------------------------------------------
// Lecture d'une ligne (validation champ par champ ; une ligne fausse est
// ignorée avec sa raison, elle ne fait pas échouer le lot)
// ---------------------------------------------------------------------------

function texte(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function entier(v: unknown): number | null {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? Math.round(n) : null;
}

export function parseAgendaEvenement(raw: unknown): { ok: true; ev: AgendaEvenement } | { ok: false; uid: string; raison: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const uid = texte(r.uid, 300) ?? "";
  if (uid.length < 3 || /\s/.test(uid)) return { ok: false, uid, raison: "uid manquant ou illisible" };
  const checkin = String(r.checkin ?? "");
  const checkout = String(r.checkout ?? "");
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) return { ok: false, uid, raison: "dates invalides" };
  const statut = String(r.statut ?? "");
  if (statut !== "confirmee" && statut !== "annulee" && statut !== "blocage") return { ok: false, uid, raison: `statut inconnu « ${statut} »` };
  const email = texte(r.email, 200)?.toLowerCase() ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, uid, raison: "adresse e-mail illisible" };
  const personnes = entier(r.personnes);
  if (personnes != null && (personnes < 1 || personnes > 60)) return { ok: false, uid, raison: "nombre de personnes invalide" };
  const totalCents = entier(r.totalCents);
  if (totalCents != null && (totalCents < 0 || totalCents > 10_000_000)) return { ok: false, uid, raison: "total invalide" };
  const paiements: AgendaPaiement[] = [];
  for (const p of Array.isArray(r.paiements) ? r.paiements : []) {
    const q = (p ?? {}) as Record<string, unknown>;
    const cents = entier(q.cents);
    if (cents == null || cents <= 0 || cents > 10_000_000) return { ok: false, uid, raison: "montant de paiement invalide" };
    const date = q.date == null || q.date === "" ? null : String(q.date);
    if (date != null && !isIsoDate(date)) return { ok: false, uid, raison: "date de paiement invalide" };
    const methode = PAYMENT_METHODS.has(String(q.methode)) ? (String(q.methode) as AgendaPaiement["methode"]) : "transfer";
    paiements.push({ cents, date, methode });
  }
  const motif = texte(r.motif, 200);
  if (statut === "blocage" && (!motif || motif.length < 2)) return { ok: false, uid, raison: "motif de blocage requis" };
  if (statut !== "blocage" && !texte(r.nom, 120) && !email) return { ok: false, uid, raison: "ni nom ni adresse : rien à rattacher" };
  return {
    ok: true,
    ev: {
      uid, checkin, checkout, statut, email, personnes, totalCents, paiements, motif,
      nom: texte(r.nom, 120),
      telephone: texte(r.telephone, 40),
      notes: texte(r.notes, 4000) ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// Écritures
// ---------------------------------------------------------------------------

/** Client de la réservation : retrouvé par e-mail (jamais renommé : un nom
 *  déduit d'une adresse ne remplace pas un nom saisi), sinon créé. */
async function guestFor(db: D1Database, ev: AgendaEvenement): Promise<number | null> {
  if (ev.email) {
    const existing = await db.prepare("SELECT id FROM guests WHERE lower(email) = ?1 ORDER BY id LIMIT 1").bind(ev.email).first<{ id: number }>();
    if (existing) {
      if (ev.telephone) await db.prepare("UPDATE guests SET phone = COALESCE(phone, ?2) WHERE id = ?1").bind(existing.id, ev.telephone).run();
      return existing.id;
    }
  }
  const nom = ev.nom ?? ev.email?.split("@")[0] ?? null;
  if (!nom) return null;
  const mots = nom.split(/\s+/);
  const [firstName, lastName] = mots.length === 2 ? [mots[0]!, mots[1]!] : [null, nom];
  const res = await db
    .prepare("INSERT INTO guests (email, first_name, last_name, phone, notes) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(ev.email, firstName, lastName, ev.telephone, "Créé par l'import des agendas Google : nom déduit de l'adresse ou du titre, à vérifier.")
    .run();
  return res.meta.last_row_id;
}

function noteBlock(ev: AgendaEvenement, feed: FeedRow, personnesParDefaut: number | null): string {
  const lignes = [`${NOTE_MARKER} (${feed.name}, ${ev.uid}) —`];
  if (ev.notes) lignes.push(ev.notes);
  if (personnesParDefaut != null) lignes.push(`Nombre de personnes à vérifier (capacité par défaut du bien : ${personnesParDefaut}).`);
  return lignes.join("\n");
}

/** Notes existantes + bloc d'import, une seule fois. La ligne « iCal : Busy »
 *  posée par la synchro ne dit rien : elle s'efface devant le vrai texte. */
function mergedNotes(existing: string | null, block: string): string | null {
  if (existing?.includes(NOTE_MARKER)) return null; // déjà fait
  const garde = (existing ?? "")
    .split("\n")
    .filter((l) => !/^iCal : Busy\s*$/i.test(l.trim()))
    .join("\n")
    .trim();
  return garde ? `${garde}\n\n${block}` : block;
}

/** Paiements de l'agenda, une fois chacun : la note porte la clé uid + rang. */
async function addPayments(db: D1Database, bookingId: number, ev: AgendaEvenement): Promise<number> {
  let added = 0;
  for (const [i, p] of ev.paiements.entries()) {
    const note = `Agenda Google ${ev.uid} — paiement ${i + 1}`;
    const exists = await db.prepare("SELECT 1 AS x FROM payments WHERE booking_id = ?1 AND note = ?2").bind(bookingId, note).first();
    if (exists) continue;
    await addPayment(db, {
      bookingId,
      kind: "manual",
      method: p.methode,
      amountCents: p.cents,
      status: "succeeded",
      note,
      receivedAt: p.date ? `${p.date} 12:00:00` : null,
    });
    added += 1;
  }
  return added;
}

function paidTotal(ev: AgendaEvenement): number {
  return ev.paiements.reduce((s, p) => s + p.cents, 0);
}

/** Complète une réservation existante sans toucher à ses dates ni à son statut. */
async function completeBooking(
  db: D1Database, b: BookingRow, ev: AgendaEvenement, feed: FeedRow, unit: UnitRow, nowSql: string,
): Promise<string[]> {
  const warnings: string[] = [];
  if (b.checkin !== ev.checkin || b.checkout !== ev.checkout) {
    warnings.push(`dates de la plateforme gardées (${b.checkin}→${b.checkout}), l'agenda dit ${ev.checkin}→${ev.checkout}`);
  }
  const guestId = b.guestId ?? (await guestFor(db, ev));
  const sansPersonnes = b.adults === 0 && b.children === 0;
  const adults = sansPersonnes ? (ev.personnes ?? unit.capacityBase) : b.adults;
  const notes = mergedNotes(b.internalNotes, noteBlock(ev, feed, sansPersonnes && ev.personnes == null ? unit.capacityBase : null));
  const total = Math.max(b.totalCents, ev.totalCents ?? 0, paidTotal(ev));
  await db
    .prepare(
      `UPDATE bookings SET guest_id = ?2, adults = ?3, total_cents = ?4,
              internal_notes = COALESCE(?5, internal_notes), updated_at = ?6
        WHERE id = ?1`,
    )
    .bind(b.id, guestId, adults, total, notes, nowSql)
    .run();
  await addPayments(db, b.id, ev);
  return warnings;
}

function conflictLabel(bookings: BookingRow[], blocks: { reason: string; checkin: string; checkout: string }[]): string {
  const parts = [
    ...bookings.map((b) => `${b.reference} (${b.checkin}→${b.checkout})`),
    ...blocks.map((k) => `blocage « ${k.reason} » (${k.checkin}→${k.checkout})`),
  ];
  return `créneau déjà occupé : ${parts.join(", ") || "occupation inconnue"}`;
}

// ---------------------------------------------------------------------------
// Une ligne
// ---------------------------------------------------------------------------

async function importOne(
  db: D1Database, ev: AgendaEvenement, feed: FeedRow, unit: UnitRow, essai: boolean, now: Date,
): Promise<AgendaLigneResultat> {
  const nowSql = sqlNow(now);
  const extUid = `feed${feed.id}:${ev.uid}`;
  const base = { uid: ev.uid, statut: ev.statut };
  const existing = await getBookingByExternalUid(db, extUid);
  if (existing && existing.unitId !== unit.id) {
    return { ...base, action: "ignoree", raison: `l'UID est déjà rattaché à un autre bien (${existing.reference})` };
  }
  const active = existing && existing.status !== "cancelled" ? existing : null;

  // --- blocage ------------------------------------------------------------
  if (ev.statut === "blocage") {
    const block = await getManualBlockByExternalUid(db, extUid);
    if (block) return { ...base, action: "ignoree", blockId: block.id, raison: "blocage déjà en place" };
    if (active && active.paidCents > 0) {
      return { ...base, action: "ignoree", reference: active.reference, raison: "une réservation payée occupe déjà cet UID : à trancher à la main" };
    }
    if (essai) {
      const [bs, ks] = await Promise.all([
        blockingBookings(db, unit.id, ev.checkin, ev.checkout, nowSql, active?.id),
        blockingManualBlocks(db, unit.id, ev.checkin, ev.checkout),
      ]);
      if (bs.length || ks.length) return { ...base, action: "ignoree", raison: conflictLabel(bs, ks) };
      return { ...base, action: "blocage", reference: active?.reference, raison: active ? `remplace la réservation « Busy » ${active.reference}` : undefined };
    }
    // La réservation « Busy » de la synchro libère le créneau, puis le blocage
    // le reprend ; si le blocage échoue, la réservation revient telle quelle.
    if (active) await cancelBooking(db, active.id, AGENDA_BLOCK_REASON, nowSql);
    const created = await createManualBlockAtomic(db, {
      unitId: unit.id, checkin: ev.checkin, checkout: ev.checkout, reason: ev.motif ?? "agenda",
      createdBy: "import agenda Google", externalUid: extUid, now,
    });
    if (!created.ok) {
      if (active) await reactivateBookingAtomic(db, active.id, active.unitId, active.checkin, active.checkout, nowSql);
      const [bs, ks] = await Promise.all([
        blockingBookings(db, unit.id, ev.checkin, ev.checkout, nowSql),
        blockingManualBlocks(db, unit.id, ev.checkin, ev.checkout),
      ]);
      return { ...base, action: "ignoree", raison: conflictLabel(bs, ks) };
    }
    await audit(db, "admin", "agenda.import.blocage", `block:${created.id}`, {
      feedId: feed.id, uid: ev.uid, remplace: active?.reference ?? null,
    });
    return { ...base, action: "blocage", blockId: created.id, reference: active?.reference };
  }

  // --- annulée --------------------------------------------------------------
  if (ev.statut === "annulee") {
    if (essai) {
      return existing
        ? { ...base, action: existing.status === "cancelled" ? "completee" : "annulee", reference: existing.reference }
        : { ...base, action: "annulee" };
    }
    if (existing) {
      const warnings = await completeBooking(db, existing, ev, feed, unit, nowSql);
      const done = active ? await cancelBooking(db, active.id, AGENDA_CANCEL_REASON, nowSql) : false;
      await audit(db, "admin", done ? "agenda.import.annulee" : "agenda.import.completee", `booking:${existing.id}`, {
        feedId: feed.id, uid: ev.uid, reference: existing.reference, paiements: ev.paiements.length,
      });
      return { ...base, action: done ? "annulee" : "completee", reference: existing.reference, avertissements: warnings.length ? warnings : undefined };
    }
    const guestId = await guestFor(db, ev);
    const created = await insertCancelledBooking(db, {
      unitId: unit.id, checkin: ev.checkin, checkout: ev.checkout,
      adults: ev.personnes ?? unit.capacityBase, children: 0, source: "ical", channelLabel: feed.name,
      externalUid: extUid, guestId, totalCents: Math.max(ev.totalCents ?? 0, paidTotal(ev)),
      internalNotes: noteBlock(ev, feed, ev.personnes == null ? unit.capacityBase : null),
      cancelReason: AGENDA_CANCEL_REASON, now,
    });
    await addPayments(db, created.id, ev);
    await audit(db, "admin", "agenda.import.annulee", `booking:${created.id}`, {
      feedId: feed.id, uid: ev.uid, reference: created.reference, paiements: ev.paiements.length,
    });
    return { ...base, action: "annulee", reference: created.reference };
  }

  // --- confirmée ------------------------------------------------------------
  if (existing && !active) {
    return {
      ...base, action: "ignoree", reference: existing.reference,
      raison: `réservation annulée sur la plateforme (motif « ${existing.cancelReason ?? "?"} ») alors que l'agenda la garde : à revoir`,
    };
  }
  if (active) {
    if (essai) return { ...base, action: "completee", reference: active.reference };
    const warnings = await completeBooking(db, active, ev, feed, unit, nowSql);
    await audit(db, "admin", "agenda.import.completee", `booking:${active.id}`, {
      feedId: feed.id, uid: ev.uid, reference: active.reference, paiements: ev.paiements.length,
    });
    return { ...base, action: "completee", reference: active.reference, avertissements: warnings.length ? warnings : undefined };
  }
  if (essai) {
    const [bs, ks] = await Promise.all([
      blockingBookings(db, unit.id, ev.checkin, ev.checkout, nowSql),
      blockingManualBlocks(db, unit.id, ev.checkin, ev.checkout),
    ]);
    if (bs.length || ks.length) return { ...base, action: "ignoree", raison: conflictLabel(bs, ks) };
    return { ...base, action: "creee" };
  }
  const guestId = await guestFor(db, ev);
  const created = await createBookingAtomic(db, {
    unitId: unit.id, checkin: ev.checkin, checkout: ev.checkout,
    adults: ev.personnes ?? unit.capacityBase, children: 0,
    status: "confirmed", source: "ical", channelLabel: feed.name, externalUid: extUid, guestId,
    totalCents: Math.max(ev.totalCents ?? 0, paidTotal(ev)),
    internalNotes: noteBlock(ev, feed, ev.personnes == null ? unit.capacityBase : null),
    now,
  });
  if (!created.ok) {
    const [bs, ks] = await Promise.all([
      blockingBookings(db, unit.id, ev.checkin, ev.checkout, nowSql),
      blockingManualBlocks(db, unit.id, ev.checkin, ev.checkout),
    ]);
    return { ...base, action: "ignoree", raison: conflictLabel(bs, ks) };
  }
  await addPayments(db, created.id, ev);
  await audit(db, "admin", "agenda.import.creee", `booking:${created.id}`, {
    feedId: feed.id, uid: ev.uid, reference: created.reference, paiements: ev.paiements.length,
  });
  return { ...base, action: "creee", reference: created.reference };
}

// ---------------------------------------------------------------------------
// Le lot
// ---------------------------------------------------------------------------

export async function importAgendaGoogle(
  db: D1Database,
  feed: FeedRow,
  rawEvents: unknown[],
  opts: { essai: boolean; now?: Date },
): Promise<AgendaImportResult> {
  const now = opts.now ?? new Date();
  const unit = await getUnit(db, feed.unitId);
  if (!unit) throw new Error(`importAgendaGoogle: bien ${feed.unitId} introuvable`);
  const result: AgendaImportResult = {
    essai: opts.essai, unitId: unit.id, feedId: feed.id,
    creees: 0, completees: 0, annulees: 0, blocages: 0, ignorees: 0, lignes: [],
  };
  const vus = new Set<string>();
  for (const raw of rawEvents) {
    const parsed = parseAgendaEvenement(raw);
    let ligne: AgendaLigneResultat;
    if (!parsed.ok) {
      ligne = { uid: parsed.uid, statut: String((raw as Record<string, unknown>)?.statut ?? ""), action: "ignoree", raison: parsed.raison };
    } else if (vus.has(parsed.ev.uid)) {
      ligne = { uid: parsed.ev.uid, statut: parsed.ev.statut, action: "ignoree", raison: "uid en double dans la requête" };
    } else {
      vus.add(parsed.ev.uid);
      ligne = await importOne(db, parsed.ev, feed, unit, opts.essai, now);
    }
    result.lignes.push(ligne);
    if (ligne.action === "creee") result.creees += 1;
    else if (ligne.action === "completee") result.completees += 1;
    else if (ligne.action === "annulee") result.annulees += 1;
    else if (ligne.action === "blocage") result.blocages += 1;
    else result.ignorees += 1;
    if (ligne.action === "ignoree" && !opts.essai) {
      await audit(db, "admin", "agenda.import.ignoree", `feed:${feed.id}`, { uid: ligne.uid, raison: ligne.raison });
    }
  }
  return result;
}
