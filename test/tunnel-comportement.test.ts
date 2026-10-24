// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://localhost/book/"}
// Tunnel de réservation : le VRAI book.js tourne dans jsdom, sur le VRAI
// index.html, avec un fetch scripté. Vérifie le comportement (verrou, reprise,
// annulation, refus), pas la présence de chaînes dans le source.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const lire = (f: string) => readFileSync(join(process.cwd(), "public/book", f), "utf8");
const html = lire("index.html");

// Vite refuse d'importer un fichier de public/ : on copie les modules du
// tunnel hors du dossier, en remplaçant la seule dépendance absolue
// (/galerie.js, visionneuse d'images, hors sujet ici) par une coquille vide.
const copie = join(process.cwd(), "test/.tmp-tunnel");
rmSync(copie, { recursive: true, force: true });
mkdirSync(copie, { recursive: true });
for (const f of readdirSync(join(process.cwd(), "public/book")).filter((n) => n.endsWith(".js"))) {
  writeFileSync(join(copie, f), lire(f).replace(/from "\/galerie\.js"/g, 'from "./galerie-vide.js"'));
}
writeFileSync(join(copie, "galerie-vide.js"), "export const visionneuse = () => {};\n");

type Rep = { status?: number; body: unknown };
let appels: { url: string; method: string; body: any }[] = [];
let routes: Record<string, Rep | (() => Rep)> = {};

const tomorrow = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const sqlNow = (ms = 0) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");

function holdServeur(extra: Record<string, unknown> = {}) {
  return {
    hold: {
      reference: "GP-TEST1", checkin: tomorrow(30), checkout: tomorrow(33), adults: 2, children: 0,
      unitSlug: "a", unitName: "Gîte A", amountDueCents: 12000, guestEmail: "x@y.be",
      holdExpiresAt: sqlNow(20 * 60000), now: sqlNow(), ...extra,
    },
  };
}
const stockage = (minutes: number) => ({
  reference: "GP-OLD", info: { checkin: tomorrow(10), checkout: tomorrow(12), unitName: "Gîte A", amountCents: 9000, email: "x@y.be" },
  expiresAtLocal: Date.now() + minutes * 60000,
});

async function demarrer(opts: { stocke?: unknown } = {}) {
  vi.resetModules();
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.dataset.property = "demo";
  sessionStorage.clear();
  if (opts.stocke) sessionStorage.setItem("gites-hold:demo", JSON.stringify(opts.stocke));
  await import(/* @vite-ignore */ join(copie, "book.js"));
  await vi.waitFor(() => expect(appels.some((a) => a.url.startsWith("/api/public/hold?"))).toBe(true));
  await new Promise((r) => setTimeout(r, 30));
}
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const compte = (fragment: string) => appels.filter((a) => a.url.includes(fragment)).length;

beforeEach(() => {
  appels = [];
  routes = {
    "/api/public/properties/demo": { body: { property: { name: "Demo", contactEmail: "a@b.be" }, units: [] } },
    "/api/public/today": { body: { today: tomorrow(0) } },
    "/api/public/offers": { body: { offers: [] } },
    "/api/public/calendar": { body: { units: [] } },
    "/api/public/payment-config": { body: { publishableKey: "" } },
  };
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    appels.push({ url, method: init.method ?? "GET", body });
    const cle = Object.keys(routes).filter((k) => url.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = cle ? routes[cle] : { status: 404, body: { error: "inconnu" } };
    const rep = typeof r === "function" ? r() : r;
    const status = rep.status ?? 200;
    return { ok: status < 400, status, json: async () => rep.body };
  });
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = window.matchMedia || ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any);
  (window as any).scrollTo = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(() => rmSync(copie, { recursive: true, force: true }));

describe("tunnel : comportement réel", () => {
  it("un hold serveur verrouille le tunnel et montre le bandeau avec ses deux actions", async () => {
    routes["/api/public/hold?"] = { body: holdServeur() };
    await demarrer();
    expect($("holdBanner").hidden).toBe(false);
    expect(document.body.classList.contains("hold-locked")).toBe(true);
    for (const id of ["offersCard", "searchCard", "results"]) expect(($(id) as any).inert).toBe(true);
    expect($("holdResume")).toBeTruthy();
    expect($("holdCancel")).toBeTruthy();
  });

  it("le serveur répond hold:null : la copie locale périmée ne rouvre rien", async () => {
    routes["/api/public/hold?"] = { body: { hold: null } };
    await demarrer({ stocke: stockage(20) });
    expect($("holdBanner").hidden).toBe(true);
    expect(document.body.classList.contains("hold-locked")).toBe(false);
    expect(sessionStorage.getItem("gites-hold:demo")).toBeNull();
  });

  it("serveur muet : la copie locale encore valable est reprise", async () => {
    routes["/api/public/hold?"] = { status: 500, body: {} };
    await demarrer({ stocke: stockage(20) });
    expect($("holdBanner").hidden).toBe(false);
    expect(document.body.classList.contains("hold-locked")).toBe(true);
  });

  it("annuler : appelle la route, libère le tunnel, annonce, remet le focus sur les dates", async () => {
    routes["/api/public/hold?"] = { body: holdServeur() };
    routes["/api/public/hold/cancel"] = { body: { ok: true } };
    await demarrer();
    $("holdCancel").click();
    await vi.waitFor(() => expect($("holdBanner").hidden).toBe(true));
    expect(compte("/api/public/hold/cancel")).toBe(1);
    expect(appels.find((a) => a.url.includes("hold/cancel"))!.method).toBe("POST");
    expect(document.body.classList.contains("hold-locked")).toBe(false);
    expect(sessionStorage.getItem("gites-hold:demo")).toBeNull();
    expect(document.activeElement?.id).toBe("paxTitle");
    expect($("holdLive").textContent).toMatch(/annulée/);
  });

  it("annuler refusé (paiement en cours) : message affiché, bandeau et verrou conservés", async () => {
    routes["/api/public/hold?"] = { body: holdServeur() };
    routes["/api/public/hold/cancel"] = { status: 409, body: { error: "Paiement en cours, réessayez dans une minute." } };
    await demarrer();
    $("holdCancel").click();
    await vi.waitFor(() => expect($("holdErr").textContent).toMatch(/Paiement en cours/));
    expect($("holdBanner").hidden).toBe(false);
    expect(document.body.classList.contains("hold-locked")).toBe(true);
    expect(($("holdCancel") as HTMLButtonElement).disabled).toBe(false);
  });

  it("échéance atteinte : message d'expiration, boutons cachés pour de bon", async () => {
    routes["/api/public/hold?"] = { body: holdServeur({ holdExpiresAt: sqlNow(1500), now: sqlNow() }) };
    await demarrer();
    await vi.waitFor(() => expect($("holdBanner").classList.contains("expired")).toBe(true), { timeout: 4000 });
    const actions = $("holdBanner").querySelector(".holdactions") as HTMLElement;
    expect(actions.hidden).toBe(true);
    expect(document.body.classList.contains("hold-locked")).toBe(false);
    // la règle CSS livrée doit réellement masquer l'élément [hidden]
    expect(lire("book.css")).toMatch(/\.holdactions\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("Continuer : rouvre le paiement initial d'un hold actif", async () => {
    routes["/api/public/hold?"] = { body: holdServeur() };
    routes["/api/public/bookings/GP-TEST1/pay"] = { body: { kind: "deposit", holdExpiresAt: sqlNow(600000), amountCents: 12000, payment: { mode: "redirect" }, checkoutUrl: "https://pay.example/ok" } };
    const nav = vi.spyOn(console, "error").mockImplementation(() => {});
    await demarrer();
    $("holdResume").click();
    await vi.waitFor(() => expect(compte("/pay")).toBe(1));
    await vi.waitFor(() => expect(nav.mock.calls.some((c) => /navigation/i.test(String(c[0]?.message ?? c[0])))).toBe(true));
  });

  it("Continuer refuse un solde (kind balance) sans repli sur l'URL de paiement", async () => {
    routes["/api/public/hold?"] = { body: holdServeur() };
    routes["/api/public/bookings/GP-TEST1/pay"] = { body: { kind: "balance", checkoutUrl: "https://pay.example/solde" } };
    const nav = vi.spyOn(console, "error").mockImplementation(() => {});
    await demarrer();
    $("holdResume").click();
    await vi.waitFor(() => expect($("holdErr").textContent).toMatch(/Annulez puis recommencez/));
    expect(nav.mock.calls.some((c) => /navigation/i.test(String(c[0]?.message ?? c[0])))).toBe(false);
    expect(($("holdResume") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Continuer après un refus 4xx du serveur : jamais de repli sur l'ancienne adresse", async () => {
    routes["/api/public/hold?"] = { body: holdServeur() };
    routes["/api/public/bookings/GP-TEST1/pay"] = { status: 409, body: { error: "Réservation expirée." } };
    const nav = vi.spyOn(console, "error").mockImplementation(() => {});
    await demarrer({ stocke: { ...stockage(20), checkoutUrl: "https://pay.example/ancien" } });
    $("holdResume").click();
    await vi.waitFor(() => expect($("holdErr").textContent).toMatch(/expirée/));
    expect(nav.mock.calls.some((c) => /navigation/i.test(String(c[0]?.message ?? c[0])))).toBe(false);
  });
});
