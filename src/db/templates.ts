// Modèles de réponse (migration 0023) — requêtes SQL.
import { sqlNow } from "../core/dates";

type Raw = Record<string, unknown>;

export type TemplateLang = "fr" | "nl" | "en";
export const TEMPLATE_LANGS: TemplateLang[] = ["fr", "nl", "en"];

/** Variables reconnues dans le corps d'un modèle (remplies par l'écran Messages). */
export const TEMPLATE_VARIABLES = ["prenom", "bien", "arrivee", "solde", "heure_arrivee", "heure_depart", "signature"] as const;

export interface TemplateRow {
  id: number;
  propertyId: number | null;
  name: string;
  lang: TemplateLang;
  body: string;
  sortOrder: number;
  active: boolean;
  updatedAt: string;
}

function mapTemplate(r: Raw): TemplateRow {
  return {
    id: Number(r.id),
    propertyId: r.property_id == null ? null : Number(r.property_id),
    name: String(r.name),
    lang: String(r.lang) as TemplateLang,
    body: String(r.body),
    sortOrder: Number(r.sort_order ?? 0),
    active: Number(r.active) === 1,
    updatedAt: String(r.updated_at ?? ""),
  };
}

/** Modèles visibles pour un domaine (communs + propres), ou tous. */
export async function listTemplates(db: D1Database, opts: { propertyId?: number; activeOnly?: boolean } = {}): Promise<TemplateRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.propertyId) {
    binds.push(opts.propertyId);
    where.push(`(property_id IS NULL OR property_id = ?${binds.length})`);
  }
  if (opts.activeOnly) where.push("active = 1");
  const { results } = await db
    .prepare(`SELECT * FROM message_templates${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY sort_order, id`)
    .bind(...binds)
    .all();
  return (results as Raw[]).map(mapTemplate);
}

export async function getTemplate(db: D1Database, id: number): Promise<TemplateRow | null> {
  const r = await db.prepare("SELECT * FROM message_templates WHERE id = ?1").bind(id).first<Raw>();
  return r ? mapTemplate(r) : null;
}

export interface TemplateInput {
  propertyId: number | null;
  name: string;
  lang: TemplateLang;
  body: string;
  sortOrder: number;
  active: boolean;
}

export async function createTemplate(db: D1Database, t: TemplateInput): Promise<number> {
  const res = await db
    .prepare("INSERT INTO message_templates (property_id, name, lang, body, sort_order, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(t.propertyId, t.name, t.lang, t.body, t.sortOrder, t.active ? 1 : 0)
    .run();
  return res.meta.last_row_id;
}

export async function updateTemplate(db: D1Database, id: number, t: Partial<TemplateInput>): Promise<void> {
  const cols: Record<keyof TemplateInput, string> = {
    propertyId: "property_id", name: "name", lang: "lang", body: "body", sortOrder: "sort_order", active: "active",
  };
  const sets: string[] = [];
  const binds: unknown[] = [id];
  for (const [k, col] of Object.entries(cols) as [keyof TemplateInput, string][]) {
    if (t[k] === undefined) continue;
    binds.push(k === "active" ? (t.active ? 1 : 0) : t[k]);
    sets.push(`${col} = ?${binds.length}`);
  }
  if (!sets.length) return;
  binds.push(sqlNow());
  sets.push(`updated_at = ?${binds.length}`);
  await db.prepare(`UPDATE message_templates SET ${sets.join(", ")} WHERE id = ?1`).bind(...binds).run();
}

export async function deleteTemplate(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM message_templates WHERE id = ?1").bind(id).run();
  return res.meta.changes > 0;
}
