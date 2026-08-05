// API back-office. Protection : Cloudflare Access en production (décision de
// déploiement de Julien) + jeton optionnel ADMIN_TOKEN en défense en profondeur
// (si configuré, exigé en header Authorization: Bearer …).

import { apiError, json, readJson, Router, type Handler } from "./router";
import { addDays, diffDays, isIsoDate, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import { isActiveBooking } from "../core/availability";
import { rateCalendar } from "../core/pricing";
import { computeYearStats, type StatsBooking } from "../core/stats";
import {
  addPayment,
  audit,
  bookingsForGuest,
  bookingsInWindow,
  cancelBooking,
  confirmBookingAtomic,
  healthSignals,
  createBookingAtomic,
  createFeed,
  createOption,
  createPromotion,
  createRateRule,
  createSeason,
  deleteFeed,
  deleteOption,
  deletePromotion,
  deleteRateRule,
  deleteSeason,
  getBooking,
  getFeed,
  getGuest,
  getProperty,
  getQuoteContext,
  getSettings,
  listAudit,
  listAuditByAction,
  listBeds24Bookings,
  listBookings,
  listEmailLog,
  listFeeds,
  listGuests,
  listLinks,
  listOptionsAdmin,
  listPayments,
  listPromotions,
  listProperties,
  listRateRules,
  listSeasons,
  listUnits,
  updateBookingNotes,
  updateChecklistItem,
  updateFeed,
  updateGuest,
  updateOption,
  updateProperty,
  updatePromotion,
  updateRateRule,
  countNewMessages,
  createUnit,
  getMessage,
  getThread,
  insertOutboundMessage,
  listChecklist,
  listMessages,
  markMessage,
  setMutualLinks,
  updateSeason,
  updateSettings,
  updateUnit,
  upsertGuest,
  type BookingRow,
  type OptionInput,
  type PromotionInput,
  type RateRuleInput,
} from "../db/repo";
import { Beds24Error, beds24Configured, beds24Setup, beds24Status, resetBeds24TokenCache } from "../services/beds24";
import {
  createSession, deleteSession, deleteUserSessions, generatePassword, hashPassword, sessionUser, verifyPassword,
} from "../services/admin-auth";
import { getSetting, setSetting } from "../services/settings";
import { pullBeds24Bookings, pushCalendars, triggerBeds24Push, triggerBeds24PushAll } from "../services/beds24-sync";
import { quoteFromContext, sendVoucher, startCheckout, type QuoteBody } from "../services/booking-flow";
import { queueEmail } from "../services/email";
import { importElloha } from "../services/elloha-import";
import { processInboundEmail, type ParsedEmail } from "../services/inbound-email";
import { syncFeed } from "../services/ical";

// --- garde d'authentification -------------------------------------------------

/** Comparaison à temps constant — évite de fuiter le jeton octet par octet. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Garde FAIL-CLOSED (audit ECC 2026-07-30, finding critique n°1).
 *
 *  La version précédente ne vérifiait RIEN quand ADMIN_TOKEN était absent —
 *  or c'est la valeur par défaut de .dev.vars.example. Un oubli de règle
 *  Cloudflare Access (posée sur /admin mais pas sur /api/admin/*, ou contournée
 *  par le sous-domaine workers.dev) exposait alors tout le fichier clients,
 *  les écritures, et la clé du webhook Beds24 en clair.
 *
 *  Désormais : jeton valide, OU en-tête Cloudflare Access (l'utilisateur a déjà
 *  été authentifié en amont). Sinon, refus. */
/** ADMIN_TOKEN = comptes du back-office : liste `identifiant:motdepasse` séparée
 *  par des virgules (« julien:…,matthieu:…,papa:… ») — un accès par personne,
 *  révocable un par un en republiant le secret sans la paire concernée.
 *  L'ancien format à jeton unique sans identifiant reste accepté tel quel. */
function parseAdminEntries(raw: string): Array<{ user: string; password: string }> {
  return raw
    .split(",")
    .map((part) => {
      const idx = part.indexOf(":");
      return {
        user: idx > 0 ? part.slice(0, idx).trim() : "",
        password: (idx > 0 ? part.slice(idx + 1) : part).trim(),
      };
    })
    .filter((e) => e.password.length > 0);
}

/** Vérifie un couple identifiant/mot de passe. L'identifiant n'est pas secret
 *  (comparaison simple) ; le mot de passe est comparé à temps constant, avec
 *  une comparaison factice quand l'identifiant est inconnu pour ne pas fuiter
 *  son existence par le chronomètre. */
function checkCredentials(raw: string, user: string, password: string): boolean {
  const entries = parseAdminEntries(raw);
  const entry = entries.find((e) => e.user === user);
  if (!entry) {
    safeEqual(password, "comparaison-factice-anti-chronometre");
    return false;
  }
  return safeEqual(password, entry.password);
}

/** Identité authentifiée de la requête (posée par guard, lue par la page
 *  Utilisateurs pour interdire l'auto-verrouillage et tracer l'audit). */
const REQUEST_USER = new WeakMap<Request, string>();

function currentUser(req: Request): string {
  return REQUEST_USER.get(req) ?? "admin";
}

function guard(handler: Handler): Handler {
  return async (req, env, params, url, ctx) => {
    const header = req.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

    // 1) Session de la page de login (comptes en base — page Utilisateurs).
    if (presented.startsWith("session:")) {
      const username = await sessionUser(env.DB, presented.slice(8));
      if (!username) return apiError(401, "session expirée ou révoquée");
      REQUEST_USER.set(req, username);
      return handler(req, env, params, url, ctx);
    }

    // 2) Accès de secours hors base : secret ADMIN_TOKEN (couple id:mdp lié,
    //    ou mot de passe nu pour verify-deploy et les sessions historiques).
    const raw = env.ADMIN_TOKEN?.trim();
    if (raw) {
      const sep = presented.indexOf(":");
      let ok = false;
      if (sep > 0) {
        ok = checkCredentials(raw, presented.slice(0, sep), presented.slice(sep + 1));
        if (ok) REQUEST_USER.set(req, presented.slice(0, sep));
      } else {
        // Pas de sortie anticipée : chaque candidat est comparé à temps constant.
        for (const e of parseAdminEntries(raw)) ok = safeEqual(presented, e.password) || ok;
      }
      if (ok) return handler(req, env, params, url, ctx);
      return apiError(401, "non autorisé");
    }
    if (req.headers.get("cf-access-jwt-assertion")) return handler(req, env, params, url, ctx);

    // 3) Sans secret : fail-closed tant qu'aucun compte n'existe en base ;
    //    401 (→ page de login) dès que le verrou vit en base.
    const hasUsers = await env.DB.prepare("SELECT 1 FROM admin_users WHERE active = 1 LIMIT 1").first();
    if (hasUsers) return apiError(401, "non autorisé");
    return apiError(503, "ADMIN_TOKEN non configuré — accès refusé (fail-closed)");
  };
}

/** Pourcentage de remise borné à [0,100] — une saisie « 150 » au lieu de « 15 »
 *  produisait un devis et des arrhes NÉGATIFS (audit ECC 2026-07-30). Le moteur
 *  de tarification plafonne aussi de son côté : double ceinture, la saisie
 *  fautive est refusée ici pour ne jamais entrer en base. */
function pctOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), 100);
}

/** Vrai si la valeur fournie est un pourcentage hors bornes (refus en 400). */
function badPct(v: unknown): boolean {
  if (v == null) return false;
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 || n > 100;
}

function intParam(v: string | null | undefined, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toStatsBooking(b: BookingRow): StatsBooking {
  return { unitId: b.unitId, checkin: b.checkin, checkout: b.checkout, totalCents: b.totalCents };
}

function csvEscape(v: unknown): string {
  const raw = String(v ?? "");
  // Injection de formule Excel/LibreOffice : un client qui saisit son nom en
  // « =HYPERLINK("http://…"&A1,"Cliquez") » verrait la formule s'exécuter à
  // l'ouverture de l'export. L'apostrophe de tête neutralise la cellule.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvResponse(rows: unknown[][], filename: string): Response {
  const text = rows.map((r) => r.map(csvEscape).join(";")).join("\r\n");
  // BOM UTF-8 pour Excel
  return new Response("﻿" + text, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function confirmedYearBookings(db: D1Database, propertyId: number, year: number): Promise<StatsBooking[]> {
  const rows = await bookingsInWindow(db, propertyId, `${year}-01-01`, `${year + 1}-01-01`);
  return rows.filter((b) => b.status === "confirmed").map(toStatsBooking);
}

export function registerAdminRoutes(router: Router): void {
  // --- connexion --------------------------------------------------------------
  // SEULE route /api/admin/* volontairement HORS guard : elle sert à obtenir
  // l'accès. Elle ne renvoie jamais de donnée métier — juste oui/non (+ session).
  router.post("/api/admin/login", async (req, env) => {
    const body = (await req.json().catch(() => ({}))) as { user?: unknown; password?: unknown };
    const user = typeof body.user === "string" ? body.user.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!user || !password) return apiError(400, "identifiant et mot de passe requis");

    // 1) Comptes en base (gérés par la page Utilisateurs) → session de 30 jours.
    const row = await env.DB.prepare("SELECT id, username, password_hash, active FROM admin_users WHERE username = ?")
      .bind(user)
      .first<{ id: number; username: string; password_hash: string; active: number }>();
    if (row) {
      if (!row.active) return apiError(401, "compte désactivé");
      if (!(await verifyPassword(password, row.password_hash))) {
        await audit(env.DB, "admin", "login.failed", `user:${row.username}`);
        return apiError(401, "identifiant ou mot de passe incorrect");
      }
      const session = await createSession(env.DB, row.id);
      await audit(env.DB, "admin", "login.ok", `user:${row.username}`);
      return json({ ok: true, user: row.username, session });
    }

    // 2) Accès de secours : secret ADMIN_TOKEN (pas de session — le navigateur
    //    conserve id:mdp et la garde le revérifie à chaque requête).
    const raw = env.ADMIN_TOKEN?.trim();
    if (raw && checkCredentials(raw, user, password)) return json({ ok: true, user });
    if (!raw) {
      const hasUsers = await env.DB.prepare("SELECT 1 FROM admin_users LIMIT 1").first();
      if (!hasUsers) return apiError(503, "ADMIN_TOKEN non configuré — accès refusé (fail-closed)");
    }
    await audit(env.DB, "admin", "login.failed", `user:${user.slice(0, 40)}`);
    return apiError(401, "identifiant ou mot de passe incorrect");
  });

  router.post("/api/admin/logout", guard(async (req, env) => {
    const header = req.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented.startsWith("session:")) await deleteSession(env.DB, presented.slice(8));
    return json({ ok: true });
  }));

  // --- utilisateurs (page Utilisateurs — tout se gère depuis le back-office) --
  router.get("/api/admin/users", guard(async (_req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT u.id, u.username, u.active, u.created_at, u.last_login_at, " +
        "(SELECT COUNT(*) FROM admin_sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions " +
        "FROM admin_users u ORDER BY u.username",
    ).all();
    return json({ users: results, breakGlass: Boolean(env.ADMIN_TOKEN?.trim()) });
  }));

  router.post("/api/admin/users", guard(async (req, env) => {
    const body = (await req.json().catch(() => ({}))) as { username?: unknown };
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{1,19}$/.test(username)) {
      return apiError(400, "identifiant invalide — 2 à 20 caractères parmi a-z, 0-9, point, tiret, underscore");
    }
    const exists = await env.DB.prepare("SELECT 1 FROM admin_users WHERE username = ?").bind(username).first();
    if (exists) return apiError(409, "cet identifiant existe déjà");
    const password = generatePassword();
    const res = await env.DB.prepare("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)")
      .bind(username, await hashPassword(password))
      .run();
    await audit(env.DB, "admin", "user.create", `user:${username}`, { par: currentUser(req) });
    // Le mot de passe n'est affiché qu'une fois — il n'est stocké que haché.
    return json({ ok: true, id: res.meta.last_row_id, username, password });
  }));

  router.post("/api/admin/users/:id/reset-password", guard(async (req, env, p) => {
    const id = Number(p.id);
    const row = await env.DB.prepare("SELECT id, username FROM admin_users WHERE id = ?").bind(id)
      .first<{ id: number; username: string }>();
    if (!row) return apiError(404, "utilisateur inconnu");
    const password = generatePassword();
    await env.DB.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), id).run();
    await deleteUserSessions(env.DB, id); // l'ancien mot de passe et ses sessions tombent ensemble
    await audit(env.DB, "admin", "user.reset_password", `user:${row.username}`, { par: currentUser(req) });
    return json({ ok: true, username: row.username, password });
  }));

  router.patch("/api/admin/users/:id", guard(async (req, env, p) => {
    const id = Number(p.id);
    const body = (await req.json().catch(() => ({}))) as { active?: unknown };
    if (typeof body.active !== "boolean") return apiError(400, "champ active (booléen) requis");
    const row = await env.DB.prepare("SELECT id, username FROM admin_users WHERE id = ?").bind(id)
      .first<{ id: number; username: string }>();
    if (!row) return apiError(404, "utilisateur inconnu");
    if (!body.active && row.username === currentUser(req)) return apiError(400, "impossible de désactiver son propre compte");
    await env.DB.prepare("UPDATE admin_users SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
    if (!body.active) await deleteUserSessions(env.DB, id);
    await audit(env.DB, "admin", body.active ? "user.enable" : "user.disable", `user:${row.username}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  router.delete("/api/admin/users/:id", guard(async (req, env, p) => {
    const id = Number(p.id);
    const row = await env.DB.prepare("SELECT id, username FROM admin_users WHERE id = ?").bind(id)
      .first<{ id: number; username: string }>();
    if (!row) return apiError(404, "utilisateur inconnu");
    if (row.username === currentUser(req)) return apiError(400, "impossible de supprimer son propre compte");
    await deleteUserSessions(env.DB, id);
    await env.DB.prepare("DELETE FROM admin_users WHERE id = ?").bind(id).run();
    await audit(env.DB, "admin", "user.delete", `user:${row.username}`, { par: currentUser(req) });
    return json({ ok: true });
  }));

  // --- référentiel de base ----------------------------------------------------
  router.get("/api/admin/properties", guard(async (_req, env) => json({ properties: await listProperties(env.DB) })));

  router.get("/api/admin/units", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ units: await listUnits(env.DB, propertyId), links: await listLinks(env.DB, propertyId) });
  }));

  router.patch("/api/admin/units/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    if (!id) return apiError(400, "id invalide");
    const body = await readJson<Record<string, unknown>>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    await updateUnit(env.DB, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      capacityBase: body.capacityBase != null ? Number(body.capacityBase) : undefined,
      capacityMax: body.capacityMax != null ? Number(body.capacityMax) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      compositePricing: body.compositePricing === "own" || body.compositePricing === "sum" ? body.compositePricing : undefined,
      cleaningFeeCents: body.cleaningFeeCents != null ? Math.round(Number(body.cleaningFeeCents)) : undefined,
      photoUrl: typeof body.photoUrl === "string" ? body.photoUrl.trim() : undefined,
    });
    await audit(env.DB, "admin", "unit.update", `unit:${id}`, body);
    return json({ ok: true });
  }));

  // Nouveau bien (maison C, futur gîte…) + liaisons mutuelles optionnelles.
  router.post("/api/admin/units", guard(async (req, env) => {
    const body = await readJson<Record<string, unknown>>(req);
    const name = String(body?.name ?? "").trim();
    const propertyId = intParam(String(body?.propertyId ?? ""), 0);
    if (!body || !name || !propertyId) return apiError(400, "propertyId et name requis");
    const capacityBase = Math.max(1, Math.floor(Number(body.capacityBase ?? 2)));
    const capacityMax = Math.max(capacityBase, Math.floor(Number(body.capacityMax ?? capacityBase)));
    const id = await createUnit(env.DB, {
      propertyId,
      name,
      description: typeof body.description === "string" ? body.description : null,
      capacityBase,
      capacityMax,
      isComposite: body.isComposite === true,
      compositePricing: body.compositePricing === "sum" ? "sum" : "own",
      cleaningFeeCents: body.cleaningFeeCents != null ? Math.round(Number(body.cleaningFeeCents)) : 0,
      photoUrl: typeof body.photoUrl === "string" ? body.photoUrl.trim() || null : null,
    });
    if (Array.isArray(body.linkedUnitIds) && body.linkedUnitIds.length > 0) {
      await setMutualLinks(env.DB, id, body.linkedUnitIds.map(Number));
    }
    // règle tarifaire de départ optionnelle, pour que le bien soit vendable direct
    if (body.priceWeekCents != null) {
      const week = Math.round(Number(body.priceWeekCents));
      await createRateRule(env.DB, {
        unitId: id,
        seasonId: null,
        priceWeekCents: week,
        priceWeekendCents: Math.round(Number(body.priceWeekendCents ?? week)),
        holidayPct: 15,
        minNights: Math.max(1, Math.floor(Number(body.minNights ?? 2))),
        checkinDays: null,
      });
    }
    await audit(env.DB, "admin", "unit.create", `unit:${id}`, { name, propertyId });
    return json({ id }, 201);
  }));

  // Liaisons mutuelles d'un bien (résa de l'un ⇒ blocage de l'autre, 2 sens).
  router.put("/api/admin/units/:id/links", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ partnerIds?: unknown[] }>(req);
    if (!id || !body || !Array.isArray(body.partnerIds)) return apiError(400, "partnerIds attendu");
    await setMutualLinks(env.DB, id, body.partnerIds.map(Number));
    await audit(env.DB, "admin", "unit.links", `unit:${id}`, { partnerIds: body.partnerIds });
    return json({ ok: true });
  }));

  // Calendrier des tarifs (vue elloha) : prix calculé jour par jour d'un bien.
  router.get("/api/admin/rate-calendar", guard(async (_req, env, _p, url) => {
    const unitId = intParam(url.searchParams.get("unit"), 0);
    const ctx = await getQuoteContext(env.DB, unitId);
    if (!ctx) return apiError(404, "hébergement inconnu");
    let from = url.searchParams.get("from") ?? "";
    let to = url.searchParams.get("to") ?? "";
    if (!isIsoDate(from) || !isIsoDate(to) || from >= to) {
      from = todayInZone().slice(0, 8) + "01";
      to = addDays(from, 62);
    }
    if (diffDays(from, to) > 370) to = addDays(from, 370);
    const days = rateCalendar(ctx.pricingUnit, from, to, ctx.seasons, ctx.rateRules);
    return json({
      unit: { id: ctx.unit.id, name: ctx.unit.name, cleaningFeeCents: ctx.unit.cleaningFeeCents },
      from,
      to,
      days,
      seasons: ctx.seasons,
    });
  }));

  router.patch("/api/admin/properties/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Record<string, unknown>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateProperty(env.DB, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      address: typeof body.address === "string" ? body.address : undefined,
      commune: typeof body.commune === "string" ? body.commune : undefined,
      contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : undefined,
      contactPhone: typeof body.contactPhone === "string" ? body.contactPhone : undefined,
    });
    await audit(env.DB, "admin", "property.update", `property:${id}`, body);
    return json({ ok: true });
  }));

  // --- tableau de bord ----------------------------------------------------------
  router.get("/api/admin/overview", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const property = await getProperty(db, propertyId);
    if (!property) return apiError(404, "domaine inconnu");

    const now = new Date();
    const today = todayInZone(now);
    const nowSql = sqlNow(now);
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));

    const [units, links] = await Promise.all([listUnits(db, propertyId), listLinks(db, propertyId)]);

    // Occupation & revenus du mois en cours (et du même mois N-1)
    const curBookings = await confirmedYearBookings(db, propertyId, year);
    const prevBookings = await confirmedYearBookings(db, propertyId, year - 1);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));
    const cur = computeYearStats(year, statsUnits, links, curBookings);
    const prev = computeYearStats(year - 1, statsUnits, links, prevBookings);
    const curMonth = cur.months[month - 1];
    const prevMonth = prev.months[month - 1];

    // Fenêtre large pour arrivées/départs/alertes
    const wide = await bookingsInWindow(db, propertyId, addDays(today, -1), addDays(today, 540));
    const confirmed = wide.filter((b) => b.status === "confirmed");

    const horizon = addDays(today, 7);
    const arrivals = confirmed
      .filter((b) => b.checkin >= today && b.checkin < horizon)
      .map((b) => ({ ...summary(b), kind: "arrivée" as const }));
    const departures = confirmed
      .filter((b) => b.checkout >= today && b.checkout < horizon)
      .map((b) => ({ ...summary(b), kind: "départ" as const }));

    const nextArrival = confirmed.filter((b) => b.checkin >= today).sort((a, b) => (a.checkin < b.checkin ? -1 : 1))[0] ?? null;

    const balancesDue = confirmed
      .filter((b) => b.totalCents - b.paidCents > 0)
      .map((b) => ({
        ...summary(b),
        balanceCents: b.totalCents - b.paidCents,
        balanceDueDate: b.balanceDueDate,
        overdue: !!b.balanceDueDate && b.balanceDueDate <= today,
      }));

    const activeHolds = wide.filter((b) => b.status === "pending" && isActiveBooking({ status: b.status, holdExpiresAt: b.holdExpiresAt }, nowSql));

    const compositeIds = new Set(units.filter((u) => u.isComposite).map((u) => u.id));
    const linkAlerts = confirmed
      .filter((b) => compositeIds.has(b.unitId) && b.checkout >= today && b.checkin <= addDays(today, 60))
      .map((b) => {
        const blocked = links.filter((l) => l.unitId === b.unitId).map((l) => units.find((u) => u.id === l.blocksUnitId)?.name ?? "");
        return { reference: b.reference, checkin: b.checkin, checkout: b.checkout, unitName: b.unitName, blocked };
      });

    const feeds = await listFeeds(db);
    const feedAlerts = feeds.filter((f) => f.lastStatus && f.lastStatus !== "ok");

    // Carte « Santé » : ce qui échoue aujourd'hui sans que personne ne l'apprenne
    // (audit ECC 2026-07-30 § observabilité). Un échec de lecture ne doit jamais
    // faire tomber le tableau de bord — d'où le repli neutre.
    let health: Awaited<ReturnType<typeof healthSignals>> = {
      orphanPayments: [],
      failedEmails: [],
      recentErrors: [],
      beds24LastPull: null,
      beds24StaleHours: null,
    };
    try {
      health = await healthSignals(db, propertyId, now);
    } catch (e) {
      console.error("healthSignals —", e);
    }
    let newEmails = 0;
    try {
      newEmails = await countNewMessages(db, propertyId);
    } catch {
      newEmails = 0; // table absente tant que la migration 0005 n'est pas passée
    }

    function summary(b: BookingRow) {
      return {
        id: b.id,
        reference: b.reference,
        unitName: b.unitName,
        guestName: b.guestName,
        checkin: b.checkin,
        checkout: b.checkout,
        persons: b.adults + b.children,
        totalCents: b.totalCents,
        paidCents: b.paidCents,
        status: b.status,
      };
    }

    return json({
      property: { id: property.id, name: property.name },
      today,
      kpis: {
        monthLabel: today.slice(0, 7),
        occupancyPct: curMonth?.occupancyPct ?? 0,
        occupancyPrevPct: prevMonth?.occupancyPct ?? 0,
        revenueCents: curMonth?.revenueCents ?? 0,
        revenuePrevCents: prevMonth?.revenueCents ?? 0,
        nextArrival: nextArrival
          ? { checkin: nextArrival.checkin, unitName: nextArrival.unitName, persons: nextArrival.adults + nextArrival.children, guestName: nextArrival.guestName }
          : null,
        balanceDueTotalCents: balancesDue.reduce((s, b) => s + b.balanceCents, 0),
        balanceDueCount: balancesDue.length,
      },
      movements: [...arrivals, ...departures].sort((a, b) => ((a.kind === "arrivée" ? a.checkin : a.checkout) < (b.kind === "arrivée" ? b.checkin : b.checkout) ? -1 : 1)),
      alerts: {
        overdueBalances: balancesDue.filter((b) => b.overdue),
        linkAlerts,
        feedAlerts: feedAlerts.map((f) => ({ id: f.id, name: f.name, status: f.lastStatus })),
        activeHolds: activeHolds.map((b) => ({ reference: b.reference, unitName: b.unitName, holdExpiresAt: b.holdExpiresAt })),
        newEmails,
      },
      health: {
        ...health,
        // Beds24 figé > 2 h = les calendriers OTA ne reflètent plus nos dates :
        // risque de surbooking silencieux tant que personne ne regarde.
        beds24Stale: health.beds24StaleHours != null && health.beds24StaleHours > 2,
        ok:
          health.orphanPayments.length === 0 &&
          health.failedEmails.length === 0 &&
          health.recentErrors.length === 0 &&
          !(health.beds24StaleHours != null && health.beds24StaleHours > 2),
      },
    });
  }));

  // --- planning -------------------------------------------------------------
  router.get("/api/admin/planning", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    let from = url.searchParams.get("from") ?? "";
    let to = url.searchParams.get("to") ?? "";
    if (!isIsoDate(from) || !isIsoDate(to) || from >= to) {
      const today = todayInZone();
      from = today.slice(0, 8) + "01";
      to = addDays(from, 45);
    }
    const [units, links, rows] = await Promise.all([
      listUnits(db, propertyId),
      listLinks(db, propertyId),
      bookingsInWindow(db, propertyId, from, to),
    ]);
    const now = sqlNow();
    const active = rows.filter((b) => isActiveBooking({ status: b.status, holdExpiresAt: b.holdExpiresAt }, now));
    const compositeIds = new Set(units.filter((u) => u.isComposite).map((u) => u.id));

    const bookings = active.map((b) => ({
      id: b.id,
      reference: b.reference,
      unitId: b.unitId,
      checkin: b.checkin,
      checkout: b.checkout,
      status: b.status,
      source: b.source,
      channelLabel: b.channelLabel,
      guestName: b.guestName || b.channelLabel || "—",
      persons: b.adults + b.children,
      isComposite: compositeIds.has(b.unitId),
      paidState:
        b.totalCents <= 0 ? "n/a" : b.paidCents >= b.totalCents ? "soldée" : b.paidCents > 0 ? "acompte" : "impayée",
      balanceCents: Math.max(0, b.totalCents - b.paidCents),
    }));

    // Blocages par liaison : pour chaque unité, les résas actives d'AUTRES
    // unités qui la bloquent.
    const blocks: { unitId: number; checkin: IsoDate; checkout: IsoDate; sourceBookingId: number; sourceReference: string }[] = [];
    for (const u of units) {
      const blockers = new Set(links.filter((l) => l.blocksUnitId === u.id).map((l) => l.unitId));
      for (const b of active) {
        if (b.unitId !== u.id && blockers.has(b.unitId)) {
          blocks.push({ unitId: u.id, checkin: b.checkin, checkout: b.checkout, sourceBookingId: b.id, sourceReference: b.reference });
        }
      }
    }

    return json({
      from,
      to,
      units: units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active })),
      bookings,
      blocks,
    });
  }));

  // --- réservations -----------------------------------------------------------
  router.get("/api/admin/bookings", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const bookings = await listBookings(env.DB, {
      propertyId,
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      limit: intParam(url.searchParams.get("limit"), 200),
    });
    return json({ bookings });
  }));

  router.get("/api/admin/bookings/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    const [payments, emails] = await Promise.all([
      listPayments(env.DB, { bookingId: id }),
      listEmailLog(env.DB, id),
    ]);
    let quote: unknown = null;
    try {
      quote = booking.quoteJson ? JSON.parse(booking.quoteJson) : null;
    } catch {
      quote = null;
    }
    return json({ booking, payments, emails, quote });
  }));

  // Vente manuelle (résa téléphone) : devis serveur + création directe.
  router.post("/api/admin/bookings", guard(async (req, env, _p, _url, execCtx) => {
    const db = env.DB;
    const body = await readJson<
      QuoteBody & {
        guest?: { firstName?: string; lastName?: string; email?: string; phone?: string; address?: string; country?: string };
        internalNotes?: string;
        confirmNow?: boolean;          // true = confirmée d'office (paiement hors ligne)
        generatePaymentLink?: boolean; // true = créer un lien Stripe à transmettre
        paymentMode?: "deposit" | "full";
        holdMinutes?: number;          // si non confirmée : durée de l'option (défaut 72 h)
      }
    >(req);
    if (!body) return apiError(400, "corps JSON attendu");
    if (!isIsoDate(String(body.checkin)) || !isIsoDate(String(body.checkout)) || String(body.checkin) >= String(body.checkout)) {
      return apiError(400, "dates invalides");
    }
    const adults = Math.max(1, Math.floor(Number(body.adults ?? 1)));
    const children = Math.max(0, Math.floor(Number(body.children ?? 0)));
    const lastName = String(body.guest?.lastName ?? "").trim();
    if (lastName.length < 2) return apiError(400, "nom du client requis");

    const ctx = await getQuoteContext(db, Number(body.unitId));
    if (!ctx) return apiError(404, "hébergement inconnu");

    const today = todayInZone();
    const quote = quoteFromContext(ctx, { ...body, adults, children }, today);
    // En vente manuelle, min_nights et jour d'arrivée restent bloquants ;
    // seul un devis calculable passe.
    if (!quote.ok) return apiError(409, "devis impossible", { details: quote.errors, minNights: quote.minNights });

    const email = String(body.guest?.email ?? "").trim();
    const guestId = await upsertGuest(db, {
      email: email || null,
      firstName: String(body.guest?.firstName ?? "").trim() || null,
      lastName,
      phone: String(body.guest?.phone ?? "").trim() || null,
      address: String(body.guest?.address ?? "").trim() || null,
      country: String(body.guest?.country ?? "").trim() || null,
    });

    const full = body.paymentMode === "full" || quote.balanceDueDate === null;
    const amountDue = full ? quote.totalCents : quote.depositCents;
    const confirmNow = body.confirmNow !== false; // défaut : confirmée (vente téléphone)

    const created = await createBookingAtomic(db, {
      unitId: ctx.unit.id,
      checkin: String(body.checkin),
      checkout: String(body.checkout),
      adults,
      children,
      status: confirmNow ? "confirmed" : "pending",
      holdMinutes: intParam(String(body.holdMinutes ?? ""), 72 * 60),
      source: "manual",
      guestId,
      totalCents: quote.totalCents,
      depositCents: amountDue,
      balanceDueDate: full ? null : quote.balanceDueDate,
      quoteJson: JSON.stringify(quote),
      optionsJson: JSON.stringify(quote.lines.filter((l) => l.kind === "option")),
      promoCode: quote.promoApplied,
      internalNotes: String(body.internalNotes ?? "").trim() || null,
    });
    if (!created.ok) return apiError(409, "créneau indisponible (conflit avec une autre réservation)");
    await audit(db, "admin", "booking.create_manual", `booking:${created.id}`, { reference: created.reference, confirmNow });
    triggerBeds24Push(db, env, execCtx, ctx.unit.propertyId);

    let paymentUrl: string | null = null;
    if (body.generatePaymentLink && amountDue >= 50) {
      const booking = (await getBooking(db, created.id)) as BookingRow;
      const res = await startCheckout(db, env, booking, full ? "full" : "deposit", amountDue, "admin");
      paymentUrl = res.url;
    }
    const booking = await getBooking(db, created.id);
    return json({ booking, paymentUrl }, 201);
  }));

  router.post("/api/admin/bookings/:id/cancel", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ reason?: string }>(req);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    const done = await cancelBooking(env.DB, id, String(body?.reason ?? "annulation admin"));
    if (!done) return apiError(409, "déjà annulée");
    await audit(env.DB, "admin", "booking.cancel", `booking:${id}`, { reason: body?.reason });
    if (booking.propertyId != null) triggerBeds24Push(env.DB, env, execCtx, booking.propertyId);
    return json({ ok: true, note: "Remboursement éventuel à traiter manuellement dans Stripe (politique d'annulation : TODO Julien)." });
  }));

  router.post("/api/admin/bookings/:id/confirm", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ sendVoucher?: boolean }>(req);
    const outcome = await confirmBookingAtomic(env.DB, id);
    if (outcome === "conflict") {
      await audit(env.DB, "admin", "booking.confirm_conflict", `booking:${id}`);
      return apiError(409, "le créneau a été repris entre-temps — cette réservation ne peut plus être confirmée");
    }
    if (outcome !== "confirmed") return apiError(409, "cette réservation n'est pas en attente");
    await audit(env.DB, "admin", "booking.confirm_manual", `booking:${id}`);
    let voucherQueued = false;
    if (body?.sendVoucher) voucherQueued = await sendVoucher(env.DB, env, id);
    return json({ ok: true, voucherQueued });
  }));

  router.post("/api/admin/bookings/:id/payments", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    const body = await readJson<{ kind?: string; method?: string; amountCents?: number; note?: string }>(req);
    const amount = Math.round(Number(body?.amountCents));
    if (!Number.isFinite(amount) || amount === 0) return apiError(400, "montant invalide");
    const kind = ["deposit", "balance", "full", "refund", "manual"].includes(String(body?.kind)) ? String(body?.kind) : "manual";
    const method = ["stripe", "transfer", "cash", "other"].includes(String(body?.method)) ? String(body?.method) : "transfer";
    await addPayment(env.DB, {
      bookingId: id,
      kind: kind as "manual",
      method: method as "transfer",
      amountCents: amount,
      status: "succeeded",
      note: String(body?.note ?? "").trim() || null,
      receivedAt: sqlNow(),
    });
    await audit(env.DB, "admin", "payment.manual", `booking:${id}`, { amount, method, kind });
    return json({ booking: await getBooking(env.DB, id) });
  }));

  router.post("/api/admin/bookings/:id/payment-link", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const booking = await getBooking(env.DB, id);
    if (!booking) return apiError(404, "réservation inconnue");
    if (booking.status === "cancelled") return apiError(400, "réservation annulée");
    const body = await readJson<{ amountCents?: number; kind?: string }>(req);
    const balance = Math.max(0, booking.totalCents - booking.paidCents);
    const amount = body?.amountCents != null ? Math.round(Number(body.amountCents)) : balance;
    if (!Number.isFinite(amount) || amount < 50) return apiError(400, "montant invalide (min 0,50 €)");
    const kind = body?.kind === "deposit" || body?.kind === "full" ? body.kind : "balance";
    const { url } = await startCheckout(env.DB, env, booking, kind, amount, "admin");
    return json({ url, amountCents: amount });
  }));

  router.post("/api/admin/bookings/:id/resend-voucher", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const queued = await sendVoucher(env.DB, env, id);
    if (!queued) return apiError(400, "pas d'email client sur cette réservation");
    await audit(env.DB, "admin", "email.voucher_resent", `booking:${id}`);
    return json({ ok: true });
  }));

  router.patch("/api/admin/bookings/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ internalNotes?: string }>(req);
    if (!body || typeof body.internalNotes !== "string") return apiError(400, "internalNotes attendu");
    await updateBookingNotes(env.DB, id, body.internalNotes);
    return json({ ok: true });
  }));

  // Devis côté admin (vente manuelle)
  router.post("/api/admin/quote", guard(async (req, env) => {
    const body = await readJson<QuoteBody>(req);
    if (!body) return apiError(400, "corps JSON attendu");
    if (!isIsoDate(String(body.checkin)) || !isIsoDate(String(body.checkout)) || String(body.checkin) >= String(body.checkout)) {
      return apiError(400, "dates invalides");
    }
    const ctx = await getQuoteContext(env.DB, Number(body.unitId));
    if (!ctx) return apiError(404, "hébergement inconnu");
    const quote = quoteFromContext(
      ctx,
      { ...body, adults: Math.max(1, Number(body.adults ?? 1)), children: Math.max(0, Number(body.children ?? 0)) },
      todayInZone(),
    );
    return json({ unit: { id: ctx.unit.id, name: ctx.unit.name }, quote });
  }));

  // --- saisons ----------------------------------------------------------------
  router.get("/api/admin/seasons", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ seasons: await listSeasons(env.DB, propertyId) });
  }));

  router.post("/api/admin/seasons", guard(async (req, env, _p, url, execCtx) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<{ name?: string; dateStart?: string; dateEnd?: string; priority?: number }>(req);
    const name = String(body?.name ?? "").trim();
    const dateStart = String(body?.dateStart ?? "");
    const dateEnd = String(body?.dateEnd ?? "");
    if (!name || !isIsoDate(dateStart) || !isIsoDate(dateEnd) || dateStart > dateEnd) {
      return apiError(400, "nom et dates (début ≤ fin) requis");
    }
    const id = await createSeason(env.DB, propertyId, { name, dateStart, dateEnd, priority: Math.floor(Number(body?.priority ?? 0)) });
    await audit(env.DB, "admin", "season.create", `season:${id}`, body);
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ id }, 201);
  }));

  router.patch("/api/admin/seasons/:id", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ name?: string; dateStart?: string; dateEnd?: string; priority?: number }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    if (body.dateStart !== undefined && !isIsoDate(String(body.dateStart))) return apiError(400, "dateStart invalide");
    if (body.dateEnd !== undefined && !isIsoDate(String(body.dateEnd))) return apiError(400, "dateEnd invalide");
    await updateSeason(env.DB, id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      dateStart: body.dateStart !== undefined ? String(body.dateStart) : undefined,
      dateEnd: body.dateEnd !== undefined ? String(body.dateEnd) : undefined,
      priority: body.priority !== undefined ? Math.floor(Number(body.priority)) : undefined,
    });
    await audit(env.DB, "admin", "season.update", `season:${id}`, body);
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  router.delete("/api/admin/seasons/:id", guard(async (_req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    await deleteSeason(env.DB, id);
    await audit(env.DB, "admin", "season.delete", `season:${id}`);
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  // --- règles tarifaires --------------------------------------------------------
  router.get("/api/admin/rate-rules", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ rules: await listRateRules(env.DB, propertyId) });
  }));

  router.post("/api/admin/rate-rules", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<Partial<RateRuleInput>>(req);
    if (!body || !body.unitId) return apiError(400, "unitId requis");
    const priceWeek = Math.round(Number(body.priceWeekCents));
    const priceWeekend = Math.round(Number(body.priceWeekendCents ?? priceWeek));
    if (!Number.isFinite(priceWeek) || priceWeek < 0) return apiError(400, "prix semaine invalide");
    try {
      const id = await createRateRule(env.DB, {
        unitId: Number(body.unitId),
        seasonId: body.seasonId != null ? Number(body.seasonId) : null,
        priceWeekCents: priceWeek,
        priceWeekendCents: priceWeekend,
        holidayPct: Math.floor(Number(body.holidayPct ?? 0)),
        minNights: Math.max(1, Math.floor(Number(body.minNights ?? 1))),
        checkinDays: Array.isArray(body.checkinDays) ? body.checkinDays.map(Number).filter((d) => d >= 0 && d <= 6) : null,
      });
      await audit(env.DB, "admin", "rate.create", `rate:${id}`, body);
      await triggerBeds24PushAll(env.DB, env, execCtx);
      return json({ id }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) return apiError(409, "une règle existe déjà pour cette unité et cette saison");
      throw e;
    }
  }));

  router.patch("/api/admin/rate-rules/:id", guard(async (req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Partial<RateRuleInput>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateRateRule(env.DB, id, {
      priceWeekCents: body.priceWeekCents != null ? Math.round(Number(body.priceWeekCents)) : undefined,
      priceWeekendCents: body.priceWeekendCents != null ? Math.round(Number(body.priceWeekendCents)) : undefined,
      holidayPct: body.holidayPct != null ? Math.floor(Number(body.holidayPct)) : undefined,
      minNights: body.minNights != null ? Math.max(1, Math.floor(Number(body.minNights))) : undefined,
      checkinDays:
        body.checkinDays === undefined
          ? undefined
          : Array.isArray(body.checkinDays)
            ? body.checkinDays.map(Number).filter((d) => d >= 0 && d <= 6)
            : null,
    });
    await audit(env.DB, "admin", "rate.update", `rate:${id}`, body);
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  router.delete("/api/admin/rate-rules/:id", guard(async (_req, env, p, _url, execCtx) => {
    const id = intParam(p.id, 0);
    await deleteRateRule(env.DB, id);
    await audit(env.DB, "admin", "rate.delete", `rate:${id}`);
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json({ ok: true });
  }));

  // --- promotions -----------------------------------------------------------------
  router.get("/api/admin/promotions", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ promotions: await listPromotions(env.DB, propertyId) });
  }));

  router.post("/api/admin/promotions", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<Partial<PromotionInput>>(req);
    const kind = String(body?.kind ?? "");
    if (!body || !["code", "long_stay", "early_bird", "last_minute"].includes(kind)) return apiError(400, "kind invalide");
    if (kind === "code" && !String(body.code ?? "").trim()) return apiError(400, "code requis");
    if (kind !== "code" && body.threshold == null) return apiError(400, "seuil requis pour une remise automatique");
    if (body.discountPct == null && body.discountCents == null) return apiError(400, "remise % ou montant requis");
    if (badPct(body.discountPct)) return apiError(400, "remise en % hors bornes (0 à 100)");
    const id = await createPromotion(env.DB, propertyId, {
      kind: kind as PromotionInput["kind"],
      code: kind === "code" ? String(body.code).trim() : null,
      label: String(body.label ?? "").trim() || (kind === "code" ? `Code ${String(body.code).trim()}` : kind),
      discountPct: pctOrNull(body.discountPct),
      discountCents: body.discountCents != null ? Math.round(Number(body.discountCents)) : null,
      threshold: body.threshold != null ? Math.floor(Number(body.threshold)) : null,
      validFrom: body.validFrom && isIsoDate(String(body.validFrom)) ? String(body.validFrom) : null,
      validUntil: body.validUntil && isIsoDate(String(body.validUntil)) ? String(body.validUntil) : null,
      maxUses: body.maxUses != null ? Math.floor(Number(body.maxUses)) : null,
      active: body.active !== false,
    });
    await audit(env.DB, "admin", "promotion.create", `promotion:${id}`, body);
    return json({ id }, 201);
  }));

  router.patch("/api/admin/promotions/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Partial<PromotionInput>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    if (badPct(body.discountPct)) return apiError(400, "remise en % hors bornes (0 à 100)");
    await updatePromotion(env.DB, id, {
      code: body.code !== undefined ? String(body.code).trim() : undefined,
      label: body.label !== undefined ? String(body.label).trim() : undefined,
      discountPct: body.discountPct !== undefined ? pctOrNull(body.discountPct) : undefined,
      discountCents: body.discountCents !== undefined ? (body.discountCents == null ? null : Math.round(Number(body.discountCents))) : undefined,
      threshold: body.threshold !== undefined ? (body.threshold == null ? null : Math.floor(Number(body.threshold))) : undefined,
      validFrom: body.validFrom !== undefined ? (body.validFrom && isIsoDate(String(body.validFrom)) ? String(body.validFrom) : null) : undefined,
      validUntil: body.validUntil !== undefined ? (body.validUntil && isIsoDate(String(body.validUntil)) ? String(body.validUntil) : null) : undefined,
      maxUses: body.maxUses !== undefined ? (body.maxUses == null ? null : Math.floor(Number(body.maxUses))) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
    });
    await audit(env.DB, "admin", "promotion.update", `promotion:${id}`, body);
    return json({ ok: true });
  }));

  router.delete("/api/admin/promotions/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    await deletePromotion(env.DB, id);
    await audit(env.DB, "admin", "promotion.delete", `promotion:${id}`);
    return json({ ok: true });
  }));

  // --- options ---------------------------------------------------------------------
  router.get("/api/admin/options", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    return json({ options: await listOptionsAdmin(env.DB, propertyId) });
  }));

  router.post("/api/admin/options", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<Partial<OptionInput>>(req);
    const name = String(body?.name ?? "").trim();
    const mode = String(body?.pricingMode ?? "per_stay");
    const price = Math.round(Number(body?.priceCents));
    if (!name || !Number.isFinite(price) || price < 0) return apiError(400, "nom et prix requis");
    if (!["per_stay", "per_night", "per_person", "per_person_night", "per_unit_qty"].includes(mode)) {
      return apiError(400, "pricingMode invalide");
    }
    const id = await createOption(env.DB, propertyId, {
      name,
      pricingMode: mode as OptionInput["pricingMode"],
      priceCents: price,
      unitLabel: String(body?.unitLabel ?? "").trim() || null,
      maxQty: body?.maxQty != null ? Math.floor(Number(body.maxQty)) : null,
      active: body?.active !== false,
      sortOrder: Math.floor(Number(body?.sortOrder ?? 0)),
    });
    await audit(env.DB, "admin", "option.create", `option:${id}`, body);
    return json({ id }, 201);
  }));

  router.patch("/api/admin/options/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Partial<OptionInput>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateOption(env.DB, id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      pricingMode: body.pricingMode,
      priceCents: body.priceCents != null ? Math.round(Number(body.priceCents)) : undefined,
      unitLabel: body.unitLabel !== undefined ? (String(body.unitLabel).trim() || null) : undefined,
      maxQty: body.maxQty !== undefined ? (body.maxQty == null ? null : Math.floor(Number(body.maxQty))) : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      sortOrder: body.sortOrder != null ? Math.floor(Number(body.sortOrder)) : undefined,
    });
    await audit(env.DB, "admin", "option.update", `option:${id}`, body);
    return json({ ok: true });
  }));

  router.delete("/api/admin/options/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    await deleteOption(env.DB, id);
    await audit(env.DB, "admin", "option.delete", `option:${id}`);
    return json({ ok: true });
  }));

  // --- clients ---------------------------------------------------------------------
  router.get("/api/admin/guests", guard(async (_req, env, _p, url) => {
    return json({ guests: await listGuests(env.DB, url.searchParams.get("search") ?? undefined) });
  }));

  router.get("/api/admin/guests/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const guest = await getGuest(env.DB, id);
    if (!guest) return apiError(404, "client inconnu");
    return json({ guest, bookings: await bookingsForGuest(env.DB, id) });
  }));

  router.patch("/api/admin/guests/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<Record<string, unknown>>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    await updateGuest(env.DB, id, {
      email: typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined,
      firstName: typeof body.firstName === "string" ? body.firstName : undefined,
      lastName: typeof body.lastName === "string" && body.lastName.trim() ? body.lastName.trim() : undefined,
      phone: typeof body.phone === "string" ? body.phone : undefined,
      address: typeof body.address === "string" ? body.address : undefined,
      country: typeof body.country === "string" ? body.country : undefined,
      lang: typeof body.lang === "string" ? body.lang : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    await audit(env.DB, "admin", "guest.update", `guest:${id}`);
    return json({ ok: true });
  }));

  // --- paiements ---------------------------------------------------------------------
  router.get("/api/admin/payments", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    return json({ payments: await listPayments(env.DB, { propertyId }) });
  }));

  // --- statistiques ---------------------------------------------------------------------
  router.get("/api/admin/stats", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const year = intParam(url.searchParams.get("year"), Number(todayInZone().slice(0, 4)));
    const [units, links] = await Promise.all([listUnits(db, propertyId), listLinks(db, propertyId)]);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));
    const [cur, prev] = await Promise.all([
      confirmedYearBookings(db, propertyId, year).then((b) => computeYearStats(year, statsUnits, links, b)),
      confirmedYearBookings(db, propertyId, year - 1).then((b) => computeYearStats(year - 1, statsUnits, links, b)),
    ]);
    return json({ current: cur, previous: prev });
  }));

  router.get("/api/admin/stats.csv", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const year = intParam(url.searchParams.get("year"), Number(todayInZone().slice(0, 4)));
    const [units, links] = await Promise.all([listUnits(db, propertyId), listLinks(db, propertyId)]);
    const statsUnits = units.map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, active: u.active }));
    const stats = computeYearStats(year, statsUnits, links, await confirmedYearBookings(db, propertyId, year));
    const rows: unknown[][] = [
      ["Mois", "Nuits occupées", "Nuits disponibles", "Occupation %", "Revenus (€)"],
      ...stats.months.map((m) => [
        `${year}-${String(m.month).padStart(2, "0")}`,
        m.occupiedNights,
        m.capacityNights,
        m.occupancyPct,
        (m.revenueCents / 100).toFixed(2),
      ]),
      [],
      ["Unité", "Nuits vendues", "Revenus (€)"],
      ...stats.perUnit.map((u) => [u.name, u.nights, (u.revenueCents / 100).toFixed(2)]),
      [],
      ["Année", year, "Occupation %", stats.occupancyPct, "ADR (€)", (stats.adrCents / 100).toFixed(2)],
    ];
    return csvResponse(rows, `stats-${year}.csv`);
  }));

  router.get("/api/admin/bookings.csv", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const bookings = await listBookings(env.DB, { propertyId, limit: 1000 });
    const rows: unknown[][] = [
      ["Référence", "Unité", "Arrivée", "Départ", "Nuits", "Adultes", "Enfants", "Client", "Email", "Statut", "Source", "Total (€)", "Payé (€)", "Créée le"],
      ...bookings.map((b) => [
        b.reference, b.unitName, b.checkin, b.checkout, diffDays(b.checkin, b.checkout),
        b.adults, b.children, b.guestName ?? "", b.guestEmail ?? "", b.status, b.source,
        (b.totalCents / 100).toFixed(2), (b.paidCents / 100).toFixed(2), b.createdAt,
      ]),
    ];
    return csvResponse(rows, "reservations.csv");
  }));

  // --- paramètres ---------------------------------------------------------------------
  const SETTING_KEYS = new Set([
    "deposit_pct", "balance_due_days", "hold_minutes",
    "tourist_tax_cents_per_person_night", "tourist_tax_include_children",
    "caution_cents", "checkin_time", "checkout_time", "cgv_text",
    "allow_deposit", "allow_full_payment",
    "auto_reply_enabled", "auto_reply_text", "email_forward_to",
  ]);

  router.get("/api/admin/settings", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const property = await getProperty(env.DB, propertyId);
    if (!property) return apiError(404, "domaine inconnu");
    return json({
      property,
      settings: await getSettings(env.DB, propertyId),
      units: await listUnits(env.DB, propertyId),
    });
  }));

  router.put("/api/admin/settings", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<{ settings?: Record<string, unknown> }>(req);
    if (!body?.settings) return apiError(400, "settings attendu");
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.settings)) {
      if (!SETTING_KEYS.has(key)) return apiError(400, `clé inconnue : ${key}`);
      entries[key] = String(value);
    }
    await updateSettings(env.DB, propertyId, entries);
    await audit(env.DB, "admin", "settings.update", `property:${propertyId}`, entries);
    return json({ settings: await getSettings(env.DB, propertyId) });
  }));

  // --- synchro iCal ---------------------------------------------------------------------
  router.get("/api/admin/ical", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const units = await listUnits(env.DB, propertyId);
    const feeds = (await listFeeds(env.DB)).filter((f) => units.some((u) => u.id === f.unitId));
    return json({
      feeds,
      exports: units
        .filter((u) => u.active)
        .map((u) => ({ unitId: u.id, unitName: u.name, url: `${env.PUBLIC_BASE_URL}/ical/${u.icalToken}.ics` })),
    });
  }));

  router.post("/api/admin/ical-feeds", guard(async (req, env) => {
    const body = await readJson<{ unitId?: number; name?: string; url?: string }>(req);
    const unitId = intParam(String(body?.unitId ?? ""), 0);
    const name = String(body?.name ?? "").trim();
    const feedUrl = String(body?.url ?? "").trim();
    if (!unitId || !name || !/^https?:\/\//.test(feedUrl)) return apiError(400, "unitId, name et url http(s) requis");
    const id = await createFeed(env.DB, { unitId, name, url: feedUrl });
    await audit(env.DB, "admin", "ical_feed.create", `feed:${id}`, { unitId, name });
    return json({ id }, 201);
  }));

  router.patch("/api/admin/ical-feeds/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ name?: string; url?: string; active?: boolean }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    if (body.url !== undefined && !/^https?:\/\//.test(String(body.url))) return apiError(400, "url invalide");
    await updateFeed(env.DB, id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      url: body.url !== undefined ? String(body.url).trim() : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
    });
    await audit(env.DB, "admin", "ical_feed.update", `feed:${id}`, body);
    return json({ ok: true });
  }));

  router.delete("/api/admin/ical-feeds/:id", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    await deleteFeed(env.DB, id);
    await audit(env.DB, "admin", "ical_feed.delete", `feed:${id}`);
    return json({ ok: true });
  }));

  router.post("/api/admin/ical-feeds/:id/sync", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const feed = await getFeed(env.DB, id);
    if (!feed) return apiError(404, "flux inconnu");
    const result = await syncFeed(env.DB, feed);
    return json({ result });
  }));

  router.post("/api/admin/ical-sync", guard(async (_req, env) => {
    const feeds = await listFeeds(env.DB, true);
    const results = [];
    for (const feed of feeds) results.push(await syncFeed(env.DB, feed));
    return json({ results });
  }));

  // --- import elloha (phase 2) — dry-run par défaut ---------------------------------
  router.post("/api/admin/import/elloha", guard(async (req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const body = await readJson<{ csv?: string; dryRun?: boolean }>(req);
    const csv = String(body?.csv ?? "");
    if (csv.trim().length === 0) return apiError(400, "csv attendu");
    const result = await importElloha(env.DB, propertyId, csv, body?.dryRun !== false);
    return json({ result });
  }));

  // --- messages : les échanges clients vivent dans la plateforme --------------------
  router.get("/api/admin/messages", guard(async (_req, env, _p, url) => {
    const propertyId = intParam(url.searchParams.get("property"), 0) || undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const bookingId = intParam(url.searchParams.get("booking"), 0) || undefined;
    try {
      return json({
        messages: await listMessages(env.DB, { propertyId, status, bookingId, direction: bookingId ? undefined : "in" }),
      });
    } catch {
      return json({ messages: [], note: "table messages absente — appliquer les migrations" });
    }
  }));

  router.get("/api/admin/messages/:id/thread", guard(async (_req, env, p) => {
    const id = intParam(p.id, 0);
    const message = await getMessage(env.DB, id);
    if (!message) return apiError(404, "message inconnu");
    const thread = await getThread(env.DB, {
      bookingId: message.bookingId,
      guestId: message.guestId,
      email: message.bookingId || message.guestId ? null : message.direction === "in" ? message.fromEmail : message.toEmail,
    });
    return json({ message, thread });
  }));

  router.patch("/api/admin/messages/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ status?: string }>(req);
    const status = body?.status === "traité" ? "traité" : "nouveau";
    await markMessage(env.DB, id, status);
    return json({ ok: true });
  }));

  /** Réponse de l'équipe : visible immédiatement dans le fil (et sur le voucher
   *  du client) ; doublée par email si l'envoi réel est activé (sinon stub). */
  async function sendTeamReply(
    env: Env,
    opts: { propertyId: number; bookingId: number | null; guestId: number | null; toEmail: string | null; subject: string; body: string },
  ): Promise<{ id: number; delivery: string }> {
    const db = env.DB;
    const property = await getProperty(db, opts.propertyId);
    let delivery = "aucune";
    if (opts.toEmail && /@/.test(opts.toEmail)) {
      await queueEmail(db, env, {
        bookingId: opts.bookingId,
        to: opts.toEmail,
        subject: opts.subject,
        bodyText: opts.body,
        kind: "reply",
      });
      delivery = env.EMAILS_ENABLED === "true" && env.RESEND_API_KEY ? "sent" : "stub";
    }
    const id = await insertOutboundMessage(db, {
      propertyId: opts.propertyId,
      toEmail: opts.toEmail,
      fromEmail: property?.contactEmail ?? "équipe",
      subject: opts.subject,
      bodyText: opts.body,
      bookingId: opts.bookingId,
      guestId: opts.guestId,
      delivery,
    });
    await audit(db, "admin", "message.reply", `message:${id}`, { bookingId: opts.bookingId, delivery });
    return { id, delivery };
  }

  router.post("/api/admin/messages/:id/reply", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const original = await getMessage(env.DB, id);
    if (!original) return apiError(404, "message inconnu");
    const body = await readJson<{ body?: string }>(req);
    const text = String(body?.body ?? "").trim();
    if (text.length < 2) return apiError(400, "réponse vide");
    const result = await sendTeamReply(env, {
      propertyId: original.propertyId ?? 1,
      bookingId: original.bookingId,
      guestId: original.guestId,
      toEmail: original.direction === "in" ? original.fromEmail : original.toEmail,
      subject: original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`,
      body: text,
    });
    await markMessage(env.DB, id, "traité");
    return json({ ok: true, ...result });
  }));

  // Nouveau message à un client depuis sa réservation (fiche résa → Messages).
  router.post("/api/admin/bookings/:id/messages", guard(async (req, env, p) => {
    const bookingId = intParam(p.id, 0);
    const booking = await getBooking(env.DB, bookingId);
    if (!booking) return apiError(404, "réservation inconnue");
    const body = await readJson<{ body?: string }>(req);
    const text = String(body?.body ?? "").trim();
    if (text.length < 2) return apiError(400, "message vide");
    const result = await sendTeamReply(env, {
      propertyId: booking.propertyId ?? 1,
      bookingId: booking.id,
      guestId: booking.guestId,
      toEmail: booking.guestEmail ?? null,
      subject: `Votre réservation ${booking.reference}`,
      body: text,
    });
    return json({ ok: true, ...result });
  }));

  // Simulateur d'email entrant (test local de toute la chaîne, sans DNS ni
  // envoi réel : l'accusé de réception éventuel est journalisé en stub).
  router.post("/api/admin/dev-inbound-email", guard(async (req, env) => {
    const body = await readJson<{ from?: string; fromName?: string; to?: string; subject?: string; text?: string }>(req);
    if (!body?.from || !body.text) return apiError(400, "from et text requis");
    const parsed: ParsedEmail = {
      messageId: `<simulation-${Date.now()}@local>`,
      from: String(body.from).toLowerCase(),
      fromName: body.fromName ?? null,
      to: body.to ?? null,
      subject: body.subject ?? "(simulation)",
      textBody: String(body.text),
      isAutoGenerated: false,
    };
    const result = await processInboundEmail(env.DB, env, parsed, {
      reply: async (subject, replyBody) => {
        await env.DB
          .prepare(
            "INSERT INTO email_log (booking_id, to_email, subject, body_text, kind, status) VALUES (NULL, ?1, ?2, ?3, 'auto_reply_simulation', 'stub')",
          )
          .bind(parsed.from, subject, replyBody)
          .run();
      },
      // pas de hook forward en simulation : le transfert réel n'existe qu'en prod
    });
    return json({ result });
  }));

  // --- checklist de mise en route -----------------------------------------------------
  router.get("/api/admin/checklist", guard(async (_req, env) => {
    return json({ items: await listChecklist(env.DB) });
  }));

  router.patch("/api/admin/checklist/:id", guard(async (req, env, p) => {
    const id = intParam(p.id, 0);
    const body = await readJson<{ status?: string; note?: string }>(req);
    if (!id || !body) return apiError(400, "requête invalide");
    const status = ["a_faire", "en_cours", "fait", "verifie", "n_a"].includes(String(body.status))
      ? (body.status as "fait")
      : undefined;
    await updateChecklistItem(env.DB, id, { status, note: typeof body.note === "string" ? body.note : undefined });
    await audit(env.DB, "admin", "checklist.update", `checklist:${id}`, body);
    return json({ ok: true });
  }));

  // --- journaux ---------------------------------------------------------------------
  router.get("/api/admin/email-log", guard(async (_req, env, _p, url) => {
    const bookingId = intParam(url.searchParams.get("booking"), 0) || undefined;
    return json({ emails: await listEmailLog(env.DB, bookingId) });
  }));

  router.get("/api/admin/audit", guard(async (_req, env, _p, url) => {
    return json({ entries: await listAudit(env.DB, intParam(url.searchParams.get("limit"), 200)) });
  }));

  // --- Beds24 (canal OTA) : diagnostic de connexion ---------------------------------
  router.get("/api/admin/beds24/status", guard(async (_req, env) => {
    return json(await beds24Status(env));
  }));

  // Rétablissement de la liaison DEPUIS le back-office : coller un code
  // d'invitation généré dans Beds24 (Settings → Apps & Integrations → API)
  // → échangé contre un refresh token stocké en base (app_settings), aucun
  // redéploiement ni secret à manipuler.
  router.post("/api/admin/beds24/invite-code", guard(async (req, env) => {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) return apiError(400, "code d'invitation requis");
    try {
      const setup = await beds24Setup(code);
      await setSetting(env.DB, "beds24_refresh_token", setup.refreshToken);
      resetBeds24TokenCache();
      await audit(env.DB, "admin", "beds24.invite_code", "app_settings:beds24_refresh_token", { par: currentUser(req) });
      return json({ ok: true, status: await beds24Status(env) });
    } catch (e) {
      const msg = e instanceof Beds24Error ? e.message : "échange du code impossible";
      return apiError(502, msg);
    }
  }));

  // Push manuel des calendriers (dispo + prix + min-nuits) vers Beds24.
  router.post("/api/admin/beds24/push", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: number; days?: number }>(req);
    const propertyId = Number(body?.propertyId ?? 1);
    const days = Math.min(Math.max(Number(body?.days ?? 400), 1), 730);
    const result = await pushCalendars(env.DB, env, propertyId, days);
    await audit(env.DB, "admin", "beds24.push", `property:${propertyId}`, { days, rooms: result.pushed.length });
    return json(result);
  }));

  // Pull manuel des résas canaux (Beds24 → notre base).
  router.post("/api/admin/beds24/pull", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: number }>(req);
    const propertyId = Number(body?.propertyId ?? 1);
    const property = await getProperty(env.DB, propertyId);
    if (!property?.beds24PropertyId) return apiError(400, "propriété non mappée à Beds24");
    const result = await pullBeds24Bookings(env.DB, env, propertyId, property.beds24PropertyId);
    await pushCalendars(env.DB, env, propertyId);
    return json(result);
  }));

  // Vue « Canaux » : tout l'état local en un appel (aucun réseau sortant —
  // la vue reste instantanée même hors ligne ; le test de connexion réel
  // passe par GET /api/admin/beds24/status, déclenché par bouton).
  router.get("/api/admin/channels/overview", guard(async (_req, env, _p, url) => {
    const db = env.DB;
    const propertyId = intParam(url.searchParams.get("property"), 1);
    const [property, units, channelBookings, events] = await Promise.all([
      getProperty(db, propertyId),
      listUnits(db, propertyId),
      listBeds24Bookings(db),
      listAuditByAction(db, "beds24.", 15),
    ]);
    const lastPull = await db
      .prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'beds24_last_pull'")
      .bind(propertyId)
      .first<{ value: string }>();
    const webhookKey = ((await getSetting(env.DB, "beds24_webhook_key")) ?? env.BEDS24_WEBHOOK_KEY ?? "").trim() || null;
    return json({
      configured: await beds24Configured(env),
      webhookUrl: webhookKey
        ? `${env.PUBLIC_BASE_URL}/api/webhooks/beds24?key=${webhookKey}`
        : null,
      property: property
        ? { id: property.id, name: property.name, beds24PropertyId: property.beds24PropertyId }
        : null,
      units: units
        .filter((u) => u.active)
        .map((u) => ({ id: u.id, name: u.name, isComposite: u.isComposite, beds24RoomId: u.beds24RoomId })),
      channelBookings: channelBookings.map((b) => ({
        reference: b.reference, unitName: b.unitName, channelLabel: b.channelLabel,
        checkin: b.checkin, checkout: b.checkout, status: b.status, totalCents: b.totalCents,
        guestName: b.guestName,
      })),
      lastPull: lastPull?.value ?? null,
      events,
    });
  }));
}
