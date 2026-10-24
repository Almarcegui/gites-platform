-- Migration 0041 : gestion de la messagerie (décisions du propriétaire, 24/10/2026).
--
--   link_manual   1 : le rattachement de ce message (réservation, ou aucune) a été choisi à la
--                 main depuis Messages. Il prime ensuite sur le rattachement automatique :
--                 la réponse d'un client dans le même fil, ou un autre mail de la même
--                 adresse, reprend ce choix au lieu de l'écraser
--   sender_auth   1 : Gmail atteste l'expéditeur (DMARC ou DKIM pass). NULL ou 0 : non
--                 attesté. Sert à décider si les liens d'un mail peuvent être ouverts

ALTER TABLE messages ADD COLUMN link_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN sender_auth INTEGER;

CREATE INDEX idx_messages_link_manual ON messages(link_manual, from_email) WHERE link_manual = 1;
