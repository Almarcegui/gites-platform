// Faux Worker : sous-ensemble de l'API admin, assez fidèle pour exercer le
// connecteur de bout en bout (vrai HTTP, vrai protocole MCP en mémoire).

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

export interface FakeState {
  sessionMode: "session" | "secours";
  validSessions: Set<string>;
  logins: number;
  requests: Recorded[];
  bookings: any[];
  blocks: any[];
  messages: any[];
  nextId: number;
  /** Pour simuler une panne réseau sur une route donnée. */
  dropPaths: Set<string>;
}

export const UNITS = [
  { id: 1, propertyId: 1, slug: "maison-du-scieur", name: "La Maison du Scieur", capacityBase: 11, capacityMax: 11, isComposite: false, active: true, icalToken: "secret" },
  { id: 2, propertyId: 1, slug: "la-scierie", name: "La Scierie", capacityBase: 6, capacityMax: 8, isComposite: false, active: true, icalToken: "secret" },
  { id: 3, propertyId: 1, slug: "domaine-entier", name: "Le Domaine entier", capacityBase: 17, capacityMax: 19, isComposite: true, active: true, icalToken: "secret" },
  { id: 4, propertyId: 2, slug: "le-moulin", name: "Le Moulin", capacityBase: 10, capacityMax: 12, isComposite: false, active: true, icalToken: "secret" },
];
const LINKS = [
  { unitId: 3, blocksUnitId: 1 },
  { unitId: 3, blocksUnitId: 2 },
  { unitId: 1, blocksUnitId: 3 },
  { unitId: 2, blocksUnitId: 3 },
];

export function booking(over: Partial<any>): any {
  return {
    id: 0, reference: "PM-2026-000", unitId: 2, unitName: "La Scierie", propertyId: 1, guestId: 1,
    guestName: "Dupont", guestEmail: "dupont@example.test", checkin: "2026-10-10", checkout: "2026-10-12",
    adults: 4, children: 0, status: "confirmed", holdExpiresAt: null, source: "direct", channelLabel: null,
    totalCents: 60000, depositCents: 30000, paidCents: 30000, balanceDueDate: "2026-10-01", promoCode: null,
    guestNotes: null, internalNotes: null, cancelledAt: null, cancelReason: null, createdAt: "2026-09-01 10:00:00",
    ...over,
  };
}

function overlaps(a1: string, a2: string, b1: string, b2: string): boolean {
  return a1 < b2 && b1 < a2;
}

function blockers(unitId: number): Set<number> {
  return new Set([unitId, ...LINKS.filter((l) => l.blocksUnitId === unitId).map((l) => l.unitId)]);
}

function conflicts(st: FakeState, unitId: number, checkin: string, checkout: string): any[] {
  const bl = blockers(unitId);
  const out: any[] = [];
  for (const b of st.bookings) {
    if (b.status === "cancelled" || !bl.has(b.unitId) || !overlaps(b.checkin, b.checkout, checkin, checkout)) continue;
    out.push({ reference: b.reference, unitName: b.unitName, checkin: b.checkin, checkout: b.checkout, status: b.status, viaLink: b.unitId !== unitId });
  }
  for (const k of st.blocks) {
    if (!bl.has(k.unitId) || !overlaps(k.checkin, k.checkout, checkin, checkout)) continue;
    out.push({ reference: k.reason, unitName: k.unitName, checkin: k.checkin, checkout: k.checkout, status: "blocked", viaLink: k.unitId !== unitId });
  }
  return out;
}

function quote(unitId: number, checkin: string, checkout: string): any {
  const n = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86_400_000);
  const errors = n < 2 ? ["min_nights"] : [];
  const total = n * 15000 + 8000;
  return {
    ok: errors.length === 0, errors, warnings: [], nights: n, minNights: 2, checkinDays: null,
    lines: [{ kind: "accommodation", label: "nuits", amountCents: n * 15000 }],
    accommodationCents: n * 15000, discountCents: 0, cleaningFeeCents: 8000, optionsCents: 0, taxCents: 0,
    totalCents: total, depositCents: total / 2, depositPct: 50, balanceCents: total / 2, balanceDueDate: "2026-11-01",
    cautionCents: 50000, autoDiscountApplied: null, promoApplied: null, unitId,
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : undefined;
}

export async function startFake(init: Partial<FakeState> = {}): Promise<{ url: string; state: FakeState; close: () => Promise<void>; server: Server }> {
  const st: FakeState = {
    sessionMode: "session", validSessions: new Set(), logins: 0, requests: [], bookings: [], blocks: [], messages: [],
    nextId: 100, dropPaths: new Set(), ...init,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    const auth = req.headers.authorization ?? null;
    st.requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (st.dropPaths.has(`${req.method} ${url.pathname}`)) {
      req.socket.destroy();
      return;
    }
    const p = url.pathname;
    const m = req.method;
    if (m === "POST" && p === "/api/admin/login") {
      const b = body as { user?: string; password?: string };
      if (b?.user !== "julien" || b?.password !== "mdp-test") return send(401, { error: "identifiant ou mot de passe incorrect" });
      st.logins++;
      if (st.sessionMode === "secours") return send(200, { ok: true, user: "julien" });
      const s = `S${st.logins}`;
      st.validSessions.add(s);
      return send(200, { ok: true, user: "julien", session: s });
    }
    if (p === "/api/public/health") return send(200, { ok: true, lastCronAt: "2026-10-08 09:55:00", cronAgeMinutes: 5 });
    // garde
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const okAuth = bearer.startsWith("session:") ? st.validSessions.has(bearer.slice(8)) : bearer === "julien:mdp-test";
    if (!okAuth) return send(401, { error: "session expirée ou révoquée" });

    const q = url.searchParams;
    if (m === "GET" && p === "/api/admin/properties") {
      return send(200, { properties: [{ id: 1, slug: "pre-more", name: "Les Gîtes du Pré Moré", active: true }, { id: 2, slug: "moulin-de-braives", name: "Le Moulin de Braives", active: true }] });
    }
    if (m === "GET" && p === "/api/admin/units") {
      const prop = Number(q.get("property") ?? 1);
      return send(200, { units: UNITS.filter((u) => u.propertyId === prop), links: prop === 1 ? LINKS : [] });
    }
    if (m === "GET" && p === "/api/admin/bookings") {
      let list = st.bookings.slice();
      if (q.get("property")) list = list.filter((b) => b.propertyId === Number(q.get("property")));
      if (q.get("status")) list = list.filter((b) => b.status === q.get("status"));
      if (q.get("from")) list = list.filter((b) => b.checkout > q.get("from")!);
      if (q.get("to")) list = list.filter((b) => b.checkin < q.get("to")!);
      if (q.get("search")) {
        const s = q.get("search")!.toLowerCase();
        list = list.filter((b) => b.reference.toLowerCase().includes(s) || String(b.guestName).toLowerCase().includes(s));
      }
      return send(200, { bookings: list.slice(0, Number(q.get("limit") ?? 200)), today: "2026-10-08", period: q.get("period") });
    }
    let mm = p.match(/^\/api\/admin\/bookings\/(\d+)$/);
    if (m === "GET" && mm) {
      const b = st.bookings.find((x) => x.id === Number(mm![1]));
      if (!b) return send(404, { error: "réservation inconnue" });
      return send(200, { booking: b, payments: [], emails: [], history: b.history ?? [], quote: null });
    }
    if (m === "POST" && p === "/api/admin/quote") {
      const b = body as any;
      const unit = UNITS.find((u) => u.id === b.unitId);
      if (!unit) return send(404, { error: "hébergement inconnu" });
      const c = conflicts(st, unit.id, b.checkin, b.checkout);
      return send(200, { unit: { id: unit.id, name: unit.name }, quote: quote(unit.id, b.checkin, b.checkout), availability: { available: c.length === 0, conflicts: c } });
    }
    if (m === "GET" && p === "/api/admin/blocks") {
      const prop = Number(q.get("property") ?? 1);
      return send(200, { blocks: st.blocks.filter((k) => k.propertyId === prop && k.checkout > (q.get("from") ?? "")) });
    }
    if (m === "POST" && p === "/api/admin/blocks") {
      const b = body as any;
      const unit = UNITS.find((u) => u.id === b.unitId)!;
      const c = conflicts(st, unit.id, b.checkin, b.checkout);
      if (c.length) return send(409, { error: "créneau déjà occupé — rien n'a été bloqué", conflicts: c, blocks: [] });
      const k = { id: st.nextId++, unitId: unit.id, unitName: unit.name, propertyId: unit.propertyId, checkin: b.checkin, checkout: b.checkout, reason: b.reason, createdBy: "julien" };
      st.blocks.push(k);
      return send(201, { block: k });
    }
    mm = p.match(/^\/api\/admin\/blocks\/(\d+)$/);
    if (m === "DELETE" && mm) {
      const i = st.blocks.findIndex((k) => k.id === Number(mm![1]));
      if (i < 0) return send(404, { error: "blocage inconnu" });
      st.blocks.splice(i, 1);
      return send(200, { ok: true });
    }
    if (m === "GET" && p === "/api/admin/messages") {
      return send(200, { messages: st.messages.filter((x) => x.direction === "in" && (!q.get("status") || x.status === q.get("status"))) });
    }
    mm = p.match(/^\/api\/admin\/messages\/(\d+)\/thread$/);
    if (m === "GET" && mm) {
      const msg = st.messages.find((x) => x.id === Number(mm![1]));
      if (!msg) return send(404, { error: "message inconnu" });
      return send(200, { message: msg, thread: st.messages.filter((x) => x.bookingId === msg.bookingId) });
    }
    mm = p.match(/^\/api\/admin\/messages\/(\d+)\/reply$/);
    if (m === "POST" && mm) {
      const msg = st.messages.find((x) => x.id === Number(mm![1]));
      if (!msg) return send(404, { error: "message inconnu" });
      msg.status = "traité";
      return send(200, { ok: true, id: st.nextId++, delivery: "stub" });
    }
    mm = p.match(/^\/api\/admin\/bookings\/(\d+)\/messages$/);
    if (m === "POST" && mm) return send(200, { ok: true, id: st.nextId++, delivery: "stub" });
    if (m === "POST" && p === "/api/admin/bookings") {
      const b = body as any;
      const unit = UNITS.find((u) => u.id === b.unitId)!;
      if (conflicts(st, unit.id, b.checkin, b.checkout).length) return send(409, { error: "créneau indisponible (conflit avec une autre réservation)" });
      const qq = quote(unit.id, b.checkin, b.checkout);
      const nb = booking({
        id: st.nextId++, reference: `PM-2026-${st.nextId}`, unitId: unit.id, unitName: unit.name, checkin: b.checkin, checkout: b.checkout,
        guestName: b.guest.lastName, guestEmail: b.guest.email ?? null, status: b.confirmNow ? "confirmed" : "pending",
        totalCents: qq.totalCents, paidCents: 0, adults: b.adults, children: b.children,
      });
      st.bookings.push(nb);
      return send(201, { booking: nb, paymentUrl: b.generatePaymentLink ? "https://pay.example.test/s/1" : null });
    }
    mm = p.match(/^\/api\/admin\/bookings\/(\d+)\/balance-reminder$/);
    if (m === "POST" && mm) {
      const b = st.bookings.find((x) => x.id === Number(mm![1]));
      return send(200, { ok: true, balanceCents: b.totalCents - b.paidCents, payUrl: "https://x/voucher" });
    }
    if (m === "GET" && p === "/api/admin/overview") {
      const prop = Number(q.get("property"));
      return send(200, {
        property: { id: prop, name: prop === 1 ? "Les Gîtes du Pré Moré" : "Le Moulin de Braives" },
        today: "2026-10-08",
        alerts: { overdueBalances: [], linkAlerts: [], feedAlerts: prop === 2 ? [{ id: 1, name: "Airbnb", status: "http 500" }] : [], activeHolds: [], newEmails: st.messages.filter((x) => x.status === "nouveau").length },
        health: {
          orphanPayments: [], overpaidBookings: [], failedEmails: [], recentErrors: [], beds24LastPull: null, beds24StaleHours: null,
          beds24Stale: false, drift: [], ok: prop !== 2,
        },
      });
    }
    return send(404, { error: `route inconnue du faux serveur : ${m} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state: st,
    server,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
