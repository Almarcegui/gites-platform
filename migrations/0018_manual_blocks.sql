-- 0018 — Blocages manuels (issue #74, R26)
--
-- Pourquoi : fermer un hébergement quelques jours (travaux, famille, entretien)
-- imposait de créer une fausse réservation. Elle polluait les statistiques de
-- vente, les exports comptables et les relances de solde.
--
-- Un blocage manuel occupe le stock EXACTEMENT comme une réservation
-- confirmée : la clause de conflit des cinq écritures atomiques de
-- src/db/repo.ts consulte cette table en plus de bookings, en empruntant la
-- même expansion par unit_links. Bloquer La Scierie bloque donc le Domaine.
--
-- Jamais de DELETE (convention du schéma) : la levée d'un blocage passe
-- active = 0, ce qui garde la trace de qui avait fermé quoi et pourquoi.

CREATE TABLE IF NOT EXISTS manual_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES units(id),
  checkin     TEXT NOT NULL,
  checkout    TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  released_at TEXT,
  released_by TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (checkin < checkout)
);

CREATE INDEX IF NOT EXISTS idx_manual_blocks_unit ON manual_blocks(unit_id, checkin, checkout);
CREATE INDEX IF NOT EXISTS idx_manual_blocks_active ON manual_blocks(active, checkout);
