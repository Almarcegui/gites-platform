// Ménage et tâches (migration 0022) — requêtes SQL et génération idempotente.
//
// La génération lit les départs (src/core/cleaning.ts) et met la table à jour :
//  - une tâche par réservation qui part (INSERT OR IGNORE sur l'index unique
//    booking_id + kind : deux générations simultanées ne doublonnent pas) ;
//  - séjour déplacé : date, heure et arrivée suivante suivent ; une tâche
//    « fait » dont le JOUR change repasse « à faire » (ce n'est plus le même
//    ménage) ;
//  - réservation annulée : la tâche passe « annule » si elle n'était pas faite ;
//  - l'état, la personne et la note ne sont jamais écrasés autrement.
// Rien n'est écrit quand rien ne change : relancer la génération est gratuit.
import { desiredCleaningTasks, makesCleaning, type CleaningBooking, type DesiredTask } from "../core/cleaning";
import { randomHex, sha256hex } from "../core/crypto";
import { addDays, sqlNow, type IsoDate } from "../core/dates";
import { bookingsInWindow, getSettings, listLinks, listProperties } from "./repo";

type Raw = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export type TaskStatus = "a_faire" | "fait" | "annule";

export interface TaskRow {
  id: number;
  propertyId: number;
  unitId: number;
  unitName: string;
  isComposite: boolean;
  bookingId: number | null;
  kind: "menage" | "autre";
  dueDate: IsoDate;
  dueTime: string | null;
  nextCheckin: IsoDate | null;
  nextCheckinTime: string | null;
  nextUnitId: number | null;
  nextUnitName: string | null;
  nextPersons: number | null;
  status: TaskStatus;
  assignee: string | null;
  note: string | null;
  doneAt: string | null;
  doneBy: string | null;
  updatedAt: string;
}

function mapTask(r: Raw): TaskRow {
  return {
    id: num(r.id),
    propertyId: num(r.property_id),
    unitId: num(r.unit_id),
    unitName: String(r.unit_name ?? ""),
    isComposite: num(r.unit_is_composite) === 1,
    bookingId: numOrNull(r.booking_id),
    kind: (String(r.kind) as TaskRow["kind"]) ?? "menage",
    dueDate: String(r.due_date),
    dueTime: strOrNull(r.due_time),
    nextCheckin: strOrNull(r.next_checkin),
    nextCheckinTime: strOrNull(r.next_checkin_time),
    nextUnitId: numOrNull(r.next_unit_id),
    nextUnitName: strOrNull(r.next_unit_name),
    nextPersons: numOrNull(r.next_persons),
    status: String(r.status) as TaskStatus,
    assignee: strOrNull(r.assignee),
    note: strOrNull(r.note),
    doneAt: strOrNull(r.done_at),
    doneBy: strOrNull(r.done_by),
    updatedAt: String(r.updated_at ?? ""),
  };
}

const TASK_SELECT = `
  SELECT t.*, u.name AS unit_name, u.is_composite AS unit_is_composite, nu.name AS next_unit_name
    FROM tasks t
    JOIN units u ON u.id = t.unit_id
    LEFT JOIN units nu ON nu.id = t.next_unit_id`;

/** Fenêtre de génération : une semaine derrière (le ménage d'hier se coche
 *  encore), deux mois devant. */
export const TASK_PAST_DAYS = 7;
export const TASK_AHEAD_DAYS = 60;

export interface SyncResult {
  created: number;
  updated: number;
  cancelled: number;
}

function toCleaningBooking(b: Awaited<ReturnType<typeof bookingsInWindow>>[number]): CleaningBooking {
  return {
    id: b.id,
    unitId: b.unitId,
    checkin: b.checkin,
    checkout: b.checkout,
    status: b.status,
    source: b.source,
    holdExpiresAt: b.holdExpiresAt,
    persons: b.adults + b.children,
  };
}

function sameDesired(row: Raw, d: DesiredTask): boolean {
  return (
    num(row.unit_id) === d.unitId &&
    String(row.due_date) === d.dueDate &&
    strOrNull(row.due_time) === d.dueTime &&
    strOrNull(row.next_checkin) === d.nextCheckin &&
    strOrNull(row.next_checkin_time) === d.nextCheckinTime &&
    numOrNull(row.next_unit_id) === d.nextUnitId &&
    numOrNull(row.next_persons) === d.nextPersons
  );
}

/** Met les ménages d'un domaine à jour d'après ses départs. Idempotent. */
export async function syncCleaningTasks(db: D1Database, propertyId: number, today: IsoDate, now: Date = new Date()): Promise<SyncResult> {
  const from = addDays(today, -TASK_PAST_DAYS);
  const to = addDays(today, TASK_AHEAD_DAYS);
  const nowSql = sqlNow(now);
  const [links, settings, rows] = await Promise.all([
    listLinks(db, propertyId),
    getSettings(db, propertyId),
    // 90 jours au-delà : de quoi trouver l'arrivée suivante du dernier départ.
    bookingsInWindow(db, propertyId, from, addDays(to, 90)),
  ]);
  const bookings = rows.map(toCleaningBooking);
  const desired = desiredCleaningTasks(bookings, links, settings, from, to, nowSql);
  const result: SyncResult = { created: 0, updated: 0, cancelled: 0 };

  const ids = desired.map((d) => d.bookingId);
  const existing = new Map<number, Raw>();
  if (ids.length) {
    // Entiers issus de la base, jamais du client : liste sûre.
    const { results } = await db.prepare(`SELECT * FROM tasks WHERE kind = 'menage' AND booking_id IN (${ids.join(",")})`).all();
    for (const r of results as Raw[]) existing.set(num(r.booking_id), r);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const d of desired) {
    const row = existing.get(d.bookingId);
    if (!row) {
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO tasks
             (property_id, unit_id, booking_id, kind, due_date, due_time, next_checkin, next_checkin_time, next_unit_id, next_persons)
           VALUES (?1, ?2, ?3, 'menage', ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(propertyId, d.unitId, d.bookingId, d.dueDate, d.dueTime, d.nextCheckin, d.nextCheckinTime, d.nextUnitId, d.nextPersons)
        .run();
      if (res.meta.changes > 0) result.created++;
      continue;
    }
    const revived = String(row.status) === "annule";
    const dayMoved = String(row.due_date) !== d.dueDate;
    if (sameDesired(row, d) && !revived) continue;
    // Le jour change ou la réservation revient : c'est un nouveau ménage à faire.
    const resetStatus = revived || (dayMoved && String(row.status) === "fait");
    stmts.push(
      db
        .prepare(
          `UPDATE tasks SET unit_id = ?2, due_date = ?3, due_time = ?4, next_checkin = ?5, next_checkin_time = ?6,
                  next_unit_id = ?7, next_persons = ?8, updated_at = ?9
                  ${resetStatus ? ", status = 'a_faire', done_at = NULL, done_by = NULL" : ""}
            WHERE id = ?1`,
        )
        .bind(num(row.id), d.unitId, d.dueDate, d.dueTime, d.nextCheckin, d.nextCheckinTime, d.nextUnitId, d.nextPersons, nowSql),
    );
    result.updated++;
  }

  // Tâches de la fenêtre qui ne correspondent plus à aucun départ voulu.
  const wanted = new Set(ids);
  const { results: inWindow } = await db
    .prepare(
      `SELECT t.id, t.booking_id, t.status, t.due_date FROM tasks t
        WHERE t.property_id = ?1 AND t.kind = 'menage' AND t.booking_id IS NOT NULL
          AND t.status != 'annule' AND t.due_date >= ?2 AND t.due_date < ?3`,
    )
    .bind(propertyId, from, to)
    .all();
  const orphans = (inWindow as Raw[]).filter((r) => !wanted.has(num(r.booking_id)));
  if (orphans.length) {
    const { results: bs } = await db
      .prepare(`SELECT id, status, source, hold_expires_at, checkout FROM bookings WHERE id IN (${orphans.map((o) => num(o.booking_id)).join(",")})`)
      .all();
    const byId = new Map((bs as Raw[]).map((b) => [num(b.id), b]));
    for (const o of orphans) {
      const b = byId.get(num(o.booking_id));
      const alive = b && makesCleaning({ status: String(b.status), source: String(b.source), holdExpiresAt: strOrNull(b.hold_expires_at) }, nowSql);
      if (!alive) {
        if (String(o.status) === "fait") continue; // un ménage fait reste fait
        stmts.push(db.prepare("UPDATE tasks SET status = 'annule', updated_at = ?2 WHERE id = ?1").bind(num(o.id), nowSql));
        result.cancelled++;
      } else if (String(b!.checkout) >= to) {
        // Séjour prolongé au-delà de la fenêtre : la date suit, l'arrivée
        // suivante sera recalculée quand le départ entrera dans la fenêtre.
        stmts.push(
          db
            .prepare(
              `UPDATE tasks SET due_date = ?2, next_checkin = NULL, next_checkin_time = NULL, next_unit_id = NULL,
                      next_persons = NULL, status = CASE WHEN status = 'fait' THEN 'a_faire' ELSE status END,
                      done_at = CASE WHEN status = 'fait' THEN NULL ELSE done_at END, updated_at = ?3
                WHERE id = ?1`,
            )
            .bind(num(o.id), String(b!.checkout), nowSql),
        );
        result.updated++;
      }
    }
  }
  if (stmts.length) await db.batch(stmts);
  return result;
}

/** Tous les domaines (cron). */
export async function syncAllCleaningTasks(db: D1Database, today: IsoDate, now: Date = new Date()): Promise<SyncResult> {
  const total: SyncResult = { created: 0, updated: 0, cancelled: 0 };
  for (const p of await listProperties(db)) {
    const r = await syncCleaningTasks(db, p.id, today, now);
    total.created += r.created;
    total.updated += r.updated;
    total.cancelled += r.cancelled;
  }
  return total;
}

export interface TaskFilters {
  propertyIds?: number[];
  from: IsoDate;
  to: IsoDate;
  includeCancelled?: boolean;
}

export async function listTasks(db: D1Database, f: TaskFilters): Promise<TaskRow[]> {
  const where = ["t.due_date >= ?1", "t.due_date < ?2"];
  if (!f.includeCancelled) where.push("t.status != 'annule'");
  const pids = (f.propertyIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  if (f.propertyIds && pids.length === 0) return [];
  if (pids.length) where.push(`t.property_id IN (${pids.join(",")})`);
  const { results } = await db
    .prepare(`${TASK_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.due_date, t.due_time, u.sort_order, u.id`)
    .bind(f.from, f.to)
    .all();
  return (results as Raw[]).map(mapTask);
}

export async function getTask(db: D1Database, id: number): Promise<TaskRow | null> {
  const r = await db.prepare(`${TASK_SELECT} WHERE t.id = ?1`).bind(id).first<Raw>();
  return r ? mapTask(r) : null;
}

export interface TaskPatch {
  status?: "a_faire" | "fait";
  assignee?: string | null;
  note?: string | null;
}

export async function updateTask(db: D1Database, id: number, patch: TaskPatch, by: string, now: Date = new Date()): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [id];
  const add = (sql: string, v: unknown) => {
    binds.push(v);
    sets.push(sql.replace("?", `?${binds.length}`));
  };
  if (patch.status === "fait") {
    sets.push("status = 'fait'");
    add("done_at = ?", sqlNow(now));
    add("done_by = ?", by);
  } else if (patch.status === "a_faire") {
    sets.push("status = 'a_faire'", "done_at = NULL", "done_by = NULL");
  }
  if (patch.assignee !== undefined) add("assignee = ?", patch.assignee);
  if (patch.note !== undefined) add("note = ?", patch.note);
  if (!sets.length) return;
  add("updated_at = ?", sqlNow(now));
  await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?1`).bind(...binds).run();
}

// --- liens de partage ----------------------------------------------------------

export interface ShareLinkRow {
  id: number;
  label: string;
  propertyId: number | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function mapLink(r: Raw): ShareLinkRow {
  return {
    id: num(r.id),
    label: String(r.label),
    propertyId: numOrNull(r.property_id),
    createdBy: strOrNull(r.created_by),
    createdAt: String(r.created_at),
    lastUsedAt: strOrNull(r.last_used_at),
    revokedAt: strOrNull(r.revoked_at),
  };
}

/** Crée un lien et renvoie son jeton EN CLAIR (montré une seule fois). */
export async function createShareLink(db: D1Database, l: { label: string; propertyId: number | null; createdBy: string }): Promise<{ id: number; token: string }> {
  const token = randomHex(24);
  const res = await db
    .prepare("INSERT INTO task_share_links (token_hash, label, property_id, created_by) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256hex(token), l.label, l.propertyId, l.createdBy)
    .run();
  return { id: res.meta.last_row_id, token };
}

export async function listShareLinks(db: D1Database): Promise<ShareLinkRow[]> {
  const { results } = await db.prepare("SELECT * FROM task_share_links ORDER BY revoked_at IS NOT NULL, id DESC").all();
  return (results as Raw[]).map(mapLink);
}

export async function revokeShareLink(db: D1Database, id: number, now: Date = new Date()): Promise<boolean> {
  const res = await db
    .prepare("UPDATE task_share_links SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL")
    .bind(id, sqlNow(now))
    .run();
  return res.meta.changes > 0;
}

/** Lien valide pour ce jeton, ou null (inconnu ou coupé). */
export async function resolveShareLink(db: D1Database, token: string): Promise<ShareLinkRow | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const r = await db
    .prepare("SELECT * FROM task_share_links WHERE token_hash = ?1 AND revoked_at IS NULL")
    .bind(await sha256hex(token))
    .first<Raw>();
  return r ? mapLink(r) : null;
}

export async function touchShareLink(db: D1Database, id: number, now: Date = new Date()): Promise<void> {
  await db.prepare("UPDATE task_share_links SET last_used_at = ?2 WHERE id = ?1").bind(id, sqlNow(now)).run();
}
