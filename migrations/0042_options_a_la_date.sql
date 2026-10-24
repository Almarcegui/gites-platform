-- Migration 0042 : options réservées à une date du séjour (décisions du propriétaire, 24/10/2026).
--
--   per_date          1 : l'option se réserve jour par jour, un seul client par jour pour
--                 tout le domaine. 0 (défaut) : comportement inchangé
--   weekend_price_cents  prix d'un jour de week-end. NULL : même prix que la semaine
--                 (price_cents)
--   weekend_days      jours comptés week-end, numéros 0 (dimanche) à 6 (samedi) séparés
--                 par des virgules. NULL : vendredi, samedi, dimanche
--   consecutive_pct   pourcentage du prix pour un jour qui suit immédiatement un autre
--                 jour choisi. NULL : pas de remise
--
-- Aucune valeur n'est changée sur les options existantes.
--
-- option_days : un jour pris pour une option. L'unicité (option_id, date) sur les lignes
-- actives protège de la course entre deux clients.

ALTER TABLE options ADD COLUMN per_date INTEGER NOT NULL DEFAULT 0;
ALTER TABLE options ADD COLUMN weekend_price_cents INTEGER;
ALTER TABLE options ADD COLUMN weekend_days TEXT;
ALTER TABLE options ADD COLUMN consecutive_pct INTEGER;

CREATE TABLE option_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_id INTEGER NOT NULL REFERENCES options(id),
  date TEXT NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX uq_option_days_slot ON option_days(option_id, date);
CREATE INDEX idx_option_days_booking ON option_days(booking_id);
CREATE INDEX idx_option_days_date ON option_days(date);
