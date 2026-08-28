// Import des réservations futures depuis un export CSV elloha (phase 2).
//
// ⚠️ TODO_FORMAT_ELLOHA : le format réel de l'export elloha sera demandé à
// Julien au lancement de la phase 2. En attendant, ce module lit un CSV au
// format documenté ci-dessous (README § Import elloha) ; seul le mapping des
// en-têtes devra être ajusté à l'export réel.
//
// En-têtes reconnus (insensibles à la casse et aux accents) :
//   unite (ou hebergement) ; arrivee ; depart ; nom ; prenom ; email ;
//   telephone ; adultes ; enfants ; total ; paye ; reference
//
// Sécurités : dry-run PAR DÉFAUT (aucune écriture), dédoublonnage par
// référence elloha (external_uid), insertion via le même INSERT atomique que
// tout le reste — un import ne peut jamais créer de surbooking.

import { isIsoDate, rangesOverlap, sqlNow, type IsoDate } from "../core/dates";
import { blockingUnitIds, blocksAsSpans, isActiveBooking, type BookingSpan, type UnitLink } from "../core/availability";
import {
  addPayment,
  audit,
  bookingsInWindow,
  createBookingAtomic,
  listLinks,
  manualBlocksInWindow,
  listUnits,
  upsertGuest,
  type UnitRow,
} from "../db/repo";

export interface ImportRowResult {
  line: number;
  status: "importé" | "ok_simulé" | "conflit" | "déjà_importé" | "erreur";
  reference?: string;
  message?: string;
  // Dates et montants relus, ligne par ligne : c'est ce qui rend visible un
  // écart de format AVANT l'import réel (issue #28).
  checkin?: IsoDate;
  checkout?: IsoDate;
  totalCents?: number;
  paidCents?: number;
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  imported: number;
  conflicts: number;
  errors: number;
  skipped: number;
  rows: ImportRowResult[];
}

// --- parsing ----------------------------------------------------------------

/** Parseur CSV minimal : séparateur ; ou , (détecté), champs entre guillemets
 *  avec échappement "" — suffisant pour un export tableur. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const HEADER_ALIASES: Record<string, string> = {
  unite: "unit", hebergement: "unit", logement: "unit", offre: "unit",
  arrivee: "checkin", datearrivee: "checkin", debut: "checkin", checkin: "checkin",
  depart: "checkout", datedepart: "checkout", fin: "checkout", checkout: "checkout",
  nom: "lastName", client: "lastName",
  prenom: "firstName",
  email: "email", mail: "email",
  telephone: "phone", tel: "phone", gsm: "phone",
  adultes: "adults", adulte: "adults", personnes: "adults", pax: "adults",
  enfants: "children", enfant: "children",
  total: "total", montant: "total", totaleur: "total", prixtotal: "total",
  paye: "paid", acompte: "paid", regle: "paid", payeeur: "paid",
  reference: "ref", ref: "ref", numero: "ref", id: "ref", referenceexterne: "ref",
};

/** '15/08/2026' ou '2026-08-15' → ISO (null si illisible). */
export function parseFlexibleDate(raw: string): IsoDate | null {
  const trimmed = raw.trim();
  if (isIsoDate(trimmed)) return trimmed;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (m) {
    const iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

/** '1 234,56' / '1.234,56' / '1,234.56' / '1234.56' / '890 €' → centimes.
 *  null si illisible — JAMAIS 0 par défaut : un import qui refuse une ligne est
 *  réparable, un import silencieusement faux ne l'est pas (issue #28).
 *
 *  Règle de désambiguïsation quand un seul séparateur est présent : un groupe
 *  final de 3 chiffres est un groupe de MILLIERS ('1.234' = 1234 €), sauf si la
 *  partie entière commence par 0 ('0.500' = 0,50 €) — aucune monnaie n'a trois
 *  décimales. Deux séparateurs différents : le dernier est le décimal. */
export function parseFlexibleMoney(raw: string): number | null {
  const s = raw.replace(/[\s  ]|€|EUR/gi, "").trim();
  if (s === "") return null;
  if (!/^-?\d+([.,]\d+)*$/.test(s)) return null;

  // Un groupe de milliers fait TOUJOURS 3 chiffres : c'est ce qui distingue
  // '1.234.567' (milliers) de '12,50,30' (illisible → refus).
  const wellGrouped = (groups: string[]): boolean => groups.slice(1).every((g) => g.length === 3);

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = Math.max(lastComma, lastDot);
    const head = s.slice(0, dec);
    if (!wellGrouped(head.split(/[.,]/))) return null;
    normalized = `${head.replace(/[.,]/g, "")}.${s.slice(dec + 1)}`;
  } else if (lastComma >= 0 || lastDot >= 0) {
    const parts = s.split(lastComma >= 0 ? "," : ".");
    const tail = parts[parts.length - 1]!;
    if (parts.length > 2) {
      if (!wellGrouped(parts)) return null;
      normalized = parts.join("");
    } else {
      // séparateur unique : 3 chiffres après = milliers ('1.234'), sauf partie
      // entière commençant par 0 ('0.500' = 0,50 €)
      const thousands = tail.length === 3 && !/^-?0/.test(parts[0]!);
      normalized = thousands ? parts.join("") : `${parts[0]}.${tail}`;
    }
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Montant en euros pour les messages de simulation : '540,00 €'. Format figé
 *  (pas de toLocaleString) — le tableau doit être comparable d'un run à l'autre. */
function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

/** '2026-10-15' → '15/10/2026' (lecture humaine du tableau de simulation). */
function frDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** Lit une colonne monétaire. `required` : une valeur absente ou nulle est un
 *  refus (le total), sinon l'absence vaut 0 (l'acompte). */
function readMoney(raw: string, required: boolean): { ok: true; cents: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return required ? { ok: false, reason: "montant total absent" } : { ok: true, cents: 0 };
  }
  const cents = parseFlexibleMoney(trimmed);
  if (cents === null) return { ok: false, reason: `montant illisible : « ${trimmed} »` };
  if (cents < 0) return { ok: false, reason: `montant négatif : « ${trimmed} »` };
  if (required && cents === 0) return { ok: false, reason: `montant total à 0 € : « ${trimmed} »` };
  return { ok: true, cents };
}

// --- import -----------------------------------------------------------------

export async function importElloha(
  db: D1Database,
  propertyId: number,
  csvText: string,
  dryRun: boolean,
  now: Date = new Date(),
): Promise<ImportResult> {
  const rows = parseCsv(csvText);
  const result: ImportResult = { dryRun, total: 0, imported: 0, conflicts: 0, errors: 0, skipped: 0, rows: [] };
  if (rows.length < 2) {
    result.rows.push({ line: 1, status: "erreur", message: "CSV vide ou sans ligne de données" });
    result.errors = 1;
    return result;
  }

  const header = rows[0]!.map((h) => HEADER_ALIASES[normalize(h)] ?? normalize(h));
  const col = (name: string): number => header.indexOf(name);
  if (col("unit") < 0 || col("checkin") < 0 || col("checkout") < 0 || col("lastName") < 0) {
    result.rows.push({
      line: 1,
      status: "erreur",
      message: `en-têtes requis manquants (unite, arrivee, depart, nom) — trouvés : ${rows[0]!.join(", ")}`,
    });
    result.errors = 1;
    return result;
  }

  const units = await listUnits(db, propertyId);
  const links: UnitLink[] = await listLinks(db, propertyId);
  const unitByKey = new Map<string, UnitRow>();
  for (const u of units) {
    unitByKey.set(normalize(u.name), u);
    unitByKey.set(normalize(u.slug), u);
  }

  // Pour le dry-run : photo des résas existantes + accumulation des lignes
  // simulées, pour détecter aussi les conflits internes au fichier.
  const nowSql = sqlNow(now);
  const existingSpans: BookingSpan[] = dryRun
    ? [
        ...(await bookingsInWindow(db, propertyId, "2000-01-01", "2100-01-01")).map((b) => ({
          unitId: b.unitId, checkin: b.checkin, checkout: b.checkout,
          status: b.status, holdExpiresAt: b.holdExpiresAt,
        })),
        // La simulation doit annoncer les mêmes conflits que l'import réel :
        // un blocage manuel fera refuser la ligne par l'INSERT atomique.
        ...blocksAsSpans(await manualBlocksInWindow(db, propertyId, "2000-01-01", "2100-01-01")),
      ]
    : [];

  const get = (r: string[], name: string): string => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const line = i + 1;
    result.total++;

    const unit = unitByKey.get(normalize(get(r, "unit")));
    const checkin = parseFlexibleDate(get(r, "checkin"));
    const checkout = parseFlexibleDate(get(r, "checkout"));
    const lastName = get(r, "lastName");
    if (!unit) {
      result.rows.push({ line, status: "erreur", message: `unité inconnue : « ${get(r, "unit")} »` });
      result.errors++;
      continue;
    }
    if (!checkin || !checkout || checkin >= checkout) {
      result.rows.push({ line, status: "erreur", message: `dates illisibles : « ${get(r, "checkin")} » → « ${get(r, "checkout")} »` });
      result.errors++;
      continue;
    }
    if (lastName.length < 2) {
      result.rows.push({ line, status: "erreur", message: "nom du client manquant" });
      result.errors++;
      continue;
    }
    const ref = get(r, "ref");
    const externalUid = ref ? `elloha:${ref}` : null;

    // Les montants sont la raison d'être de l'import (facturation, solde dû) :
    // une ligne dont le total est illisible, absent ou nul part en ERREUR au
    // lieu de s'importer à 0 € avec le statut « importé » (issue #28).
    const total = readMoney(get(r, "total"), true);
    if (!total.ok) {
      result.rows.push({ line, status: "erreur", checkin, checkout, message: `${total.reason} — ligne refusée` });
      result.errors++;
      continue;
    }
    const paid = readMoney(get(r, "paid"), false);
    if (!paid.ok) {
      result.rows.push({ line, status: "erreur", checkin, checkout, message: `acompte : ${paid.reason} — ligne refusée` });
      result.errors++;
      continue;
    }
    const totalCents = total.cents;
    const paidCents = paid.cents;
    const money = `total ${eur(totalCents)}${paidCents > 0 ? ` · payé ${eur(paidCents)}` : ""}`;
    const adults = Math.max(1, Math.floor(Number(get(r, "adults")) || 1));
    const children = Math.max(0, Math.floor(Number(get(r, "children")) || 0));

    // dédoublonnage par référence elloha
    if (externalUid) {
      const dup = await db.prepare("SELECT id FROM bookings WHERE external_uid = ?1").bind(externalUid).first();
      if (dup) {
        result.rows.push({ line, status: "déjà_importé", message: `référence ${ref} déjà en base` });
        result.skipped++;
        continue;
      }
    }

    if (dryRun) {
      const blockers = blockingUnitIds(unit.id, links);
      const clash = existingSpans.some(
        (s) => blockers.has(s.unitId) && isActiveBooking(s, nowSql) && rangesOverlap(s.checkin, s.checkout, checkin, checkout),
      );
      if (clash) {
        result.rows.push({
          line, status: "conflit", checkin, checkout, totalCents, paidCents,
          message: `${unit.name} · ${frDate(checkin)} → ${frDate(checkout)} · ${money} — créneau déjà occupé`,
        });
        result.conflicts++;
      } else {
        existingSpans.push({ unitId: unit.id, checkin, checkout, status: "confirmed" });
        result.rows.push({
          line, status: "ok_simulé", checkin, checkout, totalCents, paidCents,
          message: `${unit.name} · ${frDate(checkin)} → ${frDate(checkout)} · ${lastName} · ${money}`,
        });
        result.imported++;
      }
      continue;
    }

    // import réel — même garantie atomique que tout le reste
    try {
      const email = get(r, "email");
      const guestId = await upsertGuest(db, {
        email: email || null,
        firstName: get(r, "firstName") || null,
        lastName,
        phone: get(r, "phone") || null,
      });
      const created = await createBookingAtomic(db, {
        unitId: unit.id,
        checkin,
        checkout,
        adults,
        children,
        status: "confirmed",
        source: "import",
        channelLabel: "elloha",
        externalUid,
        guestId,
        totalCents,
        internalNotes: ref ? `Import elloha (réf. ${ref})` : "Import elloha",
        now,
      });
      if (!created.ok) {
        result.rows.push({
          line, status: "conflit", checkin, checkout, totalCents, paidCents,
          message: `${unit.name} · ${frDate(checkin)} → ${frDate(checkout)} · ${money} — créneau déjà occupé`,
        });
        result.conflicts++;
        continue;
      }
      if (paidCents > 0) {
        await addPayment(db, {
          bookingId: created.id,
          kind: paidCents >= totalCents && totalCents > 0 ? "full" : "deposit",
          method: "other",
          amountCents: paidCents,
          status: "succeeded",
          note: "encaissé via elloha (import)",
          receivedAt: nowSql,
        });
      }
      result.rows.push({
        line, status: "importé", reference: created.reference,
        checkin, checkout, totalCents, paidCents,
        message: `${unit.name} · ${frDate(checkin)} → ${frDate(checkout)} · ${money}`,
      });
      result.imported++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) {
        result.rows.push({ line, status: "déjà_importé", message: `référence ${ref} déjà en base` });
        result.skipped++;
      } else {
        result.rows.push({ line, status: "erreur", message: msg.slice(0, 160) });
        result.errors++;
      }
    }
  }

  if (!dryRun) {
    await audit(db, "admin", "import.elloha", `property:${propertyId}`, {
      total: result.total, imported: result.imported, conflicts: result.conflicts,
      errors: result.errors, skipped: result.skipped,
    });
  }
  return result;
}
