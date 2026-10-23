-- Migration 0039 : minimum de nuits de dernière minute.
--
-- Décision du 23/10/2026 : pendant les vacances, on garde des séjours longs
-- (6 nuits), puis le minimum baisse si les nuits restent libres à l'approche.
-- Paliers stockés « jours:nuits » séparés par des virgules, par exemple
-- « 28:3,14:2 » : 3 nuits à 28 jours ou moins de la nuit d'arrivée, 2 nuits à
-- 14 jours ou moins. NULL = minimum fixe, donc aucun changement au déploiement.

ALTER TABLE rate_rules ADD COLUMN min_nights_relax TEXT;
