-- Lot 2 — tunnel de réservation : preuve d'acceptation des CGV (signature
-- électronique simple, art. 8.1 C. civ. + eIDAS : version/hash + horodatage
-- serveur + IP) et opt-in marketing explicite (art. XII.13 CDE — case non
-- pré-cochée côté front).

ALTER TABLE bookings ADD COLUMN cgv_version TEXT;
ALTER TABLE bookings ADD COLUMN cgv_accepted_at TEXT;
ALTER TABLE bookings ADD COLUMN cgv_ip TEXT;

ALTER TABLE guests ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN marketing_opt_in_at TEXT;
