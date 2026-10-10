// Routes du lot 3 du back-office (/admin2/), Réglages › Plateformes :
//  - promotions Airbnb transmises par Beds24 (POST /channels/settings) ;
//  - prix dérivés par canal (priceRules.priceLinking des chambres Beds24),
//    calculés sur les majorations existantes (pricing.channel_markups) ;
//  - avis Airbnb et Booking relevés au cron (migration 0025), lus par la carte
//    « Avis » d'Aujourd'hui.
// Toute écriture vers Beds24 exige BEDS24_WRITE_ENABLED=true : sinon 409 en
// clair, et le réglage reste enregistré ici sans partir.
import { apiError, json, readJson, type Router } from "./router";
import { currentUser, guard } from "./admin";
import { audit, getProperty, listProperties, listUnits } from "../db/repo";
import { getSetting, setSetting } from "../services/settings";
import { Beds24Error, beds24Configured, beds24Fetch, beds24WritesAllowed } from "../services/beds24";
import { triggerBeds24PushAll } from "../services/beds24-sync";
import { CHANNEL_MARKUPS_KEY, PUSH_CHANNEL_KEY, parseChannelMarkups, parsePushChannel, pushMarkupPct } from "../core/price-guardrails";
import {
  AIRBNB_PROMOTIONS_KEY,
  AIRBNB_PROMOTIONS_SENT_KEY,
  EARLY_BIRD_DAYS,
  PRICE_LINKING_KEY,
  airbnbMarkupPct,
  airbnbPreview,
  airbnbSettingsBody,
  derivedLines,
  normalizeAirbnbPromotions,
  parseAirbnbPromotions,
  parsePriceLinking,
  priceLinkingBody,
} from "../core/channel-promotions";
import { REVIEWS_LOW_SCORE, reviewsSummary } from "../services/beds24-reviews";

/** Exemple affiché tant que la personne n'a rien saisi : 7 nuits à 1 400 €. */
const EXAMPLE = { stayCents: 140_000, nights: 7 };

function intOrZero(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Ce qui permet (ou non) d'écrire chez Beds24, dit en clair à l'écran. */
async function writeState(env: Env): Promise<{ configured: boolean; writesAllowed: boolean; reason: string | null }> {
  const configured = await beds24Configured(env);
  const writesAllowed = beds24WritesAllowed(env);
  const reason = !configured
    ? "la liaison Beds24 n'est pas en place (code d'invitation à coller plus haut)"
    : !writesAllowed
      ? "les écritures vers Beds24 sont fermées sur ce serveur (BEDS24_WRITE_ENABLED n'est pas à true) : rien ne part, le réglage est gardé ici"
      : null;
  return { configured, writesAllowed: configured && writesAllowed, reason };
}

/** Propriétés Beds24 reliées et leurs chambres (le Domaine entier n'en a pas). */
async function linkedRooms(db: D1Database, propertyId?: number): Promise<Array<{ propertyId: number; name: string; beds24PropertyId: number; roomIds: number[] }>> {
  const props = propertyId ? [await getProperty(db, propertyId)].filter((p) => p != null) : await listProperties(db);
  const out = [];
  for (const p of props) {
    if (p.beds24PropertyId == null) continue;
    const roomIds = (await listUnits(db, p.id)).filter((u) => u.active && u.beds24RoomId != null).map((u) => u.beds24RoomId as number);
    if (roomIds.length) out.push({ propertyId: p.id, name: p.name, beds24PropertyId: p.beds24PropertyId, roomIds });
  }
  return out;
}

function parseSent(raw: string | null): { at: string; by: string; promotions: unknown } | null {
  try {
    return raw ? (JSON.parse(raw) as { at: string; by: string; promotions: unknown }) : null;
  } catch {
    return null;
  }
}

function beds24Failure(e: unknown): Response {
  if (e instanceof Beds24Error) {
    return apiError(502, e.issue === "inconnu" ? `${e.message} — l'envoi a pu passer en partie : vérifier dans Beds24, puis renvoyer` : e.message, { code: e.issue === "inconnu" ? "beds24_unknown" : "beds24_refused" });
  }
  throw e;
}

async function markupContext(db: D1Database) {
  const markups = parseChannelMarkups(await getSetting(db, CHANNEL_MARKUPS_KEY));
  const pushChannel = parsePushChannel(await getSetting(db, PUSH_CHANNEL_KEY), markups);
  const linking = parsePriceLinking(await getSetting(db, PRICE_LINKING_KEY));
  return { markups, pushChannel, pushPct: pushMarkupPct(markups, pushChannel), linking };
}

/** Pose (ou défait) les prix dérivés sur toutes les chambres reliées. */
export async function sendPriceLinking(env: Env, enabled: boolean): Promise<{ properties: number; rooms: number }> {
  const { markups } = await markupContext(env.DB);
  const lines = derivedLines(markups);
  const linked = await linkedRooms(env.DB);
  for (const l of linked) {
    await beds24Fetch(env, "/properties", { method: "POST", body: priceLinkingBody(l.beds24PropertyId, l.roomIds, lines, enabled) });
  }
  return { properties: linked.length, rooms: linked.reduce((n, l) => n + l.roomIds.length, 0) };
}

export function registerLot3AdminRoutes(router: Router): void {
  // --- promotions Airbnb ----------------------------------------------------------
  async function promotionsState(env: Env, propertyId: number) {
    const { markups, pushPct, linking } = await markupContext(env.DB);
    const promotions = parseAirbnbPromotions(await getSetting(env.DB, `${AIRBNB_PROMOTIONS_KEY}.${propertyId}`));
    const sent = parseSent(await getSetting(env.DB, `${AIRBNB_PROMOTIONS_SENT_KEY}.${propertyId}`));
    const linked = await linkedRooms(env.DB, propertyId);
    const markupPct = airbnbMarkupPct(linking.enabled, markups, pushPct);
    return {
      propertyId,
      promotions,
      earlyBirdDays: EARLY_BIRD_DAYS,
      markupPct,
      markupSource: linking.enabled ? "prix dérivé Airbnb" : pushPct ? "majoration de référence" : "aucune majoration",
      preview: airbnbPreview(EXAMPLE.stayCents, EXAMPLE.nights, markupPct, promotions),
      beds24: { ...(await writeState(env)), linked: linked.length > 0, rooms: linked[0]?.roomIds.length ?? 0 },
      lastSent: sent ? { at: sent.at, by: sent.by } : null,
      // Vrai si Airbnb a reçu exactement ce qui est enregistré ici.
      sentSame: sent != null && JSON.stringify(sent.promotions) === JSON.stringify(promotions),
    };
  }

  router.get("/api/admin/channels/airbnb-promotions", guard(async (_req, env, _p, url) => {
    const propertyId = intOrZero(url.searchParams.get("property"));
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "domaine inconnu (?property=)");
    return json(await promotionsState(env, propertyId));
  }));

  // Aperçu d'une saisie pas encore enregistrée : un séjour donné, les remises saisies.
  router.post("/api/admin/channels/airbnb-promotions/preview", guard(async (_req, env, _p, _url) => {
    const body = await readJson<{ promotions?: unknown; stayCents?: unknown; nights?: unknown }>(_req);
    const p = normalizeAirbnbPromotions(body?.promotions);
    if (!p.ok) return apiError(400, p.message);
    const stayCents = Math.round(Number(body?.stayCents ?? EXAMPLE.stayCents));
    const nights = Math.floor(Number(body?.nights ?? EXAMPLE.nights));
    if (!Number.isFinite(stayCents) || stayCents < 100 || stayCents > 10_000_000) return apiError(400, "montant du séjour : de 1 € à 100 000 €");
    if (!Number.isFinite(nights) || nights < 1 || nights > 365) return apiError(400, "nombre de nuits : de 1 à 365");
    const { markups, pushPct, linking } = await markupContext(env.DB);
    return json(airbnbPreview(stayCents, nights, airbnbMarkupPct(linking.enabled, markups, pushPct), p.value));
  }));

  router.put("/api/admin/channels/airbnb-promotions", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: unknown; promotions?: unknown }>(req);
    const propertyId = intOrZero(body?.propertyId);
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "domaine inconnu");
    const p = normalizeAirbnbPromotions(body?.promotions);
    if (!p.ok) return apiError(400, p.message);
    await setSetting(env.DB, `${AIRBNB_PROMOTIONS_KEY}.${propertyId}`, JSON.stringify(p.value));
    await audit(env.DB, "admin", "channels.airbnb_promotions", `property:${propertyId}`, { ...p.value, par: currentUser(req) });
    return json(await promotionsState(env, propertyId));
  }));

  router.post("/api/admin/channels/airbnb-promotions/send", guard(async (req, env) => {
    const body = await readJson<{ propertyId?: unknown }>(req);
    const propertyId = intOrZero(body?.propertyId);
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "domaine inconnu");
    const w = await writeState(env);
    if (!w.writesAllowed) return apiError(409, `rien n'est parti : ${w.reason}`, { code: "beds24_writes_closed" });
    const linked = await linkedRooms(env.DB, propertyId);
    if (!linked[0]) return apiError(409, "ce domaine n'est relié à aucune annonce Beds24", { code: "beds24_not_linked" });
    const promotions = parseAirbnbPromotions(await getSetting(env.DB, `${AIRBNB_PROMOTIONS_KEY}.${propertyId}`));
    try {
      await beds24Fetch(env, "/channels/settings", { method: "POST", body: airbnbSettingsBody(linked[0].beds24PropertyId, linked[0].roomIds, promotions) });
    } catch (e) {
      await audit(env.DB, "admin", "beds24.airbnb_promotions_failed", `property:${propertyId}`, { error: e instanceof Error ? e.message : String(e), par: currentUser(req) });
      return beds24Failure(e);
    }
    await setSetting(env.DB, `${AIRBNB_PROMOTIONS_SENT_KEY}.${propertyId}`, JSON.stringify({ at: new Date().toISOString(), by: currentUser(req), promotions }));
    await audit(env.DB, "admin", "beds24.airbnb_promotions", `property:${propertyId}`, { ...promotions, rooms: linked[0].roomIds, par: currentUser(req) });
    return json(await promotionsState(env, propertyId));
  }));

  // --- prix dérivés par canal -------------------------------------------------------
  async function linkingState(env: Env) {
    const { markups, pushChannel, pushPct, linking } = await markupContext(env.DB);
    const lines = derivedLines(markups);
    const current = Object.fromEntries(lines.map((l) => [l.channel, l.markupPct]));
    const example = 10_000; // une nuit à 100 €
    return {
      enabled: linking.enabled,
      lines: lines.map((l) => ({ ...l, exampleCents: Math.round(example * l.multiplier) })),
      // Majorations sans équivalent chez Beds24 : affichées, jamais envoyées.
      unlinked: markups.filter((m) => !lines.some((l) => l.channel === m.channel)).map((m) => m.label),
      exampleDirectCents: example,
      // Avec les prix dérivés, la majoration « de référence » n'est plus appliquée au calendrier.
      pushChannel,
      pushPct,
      upToDate: linking.enabled && JSON.stringify(linking.sentMarkups) === JSON.stringify(current),
      sentAt: linking.sentAt,
      beds24: { ...(await writeState(env)), linked: (await linkedRooms(env.DB)).length },
    };
  }

  router.get("/api/admin/channels/price-linking", guard(async (_req, env) => json(await linkingState(env))));

  router.post("/api/admin/channels/price-linking", guard(async (req, env, _p, _url, execCtx) => {
    const body = await readJson<{ enabled?: unknown }>(req);
    if (typeof body?.enabled !== "boolean") return apiError(400, "enabled (vrai ou faux) attendu");
    const w = await writeState(env);
    if (!w.writesAllowed) return apiError(409, `rien n'est parti : ${w.reason}`, { code: "beds24_writes_closed" });
    if ((await linkedRooms(env.DB)).length === 0) return apiError(409, "aucune annonce Beds24 reliée", { code: "beds24_not_linked" });
    const { markups } = await markupContext(env.DB);
    let sent;
    try {
      // Les règles d'abord, le calendrier ensuite : jamais un prix direct
      // envoyé sans la ligne qui le majore chez la plateforme.
      sent = await sendPriceLinking(env, body.enabled);
    } catch (e) {
      await audit(env.DB, "admin", "beds24.price_linking_failed", "app", { enabled: body.enabled, error: e instanceof Error ? e.message : String(e), par: currentUser(req) });
      return beds24Failure(e);
    }
    const lines = derivedLines(markups);
    await setSetting(env.DB, PRICE_LINKING_KEY, JSON.stringify({
      enabled: body.enabled,
      sentMarkups: body.enabled ? Object.fromEntries(lines.map((l) => [l.channel, l.markupPct])) : null,
      sentAt: new Date().toISOString(),
    }));
    await audit(env.DB, "admin", "beds24.price_linking", "app", { enabled: body.enabled, ...sent, lines: lines.map((l) => `${l.beds24Channel}×${l.multiplier}`), par: currentUser(req) });
    // Le prix du calendrier change (direct ↔ majoré) : renvoi immédiat.
    await triggerBeds24PushAll(env.DB, env, execCtx);
    return json(await linkingState(env));
  }));

  // --- avis (relevés au cron) --------------------------------------------------------
  router.get("/api/admin/reviews", guard(async (_req, env, _p, url) => {
    const propertyId = intOrZero(url.searchParams.get("property")) || null;
    return json({ ...(await reviewsSummary(env.DB, propertyId)), lowScore: REVIEWS_LOW_SCORE });
  }));
}
