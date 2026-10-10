// Parcours Playwright du lot 2 sur le SERVEUR NODE (la production), port 8797.
//
//   npm run build            (à la racine : dist/ et public/admin2/)
//   node app/e2e/lot2-serveur.mjs
//
// 1. base SQLite et dossier de photos TEMPORAIRES, migrations, puis données
//    INVENTÉES (noms de démonstration, téléphones +32 470 00 01 xx) ;
// 2. node/server.mjs sur 127.0.0.1:8797, compte « pilote » créé par l'API ;
// 3. `playwright test e2e/lot2.spec.ts` contre ce serveur ;
// 4. arrêt du serveur, base et photos effacées. Rien ne sort du Mac.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP = join(ROOT, "app");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "secours:mot-de-passe-du-parcours-lot2";

const { applyMigrations } = await import(join(ROOT, "node", "migrate.mjs"));
const { openDatabase } = await import(join(ROOT, "node", "sqlite-d1.mjs"));

const dir = mkdtempSync(join(tmpdir(), "gites-lot2-e2e-"));
const dbPath = join(dir, "e2e.db");
const d1 = openDatabase(dbPath);
applyMigrations(d1, join(ROOT, "migrations"));
d1.close();

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
const day = (n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// --- données inventées ----------------------------------------------------------
const db = new DatabaseSync(dbPath);
const guest = (fn, ln, phone) =>
  Number(db.prepare("INSERT INTO guests (email, first_name, last_name, phone) VALUES (?, ?, ?, ?)").run(`${ln.toLowerCase()}@example.com`, fn, ln, phone).lastInsertRowid);
let n = 0;
const booking = (unit, a, d, adults, g, paid, extra = {}) => {
  const ref = `DEMO-${String(++n).padStart(3, "0")}`;
  const total = 64000;
  const id = Number(
    db
      .prepare(
        "INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, status, source, channel_label, external_uid, total_cents, deposit_cents, paid_cents, internal_notes) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, 'Démonstration, noms inventés.')",
      )
      .run(ref, unit, g, day(a), day(d), adults, extra.source ?? "manual", extra.label ?? null, extra.source === "ical" ? `demo-${ref}` : null, extra.source === "ical" ? 0 : total, total / 2, extra.source === "ical" ? 0 : paid ? total : total / 2).lastInsertRowid,
  );
  if (extra.source !== "ical") {
    db.prepare("INSERT INTO payments (booking_id, kind, method, amount_cents, status, received_at) VALUES (?, 'deposit', 'transfer', ?, 'succeeded', datetime('now','-10 days'))").run(id, paid ? total : total / 2);
  }
  return id;
};
booking(2, -3, 0, 6, guest("Barnabé", "Pirlouvet", "+32 470 00 01 01"), true);
booking(1, -1, 2, 10, guest("Wolter", "Brugmondt", "+32 470 00 01 02"), true);
booking(2, 0, 2, 4, guest("Ombeline", "Vauchelard", "+32 470 00 01 03"), false);
booking(3, 6, 8, 19, guest("Théodric", "Malvoisinne", "+32 470 00 01 04"), false);
booking(1, 13, 20, 9, guest("Gwenola", "Oudewaeter", "+32 470 00 01 05"), false);
booking(2, 21, 24, 7, guest("Inès", "Taverdiaux", "+32 470 00 01 06"), true);
booking(4, 0, 3, 8, guest("Fiene", "Elsenhaage", null), false, { source: "ical", label: "Booking" });
booking(4, 13, 16, 6, null, false, { source: "ical", label: "Airbnb" });
db.close();

// --- serveur -------------------------------------------------------------------
const server = spawn(process.execPath, [join(ROOT, "node", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), SQLITE_PATH: dbPath, UPLOADS_DIR: join(dir, "uploads"), PUBLIC_BASE_URL: BASE, ADMIN_TOKEN: ADMIN, EMAILS_ENABLED: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let code = 1;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/internal/health`)).ok) break;
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (path, body) => {
    const r = await fetch(`${BASE}/api/admin${path}`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(data)}`);
    return data;
  };
  const u = await call("/users", { username: "pilote" });
  for (const m of [
    { from: "vauchelard@example.com", fromName: "Ombeline Vauchelard", subject: "Chaise haute", text: "Y a-t-il une chaise haute et un lit parapluie pour notre fille ?" },
    { from: "rambervaux@example.com", fromName: "Sophie Rambervaux", subject: "Domaine pour Noël", text: "Bonjour, le Domaine entier serait-il libre du 26 au 28 décembre pour 20 personnes ?" },
  ]) await call("/dev-inbound-email", m);

  const args = ["playwright", "test", "e2e/lot2.spec.ts", ...process.argv.slice(2)];
  const r = spawnSync("npx", args, { cwd: APP, stdio: "inherit", env: { ...process.env, GITES_URL: BASE, PILOTE_PASSWORD: u.password } });
  code = r.status ?? 1;
} catch (e) {
  console.error(e);
  console.error(log.slice(-3000));
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
