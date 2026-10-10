import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/client.js";
import { periodWindow } from "../src/dates.js";
import { buildServer } from "../src/server.js";
import { booking, startFake } from "./faux-serveur.js";

// Jeudi 8 octobre 2026, 12 h à Bruxelles.
const NOW = new Date("2026-10-08T10:00:00Z");

let fake: Awaited<ReturnType<typeof startFake>>;
let client: Client;
let stderr: string[];

async function connect(mode: "session" | "secours" = "session") {
  fake.state.sessionMode = mode;
  const server = buildServer({ baseUrl: fake.url, user: "julien", password: "mdp-test", timeoutMs: 2000 }, { now: () => NOW });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

function jetonOf(t: string): string {
  const m = t.match(/jeton: "([0-9a-f]+)"/);
  if (!m) throw new Error(`pas de jeton dans : ${t}`);
  return m[1]!;
}

function writes(method: string, path: string) {
  return fake.state.requests.filter((r) => r.method === method && r.path.split("?")[0] === path);
}

beforeEach(async () => {
  // Le client de test ne sait pas faire d'élicitation : mode « jeton » par
  // défaut ici ; le mode « hote » (défaut réel) a ses propres tests.
  process.env.GITES_MCP_CONFIRMATION = "jeton";
  fake = await startFake();
  fake.state.bookings.push(
    booking({ id: 1, reference: "PM-2026-001", unitId: 2, unitName: "La Scierie", checkin: "2026-10-09", checkout: "2026-10-12", guestName: "Dupont" }),
    booking({ id: 2, reference: "PM-2026-002", unitId: 1, unitName: "La Maison du Scieur", checkin: "2026-10-05", checkout: "2026-10-10", guestName: "Martin", paidCents: 60000 }),
    booking({ id: 3, reference: "PM-2026-003", unitId: 1, unitName: "La Maison du Scieur", checkin: "2026-10-10", checkout: "2026-10-11", status: "cancelled", guestName: "Annulé" }),
    booking({ id: 4, reference: "MB-2026-001", unitId: 4, unitName: "Le Moulin", propertyId: 2, checkin: "2026-11-20", checkout: "2026-11-23", guestName: "Leroy", guestEmail: "leroy@example.test", balanceDueDate: "2026-11-01" }),
  );
  fake.state.messages.push({
    id: 50, propertyId: 1, direction: "in", channel: "email", fromEmail: "client@example.test", fromName: "Claire Client",
    toEmail: null, subject: "Arrivée tardive", bodyText: "Bonjour, nous arriverons vers 22 h, est-ce possible ?", bookingId: 1,
    bookingReference: "PM-2026-001", status: "nouveau", delivery: null, receivedAt: "2026-10-07 18:00:00",
  });
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
  await connect();
});

afterEach(async () => {
  delete process.env.GITES_MCP_CONFIRMATION;
  vi.restoreAllMocks();
  await client.close();
  await fake.close();
});

describe("catalogue", () => {
  it("expose les 13 outils, écritures marquées non lecture seule", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["arrivees_departs", "bloquer_dates", "debloquer_dates", "devis", "disponibilite", "fiche_reservation", "messages_en_attente",
        "paiements_en_attente", "reservations", "relancer_solde", "repondre_client", "sante", "vente_telephone"].sort(),
    );
    for (const t of tools) {
      const write = ["bloquer_dates", "debloquer_dates", "repondre_client", "vente_telephone", "relancer_solde"].includes(t.name);
      expect(t.annotations?.readOnlyHint).toBe(!write);
      if (write) expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["confirmer", "jeton"]));
    }
    // Aucun outil d'annulation ni de remboursement.
    expect(tools.some((t) => /annul|rembours|refund|cancel/.test(t.name))).toBe(false);
  });
});

describe("authentification", () => {
  it("ouvre une session une fois, puis la réutilise", async () => {
    await call("reservations", {});
    await call("reservations", {});
    expect(fake.state.logins).toBe(1);
    const authed = fake.state.requests.filter((r) => r.path.startsWith("/api/admin/bookings"));
    expect(authed.every((r) => r.auth === "Bearer session:S1")).toBe(true);
  });

  it("renouvelle la session sur 401 et rejoue une seule fois", async () => {
    await call("reservations", {});
    fake.state.validSessions.clear(); // session révoquée côté plateforme
    const r = await call("reservations", {});
    expect(r.isError).toBe(false);
    expect(fake.state.logins).toBe(2);
    expect(fake.state.requests.at(-1)!.auth).toBe("Bearer session:S2");
  });

  it("accès de secours ADMIN_TOKEN : présente id:mdp quand la plateforme ne rend pas de session", async () => {
    await client.close();
    await connect("secours");
    const r = await call("reservations", {});
    expect(r.isError).toBe(false);
    expect(fake.state.requests.at(-1)!.auth).toBe("Bearer julien:mdp-test");
  });

  it("mauvais mot de passe : message actionnable, pas de boucle", async () => {
    await client.close();
    const server = buildServer({ baseUrl: fake.url, user: "julien", password: "faux" }, { now: () => NOW });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await call("reservations", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/GITES_ID \/ GITES_MDP/);
  });

  it("refuse une URL http hors localhost", () => {
    expect(() => loadConfig({ GITES_URL: "http://exemple.be", GITES_ID: "a", GITES_MDP: "b" })).toThrow(/https/);
    expect(loadConfig({ GITES_URL: "http://localhost:8787/", GITES_ID: "a", GITES_MDP: "b" }).baseUrl).toBe("http://localhost:8787");
    expect(() => loadConfig({ GITES_URL: "https://x.dev" })).toThrow(/GITES_ID, GITES_MDP/);
    for (const bad of ["https://u:p@x.dev", "https://x.dev/api", "https://x.dev/?k=1", "https://x.dev/#f"]) {
      expect(() => loadConfig({ GITES_URL: bad, GITES_ID: "a", GITES_MDP: "b" })).toThrow(/simple origine/);
    }
  });
});

describe("lecture", () => {
  it("périodes : le week-end va du vendredi au lundi", () => {
    expect(periodWindow("ce_week_end", "2026-10-08")).toEqual({ du: "2026-10-09", au: "2026-10-12" }); // jeudi
    expect(periodWindow("ce_week_end", "2026-10-10")).toEqual({ du: "2026-10-10", au: "2026-10-12" }); // samedi
    expect(periodWindow("ce_week_end", "2026-10-11")).toEqual({ du: "2026-10-11", au: "2026-10-12" }); // dimanche
    expect(periodWindow("week_end_prochain", "2026-10-08")).toEqual({ du: "2026-10-16", au: "2026-10-19" });
  });

  it("arrivees_departs ce week-end : arrivées, départs, annulées exclues", async () => {
    const r = await call("arrivees_departs", { periode: "ce_week_end" });
    expect(r.text).toContain("Du ven. 09/10/2026 au lun. 12/10/2026");
    const [arr, dep] = r.text.split("Départs");
    expect(arr).toContain("PM-2026-001");
    expect(arr).not.toContain("PM-2026-003");
    expect(dep).toContain("PM-2026-002"); // départ samedi 10
    expect(dep).toContain("PM-2026-001"); // départ lundi 12
    // Fenêtre envoyée au Worker élargie d'un jour de chaque côté.
    expect(fake.state.requests.some((x) => x.path.includes("from=2026-10-08") && x.path.includes("to=2026-10-13"))).toBe(true);
  });

  it("disponibilite : la Scierie occupée, le Domaine entier bloqué par liaison, le Moulin libre", async () => {
    const r = await call("disponibilite", { arrivee: "2026-10-10", depart: "2026-10-12" });
    expect(r.text).toMatch(/La Scierie : OCCUPÉ\n\s+· PM-2026-001/);
    expect(r.text).toMatch(/Le Domaine entier : OCCUPÉ[\s\S]*PM-2026-001 — La Scierie \(liaison\)/);
    expect(r.text).toContain("Le Moulin : LIBRE");
  });

  it("« Scierie » ne confond pas avec « Maison du Scieur » ; un nom ambigu liste les candidats", async () => {
    const r = await call("disponibilite", { hebergement: "scierie", arrivee: "2026-12-01", depart: "2026-12-04" });
    expect(r.text).toContain("La Scierie : LIBRE");
    expect(r.text).not.toContain("Maison du Scieur");
    const amb = await call("disponibilite", { hebergement: "scie", arrivee: "2026-12-01", depart: "2026-12-04" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/ambigu/);
  });

  it("devis sans hébergement : seuls ceux qui accueillent le groupe", async () => {
    const r = await call("devis", { arrivee: "2026-12-01", depart: "2026-12-04", adultes: 10 });
    expect(r.text).toContain("La Maison du Scieur (disponible) : total 530,00 €");
    expect(r.text).not.toContain("La Scierie");
    expect(r.text).toContain("arrhes 50 % : 265,00 €");
  });

  it("fiche_reservation par référence", async () => {
    const r = await call("fiche_reservation", { reservation: "pm-2026-001" });
    expect(r.text).toContain("PM-2026-001 (id 1) — confirmée");
    expect(r.text).toContain("reste dû 300,00 €");
  });

  it("paiements_en_attente : soldes triés, retards signalés", async () => {
    const r = await call("paiements_en_attente", {});
    expect(r.text).toMatch(/2 solde\(s\) dû\(s\), total 600,00 €/);
    expect(r.text).toMatch(/EN RETARD PM-2026-001/);
    expect(r.text).not.toContain("PM-2026-002"); // soldée
  });

  it("messages_en_attente puis fil", async () => {
    const r = await call("messages_en_attente", {});
    expect(r.text).toContain("id 50");
    expect(r.text).toContain("Arrivée tardive");
    const fil = await call("messages_en_attente", { message_id: 50 });
    expect(fil.text).toContain("nous arriverons vers 22 h");
  });

  it("sante : cron, et alertes par domaine", async () => {
    const r = await call("sante", {});
    expect(r.text).toContain("Plateforme : en ligne");
    expect(r.text).toContain("Le Moulin de Braives : à surveiller");
    expect(r.text).toContain("flux iCal en erreur : Airbnb");
  });
});

describe("écritures en deux temps", () => {
  const args = { hebergement: "La Scierie", arrivee: "2026-12-01", depart: "2026-12-04", motif: "travaux" };

  it("bloquer_dates : récapitulatif sans écriture, puis écriture avec le jeton", async () => {
    const p = await call("bloquer_dates", args);
    expect(p.isError).toBe(false);
    expect(p.text).toContain("rien n'a encore été écrit");
    expect(p.text).toContain("La Scierie, Le Domaine entier deviennent indisponibles");
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(0);

    const sansJeton = await call("bloquer_dates", { ...args, confirmer: true });
    expect(sansJeton.isError).toBe(true);
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(0);

    const jeton = jetonOf(p.text);
    const autre = await call("bloquer_dates", { ...args, depart: "2026-12-05", confirmer: true, jeton });
    expect(autre.isError).toBe(true);
    expect(autre.text).toMatch(/ne sont plus ceux du récapitulatif/);

    const ok = await call("bloquer_dates", { ...args, confirmer: true, jeton });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/blocage n° \d+ posé/);
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(1);
    expect(writes("POST", "/api/admin/blocks")[0]!.body).toEqual({ unitId: 2, checkin: "2026-12-01", checkout: "2026-12-04", reason: "travaux" });

    const rejoue = await call("bloquer_dates", { ...args, confirmer: true, jeton });
    expect(rejoue.isError).toBe(true);
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(1);
  });

  it("bloquer_dates sur un créneau pris : refus d'emblée, sans jeton", async () => {
    const p = await call("bloquer_dates", { ...args, arrivee: "2026-10-10", depart: "2026-10-11" });
    expect(p.isError).toBe(true);
    expect(p.text).toContain("PM-2026-001");
    expect(p.text).not.toContain("jeton");
  });

  it("debloquer_dates : choisit parmi plusieurs blocages, puis lève le bon", async () => {
    fake.state.blocks.push(
      { id: 7, unitId: 2, unitName: "La Scierie", propertyId: 1, checkin: "2026-12-01", checkout: "2026-12-04", reason: "travaux", createdBy: "julien" },
      { id: 8, unitId: 2, unitName: "La Scierie", propertyId: 1, checkin: "2027-01-01", checkout: "2027-01-03", reason: "famille", createdBy: "julien" },
    );
    const amb = await call("debloquer_dates", { hebergement: "La Scierie" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/n° 7[\s\S]*n° 8/);
    const p = await call("debloquer_dates", { blocage_id: 8 });
    const ok = await call("debloquer_dates", { blocage_id: 8, confirmer: true, jeton: jetonOf(p.text) });
    expect(ok.text).toContain("blocage n° 8 levé");
    expect(writes("DELETE", "/api/admin/blocks/8")).toHaveLength(1);
    expect(fake.state.blocks.map((k) => k.id)).toEqual([7]);
  });

  it("repondre_client : destinataire et texte au récapitulatif, puis réponse au message", async () => {
    const a = { message_id: 50, texte: "Bonjour Claire, aucun souci pour 22 h. Julien" };
    const p = await call("repondre_client", a);
    expect(p.text).toContain("Destinataire : client@example.test");
    expect(p.text).toContain("aucun souci pour 22 h");
    expect(writes("POST", "/api/admin/messages/50/reply")).toHaveLength(0);
    const ok = await call("repondre_client", { ...a, confirmer: true, jeton: jetonOf(p.text) });
    expect(ok.text).toMatch(/simulé/);
    expect(writes("POST", "/api/admin/messages/50/reply")[0]!.body).toEqual({ body: a.texte });
  });

  it("repondre_client refuse message_id ET reservation ensemble", async () => {
    const r = await call("repondre_client", { message_id: 50, reservation: "PM-2026-001", texte: "x y" });
    expect(r.isError).toBe(true);
  });

  it("vente_telephone : capacité vérifiée, puis création avec les bons champs", async () => {
    const trop = await call("vente_telephone", {
      hebergement: "La Scierie", arrivee: "2026-12-01", depart: "2026-12-04", adultes: 9, client: { nom: "Durand" }, statut: "confirmee",
    });
    expect(trop.isError).toBe(true);
    expect(trop.text).toMatch(/8 personnes au plus/);

    const a = {
      hebergement: "La Scierie", arrivee: "2026-12-01", depart: "2026-12-04", adultes: 4, enfants: 2,
      client: { nom: "Durand", prenom: "Léa", email: "lea@example.test", telephone: "+32 470 00 00 00" },
      statut: "option", lien_paiement: true,
    };
    const p = await call("vente_telephone", a);
    expect(p.text).toContain("en OPTION pendant 72 h");
    expect(p.text).toContain("arrhes 265,00 €");
    expect(writes("POST", "/api/admin/bookings")).toHaveLength(0);
    const ok = await call("vente_telephone", { ...a, confirmer: true, jeton: jetonOf(p.text) });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("Lien de paiement : https://pay.example.test/s/1");
    const sent = writes("POST", "/api/admin/bookings")[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ unitId: 2, adults: 4, children: 2, confirmNow: false, holdMinutes: 4320, paymentMode: "deposit", generatePaymentLink: true });
    expect(sent.guest).toMatchObject({ lastName: "Durand", firstName: "Léa", email: "lea@example.test" });
  });

  it("relancer_solde : refus si soldée, sinon rappel après confirmation", async () => {
    const soldee = await call("relancer_solde", { reservation: "PM-2026-002" });
    expect(soldee.isError).toBe(true);
    expect(soldee.text).toMatch(/intégralement réglée/);
    const p = await call("relancer_solde", { reservation: "MB-2026-001" });
    expect(p.text).toContain("leroy@example.test");
    expect(p.text).toContain("300,00 €");
    const ok = await call("relancer_solde", { reservation: "MB-2026-001", confirmer: true, jeton: jetonOf(p.text) });
    expect(ok.text).toContain("rappel de solde (300,00 €)");
    expect(writes("POST", "/api/admin/bookings/4/balance-reminder")).toHaveLength(1);
  });

  it("panne réseau pendant l'écriture : prévient que l'état est inconnu, sans rejouer", async () => {
    const p = await call("bloquer_dates", args);
    fake.state.dropPaths.add("POST /api/admin/blocks");
    const r = await call("bloquer_dates", { ...args, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/PEUT-ÊTRE eu lieu/);
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(1);
  });
});

describe("écritures : courses et états inconnus (contre-review Codex)", () => {
  const args = { hebergement: "La Scierie", arrivee: "2026-12-01", depart: "2026-12-04", motif: "travaux" };
  const vente = {
    hebergement: "La Scierie", arrivee: "2026-12-01", depart: "2026-12-04", adultes: 2,
    client: { nom: "Durand", adresse: "Rue du Test 1, 6890 Redu", pays: "BE" }, statut: "confirmee", notes_internes: "arrive en vélo",
  };

  it("un second récapitulatif révoque le premier jeton (pas de double envoi)", async () => {
    const a = { reservation: "MB-2026-001" };
    const j1 = jetonOf((await call("relancer_solde", a)).text);
    const j2 = jetonOf((await call("relancer_solde", a)).text);
    expect((await call("relancer_solde", { ...a, confirmer: true, jeton: j1 })).isError).toBe(true);
    expect((await call("relancer_solde", { ...a, confirmer: true, jeton: j2 })).isError).toBe(false);
    expect(writes("POST", "/api/admin/bookings/4/balance-reminder")).toHaveLength(1);
  });

  it("prix modifié entre le récapitulatif et la confirmation : refus, rien d'écrit", async () => {
    const p = await call("vente_telephone", vente);
    expect(p.text).toContain("adresse : Rue du Test 1, 6890 Redu");
    expect(p.text).toContain("pays : BE");
    expect(p.text).toContain("Notes internes : arrive en vélo");
    fake.state.nightPriceCents = 20000;
    const r = await call("vente_telephone", { ...vente, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/la situation a changé/);
    expect(r.text).toContain("680,00 €"); // nouveau prix montré
    expect(writes("POST", "/api/admin/bookings")).toHaveLength(0);
  });

  it("créneau pris entre-temps : refus au recalcul, rien d'écrit", async () => {
    const p = await call("bloquer_dates", args);
    fake.state.bookings.push(booking({ id: 9, reference: "PM-2026-009", unitId: 3, unitName: "Le Domaine entier", checkin: "2026-12-02", checkout: "2026-12-03" }));
    const r = await call("bloquer_dates", { ...args, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("PM-2026-009");
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(0);
  });

  it("destinataire changé entre-temps : refus", async () => {
    const p = await call("relancer_solde", { reservation: "MB-2026-001" });
    fake.state.bookings.find((b) => b.id === 4).guestEmail = "autre@example.test";
    const r = await call("relancer_solde", { reservation: "MB-2026-001", confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("autre@example.test");
    expect(writes("POST", "/api/admin/bookings/4/balance-reminder")).toHaveLength(0);
  });

  it.each(["500", "garbage"] as const)("réponse %s APRÈS traitement : état inconnu, pas « rien n'a été écrit »", async (mode) => {
    const p = await call("bloquer_dates", args);
    fake.state.afterCommit.set("POST /api/admin/blocks", mode);
    const r = await call("bloquer_dates", { ...args, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/PEUT-ÊTRE eu lieu/);
    expect(r.text).not.toMatch(/Rien n'a été écrit/);
    expect(fake.state.blocks).toHaveLength(1); // le faux Worker a bien écrit
  });

  it("mode par défaut (hote) : sans élicitation, aucune écriture", async () => {
    delete process.env.GITES_MCP_CONFIRMATION;
    const p = await call("bloquer_dates", args);
    const r = await call("bloquer_dates", { ...args, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/élicitation/);
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(0);
  });

  it("élicitation : si l'hôte sait demander, l'humain tranche (refus = rien d'écrit)", async () => {
    delete process.env.GITES_MCP_CONFIRMATION;
    await client.close();
    const server = buildServer({ baseUrl: fake.url, user: "julien", password: "mdp-test" }, { now: () => NOW });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "hote", version: "1" }, { capabilities: { elicitation: {} } });
    let answer: "accept" | "decline" = "decline";
    const seen: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(String(req.params.message));
      return answer === "accept" ? { action: "accept", content: { confirmer: true } } : { action: "decline" };
    });
    await Promise.all([server.connect(a), client.connect(b)]);
    let p = await call("bloquer_dates", args);
    let r = await call("bloquer_dates", { ...args, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.text).toMatch(/Annulé par l'utilisateur/);
    expect(seen[0]).toContain("Bloquer La Scierie");
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(0);
    answer = "accept";
    p = await call("bloquer_dates", args);
    r = await call("bloquer_dates", { ...args, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(false);
    expect(writes("POST", "/api/admin/blocks")).toHaveLength(1);
  });

  it("un seul jeton vivant par outil : deux textes presque identiques ne partent pas deux fois", async () => {
    const j1 = jetonOf((await call("repondre_client", { message_id: 50, texte: "Bonjour" })).text);
    const j2 = jetonOf((await call("repondre_client", { message_id: 50, texte: " Bonjour " })).text);
    expect((await call("repondre_client", { message_id: 50, texte: "Bonjour", confirmer: true, jeton: j1 })).isError).toBe(true);
    expect((await call("repondre_client", { message_id: 50, texte: " Bonjour ", confirmer: true, jeton: j2 })).isError).toBe(false);
    expect(writes("POST", "/api/admin/messages/50/reply")).toHaveLength(1);
  });

  it("tout champ montré au récapitulatif fait partie de l'accord (arrivée déplacée → refus)", async () => {
    const p = await call("relancer_solde", { reservation: "MB-2026-001" });
    fake.state.bookings.find((b) => b.id === 4).checkin = "2026-11-21";
    const r = await call("relancer_solde", { reservation: "MB-2026-001", confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(writes("POST", "/api/admin/bookings/4/balance-reminder")).toHaveLength(0);
  });

  it("après une issue inconnue, la même demande exige apres_verification", async () => {
    const a = { reservation: "MB-2026-001" };
    const p = await call("relancer_solde", a);
    fake.state.afterCommit.set("POST /api/admin/bookings/4/balance-reminder", "500");
    expect((await call("relancer_solde", { ...a, confirmer: true, jeton: jetonOf(p.text) })).text).toMatch(/PEUT-ÊTRE/);
    fake.state.afterCommit.clear();
    const again = await call("relancer_solde", a);
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/issue INCONNUE/);
    const p2 = await call("relancer_solde", { ...a, apres_verification: true });
    expect(p2.isError).toBe(false);
    const ok = await call("relancer_solde", { ...a, apres_verification: true, confirmer: true, jeton: jetonOf(p2.text) });
    expect(ok.isError).toBe(false);
    expect(writes("POST", "/api/admin/bookings/4/balance-reminder")).toHaveLength(2);
  });

  it("réponse 2xx de forme inattendue : état inconnu", async () => {
    fake.state.blocks.push({ id: 7, unitId: 2, unitName: "La Scierie", propertyId: 1, checkin: "2026-12-01", checkout: "2026-12-04", reason: "travaux", createdBy: "julien" });
    const pv = await call("debloquer_dates", { blocage_id: 7 });
    fake.state.afterCommit.set("DELETE /api/admin/blocks/7", "vide");
    const r = await call("debloquer_dates", { blocage_id: 7, confirmer: true, jeton: jetonOf(pv.text) });
    expect(r.text).toMatch(/forme inattendue[\s\S]*PEUT-ÊTRE/);
    expect(fake.state.blocks).toHaveLength(0); // le faux Worker a bien levé le blocage
  });

  it("vente refusée (409) : message d'écriture partielle, sans « rien n'a été écrit »", async () => {
    const p = await call("vente_telephone", vente);
    // Créneau pris APRÈS le recalcul : seul le Worker le voit (409).
    fake.state.conflictOnCreate = true;
    const r = await call("vente_telephone", { ...vente, confirmer: true, jeton: jetonOf(p.text) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/fiche client a pu être créée/);
    expect(r.text).not.toMatch(/Rien n'a été écrit/);
  });

  it("vente sur un hébergement désactivé : refus", async () => {
    const { UNITS } = await import("./faux-serveur.js");
    UNITS[1]!.active = false;
    try {
      const r = await call("vente_telephone", vente);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/désactivé/);
    } finally {
      UNITS[1]!.active = true;
    }
  });

  it("sante : la sonde publique répond même si la connexion admin échoue", async () => {
    await client.close();
    const server = buildServer({ baseUrl: fake.url, user: "julien", password: "faux" }, { now: () => NOW });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await call("sante", {});
    expect(r.text).toContain("Plateforme : en ligne");
    expect(r.text).toMatch(/Back-office : inaccessible/);
    expect(r.text).not.toContain("http://"); // hôte seul, jamais l'URL
  });
});

describe("journal", () => {
  it("n'écrit aucune donnée client sur stderr", async () => {
    await call("arrivees_departs", { periode: "ce_week_end" });
    await call("reservations", { recherche: "Dupont" });
    await call("messages_en_attente", { message_id: 50 });
    const p = await call("repondre_client", { message_id: 50, texte: "Texte confidentiel Claire" });
    await call("repondre_client", { message_id: 50, texte: "Texte confidentiel Claire", confirmer: true, jeton: jetonOf(p.text) });
    const log = stderr.join("");
    expect(log.length).toBeGreaterThan(0);
    for (const secret of ["Dupont", "Claire", "client@example.test", "confidentiel", "PM-2026", "mdp-test", "session:S"]) {
      expect(log).not.toContain(secret);
    }
  });
});
