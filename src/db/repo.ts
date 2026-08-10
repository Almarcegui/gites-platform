// Couche d'accès D1 — toutes les requêtes SQL du projet vivent ici.
//
// GARANTIE ANTI-SURBOOKING : createBookingAtomic vérifie la disponibilité
// (liaisons unit_links comprises) et insère la réservation dans UNE SEULE
// instruction SQL (INSERT … SELECT … WHERE NOT EXISTS). SQLite exécute chaque
// instruction atomiquement et D1 sérialise les écritures : deux réservations
// simultanées sur des unités en conflit ne peuvent jamais passer toutes les
// deux. Ce comportement est prouvé par test/booking-db.test.ts (courses).

import { isIsoDate, sqlNow, todayInZone, type IsoDate } from "../core/dates";
import type { UnitLink } from "../core/availability";
import type { OptionDef, Promotion, RateOverride, RateRule, Season, UnitPricingInfo } from "../core/pricing";

type Raw = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string => String(v ?? "");
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

// ---------------------------------------------------------------------------
// Domaines & unités
// ---------------------------------------------------------------------------

export interface PropertyRow {
  id: number;
  slug: string;
  name: string;
  refPrefix: string;
  address: string | null;
  commune: string | null;
  timezone: string;
  currency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  active: boolean;
  beds24PropertyId: number | null;
}

function mapProperty(r: Raw): PropertyRow {
  return {
    id: num(r.id), slug: str(r.slug), name: str(r.name), refPrefix: str(r.ref_prefix),
    address: strOrNull(r.address), commune: strOrNull(r.commune),
    timezone: str(r.timezone), currency: str(r.currency),
    contactEmail: strOrNull(r.contact_email), contactPhone: strOrNull(r.contact_phone),
    active: num(r.active) === 1,
    beds24PropertyId: r.beds24_property_id == null ? null : num(r.beds24_property_id),
  };
}

export async function listProperties(db: D1Database): Promise<PropertyRow[]> {
  const { results } = await db.prepare("SELECT * FROM properties WHERE active = 1 ORDER BY id").all();
  return (results as Raw[]).map(mapProperty);
}

export async function getProperty(db: D1Database, idOrSlug: number | string): Promise<PropertyRow | null> {
  const row = await db
    .prepare("SELECT * FROM properties WHERE id = ?1 OR slug = ?2")
    .bind(typeof idOrSlug === "number" ? idOrSlug : -1, String(idOrSlug))
    .first();
  return row ? mapProperty(row as Raw) : null;
}

export interface UnitRow {
  id: number;
  propertyId: number;
  slug: string;
  name: string;
  description: string | null;
  capacityBase: number;
  capacityMax: number;
  isComposite: boolean;
  compositePricing: "own" | "sum";
  active: boolean;
  sortOrder: number;
  icalToken: string;
  cleaningFeeCents: number;
  photoUrl: string | null;
  beds24RoomId: number | null;
  /** garde-fous de prix par nuit (issue #31) — null = aucune borne configurée */
  priceMinCents: number | null;
  priceMaxCents: number | null;
}

function mapUnit(r: Raw): UnitRow {
  return {
    id: num(r.id), propertyId: num(r.property_id), slug: str(r.slug), name: str(r.name),
    description: strOrNull(r.description),
    capacityBase: num(r.capacity_base), capacityMax: num(r.capacity_max),
    isComposite: num(r.is_composite) === 1,
    compositePricing: str(r.composite_pricing) === "sum" ? "sum" : "own",
    active: num(r.active) === 1, sortOrder: num(r.sort_order), icalToken: str(r.ical_token),
    cleaningFeeCents: num(r.cleaning_fee_cents), photoUrl: strOrNull(r.photo_url),
    beds24RoomId: r.beds24_room_id == null ? null : num(r.beds24_room_id),
    priceMinCents: numOrNull(r.price_min_cents),
    priceMaxCents: numOrNull(r.price_max_cents),
  };
}

export async function listUnits(db: D1Database, propertyId?: number): Promise<UnitRow[]> {
  const stmt = propertyId
    ? db.prepare("SELECT * FROM units WHERE property_id = ?1 ORDER BY sort_order, id").bind(propertyId)
    : db.prepare("SELECT * FROM units ORDER BY property_id, sort_order, id");
  const { results } = await stmt.all();
  return (results as Raw[]).map(mapUnit);
}

export async function getUnit(db: D1Database, unitId: number): Promise<UnitRow | null> {
  const row = await db.prepare("SELECT * FROM units WHERE id = ?1").bind(unitId).first();
  return row ? mapUnit(row as Raw) : null;
}

export async function getUnitByIcalToken(db: D1Database, token: string): Promise<UnitRow | null> {
  const row = await db.prepare("SELECT * FROM units WHERE ical_token = ?1").bind(token).first();
  return row ? mapUnit(row as Raw) : null;
}

export async function updateUnit(
  db: D1Database,
  unitId: number,
  fields: Partial<
    Pick<
      UnitRow,
      | "name" | "description" | "capacityBase" | "capacityMax" | "active" | "compositePricing"
      | "cleaningFeeCents" | "photoUrl" | "priceMinCents" | "priceMaxCents"
    >
  >,
): Promise<void> {
  // Les garde-fous de prix se RETIRENT (retour à null) autant qu'ils se posent :
  // COALESCE ne suffit pas, d'où le drapeau « clé fournie » de ?10 et ?12.
  await db
    .prepare(
      `UPDATE units SET
         name = COALESCE(?2, name),
         description = COALESCE(?3, description),
         capacity_base = COALESCE(?4, capacity_base),
         capacity_max = COALESCE(?5, capacity_max),
         active = COALESCE(?6, active),
         composite_pricing = COALESCE(?7, composite_pricing),
         cleaning_fee_cents = COALESCE(?8, cleaning_fee_cents),
         photo_url = COALESCE(?9, photo_url),
         price_min_cents = CASE WHEN ?10 = 1 THEN ?11 ELSE price_min_cents END,
         price_max_cents = CASE WHEN ?12 = 1 THEN ?13 ELSE price_max_cents END
       WHERE id = ?1`,
    )
    .bind(
      unitId,
      fields.name ?? null,
      fields.description ?? null,
      fields.capacityBase ?? null,
      fields.capacityMax ?? null,
      fields.active === undefined ? null : fields.active ? 1 : 0,
      fields.compositePricing ?? null,
      fields.cleaningFeeCents ?? null,
      fields.photoUrl ?? null,
      fields.priceMinCents === undefined ? 0 : 1,
      fields.priceMinCents ?? null,
      fields.priceMaxCents === undefined ? 0 : 1,
      fields.priceMaxCents ?? null,
    )
    .run();
}

/** Crée un nouvel hébergement (maison C, futur gîte…). Le token iCal est
 *  généré aléatoirement ; les liaisons se posent ensuite via setMutualLinks. */
export async function createUnit(
  db: D1Database,
  u: {
    propertyId: number;
    name: string;
    description?: string | null;
    capacityBase: number;
    capacityMax: number;
    isComposite?: boolean;
    compositePricing?: "own" | "sum";
    cleaningFeeCents?: number;
    photoUrl?: string | null;
    sortOrder?: number;
  },
): Promise<number> {
  const slug = u.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `unite-${Date.now()}`;
  const token = crypto.randomUUID().replace(/-/g, "");
  const res = await db
    .prepare(
      `INSERT INTO units (property_id, slug, name, description, capacity_base, capacity_max,
                          is_composite, composite_pricing, sort_order, ical_token, cleaning_fee_cents, photo_url)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      u.propertyId, slug, u.name, u.description ?? null, u.capacityBase, u.capacityMax,
      u.isComposite ? 1 : 0, u.compositePricing ?? "own", u.sortOrder ?? 99, token,
      u.cleaningFeeCents ?? 0, u.photoUrl ?? null,
    )
    .run();
  return res.meta.last_row_id;
}

/** Redéfinit les liaisons MUTUELLES d'une unité : toute résa de l'une bloque
 *  l'autre, dans les deux sens. Remplace l'existant pour cette unité. */
export async function setMutualLinks(db: D1Database, unitId: number, partnerIds: number[]): Promise<void> {
  const partners = [...new Set(partnerIds.filter((p) => p !== unitId && p > 0))];
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM unit_links WHERE unit_id = ?1 OR blocks_unit_id = ?1").bind(unitId),
  ];
  for (const p of partners) {
    stmts.push(db.prepare("INSERT INTO unit_links (unit_id, blocks_unit_id) VALUES (?1, ?2)").bind(unitId, p));
    stmts.push(db.prepare("INSERT INTO unit_links (unit_id, blocks_unit_id) VALUES (?1, ?2)").bind(p, unitId));
  }
  await db.batch(stmts);
}

/** Liens de blocage. Les liens sont toujours intra-domaine. */
export async function listLinks(db: D1Database, propertyId?: number): Promise<UnitLink[]> {
  const stmt = propertyId
    ? db
        .prepare(
          "SELECT ul.unit_id, ul.blocks_unit_id FROM unit_links ul JOIN units u ON u.id = ul.unit_id WHERE u.property_id = ?1",
        )
        .bind(propertyId)
    : db.prepare("SELECT unit_id, blocks_unit_id FROM unit_links");
  const { results } = await stmt.all();
  return (results as Raw[]).map((r) => ({ unitId: num(r.unit_id), blocksUnitId: num(r.blocks_unit_id) }));
}

// ---------------------------------------------------------------------------
// Paramètres par domaine
// ---------------------------------------------------------------------------

export interface PropertySettings {
  depositPct: number;
  balanceDueDays: number;
  holdMinutes: number;
  touristTaxCentsPerPersonNight: number;
  touristTaxIncludeChildren: boolean;
  cautionCents: number;
  checkinTime: string;
  checkoutTime: string;
  cgvText: string;
  allowDeposit: boolean;
  allowFullPayment: boolean;
  autoReplyEnabled: boolean;
  autoReplyText: string;
  emailForwardTo: string;
}

const SETTINGS_DEFAULTS: PropertySettings = {
  depositPct: 30,
  balanceDueDays: 30,
  holdMinutes: 30,
  touristTaxCentsPerPersonNight: 0,
  touristTaxIncludeChildren: true,
  cautionCents: 0,
  checkinTime: "16:00",
  checkoutTime: "10:00",
  cgvText: "",
  allowDeposit: true,
  allowFullPayment: true,
  autoReplyEnabled: false,
  autoReplyText: "",
  emailForwardTo: "",
};

export async function getSettings(db: D1Database, propertyId: number): Promise<PropertySettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE property_id = ?1")
    .bind(propertyId)
    .all();
  const kv = new Map((results as Raw[]).map((r) => [str(r.key), str(r.value)]));
  const bool = (k: string, d: boolean) => (kv.has(k) ? kv.get(k) === "true" : d);
  const int = (k: string, d: number) => (kv.has(k) ? Number(kv.get(k)) : d);
  const text = (k: string, d: string) => kv.get(k) ?? d;
  const D = SETTINGS_DEFAULTS;
  return {
    depositPct: int("deposit_pct", D.depositPct),
    balanceDueDays: int("balance_due_days", D.balanceDueDays),
    holdMinutes: int("hold_minutes", D.holdMinutes),
    touristTaxCentsPerPersonNight: int("tourist_tax_cents_per_person_night", D.touristTaxCentsPerPersonNight),
    touristTaxIncludeChildren: bool("tourist_tax_include_children", D.touristTaxIncludeChildren),
    cautionCents: int("caution_cents", D.cautionCents),
    checkinTime: text("checkin_time", D.checkinTime),
    checkoutTime: text("checkout_time", D.checkoutTime),
    cgvText: text("cgv_text", D.cgvText),
    allowDeposit: bool("allow_deposit", D.allowDeposit),
    allowFullPayment: bool("allow_full_payment", D.allowFullPayment),
    autoReplyEnabled: bool("auto_reply_enabled", D.autoReplyEnabled),
    autoReplyText: text("auto_reply_text", D.autoReplyText),
    emailForwardTo: text("email_forward_to", D.emailForwardTo),
  };
}

export async function updateSettings(db: D1Database, propertyId: number, entries: Record<string, string>): Promise<void> {
  const stmts = Object.entries(entries).map(([key, value]) =>
    db.prepare("INSERT OR REPLACE INTO settings (property_id, key, value) VALUES (?1, ?2, ?3)").bind(propertyId, key, value),
  );
  if (stmts.length > 0) await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// Contexte de tarification (tout ce qu'il faut pour computeQuote)
// ---------------------------------------------------------------------------

function mapSeason(r: Raw): Season {
  return { id: num(r.id), name: str(r.name), dateStart: str(r.date_start), dateEnd: str(r.date_end), priority: num(r.priority) };
}

function mapRateRule(r: Raw): RateRule {
  const days = strOrNull(r.checkin_days);
  return {
    id: num(r.id), unitId: num(r.unit_id), seasonId: numOrNull(r.season_id),
    priceWeekCents: num(r.price_week_cents), priceWeekendCents: num(r.price_weekend_cents),
    holidayPct: num(r.holiday_pct), minNights: num(r.min_nights),
    checkinDays: days ? days.split(",").map((d) => Number(d.trim())).filter((d) => !Number.isNaN(d)) : null,
  };
}

function mapPromotion(r: Raw): Promotion {
  return {
    id: num(r.id), kind: str(r.kind) as Promotion["kind"], code: strOrNull(r.code), label: str(r.label),
    discountPct: numOrNull(r.discount_pct), discountCents: numOrNull(r.discount_cents),
    threshold: numOrNull(r.threshold), validFrom: strOrNull(r.valid_from), validUntil: strOrNull(r.valid_until),
    maxUses: numOrNull(r.max_uses), uses: num(r.uses), active: num(r.active) === 1,
  };
}

function mapOption(r: Raw): OptionDef & { active: boolean; sortOrder: number; propertyId: number } {
  return {
    id: num(r.id), name: str(r.name), pricingMode: str(r.pricing_mode) as OptionDef["pricingMode"],
    priceCents: num(r.price_cents), maxQty: numOrNull(r.max_qty), unitLabel: strOrNull(r.unit_label),
    active: num(r.active) === 1, sortOrder: num(r.sort_order), propertyId: num(r.property_id),
  };
}

export interface QuoteContext {
  property: PropertyRow;
  unit: UnitRow;
  pricingUnit: UnitPricingInfo;
  seasons: Season[];
  rateRules: RateRule[];
  /** surcharges par jour de l'unité et de ses composantes, sur la fenêtre
   *  demandée (toutes, si aucune fenêtre n'est passée) */
  rateOverrides: RateOverride[];
  promotions: Promotion[];
  options: (OptionDef & { active: boolean })[];
  settings: PropertySettings;
}

/** Contexte complet de tarification d'une unité.
 *
 *  `window` borne le chargement des surcharges à la période utile (le séjour
 *  pour un devis, la plage affichée pour un calendrier). Sans fenêtre, TOUTES
 *  les surcharges de l'unité sont chargées — pratique pour les tests, à éviter
 *  sur un chemin chaud. */
export async function getQuoteContext(
  db: D1Database,
  unitId: number,
  window?: { from: IsoDate; toExclusive: IsoDate },
): Promise<QuoteContext | null> {
  const unit = await getUnit(db, unitId);
  if (!unit) return null;
  const property = await getProperty(db, unit.propertyId);
  if (!property) return null;

  // Composantes d'une unité composite = unités physiques qu'elle bloque.
  const { results: compRows } = await db
    .prepare(
      `SELECT u.id, u.name, u.cleaning_fee_cents FROM unit_links ul
         JOIN units u ON u.id = ul.blocks_unit_id
        WHERE ul.unit_id = ?1 AND u.is_composite = 0
        ORDER BY u.sort_order, u.id`,
    )
    .bind(unitId)
    .all();
  const components = (compRows as Raw[]).map((r) => ({
    id: num(r.id),
    name: str(r.name),
    cleaningFeeCents: num(r.cleaning_fee_cents),
  }));

  const unitIds = [unitId, ...components.map((c) => c.id)];
  const placeholders = unitIds.map((_, i) => `?${i + 1}`).join(", ");
  const { results: ruleRows } = await db
    .prepare(`SELECT * FROM rate_rules WHERE unit_id IN (${placeholders})`)
    .bind(...unitIds)
    .all();

  const [{ results: seasonRows }, { results: promoRows }, { results: optionRows }, settings, rateOverrides] =
    await Promise.all([
      db.prepare("SELECT * FROM seasons WHERE property_id = ?1").bind(unit.propertyId).all(),
      db.prepare("SELECT * FROM promotions WHERE property_id = ?1").bind(unit.propertyId).all(),
      db.prepare("SELECT * FROM options WHERE property_id = ?1 AND active = 1 ORDER BY sort_order, id").bind(unit.propertyId).all(),
      getSettings(db, unit.propertyId),
      window
        ? listRateOverrides(db, unitIds, window.from, window.toExclusive)
        : listRateOverrides(db, unitIds, "0000-01-01", "9999-12-31"),
    ]);

  return {
    property,
    unit,
    pricingUnit: {
      id: unit.id,
      name: unit.name,
      compositePricing: unit.isComposite ? unit.compositePricing : "own",
      cleaningFeeCents: unit.cleaningFeeCents,
      components: unit.isComposite ? components : [],
    },
    seasons: (seasonRows as Raw[]).map(mapSeason),
    rateRules: (ruleRows as Raw[]).map(mapRateRule),
    rateOverrides,
    promotions: (promoRows as Raw[]).map(mapPromotion),
    options: (optionRows as Raw[]).map(mapOption),
    settings,
  };
}

// ---------------------------------------------------------------------------
// Réservations
// ---------------------------------------------------------------------------

export interface BookingRow {
  id: number;
  reference: string;
  unitId: number;
  unitName?: string;
  propertyId?: number;
  guestId: number | null;
  guestName?: string | null;
  guestEmail?: string | null;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  status: "pending" | "confirmed" | "cancelled";
  holdExpiresAt: string | null;
  source: "direct" | "manual" | "ical" | "import";
  channelLabel: string | null;
  externalUid: string | null;
  totalCents: number;
  depositCents: number;
  paidCents: number;
  balanceDueDate: IsoDate | null;
  currency: string;
  quoteJson: string | null;
  optionsJson: string | null;
  promoCode: string | null;
  guestNotes: string | null;
  internalNotes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapBooking(r: Raw): BookingRow {
  return {
    id: num(r.id), reference: str(r.reference), unitId: num(r.unit_id),
    unitName: strOrNull(r.unit_name) ?? undefined,
    propertyId: r.property_id == null ? undefined : num(r.property_id),
    guestId: numOrNull(r.guest_id),
    guestName: strOrNull(r.guest_name),
    guestEmail: strOrNull(r.guest_email),
    checkin: str(r.checkin), checkout: str(r.checkout),
    adults: num(r.adults), children: num(r.children),
    status: str(r.status) as BookingRow["status"],
    holdExpiresAt: strOrNull(r.hold_expires_at),
    source: str(r.source) as BookingRow["source"],
    channelLabel: strOrNull(r.channel_label), externalUid: strOrNull(r.external_uid),
    totalCents: num(r.total_cents), depositCents: num(r.deposit_cents), paidCents: num(r.paid_cents),
    balanceDueDate: strOrNull(r.balance_due_date), currency: str(r.currency),
    quoteJson: strOrNull(r.quote_json), optionsJson: strOrNull(r.options_json),
    promoCode: strOrNull(r.promo_code), guestNotes: strOrNull(r.guest_notes), internalNotes: strOrNull(r.internal_notes),
    cancelledAt: strOrNull(r.cancelled_at), cancelReason: strOrNull(r.cancel_reason),
    createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

const BOOKING_JOIN = `
  SELECT b.*, u.name AS unit_name, u.property_id AS property_id,
         TRIM(COALESCE(g.first_name, '') || ' ' || g.last_name) AS guest_name,
         g.email AS guest_email
    FROM bookings b
    JOIN units u ON u.id = b.unit_id
    LEFT JOIN guests g ON g.id = b.guest_id`;

export interface CreateBookingInput {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  status: "pending" | "confirmed";
  holdMinutes?: number;
  source: "direct" | "manual" | "ical" | "import";
  channelLabel?: string | null;
  externalUid?: string | null;
  guestId?: number | null;
  totalCents?: number;
  depositCents?: number;
  balanceDueDate?: IsoDate | null;
  quoteJson?: string | null;
  optionsJson?: string | null;
  promoCode?: string | null;
  guestNotes?: string | null;
  internalNotes?: string | null;
  /** injectable pour les tests (référence, hold, fenêtre de conflit) */
  now?: Date;
}

export type CreateBookingResult =
  | { ok: true; id: number; reference: string }
  | { ok: false; reason: "conflict" };

/** LA requête critique : vérifie la disponibilité (liaisons comprises) et
 *  insère dans une seule instruction atomique. meta.changes === 0 ⇒ conflit. */
export async function createBookingAtomic(db: D1Database, input: CreateBookingInput): Promise<CreateBookingResult> {
  if (!isIsoDate(input.checkin) || !isIsoDate(input.checkout) || input.checkin >= input.checkout) {
    throw new Error(`createBookingAtomic: dates invalides ${input.checkin} → ${input.checkout}`);
  }
  const nowDate = input.now ?? new Date();
  const now = sqlNow(nowDate);
  const year = todayInZone(nowDate).slice(0, 4);
  const holdExpiresAt =
    input.status === "pending"
      ? sqlNow(new Date(nowDate.getTime() + (input.holdMinutes ?? 30) * 60_000))
      : null;

  const res = await db
    .prepare(
      `INSERT INTO bookings (reference, unit_id, guest_id, checkin, checkout, adults, children,
                             status, hold_expires_at, source, channel_label, external_uid,
                             total_cents, deposit_cents, balance_due_date, quote_json, options_json,
                             promo_code, guest_notes, internal_notes, created_at, updated_at)
       SELECT
         (SELECT p.ref_prefix FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?1)
           || '-' || ?2 || '-'
           || printf('%03d', 1 + (
                SELECT COUNT(*) FROM bookings b
                 WHERE b.reference LIKE
                   (SELECT p2.ref_prefix FROM units u2 JOIN properties p2 ON p2.id = u2.property_id WHERE u2.id = ?1)
                   || '-' || ?2 || '-%'
              )),
         ?1, ?6, ?3, ?4, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?5, ?5
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.checkin < ?4
            AND b.checkout > ?3
            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
            AND b.unit_id IN (
              SELECT ?1
              UNION ALL
              SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
            )
       )`,
    )
    .bind(
      input.unitId,                    // ?1
      year,                            // ?2
      input.checkin,                   // ?3
      input.checkout,                  // ?4
      now,                             // ?5
      input.guestId ?? null,           // ?6
      input.adults,                    // ?7
      input.children,                  // ?8
      input.status,                    // ?9
      holdExpiresAt,                   // ?10
      input.source,                    // ?11
      input.channelLabel ?? null,      // ?12
      input.externalUid ?? null,       // ?13
      input.totalCents ?? 0,           // ?14
      input.depositCents ?? 0,         // ?15
      input.balanceDueDate ?? null,    // ?16
      input.quoteJson ?? null,         // ?17
      input.optionsJson ?? null,       // ?18
      input.promoCode ?? null,         // ?19
      input.guestNotes ?? null,        // ?20
      input.internalNotes ?? null,     // ?21
    )
    .run();

  if (res.meta.changes !== 1) return { ok: false, reason: "conflict" };
  const id = res.meta.last_row_id;
  const row = await db.prepare("SELECT reference FROM bookings WHERE id = ?1").bind(id).first<{ reference: string }>();
  return { ok: true, id, reference: row?.reference ?? "" };
}

export async function getBooking(db: D1Database, id: number): Promise<BookingRow | null> {
  const row = await db.prepare(`${BOOKING_JOIN} WHERE b.id = ?1`).bind(id).first();
  return row ? mapBooking(row as Raw) : null;
}

export async function getBookingByReference(db: D1Database, reference: string): Promise<BookingRow | null> {
  const row = await db.prepare(`${BOOKING_JOIN} WHERE b.reference = ?1`).bind(reference).first();
  return row ? mapBooking(row as Raw) : null;
}

export interface BookingFilters {
  propertyId?: number;
  status?: string;
  from?: IsoDate;   // checkout > from
  to?: IsoDate;     // checkin < to
  search?: string;  // référence ou nom client
  limit?: number;
}

export async function listBookings(db: D1Database, f: BookingFilters = {}): Promise<BookingRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    binds.push(value);
    where.push(clause.replace("?", `?${binds.length}`));
  };
  if (f.propertyId) push("u.property_id = ?", f.propertyId);
  if (f.status) push("b.status = ?", f.status);
  if (f.from) push("b.checkout > ?", f.from);
  if (f.to) push("b.checkin < ?", f.to);
  if (f.search) {
    binds.push(`%${f.search}%`);
    const i = binds.length;
    where.push(`(b.reference LIKE ?${i} OR g.last_name LIKE ?${i} OR g.first_name LIKE ?${i} OR g.email LIKE ?${i})`);
  }
  const sql = `${BOOKING_JOIN}${where.length ? " WHERE " + where.join(" AND ") : ""}
    ORDER BY b.created_at DESC, b.id DESC LIMIT ${Math.min(f.limit ?? 200, 1000)}`;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as Raw[]).map(mapBooking);
}

/** Résas non annulées qui intersectent une fenêtre (planning, stats, iCal). */
export async function bookingsInWindow(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  to: IsoDate,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `${BOOKING_JOIN}
        WHERE u.property_id = ?1 AND b.status != 'cancelled' AND b.checkin < ?3 AND b.checkout > ?2
        ORDER BY b.checkin`,
    )
    .bind(propertyId, from, to)
    .all();
  return (results as Raw[]).map(mapBooking);
}

export interface DirectBookingPressure {
  /** Options de paiement encore vivantes (le créneau est gelé pour ce visiteur). */
  activeHolds: number;
  /** Réservations directes lancées sur la dernière heure. */
  lastHour: number;
}

/** Pression de réservation directe d'une même identité — email OU IP appelante.
 *
 *  Le hold est posé AVANT tout paiement : sans plafond, une boucle sur les
 *  combinaisons hébergement × dates gèle tout le calendrier de vente directe
 *  (issue #6). L'IP vient de `cgv_ip`, déjà renseignée à chaque réservation
 *  publique (preuve d'acceptation des CGV) — aucune colonne nouvelle.
 *
 *  Les deux critères sont en OU : changer d'email ne suffit pas à repartir de
 *  zéro, et une IP partagée (NAT, wifi public) ne pénalise pas un visiteur qui
 *  réserve pour la première fois tant qu'il reste sous le plafond. */
export async function countDirectBookingPressure(
  db: D1Database,
  p: { email: string; ip: string | null; now?: Date },
): Promise<DirectBookingPressure> {
  const nowDate = p.now ?? new Date();
  const now = sqlNow(nowDate);
  const hourAgo = sqlNow(new Date(nowDate.getTime() - 60 * 60_000));
  const email = p.email.trim().toLowerCase();
  const ip = p.ip?.trim() || null;
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
           WHERE b.source = 'direct' AND b.status = 'pending' AND b.hold_expires_at > ?1
             AND (lower(g.email) = ?2 OR (?3 IS NOT NULL AND b.cgv_ip = ?3))) AS active_holds,
         (SELECT COUNT(*) FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
           WHERE b.source = 'direct' AND b.created_at > ?4
             AND (lower(g.email) = ?2 OR (?3 IS NOT NULL AND b.cgv_ip = ?3))) AS last_hour`,
    )
    .bind(now, email, ip, hourAgo)
    .first<{ active_holds: number; last_hour: number }>();
  return { activeHolds: num(row?.active_holds ?? 0), lastHour: num(row?.last_hour ?? 0) };
}

export type ConfirmResult = "confirmed" | "conflict" | "not_pending";

/** Confirme un hold en réservation ferme, avec LE MÊME garde-fou atomique que
 *  la création et le déplacement (en s'excluant elle-même du test de conflit).
 *
 *  Pourquoi la garde est indispensable (audit ECC 2026-07-30) : un hold expiré
 *  rouvre le créneau immédiatement, et Stripe retente une livraison de webhook
 *  pendant jusqu'à 3 jours. Sans revérification, un webhook tardif confirmait
 *  une réservation dont les dates avaient été reprises entre-temps — deux
 *  séjours confirmés sur le même créneau, sans aucune alerte.
 *
 *  'conflict' ⇒ le créneau a été pris pendant le paiement : ne rien confirmer,
 *  alerter un humain (remboursement ou relogement dans l'heure). */
export async function confirmBookingAtomic(db: D1Database, id: number, now: string = sqlNow()): Promise<ConfirmResult> {
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = ?2
        WHERE id = ?1
          AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?1
               AND b.checkin < (SELECT checkout FROM bookings WHERE id = ?1)
               AND b.checkout > (SELECT checkin FROM bookings WHERE id = ?1)
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?2))
               AND b.unit_id IN (
                 SELECT unit_id FROM bookings WHERE id = ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul
                  WHERE ul.blocks_unit_id = (SELECT unit_id FROM bookings WHERE id = ?1)
               )
          )`,
    )
    .bind(id, now)
    .run();
  if (res.meta.changes === 1) return "confirmed";
  const row = await db.prepare("SELECT status FROM bookings WHERE id = ?1").bind(id).first<{ status: string }>();
  return row?.status === "pending" ? "conflict" : "not_pending";
}

export async function cancelBooking(db: D1Database, id: number, reason: string, now: string = sqlNow()): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?3, cancel_reason = ?2, updated_at = ?3
        WHERE id = ?1 AND status != 'cancelled'`,
    )
    .bind(id, reason, now)
    .run();
  return res.meta.changes === 1;
}

export async function updateBookingNotes(db: D1Database, id: number, internalNotes: string, now: string = sqlNow()): Promise<void> {
  await db.prepare("UPDATE bookings SET internal_notes = ?2, updated_at = ?3 WHERE id = ?1").bind(id, internalNotes, now).run();
}

/** Annule les options de paiement expirées (filet de sécurité du cron ; la
 *  disponibilité ne dépend PAS de ce nettoyage — les holds expirés sont déjà
 *  ignorés par la clause de conflit et par isActiveBooking). */
export async function expireStaleHolds(db: D1Database, now: string = sqlNow()): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?1, cancel_reason = 'hold_expired', updated_at = ?1
        WHERE status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?1`,
    )
    .bind(now)
    .run();
  return res.meta.changes;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface GuestInput {
  email?: string | null;
  firstName?: string | null;
  lastName: string;
  phone?: string | null;
  address?: string | null;
  country?: string | null;
  lang?: string | null;
  notes?: string | null;
  /** true = consentement marketing donné maintenant (jamais rétrogradé ici). */
  marketingOptIn?: boolean;
}

/** Crée ou retrouve un client. Dédoublonnage par email (insensible à la casse). */
export async function upsertGuest(db: D1Database, g: GuestInput): Promise<number> {
  const email = g.email?.trim().toLowerCase() || null;
  // L'opt-in ne se donne que positivement ici : une résa sans case cochée ne
  // retire jamais un consentement déjà enregistré (le retrait = action admin).
  const optIn = g.marketingOptIn === true ? 1 : 0;
  if (email) {
    const existing = await db.prepare("SELECT id FROM guests WHERE lower(email) = ?1").bind(email).first<{ id: number }>();
    if (existing) {
      await db
        .prepare(
          `UPDATE guests SET first_name = COALESCE(?2, first_name), last_name = COALESCE(?3, last_name),
                             phone = COALESCE(?4, phone), address = COALESCE(?5, address),
                             country = COALESCE(?6, country), lang = COALESCE(?7, lang),
                             marketing_opt_in = MAX(marketing_opt_in, ?8),
                             marketing_opt_in_at = CASE WHEN ?8 = 1 AND marketing_opt_in = 0
                                                        THEN datetime('now') ELSE marketing_opt_in_at END
            WHERE id = ?1`,
        )
        .bind(existing.id, g.firstName ?? null, g.lastName ?? null, g.phone ?? null, g.address ?? null, g.country ?? null, g.lang ?? null, optIn)
        .run();
      return existing.id;
    }
  }
  const res = await db
    .prepare(
      `INSERT INTO guests (email, first_name, last_name, phone, address, country, lang, notes, marketing_opt_in, marketing_opt_in_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 'fr'), ?8, ?9, CASE WHEN ?9 = 1 THEN datetime('now') ELSE NULL END)`,
    )
    .bind(email, g.firstName ?? null, g.lastName, g.phone ?? null, g.address ?? null, g.country ?? null, g.lang ?? null, g.notes ?? null, optIn)
    .run();
  return res.meta.last_row_id;
}

/** Trace l'acceptation des CGV sur la résa (preuve : version + horodatage + IP). */
export async function recordCgvAcceptance(
  db: D1Database,
  bookingId: number,
  p: { version: string; ip: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE bookings SET cgv_version = ?2, cgv_accepted_at = datetime('now'), cgv_ip = ?3 WHERE id = ?1")
    .bind(bookingId, p.version, p.ip)
    .run();
}

export interface GuestRow {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string;
  phone: string | null;
  address: string | null;
  country: string | null;
  lang: string;
  notes: string | null;
  createdAt: string;
  bookingsCount?: number;
  totalSpentCents?: number;
}

export async function listGuests(db: D1Database, search?: string): Promise<GuestRow[]> {
  const base = `
    SELECT g.*, COUNT(b.id) AS bookings_count, COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.total_cents ELSE 0 END), 0) AS total_spent
      FROM guests g LEFT JOIN bookings b ON b.guest_id = g.id`;
  const stmt = search
    ? db.prepare(`${base} WHERE g.last_name LIKE ?1 OR g.first_name LIKE ?1 OR g.email LIKE ?1 GROUP BY g.id ORDER BY g.last_name`).bind(`%${search}%`)
    : db.prepare(`${base} GROUP BY g.id ORDER BY g.last_name`);
  const { results } = await stmt.all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), email: strOrNull(r.email), firstName: strOrNull(r.first_name), lastName: str(r.last_name),
    phone: strOrNull(r.phone), address: strOrNull(r.address), country: strOrNull(r.country),
    lang: str(r.lang), notes: strOrNull(r.notes), createdAt: str(r.created_at),
    bookingsCount: num(r.bookings_count), totalSpentCents: num(r.total_spent),
  }));
}

export async function getGuest(db: D1Database, id: number): Promise<GuestRow | null> {
  const row = await db.prepare("SELECT * FROM guests WHERE id = ?1").bind(id).first();
  if (!row) return null;
  const r = row as Raw;
  return {
    id: num(r.id), email: strOrNull(r.email), firstName: strOrNull(r.first_name), lastName: str(r.last_name),
    phone: strOrNull(r.phone), address: strOrNull(r.address), country: strOrNull(r.country),
    lang: str(r.lang), notes: strOrNull(r.notes), createdAt: str(r.created_at),
  };
}

export async function updateGuest(
  db: D1Database,
  id: number,
  g: Partial<Omit<GuestInput, "lastName"> & { lastName: string }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE guests SET
         email = COALESCE(?2, email), first_name = COALESCE(?3, first_name), last_name = COALESCE(?4, last_name),
         phone = COALESCE(?5, phone), address = COALESCE(?6, address), country = COALESCE(?7, country),
         lang = COALESCE(?8, lang), notes = COALESCE(?9, notes)
        WHERE id = ?1`,
    )
    .bind(
      id, g.email ?? null, g.firstName ?? null, g.lastName ?? null, g.phone ?? null,
      g.address ?? null, g.country ?? null, g.lang ?? null, g.notes ?? null,
    )
    .run();
}

export async function bookingsForGuest(db: D1Database, guestId: number): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(`${BOOKING_JOIN} WHERE b.guest_id = ?1 ORDER BY b.checkin DESC`)
    .bind(guestId)
    .all();
  return (results as Raw[]).map(mapBooking);
}

export async function updateProperty(
  db: D1Database,
  id: number,
  p: Partial<{ name: string; address: string; commune: string; contactEmail: string; contactPhone: string }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE properties SET name = COALESCE(?2, name), address = COALESCE(?3, address),
                             commune = COALESCE(?4, commune), contact_email = COALESCE(?5, contact_email),
                             contact_phone = COALESCE(?6, contact_phone)
        WHERE id = ?1`,
    )
    .bind(id, p.name ?? null, p.address ?? null, p.commune ?? null, p.contactEmail ?? null, p.contactPhone ?? null)
    .run();
}

// ---------------------------------------------------------------------------
// Paiements
// ---------------------------------------------------------------------------

export interface PaymentInput {
  bookingId: number;
  kind: "deposit" | "balance" | "full" | "refund" | "manual";
  method: "stripe" | "transfer" | "cash" | "other";
  amountCents: number;
  status: "pending" | "succeeded" | "failed" | "refunded";
  stripeSessionId?: string | null;
  stripePaymentIntent?: string | null;
  note?: string | null;
  receivedAt?: string | null;
}

export async function addPayment(db: D1Database, p: PaymentInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO payments (booking_id, kind, method, amount_cents, status, stripe_session_id, stripe_payment_intent, note, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      p.bookingId, p.kind, p.method, p.amountCents, p.status,
      p.stripeSessionId ?? null, p.stripePaymentIntent ?? null, p.note ?? null, p.receivedAt ?? null,
    )
    .run();
  await recomputePaid(db, p.bookingId);
  return res.meta.last_row_id;
}

/** Recalcule le dénormalisé bookings.paid_cents (somme des paiements réussis). */
export async function recomputePaid(db: D1Database, bookingId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE bookings SET paid_cents =
         (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE booking_id = ?1 AND status = 'succeeded')
       WHERE id = ?1`,
    )
    .bind(bookingId)
    .run();
}

export interface PaymentRow {
  id: number;
  bookingId: number;
  kind: string;
  method: string;
  amountCents: number;
  currency: string;
  stripeSessionId: string | null;
  stripePaymentIntent: string | null;
  status: string;
  note: string | null;
  receivedAt: string | null;
  createdAt: string;
  bookingReference?: string;
}

function mapPayment(r: Raw): PaymentRow {
  return {
    id: num(r.id), bookingId: num(r.booking_id), kind: str(r.kind), method: str(r.method),
    amountCents: num(r.amount_cents), currency: str(r.currency),
    stripeSessionId: strOrNull(r.stripe_session_id), stripePaymentIntent: strOrNull(r.stripe_payment_intent),
    status: str(r.status), note: strOrNull(r.note), receivedAt: strOrNull(r.received_at), createdAt: str(r.created_at),
    bookingReference: strOrNull(r.booking_reference) ?? undefined,
  };
}

export async function listPayments(db: D1Database, f: { bookingId?: number; propertyId?: number } = {}): Promise<PaymentRow[]> {
  const base = "SELECT p.*, b.reference AS booking_reference FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN units u ON u.id = b.unit_id";
  let stmt: D1PreparedStatement;
  if (f.bookingId) {
    stmt = db.prepare(`${base} WHERE p.booking_id = ?1 ORDER BY p.created_at DESC`).bind(f.bookingId);
  } else if (f.propertyId) {
    stmt = db.prepare(`${base} WHERE u.property_id = ?1 ORDER BY p.created_at DESC LIMIT 500`).bind(f.propertyId);
  } else {
    stmt = db.prepare(`${base} ORDER BY p.created_at DESC LIMIT 500`);
  }
  const { results } = await stmt.all();
  return (results as Raw[]).map(mapPayment);
}

export async function findPaymentBySession(db: D1Database, sessionId: string): Promise<PaymentRow | null> {
  const row = await db.prepare("SELECT * FROM payments WHERE stripe_session_id = ?1").bind(sessionId).first();
  return row ? mapPayment(row as Raw) : null;
}

export async function markPaymentStatus(
  db: D1Database,
  paymentId: number,
  status: "pending" | "succeeded" | "failed" | "refunded",
  opts: { receivedAt?: string | null; stripePaymentIntent?: string | null } = {},
): Promise<void> {
  const payment = await db.prepare("SELECT booking_id FROM payments WHERE id = ?1").bind(paymentId).first<{ booking_id: number }>();
  await db
    .prepare(
      `UPDATE payments SET status = ?2, received_at = COALESCE(?3, received_at),
                           stripe_payment_intent = COALESCE(?4, stripe_payment_intent)
        WHERE id = ?1`,
    )
    .bind(paymentId, status, opts.receivedAt ?? null, opts.stripePaymentIntent ?? null)
    .run();
  if (payment) await recomputePaid(db, payment.booking_id);
}

/** Déplace une résa iCal sur de nouvelles dates, avec le MÊME garde-fou
 *  atomique que la création (en s'excluant elle-même du test de conflit).
 *  meta.changes === 0 ⇒ conflit, les dates existantes sont conservées. */
export async function updateBookingDatesAtomic(
  db: D1Database,
  id: number,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`updateBookingDatesAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings SET checkin = ?3, checkout = ?4, updated_at = ?5
        WHERE id = ?2
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )`,
    )
    .bind(unitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

/** Déplace une résa vers un AUTRE logement (et éventuellement d'autres dates),
 *  avec le MÊME garde-fou atomique que la création — la disponibilité est
 *  vérifiée sur le logement de DESTINATION, liaisons comprises.
 *
 *  Sans cette opération, une réservation déplacée d'une maison à l'autre côté
 *  canal restait chez nous sur l'ancienne : les deux calendriers devenaient
 *  faux d'un coup (l'ancien bloqué à tort, le nouveau vendu deux fois) et rien
 *  ne le signalait, la comparaison ne portant que sur les dates (issue #19).
 *
 *  false ⇒ le créneau de destination est déjà pris : on ne force RIEN, la résa
 *  reste où elle est et l'appelant remonte une alerte. */
export async function moveBookingAtomic(
  db: D1Database,
  id: number,
  toUnitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`moveBookingAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings SET unit_id = ?1, checkin = ?3, checkout = ?4, updated_at = ?5
        WHERE id = ?2
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )`,
    )
    .bind(toUnitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

/** Réservations ACTIVES qui occupent un créneau sur un logement (liaisons
 *  comprises) — la même condition que le garde-fou d'insertion, mais en
 *  lecture. Sert à nommer le coupable quand une synchronisation échoue :
 *  « conflit » est inexploitable, « conflit avec la résa directe MDS-2026-014 »
 *  se tranche. */
export async function blockingBookings(
  db: D1Database,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
  excludeId?: number,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `${BOOKING_JOIN}
        WHERE b.id != ?5
          AND b.checkin < ?3
          AND b.checkout > ?2
          AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?4))
          AND b.unit_id IN (
            SELECT ?1
            UNION ALL
            SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
          )
        ORDER BY b.checkin`,
    )
    .bind(unitId, checkin, checkout, now, excludeId ?? -1)
    .all();
  return (results as Raw[]).map(mapBooking);
}

/** Réactive une résa externe annulée (le canal l'a rouverte), sur ses dates ou
 *  sur de nouvelles, avec le MÊME garde-fou atomique que la création.
 *  false ⇒ le créneau a été repris entre-temps : on ne force rien, l'appelant
 *  journalise une alerte. Réactiver au lieu de ré-insérer est ce qui évite la
 *  violation de l'unicité d'external_uid (issue #18). */
export async function reactivateBookingAtomic(
  db: D1Database,
  id: number,
  unitId: number,
  checkin: IsoDate,
  checkout: IsoDate,
  now: string = sqlNow(),
): Promise<boolean> {
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkin >= checkout) {
    throw new Error(`reactivateBookingAtomic: dates invalides ${checkin} → ${checkout}`);
  }
  const res = await db
    .prepare(
      `UPDATE bookings
          SET status = 'confirmed', checkin = ?3, checkout = ?4, hold_expires_at = NULL,
              cancelled_at = NULL, cancel_reason = NULL, updated_at = ?5
        WHERE id = ?2
          AND status = 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.id != ?2
               AND b.checkin < ?4
               AND b.checkout > ?3
               AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?5))
               AND b.unit_id IN (
                 SELECT ?1
                 UNION ALL
                 SELECT ul.unit_id FROM unit_links ul WHERE ul.blocks_unit_id = ?1
               )
          )`,
    )
    .bind(unitId, id, checkin, checkout, now)
    .run();
  return res.meta.changes === 1;
}

export async function setPaymentSession(db: D1Database, paymentId: number, sessionId: string): Promise<void> {
  await db.prepare("UPDATE payments SET stripe_session_id = ?2 WHERE id = ?1").bind(paymentId, sessionId).run();
}

export async function incrementPromoUse(db: D1Database, propertyId: number, code: string): Promise<void> {
  await db
    .prepare("UPDATE promotions SET uses = uses + 1 WHERE property_id = ?1 AND kind = 'code' AND lower(code) = lower(?2)")
    .bind(propertyId, code)
    .run();
}

// ---------------------------------------------------------------------------
// CRUD référentiel (saisons, règles tarifaires, promotions, options, flux iCal)
// ---------------------------------------------------------------------------

export async function listSeasons(db: D1Database, propertyId: number): Promise<Season[]> {
  const { results } = await db
    .prepare("SELECT * FROM seasons WHERE property_id = ?1 ORDER BY date_start")
    .bind(propertyId)
    .all();
  return (results as Raw[]).map(mapSeason);
}

export async function createSeason(
  db: D1Database,
  propertyId: number,
  s: { name: string; dateStart: IsoDate; dateEnd: IsoDate; priority: number },
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO seasons (property_id, name, date_start, date_end, priority) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(propertyId, s.name, s.dateStart, s.dateEnd, s.priority)
    .run();
  return res.meta.last_row_id;
}

export async function updateSeason(
  db: D1Database,
  id: number,
  s: Partial<{ name: string; dateStart: IsoDate; dateEnd: IsoDate; priority: number }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE seasons SET name = COALESCE(?2, name), date_start = COALESCE(?3, date_start),
                          date_end = COALESCE(?4, date_end), priority = COALESCE(?5, priority)
        WHERE id = ?1`,
    )
    .bind(id, s.name ?? null, s.dateStart ?? null, s.dateEnd ?? null, s.priority ?? null)
    .run();
}

/** Supprime une saison ET ses règles tarifaires (sinon violation de FK). */
export async function deleteSeason(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rate_rules WHERE season_id = ?1").bind(id),
    db.prepare("DELETE FROM seasons WHERE id = ?1").bind(id),
  ]);
}

export async function listRateRules(db: D1Database, propertyId: number): Promise<(RateRule & { unitName: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, u.name AS unit_name FROM rate_rules r JOIN units u ON u.id = r.unit_id
        WHERE u.property_id = ?1 ORDER BY u.sort_order, r.season_id`,
    )
    .bind(propertyId)
    .all();
  return (results as Raw[]).map((r) => ({ ...mapRateRule(r), unitName: str(r.unit_name) }));
}

/** Une règle par son id — sert à retrouver l'unité (donc ses bornes de prix)
 *  avant d'autoriser une modification tarifaire. */
export async function getRateRule(db: D1Database, id: number): Promise<RateRule | null> {
  const row = await db.prepare("SELECT * FROM rate_rules WHERE id = ?1").bind(id).first();
  return row ? mapRateRule(row as Raw) : null;
}

export interface RateRuleInput {
  unitId: number;
  seasonId: number | null;
  priceWeekCents: number;
  priceWeekendCents: number;
  holidayPct: number;
  minNights: number;
  checkinDays: number[] | null;
}

export async function createRateRule(db: D1Database, r: RateRuleInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO rate_rules (unit_id, season_id, price_week_cents, price_weekend_cents, holiday_pct, min_nights, checkin_days)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      r.unitId, r.seasonId, r.priceWeekCents, r.priceWeekendCents, r.holidayPct, r.minNights,
      r.checkinDays && r.checkinDays.length > 0 ? r.checkinDays.join(",") : null,
    )
    .run();
  return res.meta.last_row_id;
}

export async function updateRateRule(db: D1Database, id: number, r: Partial<RateRuleInput>): Promise<void> {
  await db
    .prepare(
      `UPDATE rate_rules SET
         price_week_cents = COALESCE(?2, price_week_cents),
         price_weekend_cents = COALESCE(?3, price_weekend_cents),
         holiday_pct = COALESCE(?4, holiday_pct),
         min_nights = COALESCE(?5, min_nights),
         checkin_days = ?6
        WHERE id = ?1`,
    )
    .bind(
      id, r.priceWeekCents ?? null, r.priceWeekendCents ?? null, r.holidayPct ?? null, r.minNights ?? null,
      r.checkinDays === undefined ? null : r.checkinDays && r.checkinDays.length > 0 ? r.checkinDays.join(",") : null,
    )
    .run();
}

export async function deleteRateRule(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM rate_rules WHERE id = ?1").bind(id).run();
}

// ---------------------------------------------------------------------------
// Surcharges par jour (rate_overrides — migration 0014, issue #23)
// ---------------------------------------------------------------------------

function mapRateOverride(r: Raw): RateOverride {
  return {
    unitId: num(r.unit_id),
    date: str(r.date),
    priceCents: numOrNull(r.price_cents),
    minNights: numOrNull(r.min_nights),
  };
}

/** Surcharges de plusieurs unités sur [from, toExclusive). */
export async function listRateOverrides(
  db: D1Database,
  unitIds: number[],
  from: IsoDate,
  toExclusive: IsoDate,
): Promise<RateOverride[]> {
  if (unitIds.length === 0) return [];
  const ids = [...new Set(unitIds)];
  const placeholders = ids.map((_, i) => `?${i + 3}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT * FROM rate_overrides
        WHERE date >= ?1 AND date < ?2 AND unit_id IN (${placeholders})
        ORDER BY unit_id, date`,
    )
    .bind(from, toExclusive, ...ids)
    .all();
  return (results as Raw[]).map(mapRateOverride);
}

/** Surcharges de toutes les unités d'un domaine sur [from, toExclusive) —
 *  une seule requête pour la vue année et pour le push vers Beds24. */
export async function listRateOverridesForProperty(
  db: D1Database,
  propertyId: number,
  from: IsoDate,
  toExclusive: IsoDate,
): Promise<RateOverride[]> {
  const { results } = await db
    .prepare(
      `SELECT o.* FROM rate_overrides o JOIN units u ON u.id = o.unit_id
        WHERE u.property_id = ?1 AND o.date >= ?2 AND o.date < ?3
        ORDER BY o.unit_id, o.date`,
    )
    .bind(propertyId, from, toExclusive)
    .all();
  return (results as Raw[]).map(mapRateOverride);
}

/** Patch d'une surcharge : `undefined` laisse la valeur en place, `null` la
 *  retire. Une ligne dont les deux valeurs finissent à null est SUPPRIMÉE —
 *  retirer un prix fait revenir la saison, jamais un 0 fantôme. */
export interface RateOverridePatch {
  priceCents?: number | null;
  minNights?: number | null;
}

export interface RateOverrideWriteResult {
  /** jours effectivement porteurs d'une surcharge après l'écriture */
  written: number;
  /** jours dont la surcharge a disparu (retour à la saison) */
  cleared: number;
}

/** Applique un patch de surcharge sur une liste de jours d'UNE unité.
 *  Écriture par jour, en un seul batch : D1 sérialise, l'ensemble part groupé. */
export async function setRateOverrides(
  db: D1Database,
  unitId: number,
  dates: IsoDate[],
  patch: RateOverridePatch,
): Promise<RateOverrideWriteResult> {
  const days = [...new Set(dates)].sort();
  if (days.length === 0) return { written: 0, cleared: 0 };

  // État courant, pour distinguer « laisser en place » de « retirer ».
  const placeholders = days.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM rate_overrides WHERE unit_id = ?1 AND date IN (${placeholders})`)
    .bind(unitId, ...days)
    .all();
  const current = new Map<string, RateOverride>();
  for (const row of results as Raw[]) {
    const o = mapRateOverride(row);
    current.set(o.date, o);
  }

  const stmts: D1PreparedStatement[] = [];
  let written = 0;
  let cleared = 0;
  for (const date of days) {
    const existing = current.get(date) ?? null;
    const price = patch.priceCents === undefined ? (existing?.priceCents ?? null) : patch.priceCents;
    const minNights = patch.minNights === undefined ? (existing?.minNights ?? null) : patch.minNights;
    if (price == null && minNights == null) {
      if (existing) {
        stmts.push(db.prepare("DELETE FROM rate_overrides WHERE unit_id = ?1 AND date = ?2").bind(unitId, date));
        cleared += 1;
      }
      continue;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO rate_overrides (unit_id, date, price_cents, min_nights)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (unit_id, date) DO UPDATE SET
             price_cents = excluded.price_cents,
             min_nights = excluded.min_nights,
             updated_at = datetime('now')`,
        )
        .bind(unitId, date, price, minNights),
    );
    written += 1;
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { written, cleared };
}

/** Retire toute surcharge sur une liste de jours — retour au tarif de saison. */
export async function deleteRateOverrides(db: D1Database, unitId: number, dates: IsoDate[]): Promise<number> {
  const days = [...new Set(dates)];
  if (days.length === 0) return 0;
  const placeholders = days.map((_, i) => `?${i + 2}`).join(", ");
  const res = await db
    .prepare(`DELETE FROM rate_overrides WHERE unit_id = ?1 AND date IN (${placeholders})`)
    .bind(unitId, ...days)
    .run();
  return res.meta.changes ?? 0;
}

export async function listPromotions(db: D1Database, propertyId: number): Promise<Promotion[]> {
  const { results } = await db
    .prepare("SELECT * FROM promotions WHERE property_id = ?1 ORDER BY kind, id")
    .bind(propertyId)
    .all();
  return (results as Raw[]).map(mapPromotion);
}

export interface PromotionInput {
  kind: Promotion["kind"];
  code: string | null;
  label: string;
  discountPct: number | null;
  discountCents: number | null;
  threshold: number | null;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
  maxUses: number | null;
  active: boolean;
}

export async function createPromotion(db: D1Database, propertyId: number, p: PromotionInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO promotions (property_id, kind, code, label, discount_pct, discount_cents, threshold, valid_from, valid_until, max_uses, active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      propertyId, p.kind, p.code, p.label, p.discountPct, p.discountCents, p.threshold,
      p.validFrom, p.validUntil, p.maxUses, p.active ? 1 : 0,
    )
    .run();
  return res.meta.last_row_id;
}

export async function updatePromotion(db: D1Database, id: number, p: Partial<PromotionInput>): Promise<void> {
  await db
    .prepare(
      `UPDATE promotions SET
         code = COALESCE(?2, code), label = COALESCE(?3, label),
         discount_pct = COALESCE(?4, discount_pct), discount_cents = COALESCE(?5, discount_cents),
         threshold = COALESCE(?6, threshold),
         valid_from = COALESCE(?7, valid_from), valid_until = COALESCE(?8, valid_until),
         max_uses = COALESCE(?9, max_uses),
         active = COALESCE(?10, active)
        WHERE id = ?1`,
    )
    .bind(
      id, p.code ?? null, p.label ?? null, p.discountPct ?? null, p.discountCents ?? null,
      p.threshold ?? null, p.validFrom ?? null, p.validUntil ?? null, p.maxUses ?? null,
      p.active === undefined ? null : p.active ? 1 : 0,
    )
    .run();
}

export async function deletePromotion(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM promotions WHERE id = ?1").bind(id).run();
}

export type OptionRow = OptionDef & { active: boolean; sortOrder: number; propertyId: number };

export async function listOptionsAdmin(db: D1Database, propertyId: number): Promise<OptionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM options WHERE property_id = ?1 ORDER BY sort_order, id")
    .bind(propertyId)
    .all();
  return (results as Raw[]).map(mapOption);
}

export interface OptionInput {
  name: string;
  pricingMode: OptionDef["pricingMode"];
  priceCents: number;
  unitLabel: string | null;
  maxQty: number | null;
  active: boolean;
  sortOrder: number;
}

export async function createOption(db: D1Database, propertyId: number, o: OptionInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO options (property_id, name, pricing_mode, price_cents, unit_label, max_qty, active, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(propertyId, o.name, o.pricingMode, o.priceCents, o.unitLabel, o.maxQty, o.active ? 1 : 0, o.sortOrder)
    .run();
  return res.meta.last_row_id;
}

export async function updateOption(db: D1Database, id: number, o: Partial<OptionInput>): Promise<void> {
  await db
    .prepare(
      `UPDATE options SET
         name = COALESCE(?2, name), pricing_mode = COALESCE(?3, pricing_mode),
         price_cents = COALESCE(?4, price_cents), unit_label = COALESCE(?5, unit_label),
         max_qty = COALESCE(?6, max_qty), active = COALESCE(?7, active), sort_order = COALESCE(?8, sort_order)
        WHERE id = ?1`,
    )
    .bind(
      id, o.name ?? null, o.pricingMode ?? null, o.priceCents ?? null, o.unitLabel ?? null,
      o.maxQty ?? null, o.active === undefined ? null : o.active ? 1 : 0, o.sortOrder ?? null,
    )
    .run();
}

export async function deleteOption(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM options WHERE id = ?1").bind(id).run();
}

// ---------------------------------------------------------------------------
// Flux iCal entrants
// ---------------------------------------------------------------------------

export interface FeedRow {
  id: number;
  unitId: number;
  unitName?: string;
  name: string;
  url: string;
  active: boolean;
  lastSyncAt: string | null;
  lastStatus: string | null;
}

function mapFeed(r: Raw): FeedRow {
  return {
    id: num(r.id), unitId: num(r.unit_id), unitName: strOrNull(r.unit_name) ?? undefined,
    name: str(r.name), url: str(r.url), active: num(r.active) === 1,
    lastSyncAt: strOrNull(r.last_sync_at), lastStatus: strOrNull(r.last_status),
  };
}

export async function listFeeds(db: D1Database, onlyActive = false): Promise<FeedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, u.name AS unit_name FROM ical_feeds f JOIN units u ON u.id = f.unit_id
        ${onlyActive ? "WHERE f.active = 1" : ""} ORDER BY f.id`,
    )
    .all();
  return (results as Raw[]).map(mapFeed);
}

export async function getFeed(db: D1Database, id: number): Promise<FeedRow | null> {
  const row = await db
    .prepare("SELECT f.*, u.name AS unit_name FROM ical_feeds f JOIN units u ON u.id = f.unit_id WHERE f.id = ?1")
    .bind(id)
    .first();
  return row ? mapFeed(row as Raw) : null;
}

export async function createFeed(db: D1Database, f: { unitId: number; name: string; url: string }): Promise<number> {
  const res = await db
    .prepare("INSERT INTO ical_feeds (unit_id, name, url) VALUES (?1, ?2, ?3)")
    .bind(f.unitId, f.name, f.url)
    .run();
  return res.meta.last_row_id;
}

export async function updateFeed(
  db: D1Database,
  id: number,
  f: Partial<{ name: string; url: string; active: boolean }>,
): Promise<void> {
  await db
    .prepare(
      "UPDATE ical_feeds SET name = COALESCE(?2, name), url = COALESCE(?3, url), active = COALESCE(?4, active) WHERE id = ?1",
    )
    .bind(id, f.name ?? null, f.url ?? null, f.active === undefined ? null : f.active ? 1 : 0)
    .run();
}

export async function deleteFeed(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM ical_feeds WHERE id = ?1").bind(id).run();
}

export async function setFeedStatus(db: D1Database, id: number, status: string, at: string = sqlNow()): Promise<void> {
  await db.prepare("UPDATE ical_feeds SET last_sync_at = ?2, last_status = ?3 WHERE id = ?1").bind(id, at, status).run();
}

/** Résas iCal actives d'un flux (pour la réconciliation import). */
export async function listFeedBookings(db: D1Database, feedId: number): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(`${BOOKING_JOIN} WHERE b.source = 'ical' AND b.external_uid LIKE ?1 AND b.status != 'cancelled'`)
    .bind(`feed${feedId}:%`)
    .all();
  return (results as Raw[]).map(mapBooking);
}

/** Résa portant cet external_uid, ANNULÉES COMPRISES (la contrainte d'unicité
 *  rend le résultat unique). Les listes de réconciliation ci-dessus filtrent
 *  les annulées : sans cette recherche, une résa externe rouverte par le canal
 *  repartait sur une création et cassait l'unicité (issue #18). */
export async function getBookingByExternalUid(db: D1Database, externalUid: string): Promise<BookingRow | null> {
  const row = await db.prepare(`${BOOKING_JOIN} WHERE b.external_uid = ?1`).bind(externalUid).first();
  return row ? mapBooking(row as Raw) : null;
}

/** Résas rapatriées de Beds24 (canaux OTA) — external_uid 'beds24:<id>'. */
export async function listBeds24Bookings(db: D1Database): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(`${BOOKING_JOIN} WHERE b.external_uid LIKE 'beds24:%' AND b.status != 'cancelled'`)
    .all();
  return (results as Raw[]).map(mapBooking);
}

// ---------------------------------------------------------------------------
// Messages — les échanges clients vivent dans la plateforme.
// direction 'in' (client) / 'out' (équipe) · channel 'email' / 'form'
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: number;
  propertyId: number | null;
  messageId: string | null;
  direction: "in" | "out";
  channel: "email" | "form";
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string;
  bodyText: string;
  bookingId: number | null;
  bookingReference: string | null;
  guestId: number | null;
  status: "nouveau" | "traité";
  autoReplied: boolean;
  forwarded: boolean;
  delivery: string | null;
  receivedAt: string;
}

function mapMessage(r: Raw): MessageRow {
  return {
    id: num(r.id), propertyId: numOrNull(r.property_id), messageId: strOrNull(r.message_id),
    direction: str(r.direction) === "out" ? "out" : "in",
    channel: str(r.channel) === "form" ? "form" : "email",
    fromEmail: str(r.from_email), fromName: strOrNull(r.from_name), toEmail: strOrNull(r.to_email),
    subject: str(r.subject), bodyText: str(r.body_text),
    bookingId: numOrNull(r.booking_id), bookingReference: strOrNull(r.booking_reference),
    guestId: numOrNull(r.guest_id),
    status: str(r.status) === "traité" ? "traité" : "nouveau",
    autoReplied: num(r.auto_replied) === 1, forwarded: num(r.forwarded) === 1,
    delivery: strOrNull(r.delivery),
    receivedAt: str(r.received_at),
  };
}

const MESSAGE_JOIN = `SELECT e.*, b.reference AS booking_reference
    FROM messages e LEFT JOIN bookings b ON b.id = e.booking_id`;

export async function listMessages(
  db: D1Database,
  f: { propertyId?: number; status?: string; direction?: string; bookingId?: number; limit?: number } = {},
): Promise<MessageRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    binds.push(value);
    where.push(clause.replace("?", `?${binds.length}`));
  };
  if (f.propertyId) push("e.property_id = ?", f.propertyId);
  if (f.status) push("e.status = ?", f.status);
  if (f.direction) push("e.direction = ?", f.direction);
  if (f.bookingId) push("e.booking_id = ?", f.bookingId);
  const sql = `${MESSAGE_JOIN} ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY e.id DESC LIMIT ${Math.min(f.limit ?? 200, 1000)}`;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as Raw[]).map(mapMessage);
}

/** Fil de conversation : tous les messages du même client OU de la même résa,
 *  du plus ancien au plus récent. */
export async function getThread(
  db: D1Database,
  ref: { bookingId?: number | null; guestId?: number | null; email?: string | null },
): Promise<MessageRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (ref.bookingId) {
    binds.push(ref.bookingId);
    clauses.push(`e.booking_id = ?${binds.length}`);
  }
  if (ref.guestId) {
    binds.push(ref.guestId);
    clauses.push(`e.guest_id = ?${binds.length}`);
  }
  if (ref.email) {
    binds.push(ref.email.toLowerCase());
    clauses.push(`lower(e.from_email) = ?${binds.length}`);
    binds.push(ref.email.toLowerCase());
    clauses.push(`lower(e.to_email) = ?${binds.length}`);
  }
  if (clauses.length === 0) return [];
  const sql = `${MESSAGE_JOIN} WHERE ${clauses.join(" OR ")} ORDER BY e.id ASC LIMIT 300`;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results as Raw[]).map(mapMessage);
}

export interface InboundMessageInput {
  propertyId: number;
  messageId?: string | null;
  channel: "email" | "form";
  fromEmail: string;
  fromName?: string | null;
  toEmail?: string | null;
  subject: string;
  bodyText: string;
  bookingId?: number | null;
  guestId?: number | null;
  receivedAt?: string;
}

/** Insère un message entrant. Retourne null si doublon (Message-ID). */
export async function insertInboundMessage(db: D1Database, m: InboundMessageInput): Promise<number | null> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO messages (property_id, message_id, direction, channel, from_email, from_name,
                               to_email, subject, body_text, booking_id, guest_id, received_at)
         VALUES (?1, ?2, 'in', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, datetime('now')))`,
      )
      .bind(
        m.propertyId, m.messageId ?? null, m.channel, m.fromEmail, m.fromName ?? null,
        m.toEmail ?? null, m.subject, m.bodyText, m.bookingId ?? null, m.guestId ?? null,
        m.receivedAt ?? null,
      )
      .run();
    return res.meta.last_row_id;
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) return null;
    throw e;
  }
}

/** Insère une réponse de l'équipe (direction 'out', déjà « traitée »). */
export async function insertOutboundMessage(
  db: D1Database,
  m: {
    propertyId: number;
    toEmail: string | null;
    fromEmail: string | null;
    subject: string;
    bodyText: string;
    bookingId?: number | null;
    guestId?: number | null;
    delivery: string; // 'aucune' | 'stub' | 'sent' | 'failed'
  },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO messages (property_id, direction, channel, from_email, to_email, subject,
                             body_text, booking_id, guest_id, status, delivery)
       VALUES (?1, 'out', 'form', ?2, ?3, ?4, ?5, ?6, ?7, 'traité', ?8)`,
    )
    .bind(
      m.propertyId, m.fromEmail ?? "équipe", m.toEmail, m.subject, m.bodyText,
      m.bookingId ?? null, m.guestId ?? null, m.delivery,
    )
    .run();
  return res.meta.last_row_id;
}

export async function markMessage(db: D1Database, id: number, status: "nouveau" | "traité"): Promise<void> {
  await db.prepare("UPDATE messages SET status = ?2 WHERE id = ?1").bind(id, status).run();
}

export async function getMessage(db: D1Database, id: number): Promise<MessageRow | null> {
  const row = await db.prepare(`${MESSAGE_JOIN} WHERE e.id = ?1`).bind(id).first();
  return row ? mapMessage(row as Raw) : null;
}

export async function countNewMessages(db: D1Database, propertyId?: number): Promise<number> {
  const stmt = propertyId
    ? db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'nouveau' AND direction = 'in' AND property_id = ?1").bind(propertyId)
    : db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'nouveau' AND direction = 'in'");
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Journaux (emails, audit)
// ---------------------------------------------------------------------------

export interface EmailLogRow {
  id: number;
  bookingId: number | null;
  toEmail: string;
  subject: string;
  bodyText: string;
  kind: string;
  status: string;
  createdAt: string;
}

export async function listEmailLog(db: D1Database, bookingId?: number, limit = 100): Promise<EmailLogRow[]> {
  const stmt = bookingId
    ? db.prepare("SELECT * FROM email_log WHERE booking_id = ?1 ORDER BY id DESC LIMIT ?2").bind(bookingId, limit)
    : db.prepare("SELECT * FROM email_log ORDER BY id DESC LIMIT ?1").bind(limit);
  const { results } = await stmt.all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), bookingId: numOrNull(r.booking_id), toEmail: str(r.to_email), subject: str(r.subject),
    bodyText: str(r.body_text), kind: str(r.kind), status: str(r.status), createdAt: str(r.created_at),
  }));
}

export async function hasEmailOfKind(db: D1Database, bookingId: number, kind: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM email_log WHERE booking_id = ?1 AND kind = ?2 LIMIT 1")
    .bind(bookingId, kind)
    .first();
  return !!row;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  entity: string | null;
  detail: string | null;
  createdAt: string;
}

export async function listAudit(db: D1Database, limit = 200): Promise<AuditRow[]> {
  const { results } = await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1").bind(limit).all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), actor: str(r.actor), action: str(r.action),
    entity: strOrNull(r.entity), detail: strOrNull(r.detail), createdAt: str(r.created_at),
  }));
}

/** Journal filtré par préfixe d'action (ex. 'beds24.') — vue Canaux. */
export async function listAuditByAction(db: D1Database, prefix: string, limit = 20): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM audit_log WHERE action LIKE ?1 ORDER BY id DESC LIMIT ?2")
    .bind(`${prefix}%`, limit)
    .all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), actor: str(r.actor), action: str(r.action),
    entity: strOrNull(r.entity), detail: strOrNull(r.detail), createdAt: str(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Checklist de mise en route (page unique du back-office)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  id: number;
  section: string;
  label: string;
  owner: "papa" | "julien" | "claude";
  status: "a_faire" | "en_cours" | "fait" | "verifie" | "n_a";
  note: string | null;
  url: string | null;
  sortOrder: number;
  updatedAt: string;
}

export async function listChecklist(db: D1Database): Promise<ChecklistItem[]> {
  const { results } = await db.prepare("SELECT * FROM checklist_items ORDER BY sort_order, id").all();
  return (results as Raw[]).map((r) => ({
    id: num(r.id), section: str(r.section), label: str(r.label),
    owner: str(r.owner) as ChecklistItem["owner"],
    status: str(r.status) as ChecklistItem["status"],
    note: strOrNull(r.note), url: strOrNull(r.url),
    sortOrder: num(r.sort_order), updatedAt: str(r.updated_at),
  }));
}

export async function updateChecklistItem(
  db: D1Database,
  id: number,
  fields: { status?: ChecklistItem["status"]; note?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE checklist_items SET status = COALESCE(?2, status), note = COALESCE(?3, note),
                                  updated_at = datetime('now') WHERE id = ?1`,
    )
    .bind(id, fields.status ?? null, fields.note ?? null)
    .run();
}

// ---------------------------------------------------------------------------
// Signaux de santé (carte « Santé » du tableau de bord)
// ---------------------------------------------------------------------------

export interface HealthSignals {
  /** Paiements encaissés dont la réservation n'est PAS confirmée : le client a
   *  payé et n'a pas son séjour. À traiter dans l'heure (rembourser/reloger). */
  orphanPayments: { reference: string; bookingId: number; amountCents: number; bookingStatus: string; receivedAt: string | null }[];
  /** Emails dont l'envoi a échoué (voucher jamais reçu, personne ne le sait). */
  failedEmails: { kind: string; toEmail: string; createdAt: string; errorDetail: string | null }[];
  /** Erreurs techniques journalisées dans les dernières 24 h. */
  recentErrors: { action: string; entity: string | null; createdAt: string; detail: string | null }[];
  /** Dernier rapatriement Beds24 réussi — figé = calendriers OTA à la dérive. */
  beds24LastPull: string | null;
  beds24StaleHours: number | null;
  /** Dernier rapatriement COMPLET quotidien (réconciliation, issue #19), au
   *  format 'AAAA-MM-JJ' de Bruxelles. Facultatifs : la carte « Santé » sait
   *  vivre sans, et le repli neutre du back-office reste valide. */
  reconcileLastRun?: string | null;
  /** Écarts du dernier rapatriement complet qui demandent un arbitrage humain
   *  (conflit avec une résa directe, source injoignable, garde de sanité). */
  reconcileAlerts?: string[];
}

export async function healthSignals(db: D1Database, propertyId: number, now: Date = new Date()): Promise<HealthSignals> {
  const since = sqlNow(new Date(now.getTime() - 24 * 3600 * 1000));

  const orphans = await db
    .prepare(
      `SELECT b.id AS booking_id, b.reference, b.status AS booking_status, p.amount_cents, p.received_at
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN units u ON u.id = b.unit_id
        WHERE p.status = 'succeeded' AND b.status != 'confirmed' AND u.property_id = ?1
        ORDER BY p.id DESC LIMIT 20`,
    )
    .bind(propertyId)
    .all();

  const emails = await db
    .prepare(
      `SELECT kind, to_email, created_at, error_detail FROM email_log
        WHERE status = 'failed' AND created_at >= ?1 ORDER BY id DESC LIMIT 20`,
    )
    .bind(since)
    .all();

  const errors = await db
    .prepare(
      `SELECT action, entity, created_at, detail FROM audit_log
        WHERE action LIKE '%.error' AND created_at >= ?1 ORDER BY id DESC LIMIT 10`,
    )
    .bind(since)
    .all();

  const pull = await db
    .prepare("SELECT value FROM settings WHERE property_id = ?1 AND key = 'beds24_last_pull'")
    .bind(propertyId)
    .first<{ value: string }>();
  const lastPull = pull?.value ?? null;
  const staleHours = lastPull ? (now.getTime() - Date.parse(lastPull.replace(" ", "T") + "Z")) / 3_600_000 : null;

  // Rapatriement complet quotidien (issue #19) : la date du dernier passage et
  // les écarts qu'il n'a pas pu résoudre seul. Lecture défensive — la carte
  // « Santé » ne doit pas tomber parce qu'un compte-rendu est illisible.
  let reconcileLastRun: string | null = null;
  let reconcileAlerts: string[] = [];
  try {
    const run = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'reconcile_last_run'")
      .first<{ value: string }>();
    reconcileLastRun = run?.value ?? null;
    const report = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?1")
      .bind(`reconcile_last_report:${propertyId}`)
      .first<{ value: string }>();
    if (report?.value) {
      const parsed = JSON.parse(report.value) as { alerts?: unknown };
      if (Array.isArray(parsed.alerts)) reconcileAlerts = parsed.alerts.map((a) => String(a));
    }
  } catch {
    reconcileLastRun = null;
    reconcileAlerts = [];
  }

  return {
    reconcileLastRun,
    reconcileAlerts,
    orphanPayments: (orphans.results as Raw[]).map((r) => ({
      bookingId: num(r.booking_id),
      reference: str(r.reference),
      bookingStatus: str(r.booking_status),
      amountCents: num(r.amount_cents),
      receivedAt: r.received_at == null ? null : str(r.received_at),
    })),
    failedEmails: (emails.results as Raw[]).map((r) => ({
      kind: str(r.kind),
      toEmail: str(r.to_email),
      createdAt: str(r.created_at),
      errorDetail: r.error_detail == null ? null : str(r.error_detail),
    })),
    recentErrors: (errors.results as Raw[]).map((r) => ({
      action: str(r.action),
      entity: r.entity == null ? null : str(r.entity),
      createdAt: str(r.created_at),
      detail: r.detail == null ? null : str(r.detail),
    })),
    beds24LastPull: lastPull,
    beds24StaleHours: staleHours == null || Number.isNaN(staleHours) ? null : Math.round(staleHours * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Journal d'audit
// ---------------------------------------------------------------------------

export async function audit(
  db: D1Database,
  actor: "public" | "admin" | "cron" | "stripe" | "event" | "webhook",
  action: string,
  entity?: string | null,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)")
    .bind(actor, action, entity ?? null, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
