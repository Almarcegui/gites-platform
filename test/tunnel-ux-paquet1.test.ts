// Paquet 1 de l'audit « facilité d'utilisation » du 10/08 — issues #41, #42, #47.
//
// Le tunnel est du JS sans framework, servi tel quel : comme test/tunnel-a11y,
// ces tests lisent les fichiers LIVRÉS pour ce qui est purement front (une
// règle CSS, un attribut, l'ordre du markup), et passent par l'API pour ce qui
// se décide côté serveur (prix à la nuit, heure de référence, adresse).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Router } from "../src/api/router";
import { registerPublicRoutes } from "../src/api/public";
import { addDays, todayInZone } from "../src/core/dates";
import { icsEsc, icsFile, icsFold } from "../public/book/ics.js";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const HTML = read("public/book/index.html");
const JS = read("public/book/book.js");
const CSS = read("public/book/book.css");
const VOUCHER = read("public/book/voucher.html");
const MERCI = read("public/book/merci.html");
const ANNULE = read("public/book/annule.html");

describe("issue #41 — case CGV : une seule règle, message ciblé, focus", () => {
  it("les deux boutons de paiement obéissent à la MÊME condition", () => {
    // Avant : le bouton mobile exigeait en plus la case cochée et restait grisé
    // sans dire pourquoi, le bouton desktop laissait cliquer.
    expect(JS).toMatch(/\$\("bPay"\)\.disabled = !ok;\s*\n\s*\$\("mbPay"\)\.disabled = !ok;/);
    expect(JS).not.toMatch(/mbPay"\)\.disabled = !ok \|\| !accepted/);
  });

  it("le refus s'écrit à côté de la case, dans une zone annoncée", () => {
    expect(JS).toMatch(/id="cgvMsg"[^>]*role="alert"/);
    expect(JS).toMatch(/aria-describedby="cgvMsg"/);
    // et la zone est bien remplie au moment du refus
    expect(JS).toMatch(/\$\("cgvMsg"\)\.textContent = t\("Cochez cette case/);
  });

  it("le focus est posé sur la case, et l'erreur se lève dès qu'on la coche", () => {
    expect(JS).toMatch(/\$\("gCgv"\)\.setAttribute\("aria-invalid", "true"\)/);
    expect(JS).toMatch(/\$\("gCgv"\)\.focus\(/);
    expect(JS).toMatch(/if \(\$\("gCgv"\)\.checked\) clearCgvError\(\)/);
  });
});

describe("issue #42 — radios du paiement à taille native", () => {
  it("la feuille du tunnel sort les radios du width:100% des champs", () => {
    // Le bloc générique `input,select,textarea{…width:100%}` s'appliquait aussi
    // aux radios : ~465 px de large chacun.
    expect(CSS).toMatch(/input\[type=checkbox\],input\[type=radio\]\{width:auto/);
  });

  it("le libellé entier reste cliquable et ne s'étire pas sous le radio", () => {
    expect(CSS).toMatch(/\.paybox label\{display:flex;[^}]*cursor:pointer/);
    // le texte du choix est dans un <span> : sinon les nœuds texte deviennent
    // des éléments flex anonymes et le libellé se disloque
    expect(JS).toMatch(/name="payMode" value="deposit" checked><span>/);
    expect(JS).toMatch(/name="payMode" value="full"[^>]*><span>/);
  });

  it("les deux choix forment un groupe nommé pour les technologies d'assistance", () => {
    expect(JS).toMatch(/<fieldset class="paychoices"><legend class="sr-only">\$\{t\("Montant à payer maintenant"\)\}<\/legend>/);
  });
});

describe("issue #47 — micro-corrections du tunnel", () => {
  it("1. le sélecteur de voyageurs est AVANT le calendrier", () => {
    const pax = HTML.indexOf('id="qAd"');
    const cal = HTML.indexOf('id="calGrid"');
    expect(pax).toBeGreaterThan(0);
    expect(cal).toBeGreaterThan(0);
    expect(pax).toBeLessThan(cal);
    // et il n'y a toujours qu'un seul sélecteur de chaque
    expect(HTML.match(/id="qAd"/g)).toHaveLength(1);
    expect(HTML.match(/id="qCh"/g)).toHaveLength(1);
  });

  it("2. le devis affiche le prix à la nuit, pas l'intitulé technique", () => {
    expect(JS).toMatch(/publicLabel && l\.unitPriceCents != null/);
    expect(JS).toMatch(/la nuit/);
    expect(VOUCHER).toMatch(/publicLabel && l\.unitPriceCents != null/);
  });

  it("3. « et taxes » n'est plus promis : le résumé dit « ménage et charges compris »", () => {
    expect(JS).not.toMatch(/ménage et taxes compris/);
    expect(JS).not.toMatch(/taxe de séjour/);
    expect(JS).toMatch(/ménage et charges compris/);
  });

  it("5. les trois pages cul-de-sac offrent un retour au site", () => {
    for (const page of [MERCI, ANNULE, VOUCHER]) {
      expect(page).toMatch(/class="back-top" href="\/"( data-i18n)?>← Retour au site<\/a>/);
    }
  });

  it("6. la région des résultats est annoncée une fois, à la fin de la recherche", () => {
    expect(HTML).toMatch(/<div id="results"[^>]*aria-live="polite"/);
    expect(JS).toMatch(/setAttribute\("aria-busy", "true"\)/);
    expect(JS).toMatch(/setAttribute\("aria-busy", "false"\)/);
    // le retour au repos vient APRÈS l'écriture de la liste, sinon rien n'est annoncé
    const written = JS.indexOf('$("results").innerHTML = cards.join("")');
    const idle = JS.indexOf('setAttribute("aria-busy", "false")', written);
    expect(written).toBeGreaterThan(0);
    expect(idle).toBeGreaterThan(written);
  });

  it("7. le voucher propose le .ics au téléchargement, sans dépendance", () => {
    expect(VOUCHER).toMatch(/import \{ icsFile \} from "\.\/ics\.js"/);
    expect(VOUCHER).toMatch(/type: "text\/calendar/);
    expect(VOUCHER).toMatch(/download="sejour-/);
  });
});

// Le générateur est un module à part (comme cgv.js) : on l'EXÉCUTE, au lieu de
// relire le source de la page — une regex verte n'aurait pas vu un crash.
describe("issue #47-7 — le fichier .ics, exécuté pour de vrai", () => {
  const BOOKING = {
    reference: "PM-2026-042",
    unitName: "La Scierie",
    checkin: "2027-06-14",
    checkout: "2027-06-18",
    adults: 2,
    children: 1,
  };
  const STAY = { checkinTime: "18:00", checkoutTime: "18:00" };
  const NOW = new Date("2026-08-28T12:00:00Z");

  it("journée entière : DTEND vaut la date de départ, qui est exclusive", () => {
    const ics = icsFile(BOOKING, STAY, "Hameau du Pré Moré, 6890 Redu", NOW);
    expect(ics).toContain("DTSTART;VALUE=DATE:20270614");
    expect(ics).toContain("DTEND;VALUE=DATE:20270618");
    expect(ics).toContain("DTSTAMP:20260828T120000Z");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // toutes les lignes séparées par CRLF, aucune ligne nue
    expect(ics.includes("\n\n")).toBe(false);
  });

  it("les virgules et les retours à la ligne sont échappés, jamais bruts", () => {
    expect(icsEsc("Hameau, 6890 Redu")).toBe("Hameau\\, 6890 Redu");
    expect(icsEsc("a;b")).toBe("a\\;b");
    expect(icsEsc("a\nb")).toBe("a\\nb");
    expect(icsEsc("c:\\dossier")).toBe("c:\\\\dossier");
    const ics = icsFile(BOOKING, STAY, "Hameau, 6890 Redu (Daverdisse)", NOW);
    expect(ics).toContain("LOCATION:Hameau\\, 6890 Redu (Daverdisse)");
  });

  it("aucune ligne ne dépasse 75 octets : les continuations sont pliées", () => {
    const ics = icsFile(BOOKING, STAY, "Un très long hameau accentué au bout d'un chemin, 6890 Redu (Daverdisse)", NOW);
    const enc = new TextEncoder();
    for (const line of ics.split("\r\n")) {
      expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    }
    // une continuation commence par une espace, et une seule
    const folded = ics.split("\r\n").filter((l) => l.startsWith(" "));
    expect(folded.length).toBeGreaterThan(0);
    // et le pliage est réversible : on retrouve le texte d'origine
    const unfolded = ics.split("\r\n").reduce((acc, l) => (l.startsWith(" ") ? acc + l.slice(1) : acc + "\n" + l), "");
    expect(unfolded).toContain("Un très long hameau accentué au bout d'un chemin");
  });

  it("le pliage ne coupe ni un caractère accentué ni une séquence échappée", () => {
    const line = "DESCRIPTION:" + "é".repeat(60) + "\\n" + "à".repeat(20);
    const out = icsFold(line);
    for (const l of out.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    // aucune ligne ne se termine par un antislash isolé : l'échappement survit
    for (const l of out.split("\r\n")) expect(/(^|[^\\])\\$/.test(l)).toBe(false);
  });

  it("sans adresse ni horaires, le fichier reste valide", () => {
    const ics = icsFile(BOOKING, {}, "", NOW);
    expect(ics).not.toContain("LOCATION:");
    expect(ics).not.toContain("Arrivée dès");
    expect(ics).toContain("DESCRIPTION:Référence PM-2026-042");
  });
});

describe("issue #47 — le contrat d'API derrière ces affichages", () => {
  let t: TestDb;
  let db: D1Database;
  let env: Env;
  const router = new Router();
  registerPublicRoutes(router);
  const CHECKIN = addDays(todayInZone(), 200);
  const CHECKOUT = addDays(CHECKIN, 3);
  // Séjour distinct pour le scénario « option expirée » : la première option
  // bloque encore les dates ci-dessus.
  const LATER_IN = addDays(CHECKIN, 30);
  const LATER_OUT = addDays(LATER_IN, 3);
  const GUEST = { firstName: "Alix", lastName: "Voyageur", email: "alix.voyageur@example.com", phone: "+32 470 12 34 56" };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    env = {
      DB: db,
      ASSETS: undefined as unknown as Fetcher,
      PUBLIC_BASE_URL: "http://test.local",
      EMAILS_ENABLED: "false",
    } as Env;
  });
  afterAll(async () => {
    await t.dispose();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`http://test.local${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await router.handle(req, env);
    if (!res) throw new Error(`route non matchée : ${method} ${path}`);
    return { status: res.status, data: (await res.json()) as Record<string, never> };
  };

  it("2. chaque ligne d'hébergement porte son libellé client et son prix unitaire", async () => {
    const { status, data } = await call("POST", "/api/public/quote", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
    });
    expect(status).toBe(200);
    const quote = data.quote as unknown as {
      ok: boolean;
      lines: { kind: string; label: string; publicLabel?: string; unitPriceCents?: number; amountCents: number }[];
    };
    expect(quote.ok).toBe(true);
    const nuits = quote.lines.filter((l) => l.kind === "accommodation");
    expect(nuits.length).toBeGreaterThan(0);
    for (const l of nuits) {
      // le libellé technique reste intact pour le back-office…
      expect(l.label).toContain("·");
      // …et le libellé client est le même, débarrassé de l'origine du prix
      expect(l.publicLabel).toBeDefined();
      expect(l.publicLabel).not.toContain("tarif de base");
      expect(l.label.startsWith(l.publicLabel!)).toBe(true);
      // prix unitaire exact, jamais une moyenne arrondie
      expect(l.unitPriceCents).toBeDefined();
      const nights = Number(l.publicLabel!.split(" ")[0]);
      expect(l.unitPriceCents! * nights).toBe(l.amountCents);
    }
  });

  it("3. la carte de résultat sait si une taxe de séjour est comprise", async () => {
    const { status, data } = await call(
      "GET",
      `/api/public/availability?property=pre-more&checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=2&children=0`,
    );
    expect(status).toBe(200);
    const units = data.units as unknown as { quote: { ok: boolean; taxCents?: number } | null }[];
    const bookable = units.filter((u) => u.quote?.ok);
    expect(bookable.length).toBeGreaterThan(0);
    for (const u of bookable) expect(typeof u.quote!.taxCents).toBe("number");
  });

  it("4 et 7. le voucher reçoit l'heure serveur et l'adresse du gîte", async () => {
    const created = await call("POST", "/api/public/bookings", {
      unitId: 2, checkin: CHECKIN, checkout: CHECKOUT, adults: 2, children: 0,
      paymentMode: "deposit", cgvAccepted: true, guest: GUEST,
    });
    expect(created.status).toBe(201);
    const reference = String(created.data.reference);
    const { status, data } = await call(
      "GET",
      `/api/public/bookings/${reference}?email=${encodeURIComponent(GUEST.email)}`,
    );
    expect(status).toBe(200);
    // heure serveur au même format SQL que holdExpiresAt : la page peut soustraire
    const now = String(data.now);
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const booking = data.booking as unknown as { holdExpiresAt: string | null };
    expect(booking.holdExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Date.parse(booking.holdExpiresAt!.replace(" ", "T") + "Z")).toBeGreaterThan(
      Date.parse(now.replace(" ", "T") + "Z"),
    );
    // adresse du domaine, telle qu'elle est en base
    const contact = data.contact as unknown as { address: string | null; commune: string | null };
    expect(contact.address).toBeTruthy();
  });

  it("4. une option arrivée à terme ne se paie plus : le voucher doit le dire", async () => {
    const created = await call("POST", "/api/public/bookings", {
      unitId: 2, checkin: LATER_IN, checkout: LATER_OUT, adults: 2, children: 0,
      paymentMode: "deposit", cgvAccepted: true, guest: { ...GUEST, email: "alix.expire@example.com" },
    });
    expect(created.status).toBe(201);
    const reference = String(created.data.reference);
    // on fait vieillir l'option d'une heure : c'est l'état qu'un client
    // retrouve en rouvrant son lien le lendemain
    await db
      .prepare("UPDATE bookings SET hold_expires_at = datetime('now', '-1 hour') WHERE reference = ?1")
      .bind(reference)
      .run();
    const v = await call("GET", `/api/public/bookings/${reference}?email=alix.expire@example.com`);
    const booking = v.data.booking as unknown as { holdExpiresAt: string | null };
    // la page compare à data.now, jamais à l'horloge du poste
    expect(Date.parse(booking.holdExpiresAt!.replace(" ", "T") + "Z")).toBeLessThan(
      Date.parse(String(v.data.now).replace(" ", "T") + "Z"),
    );
    const pay = await call("POST", `/api/public/bookings/${reference}/pay`, { email: "alix.expire@example.com" });
    expect(pay.status).toBe(410);
    // et le voucher a bien un état « Option expirée » à afficher pour ce cas
    expect(VOUCHER).toMatch(/Option expirée/);
    expect(VOUCHER).toMatch(/const holdAlive = b\.status === "pending" && b\.holdExpiresAt && holdMsLeft > 0/);
    // le décompte VIT : sans ce minuteur, un onglet resté ouvert afficherait
    // encore « bloqué encore 2 minutes » une heure après (contre-review Gemini)
    expect(VOUCHER).toMatch(/const holdExpiresLocal = Date\.now\(\) \+ holdMsLeft/);
    expect(VOUCHER).toMatch(/if \(left <= 0\) \{\s*\n\s*card\.innerHTML = expiredHtml;/);
  });
});
