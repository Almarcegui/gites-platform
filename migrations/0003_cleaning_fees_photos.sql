-- Migration 0003 — Frais de ménage par bien + photo principale + données
-- réelles du site lesgitesdupremore.be (relevé du 2026-07-12).
-- Le modèle tarifaire réel du site : location « sur demande » (grille location
-- toujours TODO Julien) + charges/nuit saisonnières (intégrées au tarif nuit
-- chez nous) + NETTOYAGE fixe par séjour (ci-dessous, réel) + draps en option.

ALTER TABLE units ADD COLUMN cleaning_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN photo_url TEXT;

-- Frais de ménage réels (site Pré Moré) : Scieur 120 €, Scierie 90 €.
-- Le Domaine entier est en mode « somme » : son ménage = somme des deux (moteur).
UPDATE units SET cleaning_fee_cents = 12000 WHERE id = 1;
UPDATE units SET cleaning_fee_cents = 9000 WHERE id = 2;

-- Photos réelles (hébergées sur le site WordPress existant).
UPDATE units SET photo_url = 'https://lesgitesdupremore.be/wp-content/uploads/2019/08/vue-berge.jpg' WHERE id = 1;
UPDATE units SET photo_url = 'https://lesgitesdupremore.be/wp-content/uploads/2019/08/scierie.jpg' WHERE id = 2;
UPDATE units SET photo_url = 'https://lesgitesdupremore.be/wp-content/uploads/2019/08/entre-maisons.jpg' WHERE id = 3;

-- Accroches réelles du site.
UPDATE units SET description = 'Robuste et prévue pour les groupes — jusqu''à 11 personnes au bord du Ry des Glands.' WHERE id = 1;
UPDATE units SET description = 'Une maison intime et chaleureuse pour 6 à 8 personnes, au fil de l''eau.' WHERE id = 2;
UPDATE units SET description = 'Les deux maisons ensemble — isolement total au milieu d''un magnifique territoire de promenade, jusqu''à 19 personnes.' WHERE id = 3;

-- Options linge réelles : draps et taies, lit simple 7 € / lit double 10 €
-- (remplacent le placeholder « Linge de maison »).
DELETE FROM options WHERE property_id = 1 AND name = 'Linge de maison';
INSERT INTO options (property_id, name, pricing_mode, price_cents, unit_label, max_qty, sort_order) VALUES
  (1, 'Draps et taies — lit simple', 'per_unit_qty', 700, 'lit', 15, 4),
  (1, 'Draps et taies — lit double', 'per_unit_qty', 1000, 'lit', 8, 5);

-- Adresse et contact réels (site) — l'email de réservation reste TODO Julien.
UPDATE properties SET
  address = 'Hameau du Pré Moré, 6890 Redu (Daverdisse)',
  contact_phone = '0498/440 883'
WHERE id = 1;
