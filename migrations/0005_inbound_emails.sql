-- Migration 0005 — Intégration email : boîte de réception de la plateforme.
-- Les mails entrants (Cloudflare Email Routing → Email Worker) sont stockés
-- ici, rattachés au client/à la résa quand c'est possible, avec accusé de
-- réception automatique (désactivé par défaut) et transfert vers l'adresse
-- personnelle de Julien (vide par défaut).

CREATE TABLE inbound_emails (
  id INTEGER PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  message_id TEXT,                       -- Message-ID (dédoublonnage des re-livraisons)
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  booking_id INTEGER REFERENCES bookings(id),
  guest_id INTEGER REFERENCES guests(id),
  status TEXT NOT NULL DEFAULT 'nouveau' CHECK (status IN ('nouveau', 'traité')),
  auto_replied INTEGER NOT NULL DEFAULT 0,
  forwarded INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_inbound_message_id ON inbound_emails(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_inbound_status ON inbound_emails(status, property_id);

-- Réglages email par domaine. L'accusé de réception automatique est OFF par
-- défaut : AUCUN envoi réel sans décision explicite de Julien.
INSERT INTO settings (property_id, key, value) VALUES
  (1, 'auto_reply_enabled', 'false'),
  (1, 'auto_reply_text', 'Bonjour,

Merci pour votre message — nous l''avons bien reçu et nous vous répondons au plus vite (en général sous 24 h).

Pour toute question sur une réservation existante, pensez à mentionner votre référence (ex. PM-2026-001).

À très bientôt,
Les Gîtes du Pré Moré'),
  (1, 'email_forward_to', ''),
  (2, 'auto_reply_enabled', 'false'),
  (2, 'auto_reply_text', 'Bonjour,

Merci pour votre message — nous l''avons bien reçu et nous vous répondons au plus vite (en général sous 24 h).

À très bientôt,
Le Moulin de Braives'),
  (2, 'email_forward_to', '');
