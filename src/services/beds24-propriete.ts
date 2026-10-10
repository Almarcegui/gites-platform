// Création de la propriété Beds24 depuis NOTRE base (10/10/2026).
//
// Contexte : en juillet, la propriété #344555 et ses deux rooms avaient été
// créées à la main par l'API (migration 0010). Le compte d'alors est résilié ;
// le nouveau compte (`gites-premore`) est vide et le mapping en base pointe
// sur des identifiants qui n'existent plus. Ce module refait la création
// depuis le back-office, sans jamais ouvrir Beds24 :
//   - une propriété (nom, adresse, commune, pays, devise, contact) ;
//   - un roomType par hébergement VENDABLE sur les canaux : les unités
//     physiques actives (Scieur, Scierie). Le Domaine entier (unité composite)
//     reste en vente directe : sa liaison est déjà reflétée dans les
//     calendriers des deux rooms que notre moteur pousse (beds24-sync.ts).
//
// Garde-fous :
//   - refus si la propriété mappée en base existe ENCORE dans le compte ;
//   - idempotence : une propriété du compte portant notre nom est retrouvée
//     (et complétée des rooms manquantes) au lieu d'être recréée — un second
//     appel, ou une reprise après une panne entre la création et l'écriture
//     du mapping, ne fabrique pas de doublon ;
//   - le mapping n'est écrit qu'après RELECTURE du compte (les ids viennent de
//     ce que Beds24 montre, pas de la réponse au POST, dont le format est flou
//     dans la doc Beta) ;
//   - verrou court en base contre le double clic (deux POST simultanés
//     créeraient deux propriétés avant que l'un ne voie l'autre).

import { listRateRules, listUnits, getProperty, audit, type PropertyRow, type UnitRow } from "../db/repo";
import { pushedPriceCents } from "../core/price-guardrails";
import { resolvePushMarkup } from "./beds24-sync";
import {
  Beds24Error,
  beds24Fetch,
  beds24ListProperties,
  beds24Status,
  beds24WritesAllowed,
  type Beds24Compte,
  type Beds24PropertySummary,
} from "./beds24";

/** Tous nos domaines sont en Belgique ; la base n'a pas de colonne pays.
 *  Beds24 attend un code ISO à 2 lettres (maxLength 2 dans le schéma). */
const PAYS = "BE";

/** Type de propriété Beds24 : un gîte rural = « cottage » dans l'énumération
 *  de l'API. Modifiable ensuite dans Beds24 sans effet sur la synchro. */
const PROPERTY_TYPE = "cottage";
const ROOM_TYPE = "holidayHome";

export class CreationRefusee extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message);
  }
}

export interface RoomPlan {
  unitId: number;
  name: string;
  qty: 1;
  roomType: string;
  maxPeople: number;
  minStay?: number;
  /** Prix nuit de base (semaine, hors saison), majoration canal comprise —
   *  repli seulement : le push quotidien fixe le vrai prix jour par jour. */
  rackRate?: number;
}

export interface PropertyPlan {
  propertyId: number;
  name: string;
  propertyType: string;
  currency: string;
  address?: string;
  city?: string;
  country: string;
  email?: string;
  phone?: string;
  rooms: RoomPlan[];
  /** Unités actives laissées en vente directe (non créées chez Beds24). */
  directOnly: { unitId: number; name: string; raison: string }[];
}

const clean = (v: string | null | undefined): string | undefined => {
  const t = (v ?? "").trim();
  // Les valeurs de seed « TODO_… » ne doivent pas partir chez un tiers.
  return t && !t.startsWith("TODO") ? t : undefined;
};

export const sameName = (a: string, b: string): boolean =>
  a.normalize("NFC").trim().toLocaleLowerCase("fr") === b.normalize("NFC").trim().toLocaleLowerCase("fr");

function sellable(units: UnitRow[]): UnitRow[] {
  return units.filter((u) => u.active && !u.isComposite);
}

/** Ce qui serait créé chez Beds24 — pur lecture de notre base, aucun réseau. */
export async function buildPropertyPlan(db: D1Database, propertyId: number): Promise<PropertyPlan> {
  const property = await getProperty(db, propertyId);
  if (!property) throw new CreationRefusee("domaine introuvable", 404);
  const [units, rules, markup] = await Promise.all([
    listUnits(db, propertyId),
    listRateRules(db, propertyId),
    resolvePushMarkup(db),
  ]);
  const rooms: RoomPlan[] = sellable(units).map((u) => {
    const base = rules.find((r) => r.unitId === u.id && r.seasonId == null);
    const rack = base && base.priceWeekCents > 0 ? pushedPriceCents(base.priceWeekCents, markup.pct) / 100 : undefined;
    return {
      unitId: u.id,
      name: u.name,
      qty: 1,
      roomType: ROOM_TYPE,
      maxPeople: Math.max(1, u.capacityMax),
      ...(base && base.minNights >= 1 ? { minStay: Math.min(base.minNights, 365) } : {}),
      ...(rack != null ? { rackRate: rack } : {}),
    };
  });
  return {
    propertyId: property.id,
    name: property.name,
    propertyType: PROPERTY_TYPE,
    currency: property.currency || "EUR",
    address: clean(property.address),
    city: clean(property.commune),
    country: PAYS,
    email: clean(property.contactEmail),
    phone: clean(property.contactPhone),
    rooms,
    directOnly: units
      .filter((u) => u.active && u.isComposite)
      .map((u) => ({
        unitId: u.id,
        name: u.name,
        raison: "vente directe uniquement — la liaison ferme les rooms des maisons qui le composent",
      })),
  };
}

export type MappingEtat = "absent" | "actif" | "perime" | "inconnu";

export interface MappingStatus {
  propertyId: number;
  propertyName: string;
  beds24PropertyId: number | null;
  etat: MappingEtat;
  rooms: { unitId: number; unitName: string; beds24RoomId: number | null; etat: MappingEtat }[];
  /** Propriété du compte qui porte notre nom (reprise idempotente). */
  homonyme: { id: number; name: string } | null;
}

function mappingStatus(
  property: PropertyRow,
  units: UnitRow[],
  accountProps: Beds24PropertySummary[] | null,
): MappingStatus {
  const mapped = property.beds24PropertyId;
  const found = accountProps && mapped != null ? accountProps.find((p) => p.id === mapped) ?? null : null;
  const etat: MappingEtat = mapped == null ? "absent" : accountProps == null ? "inconnu" : found ? "actif" : "perime";
  const roomIds = new Set((found?.roomTypes ?? []).map((r) => r.id));
  const homonyme = accountProps?.find((p) => sameName(p.name, property.name)) ?? null;
  return {
    propertyId: property.id,
    propertyName: property.name,
    beds24PropertyId: mapped,
    etat,
    rooms: sellable(units).map((u) => ({
      unitId: u.id,
      unitName: u.name,
      beds24RoomId: u.beds24RoomId,
      etat:
        u.beds24RoomId == null ? "absent" : accountProps == null ? "inconnu" : found && roomIds.has(u.beds24RoomId) ? "actif" : "perime",
    })),
    homonyme: homonyme ? { id: homonyme.id, name: homonyme.name } : null,
  };
}

/** Le jeton a-t-il le droit d'écrire les propriétés ? null = on ne sait pas
 *  (aucun scope remonté). Sert d'avertissement, jamais de blocage : les noms
 *  de scopes ne sont pas listés dans la doc. */
function canWriteProperties(compte: Beds24Compte | undefined): boolean | null {
  if (!compte || compte.scopes.length === 0) return null;
  return compte.scopes.some((s) => /propert/i.test(s) && /^(write|all)/i.test(s));
}

/** Diagnostic complet pour l'écran Canaux : compte relié, propriétés du
 *  compte, état du mapping en base, et si la création est proposée. */
export async function beds24Liaison(env: Env, propertyId: number) {
  const status = await beds24Status(env);
  const property = await getProperty(env.DB, propertyId);
  const units = property ? await listUnits(env.DB, propertyId) : [];
  const mapping = property ? mappingStatus(property, units, status.connected ? status.properties ?? [] : null) : null;
  const ecriturePropriete = canWriteProperties(status.compte);
  return {
    ...status,
    ecritureAutorisee: beds24WritesAllowed(env),
    ecriturePropriete,
    mapping,
    // Le bouton « Créer la propriété » n'a de sens que liaison active ET
    // mapping absent ou périmé (un mapping vivant se pousse, il ne se recrée pas).
    creationPossible: Boolean(status.connected && mapping && (mapping.etat === "absent" || mapping.etat === "perime")),
  };
}

const LOCK_KEY = "beds24_creation_verrou";
const LOCK_TTL_SECONDS = 120;

async function takeLock(db: D1Database): Promise<boolean> {
  // Un verrou plus vieux que le TTL (Worker tué en plein appel) est repris.
  await db
    .prepare(`DELETE FROM app_settings WHERE key = ?1 AND updated_at < datetime('now', ?2)`)
    .bind(LOCK_KEY, `-${LOCK_TTL_SECONDS} seconds`)
    .run();
  const res = await db
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?1, 'creation', datetime('now')) ON CONFLICT(key) DO NOTHING`)
    .bind(LOCK_KEY)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

async function releaseLock(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM app_settings WHERE key = ?1").bind(LOCK_KEY).run();
}

function roomBody(r: RoomPlan): Record<string, unknown> {
  return {
    name: r.name,
    roomType: r.roomType,
    qty: r.qty,
    maxPeople: r.maxPeople,
    ...(r.minStay != null ? { minStay: r.minStay } : {}),
    ...(r.rackRate != null ? { rackRate: r.rackRate } : {}),
  };
}

export interface CreationResult {
  ok: true;
  propriete: { beds24PropertyId: number; name: string; creee: boolean };
  rooms: { unitId: number; name: string; beds24RoomId: number; creee: boolean }[];
  directOnly: PropertyPlan["directOnly"];
  ancienMapping: { beds24PropertyId: number | null; rooms: { unitId: number; beds24RoomId: number | null }[] };
}

/** Crée (ou retrouve) la propriété et ses rooms chez Beds24, puis écrit le
 *  mapping en base. Lève CreationRefusee (garde-fou) ou Beds24Error (refus de
 *  l'API, message en clair). */
export async function createBeds24Property(env: Env, propertyId: number, actor: string): Promise<CreationResult> {
  const db = env.DB;
  if (!beds24WritesAllowed(env)) {
    throw new CreationRefusee(
      "écriture Beds24 bloquée hors production — la création se fait depuis le site en ligne",
      403,
    );
  }
  const plan = await buildPropertyPlan(db, propertyId);
  if (plan.rooms.length === 0) throw new CreationRefusee("aucun hébergement vendable sur les canaux dans ce domaine", 400);
  const property = (await getProperty(db, propertyId))!;
  const units = await listUnits(db, propertyId);

  if (!(await takeLock(db))) throw new CreationRefusee("une création Beds24 est déjà en cours — réessaie dans deux minutes", 409);
  try {
    const before = await beds24ListProperties(env);
    const mapping = mappingStatus(property, units, before);
    if (mapping.etat === "actif") {
      throw new CreationRefusee(
        `la propriété Beds24 #${property.beds24PropertyId} est déjà mappée et existe dans le compte — rien à créer (pousser les calendriers suffit)`,
        409,
        { beds24PropertyId: property.beds24PropertyId },
      );
    }
    const homonymes = before.filter((p) => sameName(p.name, plan.name));
    if (homonymes.length > 1) {
      throw new CreationRefusee(
        `plusieurs propriétés « ${plan.name} » dans le compte Beds24 (#${homonymes.map((p) => p.id).join(", #")}) — en supprimer les doublons dans Beds24 avant de relier`,
        409,
        { ids: homonymes.map((p) => p.id) },
      );
    }
    const existing = homonymes[0] ?? null;
    const missing = plan.rooms.filter((r) => !(existing?.roomTypes ?? []).some((rt) => sameName(rt.name, r.name)));
    const propertyCreated = existing == null;

    if (existing == null) {
      await beds24Fetch(env, "/properties", {
        method: "POST",
        body: [
          {
            name: plan.name,
            propertyType: plan.propertyType,
            currency: plan.currency,
            ...(plan.address ? { address: plan.address } : {}),
            ...(plan.city ? { city: plan.city } : {}),
            country: plan.country,
            ...(plan.email ? { email: plan.email } : {}),
            ...(plan.phone ? { phone: plan.phone } : {}),
            roomTypes: plan.rooms.map(roomBody),
          },
        ],
      });
    } else if (missing.length > 0) {
      await beds24Fetch(env, "/properties", {
        method: "POST",
        body: [{ id: existing.id, roomTypes: missing.map(roomBody) }],
      });
    }

    // Relecture : les ids viennent de ce que le compte montre.
    const after = existing != null && missing.length === 0 ? before : await beds24ListProperties(env);
    const target = after.filter((p) => sameName(p.name, plan.name));
    const prop = target[0];
    if (target.length !== 1 || !prop) {
      throw new Beds24Error(
        target.length === 0
          ? `Beds24 a accepté la création mais la propriété « ${plan.name} » n'apparaît pas à la relecture — vérifier le compte avant de relancer`
          : `plusieurs propriétés « ${plan.name} » à la relecture (#${target.map((p) => p.id).join(", #")}) — mapping non écrit`,
      );
    }
    const rooms = plan.rooms.map((r) => {
      const rt = (prop.roomTypes ?? []).filter((x) => sameName(x.name, r.name));
      const room = rt[0];
      if (rt.length !== 1 || !room) {
        throw new Beds24Error(
          `room « ${r.name} » ${rt.length === 0 ? "absente" : "en double"} dans la propriété Beds24 #${prop.id} à la relecture — mapping non écrit`,
        );
      }
      return { unitId: r.unitId, name: r.name, beds24RoomId: room.id, creee: missing.some((m) => m.unitId === r.unitId) };
    });

    const ancienMapping = {
      beds24PropertyId: property.beds24PropertyId,
      rooms: units.filter((u) => u.beds24RoomId != null).map((u) => ({ unitId: u.id, beds24RoomId: u.beds24RoomId })),
    };
    // Écriture atomique : propriété, rooms des maisons, et effacement de tout
    // ancien room id resté sur une autre unité du domaine (mapping périmé).
    const keep = new Set(rooms.map((r) => r.unitId));
    await db.batch([
      db.prepare("UPDATE properties SET beds24_property_id = ?1 WHERE id = ?2").bind(prop.id, propertyId),
      ...rooms.map((r) => db.prepare("UPDATE units SET beds24_room_id = ?1 WHERE id = ?2").bind(r.beds24RoomId, r.unitId)),
      ...units
        .filter((u) => !keep.has(u.id) && u.beds24RoomId != null)
        .map((u) => db.prepare("UPDATE units SET beds24_room_id = NULL WHERE id = ?1").bind(u.id)),
    ]);
    const result: CreationResult = {
      ok: true,
      propriete: { beds24PropertyId: prop.id, name: prop.name, creee: propertyCreated },
      rooms,
      directOnly: plan.directOnly,
      ancienMapping,
    };
    await audit(db, "admin", "beds24.creer_propriete", `property:${propertyId}`, {
      par: actor,
      propriete: result.propriete,
      rooms: rooms.map((r) => ({ unitId: r.unitId, beds24RoomId: r.beds24RoomId, creee: r.creee })),
      ancienMapping,
    });
    return result;
  } finally {
    await releaseLock(db);
  }
}
