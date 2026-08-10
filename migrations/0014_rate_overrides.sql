-- Migration 0014 — Surcharges tarifaires par jour (issue #23) et garde-fous de
-- prix par hébergement (issue #31), suivant la spec UX du 10/08 sections 3 et 6.
--
-- Modèle : la saison reste le fond de teinte, la surcharge du jour prime.
-- Priorité de résolution d'une nuit : surcharge du jour > règle de saison >
-- tarif de base.
--
-- Une surcharge de prix est un PRIX FINAL ABSOLU (spec section 3) : ni le
-- supplément week-end ni la majoration fériés ne s'y ajoutent. Sans cette
-- règle, saisir 200 euros sur le 21 juillet facturerait 230 euros.
--
-- price_cents NULL = pas de surcharge de prix (la saison s'applique).
-- min_nights NULL = pas de surcharge de minimum de nuits.
-- Le minimum de nuits ne concerne que la NUIT D'ARRIVÉE (spec section 4) :
-- il interdit d'arriver ce jour-là pour moins de N nuits, il n'interdit pas
-- un séjour qui enjambe le jour.
--
-- Retirer une surcharge = revenir à la saison, jamais un 0 fantôme : une ligne
-- dont les deux colonnes seraient NULL n'a pas de sens, le CHECK l'interdit et
-- le code supprime la ligne à la place.

CREATE TABLE rate_overrides (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  date TEXT NOT NULL,
  price_cents INTEGER,
  min_nights INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, date),
  CHECK (price_cents IS NULL OR price_cents > 0),
  CHECK (min_nights IS NULL OR min_nights >= 1),
  CHECK (price_cents IS NOT NULL OR min_nights IS NOT NULL)
);

CREATE INDEX idx_rate_overrides_unit_date ON rate_overrides(unit_id, date);

-- Garde-fous de prix par hébergement (issue #31, spec section 6 point 2).
-- Colonne plutôt qu'entrée app_settings : la borne est un attribut de l'unité,
-- relue à CHAQUE écriture tarifaire (règle de saison comme surcharge de jour),
-- et la ligne units est déjà chargée à ce moment-là. La stocker en clé/valeur
-- imposerait un encodage de l'id d'unité dans la clé et une lecture de plus.
-- NULL = aucune borne configurée pour ce bien.
ALTER TABLE units ADD COLUMN price_min_cents INTEGER;
ALTER TABLE units ADD COLUMN price_max_cents INTEGER;
