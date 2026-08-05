-- Décisions Julien 27/07 (risque de requalification fiscale « services » — TVA
-- para-hôtellerie) + photos rapatriées en local (le WordPress ne sert plus les
-- images aux navigateurs, et il est destiné à disparaître).
--
-- 1. Draps et taies : plus une option payante — inclus de base dans les frais
--    généraux (ménage + charges). Les deux options draps sont désactivées.
-- 2. Option « Ménage de fin de séjour » : doublon du forfait ménage déjà
--    obligatoire dans le devis (cleaning_fee_cents par unité) — désactivée.
-- 3. Sauna et bain chaud restent réservables (mise à disposition d'équipement,
--    bouton « Ajouter » côté front).
-- 4. Taxe de séjour : aucune pour le moment (0) — la ligne disparaît du devis.
-- 5. Arrivée 18:00, départ 18:00 (rotation le jour même possible, le moteur
--    travaille en intervalles semi-ouverts).
-- 6. photo_url des unités : assets locaux /img/ servis par le Worker.

UPDATE options SET active = 0 WHERE name LIKE 'Draps et taies%';
UPDATE options SET active = 0 WHERE name = 'Ménage de fin de séjour';

UPDATE settings SET value = '0' WHERE key = 'tourist_tax_cents_per_person_night';
UPDATE settings SET value = '18:00' WHERE key = 'checkin_time';
UPDATE settings SET value = '18:00' WHERE key = 'checkout_time';

UPDATE units SET photo_url = '/img/vue-berge.jpg' WHERE id = 1;
UPDATE units SET photo_url = '/img/scierie.jpg' WHERE id = 2;
UPDATE units SET photo_url = '/img/entre-maisons.jpg' WHERE id = 3;
UPDATE units SET photo_url = '/img/moulin.jpg' WHERE id = 4;
