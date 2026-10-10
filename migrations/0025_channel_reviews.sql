-- Migration 0025 — Avis des plateformes (Airbnb, Booking.com) relevés par Beds24 (lot 3).
-- Lecture seule : Beds24 ne permet pas d'y répondre par l'API (findings Beds24 § 5) ;
-- la carte « Avis » d'Aujourd'hui renvoie vers Beds24 pour répondre.
--
-- Le cron relève au plus toutes les 6 heures :
--   GET /channels/airbnb/reviews?roomId=…            (Beta, 100 au plus, une chambre par appel)
--   GET /channels/booking/reviews?propertyId=…&from=… (Alpha, 100 au plus)
-- Une ligne par avis, mise à jour quand l'avis change (réponse de l'hôte, note).
--   rating      : note ramenée sur 5 (Airbnb : overall_rating 1-5 ; Booking : review_score / 2)
--   raw_score / raw_scale : la note telle que le canal la donne (5 ou 10)
--   Les commentaires privés au propriétaire (private_feedback d'Airbnb) ne sont PAS gardés.

CREATE TABLE channel_reviews (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('airbnb', 'booking')),
  external_id TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  booking_ref TEXT,
  rating REAL,
  raw_score REAL,
  raw_scale INTEGER NOT NULL,
  reviewer_name TEXT,
  language TEXT,
  headline TEXT,
  body_text TEXT,
  negative_text TEXT,
  reply_text TEXT,
  replied_at TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, external_id)
);
CREATE INDEX idx_channel_reviews_property ON channel_reviews(property_id, submitted_at);
