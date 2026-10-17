-- Migration 0037 : délai minimum de réservation, trois modèles de réponse FR et NL.
--
-- Demandes des testeurs du 17/10/2026 :
--   n° 15 (le propriétaire) : « dernière réservation minimum cinq jours avant
--   le jour d'arrivée ». Nouveau réglage du DOMAINE `min_lead_days` (table
--   settings, clé/valeur), lu par getSettings. Le site public le fait
--   respecter côté serveur (devis, recherche, calendrier, création), le
--   back-office peut passer outre avec un avertissement. Valeur posée ici : 0,
--   c'est-à-dire aucun changement de comportement au déploiement. Le
--   propriétaire règle lui-même la valeur dans Réglages › Domaine.
--   n° 9 (Matthieu) : trois modèles de réponse, en français et en néerlandais,
--   « Confirmation de réservation », « Annulation », « Revenez nous voir ».
--   Le modèle d'annulation renvoie aux conditions générales sans les résumer
--   (version 3.1 en discussion).
--
-- Rejouable : chaque INSERT est gardé par un NOT EXISTS (sur la clé du
-- réglage, sur le nom du modèle). Un modèle déjà créé à la main sous le même
-- nom n'est ni dupliqué ni écrasé.
--
-- Mêmes règles que les autres migrations : aucun point-virgule ni double tiret
-- dans un littéral, apostrophes doublées. Variables du même format que la 0023.

INSERT INTO settings (property_id, key, value)
SELECT p.id, 'min_lead_days', '0' FROM properties p
WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.property_id = p.id AND s.key = 'min_lead_days');

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Confirmation de réservation', 'fr', 'Bonjour {prenom},

Nous vous confirmons votre réservation à {bien}, avec une arrivée le {arrivee} à partir de {heure_arrivee}. Le départ se fait avant {heure_depart}.
Le détail de votre séjour figure dans votre confirmation de réservation. Pour toute question d''ici là, il vous suffit de répondre à ce message.

Nous nous réjouissons de vous accueillir.
{signature}', 50
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE lower(trim(name)) = lower('Confirmation de réservation'));

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Bevestiging van de reservering', 'nl', 'Beste {prenom},

Wij bevestigen uw reservering in {bien}, met aankomst op {arrivee} vanaf {heure_arrivee}. Het vertrek is vóór {heure_depart}.
U vindt alle details van uw verblijf in uw reserveringsbevestiging. Hebt u intussen een vraag, dan kunt u gewoon op dit bericht antwoorden.

Wij kijken ernaar uit u te ontvangen.
{signature}', 51
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE lower(trim(name)) = lower('Bevestiging van de reservering'));

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Annulation', 'fr', 'Bonjour {prenom},

Nous avons bien enregistré l''annulation de votre réservation à {bien}, prévue à partir du {arrivee}.
Les suites de cette annulation, notamment pour les sommes déjà versées, sont celles prévues par les conditions générales de location acceptées lors de votre réservation.
Si vous avez une question, il vous suffit de répondre à ce message.

Bien cordialement,
{signature}', 60
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE lower(trim(name)) = lower('Annulation'));

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Annulering', 'nl', 'Beste {prenom},

Wij hebben de annulering van uw reservering in {bien}, vanaf {arrivee}, goed ontvangen.
Wat de gevolgen van deze annulering betreft, ook voor de reeds betaalde bedragen, gelden de algemene huurvoorwaarden die u bij uw reservering hebt aanvaard.
Hebt u een vraag, dan kunt u gewoon op dit bericht antwoorden.

Met vriendelijke groeten,
{signature}', 61
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE lower(trim(name)) = lower('Annulering'));

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Revenez nous voir', 'fr', 'Bonjour {prenom},

Merci encore d''avoir séjourné à {bien}.
Si l''envie vous prend de revenir, pour un week-end ou pour des vacances plus longues, nous serons heureux de vous accueillir à nouveau. Le calendrier et les prix sont à jour sur notre site, et vous pouvez aussi simplement répondre à ce message.

Au plaisir de vous revoir,
{signature}', 70
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE lower(trim(name)) = lower('Revenez nous voir'));

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Kom ons nog eens bezoeken', 'nl', 'Beste {prenom},

Nogmaals bedankt voor uw verblijf in {bien}.
Hebt u zin om terug te komen, voor een weekend of voor een langere vakantie, dan ontvangen wij u met plezier opnieuw. De kalender en de prijzen staan bijgewerkt op onze website, en u kunt ook gewoon op dit bericht antwoorden.

Tot een volgende keer,
{signature}', 71
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE lower(trim(name)) = lower('Kom ons nog eens bezoeken'));
