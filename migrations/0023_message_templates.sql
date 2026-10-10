-- Migration 0023 : modèles de réponse en base (plan v4, fonction 2, lot 2 du nouvel écran).
--
-- POURQUOI. Le pilote avait quatre modèles écrits en dur dans l'écran. Les
-- textes changent (code de la boîte à clés, consignes de parking) et doivent
-- exister en néerlandais : ils passent en base, modifiables dans Réglages.
--
-- VARIABLES. Le corps peut contenir {prenom}, {bien}, {arrivee}, {solde},
-- {heure_arrivee}, {heure_depart} et {signature}. L'écran Messages les remplit
-- à partir de la réservation liée au message. Une variable inconnue reste telle
-- quelle, visible, plutôt que de disparaître en silence.
--
-- PORTÉE. property_id NULL = modèle commun à tous les domaines.
--
-- SEED. Les quatre modèles du pilote, en français. Le texte n'a ni point-virgule
-- ni double tiret (cf. migrations/README.md). Seed posé seulement si la table
-- est vide.

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  name TEXT NOT NULL CHECK (length(trim(name)) >= 2 AND length(name) <= 60),
  lang TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr', 'nl', 'en')),
  body TEXT NOT NULL CHECK (length(trim(body)) >= 2 AND length(body) <= 4000),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_message_templates_order ON message_templates (sort_order, id);

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Accès et clés', 'fr', 'Bonjour {prenom},

{bien} vous attend {arrivee}, à partir de {heure_arrivee}.
Les clés sont dans la boîte à code, à côté de la porte d''entrée. Le code vous parvient par SMS le matin de votre arrivée.
Vous pouvez vous garer devant la maison.

Bonne route,
{signature}', 10
WHERE NOT EXISTS (SELECT 1 FROM message_templates);

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Horaires', 'fr', 'Bonjour {prenom},

L''arrivée se fait à partir de {heure_arrivee} et le départ avant {heure_depart}.
Si vous avez besoin d''un peu plus de souplesse, dites-le-nous : nous regardons ce qui est possible selon les voyageurs suivants.

À bientôt,
{signature}', 20
WHERE (SELECT COUNT(*) FROM message_templates) = 1;

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Rappel du solde', 'fr', 'Bonjour {prenom},

Petit rappel : le solde de votre séjour à {bien}, soit {solde}, reste à régler avant votre arrivée. Le lien de paiement figure dans votre confirmation de réservation.

Merci, et à bientôt,
{signature}', 30
WHERE (SELECT COUNT(*) FROM message_templates) = 2;

INSERT INTO message_templates (property_id, name, lang, body, sort_order)
SELECT NULL, 'Après le séjour', 'fr', 'Bonjour {prenom},

Merci d''avoir séjourné à {bien}. Nous espérons que tout vous a plu.
Un mot sur votre séjour nous aide beaucoup, et vous êtes toujours les bienvenus.

Au plaisir de vous revoir,
{signature}', 40
WHERE (SELECT COUNT(*) FROM message_templates) = 3;
