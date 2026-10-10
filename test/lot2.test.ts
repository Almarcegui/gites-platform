// Lot 2 du nouvel écran (/admin2/) : ménage en base et lien de partage,
// modèles de réponse, recherche par téléphone, changement de son mot de passe,
// envoi de photos, garde par adresse IP.
//
// TOUTE la suite est jouée DEUX fois : sur la D1 de Workers (Miniflare) et sur
// la base du serveur Node (node:sqlite + node/sqlite-d1.mjs + node/migrate.mjs).
// La production est le serveur Node : un écart entre les deux se voit ici.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { createNodeTestDb } from "./helpers/node-db";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { registerAdminRoutes } from "../src/api/admin";
import { addDays, todayInZone } from "../src/core/dates";
import { adminIpDecision, adminIpGate, isAdminPath, parseAllowList, parseIp } from "../src/core/ip-allow";
import { looksLikePhone, phoneCore } from "../src/core/phone";
import { pngSize, sniffImageType } from "../src/core/image-size";
import { desiredCleaningTasks } from "../src/core/cleaning";
import { runLot2Scheduled } from "../src/jobs/scheduled";

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

const ADMIN = "julien:secret-de-test-lot2";
const TODAY = todayInZone();
const D = (n: number) => addDays(TODAY, n);

type Call = { status: number; data: Record<string, unknown>; text: string; headers: Headers };

function pngBytes(w: number, h: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

describe("primitives pures", () => {
  it("téléphone : chiffres, indicatif belge et 0 de tête retirés", () => {
    expect(phoneCore("+32 475 12 34 56")).toBe("475123456");
    expect(phoneCore("0032475123456")).toBe("475123456");
    expect(phoneCore("0475/12.34.56")).toBe("475123456");
    expect(phoneCore("0475 12")).toBe("47512");
    expect(phoneCore("+33 6 12 34 56 78")).toBe("33612345678");
    expect(phoneCore("Dupont")).toBeNull();
    expect(phoneCore("PM-2026-004")).toBeNull();
    expect(looksLikePhone("12")).toBe(false);
  });

  it("IP : liste vide ouverte, CIDR v4 et v6, IPv4 mappée, liste illisible fermée", () => {
    expect(adminIpDecision("", "1.2.3.4")).toBe("open");
    expect(adminIpDecision("  ", null)).toBe("open");
    expect(adminIpDecision("81.82.83.0/24", "81.82.83.84")).toBe("allowed");
    expect(adminIpDecision("81.82.83.0/24", "81.82.84.1")).toBe("denied");
    expect(adminIpDecision("81.82.83.84", "::ffff:81.82.83.84")).toBe("allowed");
    expect(adminIpDecision("2a02:1810::/32, 10.0.0.1", "2a02:1810:abcd::1")).toBe("allowed");
    expect(adminIpDecision("2a02:1810::/32", "2a02:1811::1")).toBe("denied");
    expect(adminIpDecision("::1", "::1")).toBe("allowed");
    expect(adminIpDecision("pas-une-ip", "1.2.3.4")).toBe("denied");
    expect(adminIpDecision("1.2.3.4/33", "1.2.3.4")).toBe("denied");
    expect(adminIpDecision("1.2.3.4", "")).toBe("denied");
    expect(parseAllowList("0.0.0.0/0")?.length).toBe(1);
    expect(adminIpDecision("0.0.0.0/0", "9.9.9.9")).toBe("allowed");
    expect(parseIp("[2001:db8::1]")?.v6).toBe(true);
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
  });

  it("IP : seuls l'API admin et les deux écrans sont gardés, 403 explicite", async () => {
    for (const p of ["/api/admin/units", "/api/admin/login", "/admin/", "/admin", "/admin2/", "/admin2/assets/x.js"]) expect(isAdminPath(p)).toBe(true);
    for (const p of ["/", "/book/", "/api/public/health", "/t/abc", "/uploads/x.jpg", "/administration"]) expect(isAdminPath(p)).toBe(false);
    const api = adminIpGate("/api/admin/units", "10.0.0.0/8", "1.2.3.4");
    expect(api?.status).toBe(403);
    expect(((await api!.json()) as { code: string }).code).toBe("admin_ip_denied");
    const html = adminIpGate("/admin2/", "10.0.0.0/8", "1.2.3.4");
    expect(html?.status).toBe(403);
    expect(await html!.text()).toContain("Accès fermé");
    expect(adminIpGate("/admin2/", "10.0.0.0/8", "10.1.2.3")).toBeNull();
    expect(adminIpGate("/t/abc", "10.0.0.0/8", "1.2.3.4")).toBeNull();
    expect(adminIpGate("/api/admin/units", "", "1.2.3.4")).toBeNull();
  });

  it("images : type lu dans les octets, dimensions d'un PNG", () => {
    expect(sniffImageType(pngBytes(800, 600))).toBe("png");
    expect(pngSize(pngBytes(800, 600))).toEqual({ width: 800, height: 600 });
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a........"))).toBeNull();
  });

  it("ménage : arrivée suivante cherchée sur les biens liés, holds du site ignorés", () => {
    const links = [
      { unitId: 1, blocksUnitId: 3 },
      { unitId: 3, blocksUnitId: 1 },
    ];
    const base = { status: "confirmed", source: "manual", holdExpiresAt: null };
    const tasks = desiredCleaningTasks(
      [
        { id: 1, unitId: 1, checkin: D(-2), checkout: D(1), persons: 2, ...base },
        { id: 2, unitId: 3, checkin: D(1), checkout: D(4), persons: 9, ...base },
        { id: 3, unitId: 2, checkin: D(2), checkout: D(3), persons: 3, status: "pending", source: "direct", holdExpiresAt: "2999-01-01 00:00:00" },
      ],
      links,
      { checkinTime: "16:00", checkoutTime: "10:00" },
      D(-7),
      D(60),
      "2000-01-01 00:00:00",
    );
    expect(tasks.map((t) => t.bookingId)).toEqual([1, 2]);
    expect(tasks[0]).toMatchObject({ dueDate: D(1), dueTime: "10:00", nextCheckin: D(1), nextUnitId: 3, nextPersons: 9, nextCheckinTime: "16:00" });
    expect(tasks[1]!.nextCheckin).toBeNull();
  });
});

for (const [backend, create] of [
  ["Workers (D1 Miniflare)", createTestDb],
  ["Node (node:sqlite)", createNodeTestDb],
] as const) {
  describe(`lot 2 — ${backend}`, () => {
    let t: TestDb;
    let env: Env;
    const stored = new Map<string, Uint8Array>();

    beforeAll(async () => {
      t = await create();
      env = {
        DB: t.db,
        ASSETS: undefined as unknown as Fetcher,
        PUBLIC_BASE_URL: "http://test.local",
        EMAILS_ENABLED: "false",
        ADMIN_TOKEN: ADMIN,
      };
    });
    afterAll(async () => {
      await t.dispose();
    });

    async function call(method: string, path: string, body?: unknown, opts: { auth?: string | null; env?: Env; form?: FormData } = {}): Promise<Call> {
      const headers: Record<string, string> = {};
      const auth = opts.auth === undefined ? `Bearer ${ADMIN}` : opts.auth;
      if (auth && path.startsWith("/api/admin")) headers.authorization = auth;
      let payload: BodyInit | undefined;
      if (opts.form) payload = opts.form;
      else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await router.handle(new Request(`http://test.local${path}`, { method, headers, body: payload }), opts.env ?? env);
      if (!res) throw new Error(`route non matchée : ${method} ${path}`);
      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = {};
      }
      return { status: res.status, data, text, headers: res.headers };
    }

    let guestId = 0;
    async function booking(ref: string, unitId: number, checkin: string, checkout: string, extra: Record<string, unknown> = {}): Promise<number> {
      const res = await t.db
        .prepare(
          `INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, children, status, source, hold_expires_at, total_cents)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 50000)`,
        )
        .bind(ref, unitId, guestId, checkin, checkout, extra.adults ?? 2, extra.children ?? 0, extra.status ?? "confirmed", extra.source ?? "manual", extra.hold ?? null)
        .run();
      return res.meta.last_row_id;
    }

    describe("ménage et tâches", () => {
      let b1 = 0;
      let b2 = 0;
      let b4 = 0;
      beforeAll(async () => {
        const g = await t.db
          .prepare("INSERT INTO guests (email, first_name, last_name, phone) VALUES ('claire.essai@example.test', 'Claire', 'Essai', '+32 475 12 34 56')")
          .run();
        guestId = g.meta.last_row_id;
        b1 = await booking("PM-T-001", 1, D(-3), D(2), { adults: 4 });
        b2 = await booking("PM-T-002", 3, D(2), D(6), { adults: 8, children: 1 });
        await booking("PM-T-003", 2, D(8), D(10), { status: "pending", source: "direct", hold: "2999-01-01 00:00:00" });
        b4 = await booking("MB-T-004", 4, D(1), D(5));
      });

      it("la lecture génère un ménage par départ, avec l'arrivée suivante sur un bien lié", async () => {
        const r = await call("GET", "/api/admin/tasks");
        expect(r.status).toBe(200);
        const tasks = r.data.tasks as Record<string, unknown>[];
        const t1 = tasks.find((x) => x.bookingId === b1)!;
        expect(t1).toMatchObject({ dueDate: D(2), unitName: "La Maison du Scieur", nextCheckin: D(2), nextPersons: 9, status: "a_faire" });
        expect(tasks.some((x) => x.bookingId === b4)).toBe(true);
        // Le hold du tunnel public ne crée rien.
        expect(tasks.some((x) => x.dueDate === D(10))).toBe(false);
        // Aucun nom de voyageur dans une tâche.
        expect(JSON.stringify(tasks)).not.toContain("Essai");
      });

      it("la génération est idempotente", async () => {
        const again = await call("POST", "/api/admin/tasks/generate", {});
        expect(again.data).toMatchObject({ created: 0, updated: 0, cancelled: 0 });
        const n = await t.db.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
        const r = await call("GET", "/api/admin/tasks");
        const n2 = await t.db.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
        expect(n2!.n).toBe(n!.n);
        expect((r.data.tasks as unknown[]).length).toBeGreaterThanOrEqual(3);
      });

      it("fait, personne et note ; la génération ne les écrase pas", async () => {
        const id = ((await call("GET", "/api/admin/tasks")).data.tasks as { id: number; bookingId: number }[]).find((x) => x.bookingId === b1)!.id;
        const p = await call("PATCH", `/api/admin/tasks/${id}`, { status: "fait", assignee: "Martine", note: "Draps dans l'armoire du haut" });
        expect(p.status).toBe(200);
        expect(p.data.task).toMatchObject({ status: "fait", assignee: "Martine", doneBy: "julien" });
        await call("POST", "/api/admin/tasks/generate", {});
        const after = ((await call("GET", "/api/admin/tasks")).data.tasks as Record<string, unknown>[]).find((x) => x.id === id)!;
        expect(after).toMatchObject({ status: "fait", assignee: "Martine", note: "Draps dans l'armoire du haut" });
        expect((await call("PATCH", `/api/admin/tasks/${id}`, { status: "annule" })).status).toBe(400);
        expect((await call("PATCH", `/api/admin/tasks/${id}`, { note: "x".repeat(501) })).status).toBe(400);
        expect((await call("PATCH", "/api/admin/tasks/99999", { status: "fait" })).status).toBe(404);
      });

      it("séjour déplacé : la date suit et un ménage fait repasse à faire", async () => {
        await t.db.prepare("UPDATE bookings SET checkout = ?2 WHERE id = ?1").bind(b1, D(3)).run();
        // ce n'est plus compatible avec b2 (Domaine dès D(2)) mais la base de test ne vérifie pas : seul le ménage compte ici
        const r = await call("POST", "/api/admin/tasks/generate", {});
        expect(r.data.updated).toBeGreaterThanOrEqual(1);
        const t1 = ((await call("GET", "/api/admin/tasks")).data.tasks as Record<string, unknown>[]).find((x) => x.bookingId === b1)!;
        expect(t1).toMatchObject({ dueDate: D(3), status: "a_faire", assignee: "Martine" });
      });

      it("réservation annulée : la tâche passe annulée et disparaît de la liste", async () => {
        await t.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?1").bind(b4).run();
        const r = await call("POST", "/api/admin/tasks/generate", {});
        expect(r.data.cancelled).toBe(1);
        const list = (await call("GET", "/api/admin/tasks")).data.tasks as Record<string, unknown>[];
        expect(list.some((x) => x.bookingId === b4)).toBe(false);
        const all = (await call("GET", "/api/admin/tasks?cancelled=1")).data.tasks as Record<string, unknown>[];
        expect(all.find((x) => x.bookingId === b4)?.status).toBe("annule");
        // Réservation rétablie : le ménage revient, à faire.
        await t.db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?1").bind(b4).run();
        await call("POST", "/api/admin/tasks/generate", {});
        const back = ((await call("GET", "/api/admin/tasks")).data.tasks as Record<string, unknown>[]).find((x) => x.bookingId === b4);
        expect(back?.status).toBe("a_faire");
      });

      it("filtres : domaine, plage, dates invalides", async () => {
        const moulin = (await call("GET", "/api/admin/tasks?property=2")).data.tasks as { propertyId: number }[];
        expect(moulin.every((x) => x.propertyId === 2)).toBe(true);
        expect((await call("GET", "/api/admin/tasks?from=2026-13-01&to=2026-12-01")).status).toBe(400);
        expect((await call("GET", `/api/admin/tasks?from=${D(0)}&to=${D(400)}`)).status).toBe(400);
        expect((await call("GET", "/api/admin/tasks", undefined, { auth: null })).status).toBe(401);
      });

      it("la lecture d'une plage lointaine génère ses ménages (calendrier d'un autre mois)", async () => {
        const id = await booking("PM-T-090", 2, D(85), D(88));
        const r = await call("GET", `/api/admin/tasks?from=${D(80)}&to=${D(100)}`);
        expect((r.data.tasks as { bookingId: number }[]).some((x) => x.bookingId === id)).toBe(true);
      });

      it("un départ le premier jour de la plage est généré, une plage hors horizon est refusée", async () => {
        const id = await booking("PM-T-091", 1, D(-12), D(-7));
        await call("POST", "/api/admin/tasks/generate", {});
        const row = await t.db.prepare("SELECT due_date FROM tasks WHERE booking_id = ?1").bind(id).first<{ due_date: string }>();
        expect(row?.due_date).toBe(D(-7));
        expect((await call("GET", `/api/admin/tasks?from=${D(500)}&to=${D(510)}`)).status).toBe(400);
      });

      it("réservation déplacée sur un autre bien : la tâche suit et repasse à faire", async () => {
        const id = await booking("PM-T-092", 2, D(40), D(43));
        await call("POST", "/api/admin/tasks/generate", {});
        const tid = (await t.db.prepare("SELECT id FROM tasks WHERE booking_id = ?1").bind(id).first<{ id: number }>())!.id;
        await call("PATCH", `/api/admin/tasks/${tid}`, { status: "fait" });
        await t.db.prepare("UPDATE bookings SET unit_id = 4 WHERE id = ?1").bind(id).run();
        await call("POST", "/api/admin/tasks/generate", {});
        const row = await t.db.prepare("SELECT unit_id, property_id, status FROM tasks WHERE id = ?1").bind(tid).first();
        expect(row).toEqual({ unit_id: 4, property_id: 2, status: "a_faire" });
      });

      it("le cron génère aussi les ménages", async () => {
        const id = await booking("PM-T-005", 2, D(20), D(23));
        await runLot2Scheduled(env);
        const row = await t.db.prepare("SELECT due_date FROM tasks WHERE booking_id = ?1").bind(id).first<{ due_date: string }>();
        expect(row?.due_date).toBe(D(23));
      });

      it("lien de partage : page sans login ni nom de client, case « fait » par formulaire", async () => {
        const created = await call("POST", "/api/admin/task-links", { label: "Martine", propertyId: 1 });
        expect(created.status).toBe(201);
        const url = String(created.data.url);
        expect(url).toMatch(/^http:\/\/test\.local\/t\/[0-9a-f]{48}$/);
        const path = new URL(url).pathname;
        const page = await call("GET", path);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(page.headers.get("x-robots-tag")).toContain("noindex");
        expect(page.text).toContain("La Maison du Scieur");
        expect(page.text).not.toContain("Essai");
        expect(page.text).not.toContain("Claire");
        expect(page.text).not.toContain("Le Moulin"); // lien limité au Pré Moré
        // Le jeton n'est jamais stocké en clair.
        const tok = path.split("/").pop()!;
        const raw = await t.db.prepare("SELECT COUNT(*) AS n FROM task_share_links WHERE token_hash = ?1").bind(tok).first<{ n: number }>();
        expect(raw!.n).toBe(0);

        const task = ((await call("GET", "/api/admin/tasks?property=1")).data.tasks as { id: number; bookingId: number }[]).find((x) => x.bookingId === b1)!;
        const form = new FormData();
        form.set("etat", "fait");
        const post = await call("POST", `${path}/${task.id}`, undefined, { form });
        expect(post.status).toBe(303);
        expect(post.headers.get("location")).toBe(`${path}?ok=fait`);
        const row = await t.db.prepare("SELECT status, done_by FROM tasks WHERE id = ?1").bind(task.id).first<{ status: string; done_by: string }>();
        expect(row).toEqual({ status: "fait", done_by: "lien:Martine" });
        expect((await call("GET", `${path}?ok=fait`)).text).toContain("noté : ménage fait");

        // Une tâche d'un autre domaine n'est pas modifiable par ce lien.
        const other = await t.db.prepare("SELECT id FROM tasks WHERE property_id = 2 LIMIT 1").first<{ id: number }>();
        const f2 = new FormData();
        f2.set("etat", "fait");
        expect((await call("POST", `${path}/${other!.id}`, undefined, { form: f2 })).status).toBe(404);

        // Lien coupé : plus rien.
        const links = (await call("GET", "/api/admin/task-links")).data.links as { id: number; label: string }[];
        const id = links.find((l) => l.label === "Martine")!.id;
        expect((await call("DELETE", `/api/admin/task-links/${id}`)).status).toBe(200);
        expect((await call("GET", path)).status).toBe(404);
        expect((await call("POST", `${path}/${task.id}`, undefined, { form })).status).toBe(404);
        expect((await call("GET", "/t/pas-un-jeton")).status).toBe(404);
        expect((await call("POST", "/api/admin/task-links", { label: "x" })).status).toBe(400);
      });
    });

    describe("modèles de réponse", () => {
      it("les quatre modèles du pilote sont là, avec les variables", async () => {
        const r = await call("GET", "/api/admin/message-templates");
        const list = r.data.templates as { name: string; body: string; lang: string }[];
        expect(list.map((x) => x.name)).toEqual(["Accès et clés", "Horaires", "Rappel du solde", "Après le séjour"]);
        expect(list[0]!.body).toContain("{prenom}");
        expect(list[2]!.body).toContain("{solde}");
        expect(list[1]!.body).toContain("L'arrivée");
        expect(r.data.variables).toEqual(["prenom", "bien", "arrivee", "solde", "heure_arrivee", "heure_depart", "signature"]);
      });

      it("créer, modifier, filtrer par domaine, supprimer", async () => {
        const c = await call("POST", "/api/admin/message-templates", { name: "Toegang", lang: "nl", body: "Beste {prenom},\n\nWelkom in {bien}.", propertyId: 2, sortOrder: 50 });
        expect(c.status).toBe(201);
        const id = c.data.id as number;
        const forPm = (await call("GET", "/api/admin/message-templates?property=1")).data.templates as { id: number }[];
        expect(forPm.some((x) => x.id === id)).toBe(false);
        const forMb = (await call("GET", "/api/admin/message-templates?property=2")).data.templates as { id: number }[];
        expect(forMb.some((x) => x.id === id)).toBe(true);
        const p = await call("PATCH", `/api/admin/message-templates/${id}`, { body: "Beste {prenom}, tot snel.", active: false });
        expect(p.data.template).toMatchObject({ body: "Beste {prenom}, tot snel.", active: false, lang: "nl" });
        const active = (await call("GET", "/api/admin/message-templates?property=2&active=1")).data.templates as { id: number }[];
        expect(active.some((x) => x.id === id)).toBe(false);
        expect((await call("DELETE", `/api/admin/message-templates/${id}`)).status).toBe(200);
        expect((await call("DELETE", `/api/admin/message-templates/${id}`)).status).toBe(404);
      });

      it("domaine inconnu : les modèles communs seulement", async () => {
        const c = await call("POST", "/api/admin/message-templates", { name: "Privé Moulin", body: "Texte du Moulin", propertyId: 2 });
        const common = (await call("GET", "/api/admin/message-templates?common=1")).data.templates as { id: number; propertyId: number | null }[];
        expect(common.every((x) => x.propertyId == null)).toBe(true);
        expect(common.some((x) => x.id === c.data.id)).toBe(false);
        await call("DELETE", `/api/admin/message-templates/${c.data.id}`);
      });

      it("refuse un modèle vide, une langue inconnue, un domaine inconnu", async () => {
        expect((await call("POST", "/api/admin/message-templates", { name: "A", body: "texte" })).status).toBe(400);
        expect((await call("POST", "/api/admin/message-templates", { name: "Nom", body: " " })).status).toBe(400);
        expect((await call("POST", "/api/admin/message-templates", { name: "Nom", body: "texte", lang: "de" })).status).toBe(400);
        expect((await call("POST", "/api/admin/message-templates", { name: "Nom", body: "texte", propertyId: 99 })).status).toBe(400);
      });
    });

    describe("recherche par téléphone", () => {
      it("réservations et clients se trouvent par leur numéro, quelle que soit l'écriture", async () => {
        for (const q of ["0475123456", "0475 12 34 56", "+32475123456", "0032 475 12", "475/12.34"]) {
          const r = await call("GET", `/api/admin/bookings?search=${encodeURIComponent(q)}`);
          expect((r.data.bookings as { reference: string }[]).some((b) => b.reference === "PM-T-001")).toBe(true);
          const g = await call("GET", `/api/admin/guests?search=${encodeURIComponent(q)}`);
          expect((g.data.guests as { lastName: string }[]).map((x) => x.lastName)).toContain("Essai");
        }
        const none = await call("GET", "/api/admin/bookings?search=0499999999");
        expect((none.data.bookings as unknown[]).length).toBe(0);
        // La recherche par nom et par référence continue de marcher.
        expect(((await call("GET", "/api/admin/bookings?search=Essai")).data.bookings as unknown[]).length).toBeGreaterThan(0);
        expect(((await call("GET", "/api/admin/bookings?search=PM-T-002")).data.bookings as unknown[]).length).toBe(1);
      });
    });

    describe("mon mot de passe", () => {
      it("ancien exigé, autres sessions coupées, la session courante reste", async () => {
        const created = await call("POST", "/api/admin/users", { username: "papa" });
        const initial = String(created.data.password);
        const s1 = String((await call("POST", "/api/admin/login", { user: "papa", password: initial })).data.session);
        const s2 = String((await call("POST", "/api/admin/login", { user: "papa", password: initial })).data.session);
        const a1 = `Bearer session:${s1}`;
        const a2 = `Bearer session:${s2}`;

        const me = await call("GET", "/api/admin/me", undefined, { auth: a1 });
        expect(me.data).toMatchObject({ user: "papa", kind: "compte", sessions: 2 });

        expect((await call("POST", "/api/admin/me/password", { current: "faux", next: "un-nouveau-mot-de-passe" }, { auth: a1 })).status).toBe(403);
        expect((await call("POST", "/api/admin/me/password", { current: initial, next: "court" }, { auth: a1 })).status).toBe(400);
        expect((await call("POST", "/api/admin/me/password", { current: initial, next: "papa-est-content-2026" }, { auth: a1 })).status).toBe(400);
        const ok = await call("POST", "/api/admin/me/password", { current: initial, next: "riviere-sapin-granit-2026" }, { auth: a1 });
        expect(ok.status).toBe(200);
        expect(ok.data.password).toBeUndefined();

        expect((await call("GET", "/api/admin/me", undefined, { auth: a1 })).status).toBe(200);
        expect((await call("GET", "/api/admin/me", undefined, { auth: a2 })).status).toBe(401);
        expect((await call("POST", "/api/admin/login", { user: "papa", password: initial })).status).toBe(401);
        expect((await call("POST", "/api/admin/login", { user: "papa", password: "riviere-sapin-granit-2026" })).status).toBe(200);

        const gen = await call("POST", "/api/admin/me/password", { current: "riviere-sapin-granit-2026", generate: true }, { auth: a1 });
        expect(gen.status).toBe(200);
        expect(String(gen.data.password)).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
        expect((await call("POST", "/api/admin/login", { user: "papa", password: String(gen.data.password) })).status).toBe(200);
      });

      it("trop d'essais manqués : 429", async () => {
        const created = await call("POST", "/api/admin/users", { username: "essais" });
        const s = String((await call("POST", "/api/admin/login", { user: "essais", password: String(created.data.password) })).data.session);
        const auth = `Bearer session:${s}`;
        for (let i = 0; i < 5; i++) expect((await call("POST", "/api/admin/me/password", { current: "faux", next: "abcdefghijklmn" }, { auth })).status).toBe(403);
        expect((await call("POST", "/api/admin/me/password", { current: String(created.data.password), next: "abcdefghijklmn" }, { auth })).status).toBe(429);
      });

      it("accès de secours (ADMIN_TOKEN) : refus clair", async () => {
        const r = await call("POST", "/api/admin/me/password", { current: "x", next: "yyyyyyyyyyyyyy" });
        expect(r.status).toBe(400);
        expect(String(r.data.error)).toContain("ADMIN_TOKEN");
        expect((await call("GET", "/api/admin/me")).data).toMatchObject({ user: "julien", kind: "secours" });
      });
    });

    describe("envoi de photos", () => {
      const uploadEnv = (): Env => ({
        ...env,
        UPLOADS: {
          async put(name: string, bytes: Uint8Array) {
            stored.set(name, bytes);
          },
        },
      });
      const form = (bytes: Uint8Array, extra: Record<string, string> = {}) => {
        const f = new FormData();
        f.set("file", new File([bytes as BlobPart], "photo.bin", { type: "image/jpeg" }));
        for (const [k, v] of Object.entries(extra)) f.set(k, v);
        return f;
      };

      it("sans dépôt (Workers) : 501 propre", async () => {
        const r = await call("POST", "/api/admin/units/1/photos/upload", undefined, { form: form(pngBytes(10, 10)) });
        expect(r.status).toBe(501);
        expect(r.data.code).toBe("uploads_unavailable");
      });

      it("PNG sans texte : rangé sous un nom au hasard, masqué jusqu'à sa description", async () => {
        const r = await call("POST", "/api/admin/units/2/photos/upload", undefined, { form: form(pngBytes(1600, 1200)), env: uploadEnv() });
        expect(r.status).toBe(201);
        expect(r.data).toMatchObject({ width: 1600, height: 1200, active: false });
        const path = String(r.data.path);
        expect(path).toMatch(/^\/uploads\/[0-9a-f]{32}\.png$/);
        expect(stored.has(path.slice("/uploads/".length))).toBe(true);
        const photos = (await call("GET", "/api/admin/units/2/photos")).data.photos as { path: string; active: boolean; alt: string }[];
        expect(photos.find((p) => p.path === path)).toMatchObject({ active: false });
        // Masquée : invisible du public.
        const pub = await t.db.prepare("SELECT COUNT(*) AS n FROM unit_photos WHERE path = ?1 AND active = 1").bind(path).first<{ n: number }>();
        expect(pub!.n).toBe(0);
      });

      it("avec texte : affichée tout de suite", async () => {
        const r = await call("POST", "/api/admin/units/2/photos/upload", undefined, { form: form(pngBytes(640, 480), { alt: "Le jardin sous la neige" }), env: uploadEnv() });
        expect(r.status).toBe(201);
        expect(r.data.active).toBe(true);
      });

      it("refuse un autre format, un fichier trop lourd, un bien inconnu", async () => {
        const gif = new TextEncoder().encode("GIF89a-pas-une-photo-acceptee");
        expect((await call("POST", "/api/admin/units/2/photos/upload", undefined, { form: form(gif), env: uploadEnv() })).status).toBe(415);
        const big = pngBytes(10, 10, 8 * 1024 * 1024);
        expect((await call("POST", "/api/admin/units/2/photos/upload", undefined, { form: form(big), env: uploadEnv() })).status).toBe(413);
        expect((await call("POST", "/api/admin/units/999/photos/upload", undefined, { form: form(pngBytes(10, 10)), env: uploadEnv() })).status).toBe(404);
        expect((await call("POST", "/api/admin/units/2/photos/upload", undefined, { form: form(pngBytes(10, 10)), env: uploadEnv(), auth: null })).status).toBe(401);
      });
    });
  });
}

describe("garde IP dans le point d'entrée Worker", () => {
  it("403 sur /api/admin et /admin2/ hors liste, passage depuis une adresse autorisée, public jamais gardé", async () => {
    const worker = (await import("../src/index")).default;
    const assets = { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher;
    const env = { DB: undefined, ASSETS: assets, PUBLIC_BASE_URL: "http://test.local", ADMIN_ALLOWED_IPS: "81.82.83.0/24" } as unknown as Env;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const req = (path: string, ip: string) => new Request(`http://test.local${path}`, { headers: { "cf-connecting-ip": ip } });
    expect((await worker.fetch(req("/api/admin/units", "1.2.3.4"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(req("/admin2/", "1.2.3.4"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(req("/admin/", "1.2.3.4"), env, ctx)).status).toBe(403);
    const ok = await worker.fetch(req("/admin2/", "81.82.83.84"), env, ctx);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("asset");
    expect((await worker.fetch(req("/book/", "1.2.3.4"), env, ctx)).status).toBe(200);
  });
});

describe("revue Codex 1", () => {
  it("garde IP : doubles barres, casse et encodage ne contournent pas", () => {
    for (const p of ["/api//admin/tasks", "//api/admin/units", "//admin2/", "/API/admin/units", "/api/%61dmin/units", "/Admin2/", "/api/admin%2"]) expect(isAdminPath(p)).toBe(true);
    expect(adminIpGate("/api//admin/tasks", "10.0.0.0/8", "1.2.3.4")?.status).toBe(403);
  });

  it("revue Codex 2 : séparateur encodé, barre inverse, CIDR à deux barres", () => {
    for (const p of ["/admin2%2F", "/admin%2Findex.html", "/admin2%2f", "/%61dmin2/", "/admin2%5Cindex.html", "/api%2Fadmin%2Funits"]) expect(isAdminPath(p)).toBe(true);
    expect(adminIpDecision("10.0.0.0/8/erreur", "10.1.1.1")).toBe("denied");
  });
});
