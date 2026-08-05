-- Migration 0006 — Les échanges clients vivent DANS la plateforme.
-- La table inbound_emails devient `messages` : fils de conversation entrants
-- ET sortants, par réservation/client, quel que soit le canal :
--   channel 'email'  → arrivé par Cloudflare Email Routing (ou simulation)
--   channel 'form'   → écrit par le client sur la page publique / son voucher
--   direction 'in'   → message du client   · 'out' → réponse de l'équipe
-- L'email n'est plus qu'une couche optionnelle : sans lui, tout fonctionne
-- (formulaire → boîte Messages → réponse visible sur le voucher du client).

ALTER TABLE inbound_emails RENAME TO messages;
ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'in';
ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';
-- Pour les sortants : trace de la notification email ('aucune'|'stub'|'sent'|'failed').
ALTER TABLE messages ADD COLUMN delivery TEXT;
