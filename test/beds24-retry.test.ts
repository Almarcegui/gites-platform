// Nouveaux essais Beds24 sur panne RÉSEAU seulement (état des erreurs du 17/10 :
// « fetch failed » presque chaque nuit à 00:00 UTC), et fenêtre calme de minuit.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { Beds24Error, beds24Fetch, resetBeds24RetryState, resetBeds24TokenCache } from "../src/services/beds24";
import { inBeds24QuietWindow } from "../src/services/cron";
import { pushCalendars } from "../src/services/beds24-sync";

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.dispose(); });

const env = () => ({ DB: t.db, BEDS24_REFRESH_TOKEN: "refresh_test", BEDS24_WRITE_ENABLED: "true" }) as Env;
const real = globalThis.fetch;
let calls: { url: string; method: string }[] = [];
const waits: number[] = [];
const sleep = async (ms: number) => { waits.push(ms); };

/** Remplace fetch : `script` décide, pour chaque appel API (hors jeton), de lever ou de répondre. */
function stub(script: (n: number) => Response | Error) {
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("api.beds24.com")) return real(input as RequestInfo, init);
    if (url.includes("/authentication/token")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
    calls.push({ url, method: init?.method ?? "GET" });
    const r = script(n++);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
}
const down = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
const ok = () => new Response(JSON.stringify({ data: [] }), { status: 200 });

beforeEach(() => { calls = []; waits.length = 0; resetBeds24TokenCache(); resetBeds24RetryState(); });
afterEach(() => { globalThis.fetch = real; });

describe("beds24Fetch — nouveaux essais sur panne réseau", () => {
  it("GET : deux pannes puis succès, attentes de 30 s puis 2 min", async () => {
    stub((n) => (n < 2 ? down() : ok()));
    await expect(beds24Fetch(env(), "/bookings", { sleep })).resolves.toEqual({ data: [] });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([30_000, 120_000]);
  });

  it("GET : trois pannes → Beds24Error « inconnu », après trois essais en tout", async () => {
    stub(() => down());
    const e = await beds24Fetch(env(), "/bookings", { sleep }).catch((x) => x);
    expect(e).toBeInstanceOf(Beds24Error);
    expect(e.message).toContain("injoignable");
    expect(calls).toHaveLength(3);
  });

  it("une panne qui a épuisé ses essais coupe les nouveaux essais des appels suivants", async () => {
    stub(() => down());
    await beds24Fetch(env(), "/bookings", { sleep }).catch(() => {});
    calls = [];
    await beds24Fetch(env(), "/bookings/messages", { sleep }).catch(() => {});
    expect(calls).toHaveLength(1);
  });

  it("jamais de nouvel essai sur une réponse HTTP : 4xx et 5xx", async () => {
    stub(() => new Response(JSON.stringify({ error: "refusé" }), { status: 403 }));
    await expect(beds24Fetch(env(), "/bookings", { sleep })).rejects.toMatchObject({ status: 403, issue: "refus" });
    expect(calls).toHaveLength(1);
    calls = [];
    stub(() => new Response(JSON.stringify({ error: "panne" }), { status: 503 }));
    await expect(beds24Fetch(env(), "/bookings", { sleep })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("POST : aucun nouvel essai (issue inconnue, peut avoir été appliqué)", async () => {
    stub(() => down());
    const e = await beds24Fetch(env(), "/properties", { method: "POST", body: [{}], sleep }).catch((x) => x);
    expect(e).toMatchObject({ issue: "inconnu" });
    expect(calls).toHaveLength(1);
  });

  it("un appel concurrent qui a épuisé ses essais coupe les attentes des autres", async () => {
    stub(() => down());
    await beds24Fetch(env(), "/bookings", { sleep }).catch(() => {});
    waits.length = 0;
    stub((n) => (n < 1 ? down() : ok()));
    await beds24Fetch(env(), "/bookings", { sleep }).catch(() => {});
    expect(waits).toEqual([]);
  });

  it("un appel endormi n'envoie pas de requête de plus si un appel concurrent a constaté la panne pendant son attente", async () => {
    stub(() => down());
    let liberer: () => void = () => {};
    const bloque = new Promise<void>((r) => { liberer = r; });
    const a = beds24Fetch(env(), "/bookings", { sleep: () => bloque, retryDelaysMs: [1] }).catch((x) => x);
    await new Promise((r) => setTimeout(r, 50));
    await beds24Fetch(env(), "/bookings/messages", { sleep: async () => {}, retryDelaysMs: [1] }).catch(() => {});
    const avant = calls.length; // A : 1 essai, B : 2 essais
    liberer();
    const e = await a;
    expect(e).toBeInstanceOf(Beds24Error);
    expect(calls).toHaveLength(avant);
    expect(avant).toBe(3);
  });

  it("une réussite referme la pause : les essais reprennent", async () => {
    stub(() => down());
    await beds24Fetch(env(), "/bookings", { sleep }).catch(() => {});
    resetBeds24RetryState();
    stub((n) => (n < 1 ? down() : ok()));
    await expect(beds24Fetch(env(), "/bookings", { sleep })).resolves.toEqual({ data: [] });
    expect(waits.at(-1)).toBe(30_000);
  });

  it("corps non sérialisable : erreur immédiate, jamais rejouée, pas de pause de panne", async () => {
    stub(() => ok());
    const circulaire: Record<string, unknown> = {};
    circulaire.self = circulaire;
    await expect(beds24Fetch(env(), "/bookings", { method: "POST", body: circulaire, sleep })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    stub((n) => (n < 1 ? down() : ok()));
    await beds24Fetch(env(), "/bookings", { sleep });
    expect(waits).toEqual([30_000]);
  });

  it("réponse 200 coupée pendant la lecture du corps : issue inconnue, jamais prise pour un succès", async () => {
    const coupee = new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } });
    stub(() => new Response(coupee, { status: 200 }));
    await expect(beds24Fetch(env(), "/bookings", { sleep })).rejects.toMatchObject({ issue: "inconnu", status: 200 });
  });
});

describe("pushCalendars — rejeu sur panne réseau avec calendrier reconstruit", () => {
  it("panne puis succès : deux POST, attente de 30 s, calendrier reconstruit à chaque essai", async () => {
    stub((n) => (n < 1 ? down() : new Response(JSON.stringify([{ modified: {} }]), { status: 200 })));
    const out = await pushCalendars(t.db, env(), 1, 7, { sleep });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(waits).toEqual([30_000]);
    expect(out.pushed.length).toBeGreaterThan(0);
  });

  it("refus 400 de Beds24 : un seul POST, aucun rejeu", async () => {
    stub(() => new Response(JSON.stringify({ error: "non" }), { status: 400 }));
    await expect(pushCalendars(t.db, env(), 1, 7, { sleep })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});

describe("fenêtre calme de minuit UTC", () => {
  it("00:00 à 00:09 UTC : Beds24 saute ; 00:15 et le reste de la journée : exécuté", () => {
    expect(inBeds24QuietWindow(new Date("2026-10-18T00:00:05Z"))).toBe(true);
    expect(inBeds24QuietWindow(new Date("2026-10-18T00:09:59Z"))).toBe(true);
    expect(inBeds24QuietWindow(new Date("2026-10-18T00:15:00Z"))).toBe(false);
    expect(inBeds24QuietWindow(new Date("2026-10-18T12:00:00Z"))).toBe(false);
    expect(inBeds24QuietWindow(new Date("2026-10-17T23:45:00Z"))).toBe(false);
  });
});
