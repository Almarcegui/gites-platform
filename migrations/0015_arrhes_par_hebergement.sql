-- Migration 0015 — Pourcentage d'arrhes propre à chaque hébergement (issue #75).
--
-- Décision du propriétaire du 28/08/2026 : le pourcentage d'arrhes cesse d'être
-- un réglage du domaine pour devenir un paramètre de l'hébergement, et la
-- valeur en vigueur passe de 30 à 50.
--
-- Colonne sur units plutôt qu'entrée clé/valeur dans settings, exactement pour
-- la raison invoquée en 0014 pour price_min_cents : la borne est un attribut de
-- l'unité, la ligne units est déjà chargée au moment du devis, et un stockage
-- clé/valeur imposerait d'encoder l'id d'unité dans la clé.
--
-- deposit_pct NULL = pas de valeur propre à l'hébergement. Le devis retombe
-- alors sur settings.deposit_pct du domaine. C'est le repli attendu pour tout
-- hébergement créé plus tard sans saisie explicite.
--
-- L'UPDATE qui suit sème les hébergements EXISTANTS à 50, conformément à la
-- décision. Il ne touche pas settings.deposit_pct des domaines, qui reste la
-- valeur de repli.

ALTER TABLE units ADD COLUMN deposit_pct INTEGER;

UPDATE units SET deposit_pct = 50;
