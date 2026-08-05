-- Migration 0001 — Schéma initial de la plateforme de gestion des gîtes.
--
-- Conventions transversales (respectées par tout le code TypeScript) :
--   · Sommes en CENTIMES (INTEGER) — jamais de flottants pour l'argent.
--   · Dates en TEXT 'YYYY-MM-DD'. Le checkout est EXCLUSIF : les nuitées
--     occupées forment l'intervalle semi-ouvert [checkin, checkout), ce qui
--     autorise nativement un départ et une arrivée le même jour.
--   · Horodatages en TEXT ISO UTC (datetime('now')).

-- ---------------------------------------------------------------------------
-- Domaines (Pré Moré, Moulin de Braives)
-- ---------------------------------------------------------------------------
CREATE TABLE properties (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,            -- 'pre-more', 'moulin-braives'
  name TEXT NOT NULL,
  ref_prefix TEXT NOT NULL UNIQUE,      -- préfixe des références de résa : PM, MB
  address TEXT,
  commune TEXT,                          -- commune (taxe de séjour)
  timezone TEXT NOT NULL DEFAULT 'Europe/Brussels',
  currency TEXT NOT NULL DEFAULT 'EUR',
  contact_email TEXT,
  contact_phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Unités louables. Une unité « composite » (Domaine entier) est une vraie
-- unité vendable, liée aux unités physiques via unit_links.
-- ---------------------------------------------------------------------------
CREATE TABLE units (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  capacity_base INTEGER NOT NULL,       -- capacité standard affichée
  capacity_max INTEGER NOT NULL,        -- capacité maximale acceptée à la recherche
  is_composite INTEGER NOT NULL DEFAULT 0,
  -- Tarification d'une unité composite :
  --   'sum' → prix = somme des unités composantes (chacune avec ses propres règles)
  --   'own' → prix = ses propres rate_rules
  composite_pricing TEXT NOT NULL DEFAULT 'own' CHECK (composite_pricing IN ('own', 'sum')),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ical_token TEXT NOT NULL UNIQUE,      -- secret de l'URL d'export iCal /ical/<token>.ics
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (property_id, slug)
);

-- ---------------------------------------------------------------------------
-- Liaison de disponibilité — LE cœur du système.
-- Une ligne (unit_id, blocks_unit_id) signifie : « toute réservation active
-- sur unit_id rend blocks_unit_id indisponible sur les mêmes nuits ».
-- Pré Moré : Scieur→Domaine, Scierie→Domaine, Domaine→Scieur, Domaine→Scierie.
-- Générique : n'importe quelles unités futures peuvent être liées.
-- ---------------------------------------------------------------------------
CREATE TABLE unit_links (
  unit_id INTEGER NOT NULL REFERENCES units(id),
  blocks_unit_id INTEGER NOT NULL REFERENCES units(id),
  PRIMARY KEY (unit_id, blocks_unit_id),
  CHECK (unit_id <> blocks_unit_id)
);

-- ---------------------------------------------------------------------------
-- Saisons tarifaires (par domaine). En cas de chevauchement, la priorité la
-- plus haute gagne. Les nuits hors saison utilisent le tarif par défaut
-- (rate_rules.season_id IS NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  date_start TEXT NOT NULL,             -- inclus
  date_end TEXT NOT NULL,               -- inclus
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_seasons_property ON seasons(property_id, date_start);

-- ---------------------------------------------------------------------------
-- Règles tarifaires : une par (unité, saison), season_id NULL = tarif défaut.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_rules (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  season_id INTEGER REFERENCES seasons(id),
  price_week_cents INTEGER NOT NULL,    -- nuit dimanche→jeudi
  price_weekend_cents INTEGER NOT NULL, -- nuit vendredi et samedi
  holiday_pct INTEGER NOT NULL DEFAULT 0, -- majoration % nuits fériées/veilles/ponts BE (auto)
  min_nights INTEGER NOT NULL DEFAULT 1,
  -- Jours d'arrivée autorisés, CSV de 0(dim)..6(sam), NULL = tous les jours.
  checkin_days TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, season_id)
);

-- ---------------------------------------------------------------------------
-- Promotions : remises automatiques (long séjour / early bird / last minute)
-- et codes promo. Portent sur le sous-total HÉBERGEMENT uniquement.
-- Règle d'empilement (défaut à valider avec Julien) : la meilleure remise
-- automatique s'applique seule ; un code promo s'ajoute ensuite.
-- ---------------------------------------------------------------------------
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL CHECK (kind IN ('code', 'long_stay', 'early_bird', 'last_minute')),
  code TEXT,                             -- pour kind='code' (insensible à la casse)
  label TEXT NOT NULL,
  discount_pct REAL,                     -- remise en % …
  discount_cents INTEGER,                -- … ou montant fixe (l'un des deux)
  -- Seuil : nuits min (long_stay) ou jours avant l'arrivée (early_bird ≥ / last_minute ≤).
  threshold INTEGER,
  valid_from TEXT,                       -- fenêtre de validité (date de réservation)
  valid_until TEXT,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_promotions_property ON promotions(property_id, kind);

-- ---------------------------------------------------------------------------
-- Options payantes (sauna, bain chaud, bois, linge, ménage…).
-- ---------------------------------------------------------------------------
CREATE TABLE options (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  pricing_mode TEXT NOT NULL CHECK (
    pricing_mode IN ('per_stay', 'per_night', 'per_person', 'per_person_night', 'per_unit_qty')
  ),
  price_cents INTEGER NOT NULL,
  unit_label TEXT,                       -- 'séjour', 'stère', 'pers.' (affichage)
  max_qty INTEGER,                       -- quantité max pour per_unit_qty
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Clients (CRM léger). Dédoublonnage à l'insertion par email quand présent.
-- ---------------------------------------------------------------------------
CREATE TABLE guests (
  id INTEGER PRIMARY KEY,
  email TEXT,
  first_name TEXT,
  last_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  country TEXT,
  lang TEXT NOT NULL DEFAULT 'fr',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_guests_email ON guests(email);

-- ---------------------------------------------------------------------------
-- Réservations. Statuts :
--   'pending'   → option en cours de paiement ; ne bloque le stock que tant
--                 que hold_expires_at est dans le futur.
--   'confirmed' → bloque le stock.
--   'cancelled' → libère le stock (jamais de DELETE : traçabilité).
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,        -- PM-2026-001
  unit_id INTEGER NOT NULL REFERENCES units(id),
  guest_id INTEGER REFERENCES guests(id),
  checkin TEXT NOT NULL,
  checkout TEXT NOT NULL,                -- EXCLUSIF
  adults INTEGER NOT NULL DEFAULT 0,
  children INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  hold_expires_at TEXT,                  -- fin de l'option (statut pending)
  source TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'manual', 'ical', 'import')),
  channel_label TEXT,                    -- 'Airbnb' etc. pour source='ical'
  external_uid TEXT,                     -- UID de l'événement iCal importé
  total_cents INTEGER NOT NULL DEFAULT 0,
  deposit_cents INTEGER NOT NULL DEFAULT 0,  -- acompte attendu à la réservation
  paid_cents INTEGER NOT NULL DEFAULT 0,     -- dénormalisé : somme des paiements 'succeeded'
  balance_due_date TEXT,                 -- échéance du solde
  currency TEXT NOT NULL DEFAULT 'EUR',
  quote_json TEXT,                       -- devis détaillé figé à la réservation (lignes)
  options_json TEXT,                     -- options choisies [{optionId, name, qty, amountCents}]
  promo_code TEXT,
  guest_notes TEXT,                      -- message du client
  internal_notes TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (checkin < checkout)
);
CREATE INDEX idx_bookings_unit_dates ON bookings(unit_id, checkin, checkout);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE UNIQUE INDEX idx_bookings_external_uid ON bookings(external_uid) WHERE external_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Paiements. amount_cents négatif = remboursement.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'balance', 'full', 'refund', 'manual')),
  method TEXT NOT NULL DEFAULT 'stripe' CHECK (method IN ('stripe', 'transfer', 'cash', 'other')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  note TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payments_booking ON payments(booking_id);
CREATE UNIQUE INDEX idx_payments_session ON payments(stripe_session_id) WHERE stripe_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Flux iCal ENTRANTS (import Airbnb → nous). L'export sortant n'a pas besoin
-- de table : /ical/<units.ical_token>.ics
-- ---------------------------------------------------------------------------
CREATE TABLE ical_feeds (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  name TEXT NOT NULL,                    -- 'Airbnb — Moulin'
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_status TEXT,                      -- 'ok' ou message d'erreur/conflit
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Journal des emails. En mode stub (par défaut), les emails sont uniquement
-- journalisés ici — AUCUN envoi réel sans accord explicite de Julien.
-- ---------------------------------------------------------------------------
CREATE TABLE email_log (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- 'voucher', 'payment_link', 'balance_reminder', …
  status TEXT NOT NULL DEFAULT 'stub' CHECK (status IN ('stub', 'sent', 'failed')),
  provider_id TEXT,                      -- id Resend si envoyé
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Journal d'audit : toute écriture significative (résa, annulation, tarif…).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,                   -- 'public' | 'admin' | 'cron' | 'stripe'
  action TEXT NOT NULL,                  -- 'booking.create', 'booking.cancel', 'rate.update', …
  entity TEXT,                           -- 'booking:12'
  detail TEXT,                           -- JSON libre
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Paramètres par domaine (clé → valeur texte). Clés utilisées :
--   deposit_pct, balance_due_days, hold_minutes, tourist_tax_cents_per_person_night,
--   tourist_tax_include_children, caution_cents, checkin_time, checkout_time,
--   cgv_text, allow_full_payment, allow_deposit
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  property_id INTEGER NOT NULL REFERENCES properties(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (property_id, key)
);
