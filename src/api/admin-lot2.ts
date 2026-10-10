// Routes du lot 2 du nouvel écran (/admin2/) :
//  1. ménage et tâches (migration 0022) et liens de partage ;
//  2. modèles de réponse (migration 0023) ;
//  4. mon compte : changer son propre mot de passe ;
//  5. envoi de photos de galerie depuis l'ordinateur (Node seulement).
// La recherche par téléphone (3) vit dans src/db/repo.ts, la garde par
// adresse IP (7) dans src/core/ip-allow.ts, la PWA (6) dans app/.
import { apiError, json, readJson, type Router } from "./router";
import { currentUser, guard } from "./admin";
import { sha256hex, randomHex } from "../core/crypto";
import { addDays, diffDays, isIsoDate, todayInZone } from "../core/dates";
import { imageSize, sniffImageType } from "../core/image-size";
import { audit, createUnitPhoto, getUnit, listProperties } from "../db/repo";
import {
  createShareLink,
  getTask,
  listShareLinks,
  listTasks,
  revokeShareLink,
  syncCleaningTasks,
  updateTask,
  type TaskPatch,
} from "../db/tasks";
import {
  TEMPLATE_LANGS,
  TEMPLATE_VARIABLES,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  type TemplateInput,
  type TemplateLang,
} from "../db/templates";
import { generatePassword, hashPassword, verifyPassword } from "../services/admin-auth";

/** Taille maximale d'une photo envoyée (8 Mo). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Plage maximale d'une lecture de tâches. */
const MAX_TASK_RANGE_DAYS = 120;
/** Essais manqués de l'ancien mot de passe tolérés par quart d'heure. */
const MAX_PASSWORD_FAILURES = 5;

function intOrZero(v: string | null | undefined): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Texte facultatif borné : null si vide, erreur si trop long. */
function optText(v: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (v == null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const s = v.trim();
  if (s.length > max) return { ok: false };
  return { ok: true, value: s || null };
}

function sessionTokenOf(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented.startsWith("session:") ? presented.slice(8) : null;
}

export function registerLot2AdminRoutes(router: Router): void {
  // --- 1. ménage ----------------------------------------------------------------
  //
  // La lecture régénère d'abord les ménages des domaines visés (idempotent, rien
  // n'est écrit quand rien ne change) : l'écran montre la réservation prise il y
  // a une minute sans attendre le cron. `?sync=0` lit sans régénérer.
  router.get("/api/admin/tasks", guard(async (_req, env, _p, url) => {
    const today = todayInZone();
    const from = url.searchParams.get("from") ?? addDays(today, -1);
    const to = url.searchParams.get("to") ?? addDays(today, 22);
    if (!isIsoDate(from) || !isIsoDate(to) || from >= to) return apiError(400, "dates invalides (format AAAA-MM-JJ, début avant fin)");
    if (diffDays(from, to) > MAX_TASK_RANGE_DAYS) return apiError(400, `plage trop longue (max ${MAX_TASK_RANGE_DAYS} jours)`);
    const pid = intOrZero(url.searchParams.get("property"));
    const properties = (await listProperties(env.DB)).filter((p) => !pid || p.id === pid);
    if (url.searchParams.get("sync") !== "0") {
      for (const p of properties) await syncCleaningTasks(env.DB, p.id, today, new Date(), { from, to });
    }
    const tasks = await listTasks(env.DB, {
      propertyIds: properties.map((p) => p.id),
      from,
      to,
      includeCancelled: url.searchParams.get("cancelled") === "1",
    });
    return json({ tasks, from, to, today });
  }));

  router.post("/api/admin/tasks/generate", guard(async (req, env) => {
    const body = (await readJson<{ property?: unknown }>(req)) ?? {};
    const pid = intOrZero(String(body.property ?? ""));
    const today = todayInZone();
    const total = { created: 0, updated: 0, cancelled: 0 };
    for (const p of (await listProperties(env.DB)).filter((x) => !pid || x.id === pid)) {
      const r = await syncCleaningTasks(env.DB, p.id, today);
      total.created += r.created;
      total.updated += r.updated;
      total.cancelled += r.cancelled;
    }
    if (total.created + total.updated + total.cancelled > 0) {
      await audit(env.DB, "admin", "tasks.generate", null, { ...total, par: currentUser(req) });
    }
    return json({ ok: true, ...total });
  }));

  router.patch("/api/admin/tasks/:id", guard(async (req, env, p) => {
    const id = intOrZero(p.id);
    const task = id ? await getTask(env.DB, id) : null;
    if (!task) return apiError(404, "tâche inconnue");
    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const patch: TaskPatch = {};
    if ("status" in body) {
      if (body.status !== "fait" && body.status !== "a_faire") return apiError(400, "status attendu : fait ou a_faire");
      if (task.status === "annule") return apiError(409, "ce ménage est annulé (la réservation n'existe plus)");
      patch.status = body.status;
    }
    if ("assignee" in body) {
      const a = optText(body.assignee, 60);
      if (!a.ok) return apiError(400, "personne : 60 caractères au plus");
      patch.assignee = a.value;
    }
    if ("note" in body) {
      const n = optText(body.note, 500);
      if (!n.ok) return apiError(400, "note : 500 caractères au plus");
      patch.note = n.value;
    }
    const by = currentUser(req);
    if (!(await updateTask(env.DB, id, patch, by))) return apiError(409, "ce ménage vient d'être annulé (la réservation n'existe plus)");
    await audit(env.DB, "admin", "task.update", `task:${id}`, { ...patch, par: by });
    return json({ ok: true, task: await getTask(env.DB, id) });
  }));

  // Liens de partage pour la personne du ménage : le jeton n'est montré qu'à
  // la création (seul son SHA-256 est gardé).
  router.get("/api/admin/task-links", guard(async (_req, env) => json({ links: await listShareLinks(env.DB) })));

  router.post("/api/admin/task-links", guard(async (req, env, _p, url) => {
    const body = await readJson<{ label?: unknown; propertyId?: unknown }>(req);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (label.length < 2 || label.length > 60) return apiError(400, "nom attendu (2 à 60 caractères)");
    let propertyId: number | null = null;
    if (body?.propertyId != null) {
      propertyId = intOrZero(String(body.propertyId));
      if (!propertyId || !(await listProperties(env.DB)).some((x) => x.id === propertyId)) return apiError(400, "domaine inconnu");
    }
    const { id, token } = await createShareLink(env.DB, { label, propertyId, createdBy: currentUser(req) });
    await audit(env.DB, "admin", "task_link.create", `task_link:${id}`, { label, propertyId, par: currentUser(req) });
    return json({ ok: true, id, url: `${url.origin}/t/${token}` }, 201);
  }));

  router.delete("/api/admin/task-links/:id", guard(async (req, env, p) => {
    const id = intOrZero(p.id);
    if (!id || !(await revokeShareLink(env.DB, id))) return apiError(404, "lien inconnu ou déjà coupé");
    await audit(env.DB, "admin", "task_link.revoke", `task_link:${id}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- 2. modèles de réponse ------------------------------------------------------
  function parseTemplate(body: Record<string, unknown>, partial: boolean): { ok: true; value: Partial<TemplateInput> } | { ok: false; message: string } {
    const out: Partial<TemplateInput> = {};
    if (!partial || "name" in body) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 60) return { ok: false, message: "nom du modèle attendu (2 à 60 caractères)" };
      out.name = name;
    }
    if (!partial || "body" in body) {
      const text = typeof body.body === "string" ? body.body.replace(/\r\n/g, "\n").trim() : "";
      if (text.length < 2 || text.length > 4000) return { ok: false, message: "texte du modèle attendu (2 à 4000 caractères)" };
      out.body = text;
    }
    if (!partial || "lang" in body) {
      const lang = (body.lang ?? "fr") as TemplateLang;
      if (!TEMPLATE_LANGS.includes(lang)) return { ok: false, message: "langue attendue : fr, nl ou en" };
      out.lang = lang;
    }
    if ("propertyId" in body || !partial) {
      if (body.propertyId == null) out.propertyId = null;
      else {
        const pid = intOrZero(String(body.propertyId));
        if (!pid) return { ok: false, message: "domaine invalide" };
        out.propertyId = pid;
      }
    }
    if ("sortOrder" in body || !partial) out.sortOrder = Math.max(0, Math.floor(Number(body.sortOrder ?? 0)) || 0);
    if ("active" in body || !partial) out.active = body.active !== false;
    return { ok: true, value: out };
  }

  router.get("/api/admin/message-templates", guard(async (_req, env, _p, url) => {
    const pid = intOrZero(url.searchParams.get("property")) || undefined;
    // ?common=1 : seulement les modèles communs (message sans domaine connu).
    const templates = await listTemplates(env.DB, { propertyId: pid, commonOnly: url.searchParams.get("common") === "1", activeOnly: url.searchParams.get("active") === "1" });
    return json({ templates, variables: TEMPLATE_VARIABLES, langs: TEMPLATE_LANGS });
  }));

  router.post("/api/admin/message-templates", guard(async (req, env) => {
    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const parsed = parseTemplate(body, false);
    if (!parsed.ok) return apiError(400, parsed.message);
    const v = parsed.value as TemplateInput;
    if (v.propertyId != null && !(await listProperties(env.DB)).some((x) => x.id === v.propertyId)) return apiError(400, "domaine inconnu");
    const id = await createTemplate(env.DB, v);
    await audit(env.DB, "admin", "template.create", `template:${id}`, { name: v.name, par: currentUser(req) });
    return json({ ok: true, id, template: await getTemplate(env.DB, id) }, 201);
  }));

  router.patch("/api/admin/message-templates/:id", guard(async (req, env, p) => {
    const id = intOrZero(p.id);
    if (!id || !(await getTemplate(env.DB, id))) return apiError(404, "modèle inconnu");
    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    const parsed = parseTemplate(body, true);
    if (!parsed.ok) return apiError(400, parsed.message);
    const pidSet = parsed.value.propertyId;
    if (pidSet != null && !(await listProperties(env.DB)).some((x) => x.id === pidSet)) return apiError(400, "domaine inconnu");
    await updateTemplate(env.DB, id, parsed.value);
    await audit(env.DB, "admin", "template.update", `template:${id}`, { champs: Object.keys(parsed.value), par: currentUser(req) });
    return json({ ok: true, template: await getTemplate(env.DB, id) });
  }));

  router.delete("/api/admin/message-templates/:id", guard(async (req, env, p) => {
    const id = intOrZero(p.id);
    const tpl = id ? await getTemplate(env.DB, id) : null;
    if (!tpl || !(await deleteTemplate(env.DB, id))) return apiError(404, "modèle inconnu");
    await audit(env.DB, "admin", "template.delete", `template:${id}`, { name: tpl.name, par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- 4. mon compte --------------------------------------------------------------
  router.get("/api/admin/me", guard(async (req, env) => {
    const user = currentUser(req);
    const session = sessionTokenOf(req);
    if (!session) return json({ user, kind: "secours", sessions: 0 });
    const row = await env.DB.prepare(
      "SELECT u.id, u.last_login_at, (SELECT COUNT(*) FROM admin_sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions FROM admin_users u WHERE u.username = ?1",
    )
      .bind(user)
      .first<{ id: number; last_login_at: string | null; sessions: number }>();
    return json({ user, kind: "compte", sessions: Number(row?.sessions ?? 0), lastLoginAt: row?.last_login_at ?? null });
  }));

  // Changer SON mot de passe : l'ancien est exigé, et toutes les AUTRES
  // sessions du compte tombent (un téléphone perdu reste connecté sinon). Le
  // nouveau est choisi (12 caractères au moins) ou proposé par la plateforme
  // (`generate: true`, même format que les accès initiaux, montré une fois).
  router.post("/api/admin/me/password", guard(async (req, env) => {
    const session = sessionTokenOf(req);
    if (!session) {
      return apiError(400, "accès de secours : ce mot de passe se change dans la configuration du serveur (ADMIN_TOKEN), pas ici");
    }
    const user = currentUser(req);
    const row = await env.DB.prepare("SELECT id, username, password_hash FROM admin_users WHERE username = ?1 AND active = 1")
      .bind(user)
      .first<{ id: number; username: string; password_hash: string }>();
    if (!row) return apiError(401, "session expirée ou révoquée");
    const failures = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'me.password.failed' AND entity = ?1 AND created_at > datetime('now', '-15 minutes')",
    )
      .bind(`user:${row.username}`)
      .first<{ n: number }>();
    if (Number(failures?.n ?? 0) >= MAX_PASSWORD_FAILURES) {
      return apiError(429, "trop d'essais manqués : réessayez dans un quart d'heure");
    }
    const body = await readJson<{ current?: unknown; next?: unknown; generate?: unknown }>(req);
    const current = typeof body?.current === "string" ? body.current : "";
    if (!current) return apiError(400, "mot de passe actuel requis");
    if (!(await verifyPassword(current, row.password_hash))) {
      await audit(env.DB, "admin", "me.password.failed", `user:${row.username}`);
      return apiError(403, "le mot de passe actuel n'est pas le bon");
    }
    const generated = body?.generate === true;
    const next = generated ? generatePassword() : typeof body?.next === "string" ? body.next : "";
    if (!generated) {
      if (next.length < 12) return apiError(400, "nouveau mot de passe trop court (12 caractères au moins)");
      if (next.length > 200) return apiError(400, "nouveau mot de passe trop long (200 caractères au plus)");
      if (next === current) return apiError(400, "le nouveau mot de passe doit être différent de l'actuel");
      if (next.toLowerCase().includes(row.username.toLowerCase())) return apiError(400, "le mot de passe ne doit pas contenir l'identifiant");
    }
    const keep = await sha256hex(session);
    await env.DB.batch([
      env.DB.prepare("UPDATE admin_users SET password_hash = ?2 WHERE id = ?1").bind(row.id, await hashPassword(next)),
      env.DB.prepare("DELETE FROM admin_sessions WHERE user_id = ?1 AND token_hash != ?2").bind(row.id, keep),
    ]);
    await audit(env.DB, "admin", "me.password.changed", `user:${row.username}`, { genere: generated });
    return json({ ok: true, ...(generated ? { password: next } : {}) });
  }));

  // --- 5. envoi de photos ---------------------------------------------------------
  //
  // multipart/form-data : `file` (jpeg, png ou webp, 8 Mo au plus), `alt` et
  // `caption` facultatifs. Le type est lu dans les octets, jamais dans le nom
  // ni dans l'en-tête du navigateur ; le nom est tiré au hasard. Sans texte de
  // photo, la photo arrive MASQUÉE : elle ne s'affiche sur le site qu'une fois
  // décrite (le texte alternatif est obligatoire, issue #32).
  //
  // Sur Workers, aucun disque : 501, propre et explicite.
  router.post("/api/admin/units/:id/photos/upload", guard(async (req, env, p) => {
    if (!env.UPLOADS) {
      return apiError(501, "envoi de photos non disponible sur cet hébergement (seulement sur le serveur Node)", { code: "uploads_unavailable" });
    }
    const id = intOrZero(p.id);
    const unit = id ? await getUnit(env.DB, id) : null;
    if (!unit) return apiError(404, "hébergement inconnu");
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024) return apiError(413, "photo trop lourde (8 Mo au plus)");
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return apiError(400, "envoi illisible : formulaire multipart attendu (champ file)");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return apiError(400, "fichier attendu (champ file)");
    if (file.size > MAX_UPLOAD_BYTES) return apiError(413, "photo trop lourde (8 Mo au plus)");
    if (file.size === 0) return apiError(400, "fichier vide");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImageType(bytes);
    if (!type) return apiError(415, "format non accepté : JPEG, PNG ou WebP seulement");
    const name = `${randomHex(16)}.${type}`;
    const size = imageSize(name, bytes);
    if (!size) return apiError(400, "fichier illisible comme image");
    const altRaw = String(form.get("alt") ?? "").trim();
    if (altRaw.length > 300) return apiError(400, "texte alternatif trop long (300 caractères maximum)");
    const caption = String(form.get("caption") ?? "").trim();
    if (caption.length > 200) return apiError(400, "légende trop longue (200 caractères maximum)");
    const described = altRaw.length >= 3;
    await env.UPLOADS.put(name, bytes);
    const path = `/uploads/${name}`;
    let photoId: number | null = null;
    try {
      photoId = await createUnitPhoto(env.DB, {
        unitId: id,
        path,
        alt: described ? altRaw : `Photo de ${unit.name}, à décrire`,
        caption: caption || null,
        webpWidths: [],
        width: size.width,
        height: size.height,
        active: described,
      });
    } finally {
      // Fichier sans ligne en base = fichier orphelin : on le retire.
      if (photoId == null) await env.UPLOADS.remove?.(name).catch(() => undefined);
    }
    if (photoId == null) return apiError(500, "la photo n'a pas pu être enregistrée");
    await audit(env.DB, "admin", "unit.photo.upload", `unit:${id}`, { path, octets: bytes.length, par: currentUser(req) });
    return json({ id: photoId, path, width: size.width, height: size.height, active: described }, 201);
  }));
}
