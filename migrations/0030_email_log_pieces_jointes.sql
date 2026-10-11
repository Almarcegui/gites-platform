-- 0030 — Journal des mails : pièces jointes
--
-- Le mail de confirmation part avec le contrat de location en PDF. Le journal
-- (email_log) garde le texte du message ; cette colonne dit en plus quelles
-- pièces jointes sont parties, par leur nom et leur taille en octets, jamais
-- leur contenu. Vide ou NULL : aucune pièce jointe.

ALTER TABLE email_log ADD COLUMN attachments TEXT;
