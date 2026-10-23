-- Migration 0040 : conditions générales de location, version 3.2, domaine 1
-- (Pré Moré) seulement.
--
-- Décision de Julien du 23/10/2026 : départ avant 10 h, sauf le dimanche,
-- départ avant 18 h. Texte validé par lui le 23/10/2026. Seules modifications
-- par rapport à la 3.1 : l'en-tête (version et date), le point 6 du résumé
-- « Comment ça se passe » et l'article 8.1. Le Moulin de Braives (domaine 2)
-- garde la 3.1.
--
-- Les horaires affichés au client viennent des réglages checkout_time et
-- checkout_time_sunday (src/core/checkout-time.ts).
--
-- Archivage : le texte en place, s'il n'est pas déjà la version 3.2, est copié
-- sous la clé cgv_text_avant_3_2 (INSERT OR IGNORE : la première copie est la
-- bonne). getSettings ne lit pas cette clé. Les réservations existantes gardent
-- la version acceptée (bookings.cgv_version n'est pas touché).
--
-- Remplacement par replace() sur le texte 3.1 en place plutôt qu'une réécriture
-- complète : rien d'autre ne peut changer. La condition sur l'en-tête 3.1 rend
-- la migration rejouable (instr() et non LIKE : D1 refuse un motif LIKE
-- trop long). Mêmes règles que la 0036 : aucun point-virgule ni
-- double tiret dans les littéraux, apostrophes doublées.

INSERT OR IGNORE INTO settings (property_id, key, value)
  SELECT property_id, 'cgv_text_avant_3_2', value FROM settings
  WHERE key = 'cgv_text' AND property_id = 1 AND value NOT LIKE '%Version 3.2 —%';

UPDATE settings SET value =
  replace(
    replace(
      replace(value,
        'Version 3.1 — 12 octobre 2026.',
        'Version 3.2 — 23 octobre 2026.'),
      '6. Arrivée à partir de 18 h. Départ avant 18 h, ou à l''heure indiquée lors de la réservation.',
      '6. Arrivée à partir de 18 h. Départ avant 10 h, le dimanche avant 18 h, ou à l''heure indiquée lors de la réservation.'),
    '8.1. Arrivée à partir de 18 h, départ avant 18 h, sauf accord écrit contraire.',
    '8.1. Arrivée à partir de 18 h, départ avant 10 h, le dimanche avant 18 h, sauf accord écrit contraire.')
  WHERE key = 'cgv_text' AND property_id = 1
    AND instr(value, 'Version 3.1 — 12 octobre 2026.') > 0
    AND instr(value, '6. Arrivée à partir de 18 h. Départ avant 18 h, ou à l''heure indiquée lors de la réservation.') > 0
    AND instr(value, '8.1. Arrivée à partir de 18 h, départ avant 18 h, sauf accord écrit contraire.') > 0;
