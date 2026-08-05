-- Migration 0004 — Le Moulin de Braives entre dans la plateforme (multi-biens).
-- Contenu réel relevé sur moulindebraives.be + page elloha publique (2026-07-12).
-- ⚠️ TODO_TARIFS_MOULIN : la grille réelle (elloha, non visible publiquement —
-- août complet au moment du relevé) et le ménage restent des placeholders.

INSERT INTO properties (id, slug, name, ref_prefix, address, commune, contact_email, contact_phone) VALUES
  (2, 'moulin-braives', 'Le Moulin de Braives', 'MB',
   '1 Rue Saint Pierre, 4260 Braives', 'Braives',
   'TODO_contact_moulin@moulindebraives.be', '0498/440 883');

-- Une seule unité vendable (l'elloha public n'expose qu'un hébergement ;
-- les « 2 offres » elloha = 2 formules tarifaires, pas 2 logements).
INSERT INTO units (id, property_id, slug, name, description, capacity_base, capacity_max,
                   is_composite, composite_pricing, sort_order, ical_token,
                   cleaning_fee_cents, photo_url) VALUES
  (4, 2, 'le-moulin', 'Le Moulin',
   'Ancien moulin du 18e siècle restauré en 2020, 300 m² le long de la Mehaigne — 5 chambres avec salles de bains privatives, home cinéma, jardin d''un hectare.',
   10, 12, 0, 'own', 1, 'local-dev-token-moulin',
   10000, 'https://moulindebraives.be/wp-content/uploads/2021/04/img_0754.jpg');
-- cleaning_fee_cents = 100 € TODO_MENAGE_MOULIN (à confirmer)

-- TODO_TARIFS_MOULIN : placeholders (12 personnes, gros gîte) — à remplacer
-- par la grille elloha réelle dès qu'elle est communiquée.
INSERT INTO rate_rules (unit_id, season_id, price_week_cents, price_weekend_cents, holiday_pct, min_nights) VALUES
  (4, NULL, 30000, 36000, 15, 2);

INSERT INTO settings (property_id, key, value) VALUES
  (2, 'deposit_pct', '30'),
  (2, 'balance_due_days', '30'),
  (2, 'hold_minutes', '30'),
  (2, 'allow_deposit', 'true'),
  (2, 'allow_full_payment', 'true'),
  (2, 'tourist_tax_cents_per_person_night', '100'),   -- TODO_TAXE commune de Braives
  (2, 'tourist_tax_include_children', 'true'),
  (2, 'caution_cents', '50000'),                      -- TODO_CAUTION Moulin
  (2, 'checkin_time', '16:00'),
  (2, 'checkout_time', '10:00'),
  (2, 'cgv_text', 'TODO_CGV Moulin de Braives (récupérables dans elloha, onglet « Contrat de location »).');
