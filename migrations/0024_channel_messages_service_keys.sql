-- Migration 0024 — Messagerie des canaux (Airbnb, Booking.com, Vrbo, Expedia) par Beds24,
-- et clés d'accès de service (fin du fichier).
-- Décision de Julien du 10/10/2026 : une seule boîte de réception dans la plateforme,
-- sans ouvrir Beds24. Beds24 n'a pas de webhook pour les messages : le cron les relève
-- (GET /bookings/messages, filter=unread), une fois par passage.
--
-- Chaque message Beds24 est gardé ici tel quel (identifiant Beds24, réservation, sens,
-- texte, lu, date). Les messages du voyageur et de l'hôte sont en plus recopiés dans
-- `messages` (channel = 'beds24') : le fil, la liste et la réponse du back-office
-- restent ceux qui existent. message_id relie les deux.
--   source  : guest (voyageur), host (hôte), internalNote, system (Beds24 ou le canal)
--   direction : in (voyageur), out (hôte), note (note interne ou message système)
--   beds24_message_id NULL : réponse partie de chez nous, dont Beds24 ne rend pas l'identifiant

CREATE TABLE channel_messages (
  id INTEGER PRIMARY KEY,
  beds24_message_id INTEGER UNIQUE,
  beds24_booking_id INTEGER NOT NULL,
  booking_id INTEGER REFERENCES bookings(id),
  property_id INTEGER REFERENCES properties(id),
  message_id INTEGER REFERENCES messages(id),
  source TEXT NOT NULL CHECK (source IN ('guest', 'host', 'internalNote', 'system')),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  channel_label TEXT,
  body_text TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_channel_messages_booking ON channel_messages(beds24_booking_id);
CREATE INDEX idx_channel_messages_message ON channel_messages(message_id);

-- Accès de service (demande de Julien du 10/10/2026) : des clés d'API pour Claude
-- et les scripts du Mac, sans compte humain. Présentées en Authorization Bearer
-- svc:<clé>. Seul le SHA-256 de la clé est gardé : elle n'est affichée qu'une fois,
-- à la création (page Utilisateurs, section Accès de service). Révoquer = poser
-- revoked_at, jamais effacer : le journal garde qui a fait quoi avec quelle clé.
--   role : admin seulement pour l'instant (mêmes droits qu'un compte du back-office)

CREATE TABLE service_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);
