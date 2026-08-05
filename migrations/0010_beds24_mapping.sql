-- Liaison Beds24 (canal OTA) — créés par API le 2026-07-28 sur GO Julien :
-- property #344555 « Les Gîtes du Pré Moré », rooms #711713 (Scieur) et
-- #711714 (Scierie). Le Domaine entier n'a PAS de room Beds24 : il se vend en
-- direct uniquement — sa liaison est déjà reflétée dans les calendriers des
-- deux maisons que notre moteur pousse (Domaine réservé → les 2 rooms fermées).

ALTER TABLE properties ADD COLUMN beds24_property_id INTEGER;
ALTER TABLE units ADD COLUMN beds24_room_id INTEGER;

UPDATE properties SET beds24_property_id = 344555 WHERE id = 1;
UPDATE units SET beds24_room_id = 711713 WHERE id = 1;
UPDATE units SET beds24_room_id = 711714 WHERE id = 2;
