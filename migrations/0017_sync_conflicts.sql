-- Migration 0017 — Conflits de synchronisation persistés (issue #72).
--
-- Jusqu'ici, un conflit détecté par l'import iCal ou par le rapatriement des
-- canaux partait dans `audit_log` et dans le champ `last_status` du flux, tous
-- deux ÉCRASÉS au tick suivant (le cron passe 96 fois par jour). Résultat :
-- l'exploitant n'a jamais eu sous les yeux la liste de ce qui ne se synchronise
-- pas, ni depuis quand.
--
-- Modèle : une ligne par conflit DISTINCT, pas une par détection. L'empreinte
-- `fingerprint` porte l'identité du conflit (source, nature, hébergement,
-- dates, identifiant externe) ; deux ticks successifs sur le même conflit
-- mettent à jour `last_seen_at` et laissent `first_seen_at` intact.
--
-- Cycle de vie :
--   open      détecté, toujours reproduit à chaque passage ;
--   resolved  posé automatiquement quand le conflit ne se reproduit plus
--             (l'événement a disparu de la source, ou le créneau s'est libéré) ;
--   ignored   décision humaine, avec motif, dans la vue Canaux. Un conflit
--             ignoré reste ignoré même s'il est redétecté — sans quoi le
--             bouton « Ignorer » ne tiendrait pas un quart d'heure.
--
-- `scope` désigne l'ensemble que balaie un passage de synchro (un flux iCal,
-- un domaine côté canaux) : c'est la clé qui permet de refermer les conflits
-- disparus SANS toucher à ceux d'une autre source.
--
-- Statuts en anglais, comme les autres énumérations du schéma
-- (bookings.status, bookings.source) ; la traduction vit dans le back-office.

CREATE TABLE sync_conflicts (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  source TEXT NOT NULL CHECK (source IN ('ical', 'beds24')),
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'move', 'relocate', 'reactivate')),
  fingerprint TEXT NOT NULL,
  checkin TEXT NOT NULL,
  checkout TEXT NOT NULL,
  external_uid TEXT,
  booking_reference TEXT,
  channel_label TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  ignore_reason TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  CHECK (checkin < checkout)
);

-- L'empreinte est UNIQUE : c'est elle qui fait qu'un conflit reproduit 96 fois
-- par jour reste UNE ligne. L'écriture est un upsert sur cet index.
CREATE UNIQUE INDEX idx_sync_conflicts_fingerprint ON sync_conflicts(fingerprint);

-- Lecture de la vue Canaux (conflits d'un domaine, les ouverts d'abord) et
-- fermeture par passage de synchro.
CREATE INDEX idx_sync_conflicts_property ON sync_conflicts(property_id, status);
CREATE INDEX idx_sync_conflicts_scope ON sync_conflicts(scope, status);
