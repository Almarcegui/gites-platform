// Point d'entrée Node — équivalent de src/index.ts côté Cloudflare.
//
// Pourquoi ce fichier est en JavaScript et pas en TypeScript : le projet est
// typé contre @cloudflare/workers-types, qui redéfinit fetch/Request/Response.
// Les mélanger avec @types/node provoque des conflits inutiles. Ici on ne fait
// que du câblage, et `src/` reste compilé tel quel — donc le déploiement
// Cloudflare reste possible à tout moment, sans divergence de code métier.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase, snapshotSqlite } from "./sqlite-d1.mjs";
import { applyMigrations } from "./migrate.mjs";
import { smtpConfigFromEnv, smtpTransport } from "./smtp.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const MIGRATIONS_DIR = join(ROOT, "migrations");

// --- configuration ----------------------------------------------------------

/** Charge un .env à la racine si présent (Infomaniak permet aussi de définir
 *  les variables dans le Manager — les deux sources fonctionnent, le Manager
 *  l'emportant puisqu'on n'écrase jamais une variable déjà définie). */
function loadEnvFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const SQLITE_PATH = process.env.SQLITE_PATH || join(ROOT, "data", "gites.db");
const CRON_KEY = (process.env.CRON_KEY || "").trim();

// --- base de données --------------------------------------------------------

// Le dossier de la base peut ne pas exister au premier démarrage (il n'est pas
// déployé : il contient les données, pas le code).
mkdirSync(dirname(resolve(SQLITE_PATH)), { recursive: true });

const db = openDatabase(SQLITE_PATH);
const applied = applyMigrations(db, MIGRATIONS_DIR);
if (applied.length > 0) console.log(`[db] migrations appliquées : ${applied.join(", ")}`);

/** L'objet `env` que tout le code métier attend (mêmes clés que sur Workers,
 *  ASSETS en moins — les fichiers statiques sont servis plus bas). */
const env = {
  DB: db,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  EMAILS_ENABLED: process.env.EMAILS_ENABLED || "false",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM: process.env.RESEND_FROM,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  BEDS24_REFRESH_TOKEN: process.env.BEDS24_REFRESH_TOKEN,
  BEDS24_WEBHOOK_KEY: process.env.BEDS24_WEBHOOK_KEY,
  BEDS24_WRITE_ENABLED: process.env.BEDS24_WRITE_ENABLED,
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_UI: process.env.STRIPE_UI,
  // Mails par SMTP (Infomaniak) : actif quand les quatre sont posés et
  // EMAILS_ENABLED=true — cf. src/services/smtp.ts. Prime sur Resend.
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  MAIL_FROM: process.env.MAIL_FROM,
  SMTP_SEND: smtpConfigFromEnv() ? smtpTransport(smtpConfigFromEnv()) : undefined,
  // Instantané de la base pour GET /api/admin/export.sqlite (Node seulement).
  SQLITE_SNAPSHOT: async () => snapshotSqlite(db, dirname(resolve(SQLITE_PATH))),
};

// --- routeur métier (code compilé depuis src/) ------------------------------

const { Router, apiError } = await import("../dist/api/router.js");
const { registerPublicRoutes } = await import("../dist/api/public.js");
const { registerAdminRoutes } = await import("../dist/api/admin.js");
const { runScheduled } = await import("../dist/services/cron.js");

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

/** Équivalent de ctx.waitUntil : sur Cloudflare, le travail de fond survit à la
 *  réponse. Ici le processus reste vivant — on lance et on capture l'échec pour
 *  qu'une promesse rejetée ne fasse jamais tomber le serveur. */
const execCtx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((e) => console.error("[waitUntil]", e));
  },
  passThroughOnException() {},
};

// --- fichiers statiques -----------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".ics": "text/calendar; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Résout un chemin d'URL vers un fichier de public/, en refusant toute
 *  sortie du dossier (traversée de répertoire). */
function resolveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  if (existsSync(full) && statSync(full).isFile()) return full;
  // /book → /book/index.html
  const asDir = join(full, "index.html");
  if (existsSync(asDir) && statSync(asDir).isFile()) return asDir;
  // /page → /page.html
  const asHtml = `${full}.html`;
  if (existsSync(asHtml) && statSync(asHtml).isFile()) return asHtml;
  return null;
}

/** En-têtes de sécurité + cache. Répond au finding « aucun en-tête de
 *  sécurité » de l'audit ECC, que le binding ASSETS de Cloudflare ne posait
 *  pas non plus. */
function staticHeaders(file) {
  const ext = extname(file);
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (file.startsWith(join(PUBLIC_DIR, "img"))) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (ext === ".html") {
    headers["cache-control"] = "no-cache";
  } else {
    headers["cache-control"] = "public, max-age=86400";
  }
  return headers;
}

// --- pont node:http ↔ Request/Response --------------------------------------

async function toRequest(req, origin) {
  const url = new URL(req.url, origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body;
  if (hasBody) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function sendResponse(res, response) {
  const headers = {};
  for (const [k, v] of response.headers) headers[k] = v;
  res.writeHead(response.status, headers);
  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } else {
    res.end();
  }
}

// --- serveur ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const origin = env.PUBLIC_BASE_URL.startsWith("http") ? env.PUBLIC_BASE_URL : `http://localhost:${PORT}`;
  let url;
  try {
    url = new URL(req.url, origin);
  } catch {
    res.writeHead(400).end("requête invalide");
    return;
  }

  try {
    // 1. Tâche planifiée déclenchée par le Planificateur Infomaniak (une URL
    //    appelée toutes les 15 min — il n'y a pas de crontab en mutualisé).
    if (url.pathname === "/internal/cron") {
      const given = url.searchParams.get("key") ?? "";
      if (!CRON_KEY || given.length !== CRON_KEY.length || given !== CRON_KEY) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "clé invalide" }));
        return;
      }
      await runScheduled(env);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
      return;
    }

    // 2. Sonde de disponibilité (monitoring externe, sans secret ni donnée).
    if (url.pathname === "/internal/health") {
      const n = await db.prepare("SELECT COUNT(*) AS n FROM units").first("n");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, units: n }));
      return;
    }

    // 3. Routes dynamiques (API, iCal) — même routeur que sur Cloudflare.
    const request = await toRequest(req, origin);
    const response = await router.handle(request, env, execCtx);
    if (response) {
      await sendResponse(res, response);
      return;
    }

    // 4. Fichiers statiques.
    const file = resolveStatic(url.pathname);
    if (file) {
      const headers = staticHeaders(file);
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
      return;
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ical/")) {
      await sendResponse(res, apiError(404, "route inconnue"));
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end("<h1>Page introuvable</h1>");
  } catch (e) {
    console.error("[erreur]", req.method, url?.pathname, e instanceof Error ? e.stack : e);
    // Même filet qu'en Worker : la trace persiste en base, les logs d'un
    // hébergement mutualisé n'étant pas toujours consultables après coup.
    try {
      await db
        .prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES ('cron', 'unhandled.error', ?1, ?2)")
        .bind(url?.pathname ?? "?", String(e instanceof Error ? e.stack : e).slice(0, 2000))
        .run();
    } catch (logErr) {
      console.error("[audit_log indisponible]", logErr);
    }
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "erreur interne" }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[gites] écoute sur le port ${PORT}`);
  console.log(`[gites] base   : ${SQLITE_PATH}`);
  console.log(`[gites] URL    : ${env.PUBLIC_BASE_URL}`);
  const transport = env.EMAILS_ENABLED !== "true" ? null : env.SMTP_SEND ? `SMTP ${env.SMTP_HOST}` : env.RESEND_API_KEY ? "Resend" : null;
  console.log(`[gites] emails : ${transport ? `ACTIFS (${transport})` : "stub (journalisés)"}`);
  if (!env.ADMIN_TOKEN) console.warn("[gites] ⚠️ ADMIN_TOKEN absent — le back-office refusera tout (garde fail-closed)");
  if (!CRON_KEY) console.warn("[gites] ⚠️ CRON_KEY absente — /internal/cron est désactivé");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[gites] arrêt (${signal})`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
