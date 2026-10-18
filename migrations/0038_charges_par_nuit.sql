-- Migration 0038 : frais généraux (ménage et charges) = forfait pour un nombre
-- de nuits incluses, plus un supplément de charges par nuit au-delà.
--
-- Règle décidée par le propriétaire le 18/10/2026. Exemple : forfait 240 euros
-- pour 2 nuits, plus 25 euros par nuit à partir de la 3e, donc 4 nuits = 290 euros.
-- `cleaning_fee_cents` reste le forfait. Valeurs par défaut : supplément 0, donc
-- aucun changement de prix au déploiement tant que le propriétaire ne règle rien.

ALTER TABLE units ADD COLUMN charges_extra_night_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN fee_included_nights INTEGER NOT NULL DEFAULT 2;
