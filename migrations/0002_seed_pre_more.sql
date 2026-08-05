-- Migration 0002 — Données initiales : Les Gîtes du Pré Moré.
-- ⚠️ Les tarifs, la taxe de séjour, la caution et les CGV sont des PLACEHOLDERS
-- (marqués TODO) en attendant la grille réelle de Julien (plan v1 § 8).
-- Ils sont modifiables dans le back-office sans re-migration.

INSERT INTO properties (id, slug, name, ref_prefix, address, commune, contact_email) VALUES
  (1, 'pre-more', 'Les Gîtes du Pré Moré', 'PM',
   'Redu (Daverdisse), Ardenne belge', 'Daverdisse',
   'TODO_contact@lesgitesdupremore.be');

INSERT INTO units (id, property_id, slug, name, description, capacity_base, capacity_max,
                   is_composite, composite_pricing, sort_order, ical_token) VALUES
  (1, 1, 'maison-du-scieur', 'La Maison du Scieur',
   'Grande maison pour 11 personnes, au bord du Ry des Glands. TODO_description',
   11, 11, 0, 'own', 1, 'local-dev-token-scieur'),
  (2, 1, 'la-scierie', 'La Scierie',
   'Maison pour 6 à 8 personnes. TODO_description',
   6, 8, 0, 'own', 2, 'local-dev-token-scierie'),
  (3, 1, 'domaine-entier', 'Le Domaine entier',
   'Les deux maisons — isolement total au bord du Ry des Glands. TODO_description',
   17, 19, 1, 'sum', 3, 'local-dev-token-domaine');
-- NB : composite_pricing='sum' = prix du Domaine entier = Scieur + Scierie
-- (TODO_PRIX_COMBINE — question ouverte n° 4 du plan : A+B ou tarif propre ?)
-- NB : les ical_token seront régénérés en valeurs aléatoires au déploiement.

-- La liaison qui fait tout le système :
INSERT INTO unit_links (unit_id, blocks_unit_id) VALUES
  (1, 3),  -- résa Maison du Scieur → bloque le Domaine entier
  (2, 3),  -- résa La Scierie      → bloque le Domaine entier
  (3, 1),  -- résa Domaine entier  → bloque la Maison du Scieur
  (3, 2);  -- résa Domaine entier  → bloque La Scierie

-- Saisons (au-delà de 2027 : à créer dans le back-office).
INSERT INTO seasons (id, property_id, name, date_start, date_end, priority) VALUES
  (1, 1, 'Haute — juillet-août 2026', '2026-07-01', '2026-08-31', 10),
  (2, 1, 'Fêtes de fin d''année 2026', '2026-12-18', '2027-01-03', 20),
  (3, 1, 'Haute — juillet-août 2027', '2027-07-01', '2027-08-31', 10);

-- TODO_TARIFS : grille placeholder inspirée du wireframe, à remplacer par la
-- grille réelle (question ouverte n° 3 du plan). season_id NULL = tarif défaut.
INSERT INTO rate_rules (unit_id, season_id, price_week_cents, price_weekend_cents, holiday_pct, min_nights) VALUES
  -- La Maison du Scieur (11 p.)
  (1, NULL, 18000, 22000, 15, 2),
  (1, 1,    24000, 28000, 15, 7),
  (1, 3,    24000, 28000, 15, 7),
  -- La Scierie (6/8 p.) — valeurs du wireframe
  (2, NULL, 12000, 15000, 15, 2),
  (2, 1,    16000, 18000, 15, 7),
  (2, 3,    16000, 18000, 15, 7);
-- Pas de règle pour le Domaine entier : mode 'sum' → somme des deux maisons.
-- Pas de règle spécifique saison 'Fêtes' : retombe sur le tarif défaut + majoration fériés.

-- Remises automatiques (valeurs du wireframe — TODO à valider).
INSERT INTO promotions (property_id, kind, label, discount_pct, threshold, active) VALUES
  (1, 'long_stay',   'Long séjour ≥ 7 nuits',  10, 7,  1),
  (1, 'early_bird',  'Early bird ≥ 90 jours',   5, 90, 1),
  (1, 'last_minute', 'Last minute ≤ 7 jours',  10, 7,  1);

-- Options payantes (TODO_OPTIONS : prix réels à confirmer).
INSERT INTO options (property_id, name, pricing_mode, price_cents, unit_label, max_qty, sort_order) VALUES
  (1, 'Sauna',                   'per_stay',     3500, 'séjour', 1,    1),
  (1, 'Bain chaud extérieur',    'per_stay',     4500, 'séjour', 1,    2),
  (1, 'Bois de chauffage',       'per_unit_qty', 1500, 'stère',  10,   3),
  (1, 'Linge de maison',         'per_person',    800, 'pers.',  NULL, 4),
  (1, 'Ménage de fin de séjour', 'per_stay',     6000, 'séjour', 1,    5);

INSERT INTO settings (property_id, key, value) VALUES
  (1, 'deposit_pct', '30'),
  (1, 'balance_due_days', '30'),
  (1, 'hold_minutes', '30'),
  (1, 'allow_deposit', 'true'),
  (1, 'allow_full_payment', 'true'),
  (1, 'tourist_tax_cents_per_person_night', '100'),   -- TODO_TAXE : montant réel commune de Daverdisse
  (1, 'tourist_tax_include_children', 'true'),        -- TODO_TAXE : exonération enfants ?
  (1, 'caution_cents', '30000'),                      -- TODO_CAUTION : montant réel
  (1, 'checkin_time', '16:00'),                       -- TODO à confirmer
  (1, 'checkout_time', '10:00'),                      -- TODO à confirmer
  (1, 'cgv_text', 'TODO_CGV — Conditions générales et contrat de location à fournir par Julien (récupérables dans elloha, onglet « Contrat de location »).');
