-- Migration 0021 — Galerie de photos par hébergement (issue #32, reliquat de la PR #61).
--
-- POURQUOI. La PR #61 a livré les 24 photos optimisées et les galeries des trois
-- pages de gîtes, mais en HTML figé : rien en base, donc rien à ordonner ni à
-- corriger depuis le back-office. Cette table donne au propriétaire la main sur
-- l'ordre d'affichage, le retrait d'une photo et le texte alternatif, sans
-- toucher aux fichiers eux-mêmes.
--
-- CE QUI RESTE UN ASSET COMMITÉ. Les fichiers vivent dans public/img/gites/<gîte>/
-- et sont produits par scripts/optimize-images.mjs. Cette table ne stocke que des
-- CHEMINS et les métadonnées éditoriales. Le back-office choisit et ordonne parmi
-- les fichiers présents, il n'en téléverse aucun.
--
-- COMPATIBILITÉ. units.photo_url n'est PAS modifiée : elle reste le repli quand
-- un hébergement n'a pas de galerie (le Domaine entier, par exemple). L'API
-- publique dérive photoUrl de la première photo active quand il y en a une.
--
-- SOURCE DU SEED. scripts/photos-sources.json, qui porte déjà l'URL d'origine, le
-- texte alternatif, la légende et l'ordre de chaque photo. Correspondance des
-- dossiers vers les unités des seeds 0002 et 0004 :
--   maison-du-scieur     -> unité 1 (slug maison-du-scieur)
--   la-scierie           -> unité 2 (slug la-scierie)
--   le-moulin-de-braives -> unité 4 (slug le-moulin)
--
-- IDEMPOTENCE. CREATE ... IF NOT EXISTS + INSERT OR IGNORE adossé à l'index
-- unique (unit_id, path) : rejouer ce fichier ne duplique ni n'écrase rien.

CREATE TABLE IF NOT EXISTS unit_photos (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  -- Chemin du JPEG de repli, servi tel quel par le Worker (assets publics).
  path TEXT NOT NULL,
  -- Texte alternatif OBLIGATOIRE (issue #32). NOT NULL seul laisserait passer
  -- une chaîne vide ou trois espaces, c'est-à-dire exactement le défaut
  -- d'accessibilité que la contrainte est censée empêcher. Le CHECK le dit au
  -- niveau du schéma, l'API le redit avec un message lisible.
  alt TEXT NOT NULL CHECK (length(trim(alt)) >= 3),
  -- Légende visible sous la vignette. Facultative, plus courte que l'alt.
  caption TEXT,
  -- Largeurs des variantes WebP présentes à côté du JPEG, ex '640,1280'.
  -- NULL = pas de WebP, on sert le JPEG seul (trois photos du site sont dans
  -- ce cas, leur WebP pesait plus lourd que le JPEG).
  webp_widths TEXT,
  -- Dimensions déclarées du JPEG, pour que le client pose width/height et
  -- n'introduise aucun décalage au chargement.
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Retrait sans suppression : convention du projet, jamais de DELETE métier.
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, path)
);

CREATE INDEX IF NOT EXISTS idx_unit_photos_unit ON unit_photos (unit_id, sort_order, id);

INSERT OR IGNORE INTO unit_photos (unit_id, path, alt, caption, webp_widths, width, height, sort_order) VALUES
  (1, '/img/gites/maison-du-scieur/facade.jpg', 'Façade en pierre de La Maison du Scieur, envahie de lierre, porte d''entrée ouverte', 'La façade, côté cour', '640,1280', 1280, 960, 10),
  (1, '/img/gites/maison-du-scieur/salon.jpg', 'Le grand salon de La Maison du Scieur, canapés de cuir et fenêtres donnant sur la forêt', 'Le grand salon', '640,1280', 1280, 960, 20),
  (1, '/img/gites/maison-du-scieur/salle-a-manger.jpg', 'La salle à manger de douze places, poêle à bois et banc contre le mur de pierre', 'La salle à manger, douze places', '640,1280', 1280, 960, 30),
  (1, '/img/gites/maison-du-scieur/cuisine.jpg', 'La cuisine de La Maison du Scieur, cuisinière de restaurant et table de ferme', 'La cuisinière de restaurant', '640,1280', 1280, 960, 40),
  (1, '/img/gites/maison-du-scieur/chambre-lits-simples.jpg', 'Chambre à deux lits simples, rideaux orangés et fenêtre ouverte sur les arbres', 'Une des quatre chambres', '640,1280', 1280, 960, 50),
  (1, '/img/gites/maison-du-scieur/chambre-lits-superposes.jpg', 'Chambre équipée de deux lits superposés en bois clair, quatre couchages', 'Chambre à lits superposés', '640,1280', 1280, 960, 60),
  (1, '/img/gites/maison-du-scieur/mezzanine.jpg', 'La mezzanine sous charpente de bois, matelas au sol et fauteuils en osier', 'La mezzanine', '640,1280', 1280, 960, 70),
  (1, '/img/gites/maison-du-scieur/douche.jpg', 'Salle d''eau carrelée de La Maison du Scieur, douche vitrée et vasque', 'Une des deux douches', '640,1280', 1280, 960, 80),
  (2, '/img/gites/la-scierie/facade.jpg', 'Façade en pierre de La Scierie, prolongée d''un auvent à toiture végétalisée', 'La façade, côté ruisseau', '640,1280', 1280, 960, 10),
  (2, '/img/gites/la-scierie/salon.jpg', 'Le salon de La Scierie, feu ouvert, canapés et escalier de bois vers la mezzanine', 'Le salon et son feu ouvert', '640,1280', 1280, 960, 20),
  (2, '/img/gites/la-scierie/feu-ouvert.jpg', 'Le feu ouvert de La Scierie, entouré de fauteuils de cuir et d''une table basse en bois', 'Se réfugier devant le feu', '640,1280', 1280, 960, 30),
  (2, '/img/gites/la-scierie/sejour-cuisine.jpg', 'Le séjour de La Scierie sous charpente : longue table de bois et cuisine ouverte', 'Séjour et cuisine ouverte', '640,1280', 1280, 960, 40),
  (2, '/img/gites/la-scierie/chambre.jpg', 'Chambre sous combles de La Scierie, plafond lambrissé et armoire ancienne', 'La grande chambre', '640,1280', 1280, 960, 50),
  (2, '/img/gites/la-scierie/mezzanine.jpg', 'La mezzanine de La Scierie, deux lits disposés contre le mur de pierre sèche', 'La mezzanine, contre la pierre', '640,1280', 1280, 960, 60),
  (2, '/img/gites/la-scierie/salle-de-bains.jpg', 'La salle de bains de La Scierie, lavabo posé sur un plan de bois et sèche-serviettes', 'La salle de bains', '640,1280', 1280, 960, 70),
  (2, '/img/gites/la-scierie/terrasse.jpg', 'La terrasse en bois de La Scierie, portes-fenêtres ouvertes sur la vallée boisée', 'La terrasse, plein sud', '640,1280', 1280, 960, 80),
  (4, '/img/gites/le-moulin-de-braives/facade-etang.jpg', 'Le Moulin de Braives en briques rouges, reflété dans l''étang bordé d''un grand arbre', 'Le moulin et son étang', '640,1280', 1280, 960, 10),
  (4, '/img/gites/le-moulin-de-braives/terrasse.jpg', 'La terrasse du Moulin et son mobilier de jardin, le long de la façade en briques', 'La terrasse et le jardin', '640,1280', 1280, 960, 20),
  (4, '/img/gites/le-moulin-de-braives/grande-table.jpg', 'La grande table de bois du Moulin sous les poutres, entourée de chaises blanches', 'La table des grandes tablées', '640,1280', 1280, 960, 30),
  (4, '/img/gites/le-moulin-de-braives/piece-de-vie.jpg', 'La pièce de vie du Moulin : poteaux de chêne, sol en pierre bleue et escalier ouvert', 'La pièce de vie', '640,1280', 1280, 960, 40),
  (4, '/img/gites/le-moulin-de-braives/cuisine.jpg', 'La cuisine du Moulin et son îlot central en bois, ouverte sur la pièce de vie', 'La cuisine et son îlot', '640,1280', 1280, 960, 50),
  (4, '/img/gites/le-moulin-de-braives/salon.jpg', 'Le salon du Moulin, canapés bleus devant la cheminée, sol en pierre bleue', 'Le salon, côté cheminée', '640,1280', 1280, 960, 60),
  (4, '/img/gites/le-moulin-de-braives/chambre.jpg', 'Chambre du Moulin, lit double devant un mur de briques apparentes sous charpente', 'Une des cinq chambres', '640,1280', 1280, 960, 70),
  (4, '/img/gites/le-moulin-de-braives/salle-de-bains.jpg', 'Salle de bains du Moulin sous les toits, baignoire et large fenêtre de toit', 'Salle de bains privative', '640,1280', 1280, 960, 80);
