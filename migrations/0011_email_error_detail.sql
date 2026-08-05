-- LOT A0 (audit ECC 2026-07-30) — traçabilité des échecs d'envoi.
-- Sans le détail de l'erreur Resend (clé expirée, quota, adresse from non
-- verifiee), un voucher jamais parti etait indiscernable d'un envoi desactive.
-- La carte Sante du tableau de bord lit cette colonne.
-- RAPPEL DE REDACTION : jamais de point-virgule ni de double tiret dans un
-- litteral SQL de migration (le splitter des tests est volontairement naif).

ALTER TABLE email_log ADD COLUMN error_detail TEXT;
