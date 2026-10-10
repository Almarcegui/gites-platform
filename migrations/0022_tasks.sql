-- Migration 0022 : ménage et tâches en base (plan v4, fonction 1, lot 2 du nouvel écran).
--
-- POURQUOI. Le pilote dérivait le ménage des départs à l'écran et gardait la
-- case « fait » dans le navigateur d'un seul appareil. La personne du ménage
-- n'y avait pas accès, et deux téléphones voyaient deux états différents.
-- Cette table garde une tâche par départ, son état, la personne assignée et
-- une note, et une seconde table porte les liens de partage sans connexion.
--
-- GÉNÉRATION. Les tâches de ménage ne se saisissent pas : elles sont produites
-- par les départs (src/core/cleaning.ts), au cron et à chaque lecture de
-- l'écran. La génération est idempotente : une tâche par réservation (index
-- unique booking_id + kind), mise à jour si le séjour bouge, passée à
-- « annule » si la réservation disparaît, jamais supprimée. L'état « fait »,
-- la personne et la note ne sont jamais écrasés par la génération.
--
-- DONNÉES. Aucune donnée de voyageur ici : ni nom, ni contact. Le nombre de
-- voyageurs est celui de l'ARRIVÉE SUIVANTE (ce qu'il faut préparer).
--
-- LIENS DE PARTAGE. Seul le SHA-256 du jeton est stocké, comme pour les
-- sessions du back-office : une fuite de la base ne rouvre aucun lien. Un lien
-- se coupe (revoked_at), il ne se supprime pas.

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  -- Réservation qui part. NULL réservé aux tâches saisies à la main (plus tard).
  booking_id INTEGER REFERENCES bookings(id),
  kind TEXT NOT NULL DEFAULT 'menage' CHECK (kind IN ('menage', 'autre')),
  -- Jour du départ (AAAA-MM-JJ) et heure de départ du domaine (HH:MM).
  due_date TEXT NOT NULL,
  due_time TEXT,
  -- Arrivée suivante sur ce bien ou un bien lié (mêmes murs), si elle existe.
  next_checkin TEXT,
  next_checkin_time TEXT,
  next_unit_id INTEGER REFERENCES units(id),
  next_persons INTEGER,
  status TEXT NOT NULL DEFAULT 'a_faire' CHECK (status IN ('a_faire', 'fait', 'annule')),
  assignee TEXT CHECK (assignee IS NULL OR length(assignee) <= 60),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  done_at TEXT,
  done_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_booking_kind ON tasks (booking_id, kind) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (property_id, due_date);

CREATE TABLE IF NOT EXISTS task_share_links (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  -- Pour qui est le lien (« Martine », « équipe du samedi »). Montré sur la page.
  label TEXT NOT NULL CHECK (length(trim(label)) >= 2 AND length(label) <= 60),
  -- Domaine visé. NULL = tous les domaines.
  property_id INTEGER REFERENCES properties(id),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
