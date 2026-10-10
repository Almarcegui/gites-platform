-- Migration 0026 — Langue de chaque réservation (lot 3, revue Codex : à part de 0025).
-- Langue dans laquelle la réservation a été faite (tunnel public FR/NL, lot 3) :
-- mails et voucher de CETTE réservation dans sa langue, même si le client en fait
-- une autre plus tard dans l'autre langue (guests.lang = dernier choix, repli).
-- NULL pour les réservations antérieures : on retombe sur guests.lang.
ALTER TABLE bookings ADD COLUMN lang TEXT CHECK (lang IS NULL OR lang IN ('fr', 'nl'));
