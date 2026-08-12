-- Journal des recherches (issue #36, décision du 10/08/2026).
--
-- POURQUOI : le back-office sait ce qui a été vendu, jamais ce qui a été
-- cherché. Une accumulation de recherches infructueuses sur les mêmes dates est
-- l'information commerciale la plus utile du système, et c'est la seule qui ne
-- se reconstitue pas après coup : une recherche non enregistrée est perdue.
--
-- MINIMISATION DES DONNÉES (RGPD, article 5.1.c) : cette table est conçue pour
-- NE PAS être une donnée personnelle. On enregistre ce qui a été cherché, pas
-- qui a cherché.
--
--   Enregistré     : dates demandées, nombre de personnes, hébergement visé,
--                    résultat trouvé ou non, horodatage.
--   JAMAIS         : adresse IP (même tronquée), e-mail, nom, identifiant de
--                    session, empreinte de navigateur, en-tête User-Agent.
--
-- Aucune colonne ci-dessous ne permet, seule ou combinée aux autres, de
-- remonter à une personne. La table n'a volontairement AUCUNE clé étrangère
-- vers guests, et il ne faut pas lui en ajouter : ce serait précisément ce qui
-- la ferait basculer dans le champ des données personnelles.
--
-- La collecte reste à mentionner dans la politique de confidentialité du site
-- public au moment de sa rédaction (page hors du périmètre de cette issue).

CREATE TABLE search_log (
  id          INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  -- Hébergement concerné. NULL pour une recherche portant sur tout le domaine
  -- (cas de la recherche de disponibilité, qui interroge toutes les unités).
  unit_id     INTEGER REFERENCES units(id),
  -- Étape du parcours : 'search' = recherche de disponibilité,
  -- 'quote' = devis détaillé affiché. C'est ce qui alimente l'entonnoir.
  stage       TEXT NOT NULL DEFAULT 'search' CHECK (stage IN ('search', 'quote')),
  checkin     TEXT NOT NULL,
  checkout    TEXT NOT NULL,
  nights      INTEGER NOT NULL,
  adults      INTEGER NOT NULL,
  children    INTEGER NOT NULL DEFAULT 0,
  -- Nombre d'hébergements réservables trouvés. 0 = recherche infructueuse.
  results     INTEGER NOT NULL DEFAULT 0,
  -- Redondant avec results, et c'est voulu : c'est LA colonne qu'on filtre, et
  -- un index sur un booléen reste utile là où un index sur un compteur ne l'est
  -- pas. 1 = au moins un hébergement réservable.
  found       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fenêtre temporelle : toutes les vues de statistiques filtrent sur une année.
CREATE INDEX idx_search_log_created ON search_log(created_at);

-- La requête qui porte la valeur de la table : les dates les plus demandées
-- sans réponse. L'index composite évite un balayage complet quand le journal
-- aura grossi.
CREATE INDEX idx_search_log_empty ON search_log(found, checkin);

-- Découpage par domaine, pour un back-office multi-biens.
CREATE INDEX idx_search_log_property ON search_log(property_id, created_at);
