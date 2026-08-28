-- Migration 0020 — Registre des personnes hébergées (issue #84).
--
-- Pourquoi : les coordonnées de réservation ne suffisent pas. Le réservant
-- n'est pas forcément un occupant, et ce qui doit être tenu porte sur
-- L'ENSEMBLE des personnes hébergées, pas sur le payeur.
--
-- Modèle : journal APPEND-ONLY. Une ligne = une déclaration d'occupant faite à
-- l'arrivée. Une correction ne réécrit jamais la ligne fautive : elle ajoute
-- une ligne qui la REMPLACE, en la désignant par supersedes_id. Le registre
-- « en vigueur » est donc l'ensemble des lignes qu'aucune autre ne remplace,
-- et la trace de la correction reste lisible.
--
-- Conséquence directe : aucun UPDATE ni DELETE de contenu n'est écrit sur
-- cette table. Le SEUL DELETE du projet sur guest_register est la purge de
-- conservation (7 ans), portée par le traitement planifié.
--
-- Ces données sont cloisonnées : elles ne partent ni dans les e-mails, ni vers
-- les canaux OTA, ni dans l'export iCal, ni dans les statistiques, ni sur le
-- voucher client. Elles ne sortent que par l'export CSV du back-office, sur
-- demande d'une autorité.
--
-- Saisi par / saisi le : recorded_by porte l'identité admin authentifiée
-- (guard de src/api/admin.ts), recorded_at l'horodatage serveur.

CREATE TABLE IF NOT EXISTS guest_register (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     INTEGER NOT NULL REFERENCES bookings(id),
  supersedes_id  INTEGER REFERENCES guest_register(id),
  last_name      TEXT NOT NULL,
  first_name     TEXT NOT NULL,
  birth_date     TEXT NOT NULL,
  nationality    TEXT NOT NULL,
  id_type        TEXT NOT NULL CHECK (id_type IN ('id_card', 'passport', 'residence_permit', 'other')),
  id_number      TEXT NOT NULL,
  arrival_date   TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  recorded_by    TEXT NOT NULL DEFAULT '',
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (arrival_date < departure_date),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

-- Fiche réservation : les lignes d'un séjour, dans l'ordre de saisie.
CREATE INDEX IF NOT EXISTS idx_guest_register_booking ON guest_register(booking_id, id);

-- Export par période et purge de conservation.
CREATE INDEX IF NOT EXISTS idx_guest_register_arrival ON guest_register(arrival_date);
CREATE INDEX IF NOT EXISTS idx_guest_register_departure ON guest_register(departure_date);

-- Une ligne ne peut être remplacée QU'UNE FOIS : sans cet index, deux
-- corrections concurrentes de la même ligne créeraient deux versions
-- « en vigueur » du même occupant, et le registre cesserait d'être lisible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_register_supersedes
  ON guest_register(supersedes_id) WHERE supersedes_id IS NOT NULL;
