-- Migration 0007 — Checklist de mise en route (page unique du back-office).
-- Décisions Julien du 18/07 intégrées : arrhes au lieu de caution (conservées
-- en cas d'annulation du locataire), exploitation = père en personne physique
-- (pas d'entité TVA), un seul site, pas de LaunchAgent (Cloudflare direct).

CREATE TABLE checklist_items (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,          -- regroupement d'affichage
  label TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'papa' CHECK (owner IN ('papa', 'julien', 'claude')),
  status TEXT NOT NULL DEFAULT 'a_faire' CHECK (status IN ('a_faire', 'en_cours', 'fait', 'verifie', 'n_a')),
  note TEXT,                      -- précisions, numéros obtenus, dates…
  url TEXT,                       -- lien utile (démarche en ligne)
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- La caution disparaît : arrhes uniquement (décision 18/07).
UPDATE settings SET value = '0' WHERE key = 'caution_cents';

INSERT INTO checklist_items (section, label, owner, note, url, sort_order) VALUES
-- ── Légal — enregistrement & sécurité ──
('Légal — enregistrement & incendie', 'Enregistrement BELWAL — La Maison du Scieur (11 p.)', 'papa',
 'Obligatoire (Code wallon du Tourisme, délai transitoire échu au 01/01/2026). Gratuit, par unité. Noter ici le numéro obtenu.',
 'https://www.tourismewallonie.be', 10),
('Légal — enregistrement & incendie', 'Enregistrement BELWAL — La Scierie (6-8 p.)', 'papa',
 'Même démarche. Le numéro devra apparaître sur toute annonce (site, plateformes).', 'https://www.tourismewallonie.be', 20),
('Légal — enregistrement & incendie', 'Enregistrement BELWAL — Le Moulin de Braives (10-12 p.)', 'papa',
 'Sans numéro, les plateformes (Airbnb…) doivent délister le bien (règlement UE 2024/1028, applicable depuis mai 2026).', 'https://www.tourismewallonie.be', 30),
('Légal — enregistrement & incendie', 'Attestation incendie ASI — Maison du Scieur', 'papa',
 '≥ 10 personnes ⇒ ASI complète obligatoire (bourgmestre, rapport pompiers, validité 5 ans). Vérifier la date de la dernière attestation.', NULL, 40),
('Légal — enregistrement & incendie', 'Attestation incendie — La Scierie (ACS possible)', 'papa',
 '< 10 personnes : contrôle simplifié (ACS) possible si les nuitées sont limitées au rez + 1er étage, sinon ASI complète.', NULL, 50),
('Légal — enregistrement & incendie', 'Attestation incendie ASI — Moulin de Braives', 'papa',
 '10-12 personnes ⇒ ASI complète obligatoire. Attention : la capacité ANNONCÉE sur le site doit rester cohérente avec l''attestation.', NULL, 60),
('Légal — enregistrement & incendie', 'Afficher le n° BELWAL sur le site, la page de résa et le voucher', 'claude',
 'Fait automatiquement par la plateforme dès que les numéros sont notés dans les items ci-dessus.', NULL, 70),
('Légal — enregistrement & incendie', 'Dénominations : ne pas afficher « Meublé de tourisme certifié » ni écusson sans certification', 'claude',
 '« Gîte » reste licite comme terme commercial — la certification (facultative, gratuite) ouvre le catalogue VisitWallonia — à envisager après BELWAL.', NULL, 80),
-- ── Légal — taxes & assurances ──
('Légal — taxes & assurances', 'Règlement taxe de séjour — commune de Libin (Redu)', 'papa',
 'Demander le règlement-taxe communal (montant/assiette). Claude l''encode ensuite dans Paramètres → le devis l''applique automatiquement.', NULL, 90),
('Légal — taxes & assurances', 'Règlement taxe de séjour — commune de Braives', 'papa', 'Idem pour le Moulin.', NULL, 100),
('Légal — taxes & assurances', 'Assurance RC exploitation / incendie à jour (location saisonnière)', 'papa',
 'Vérifier que la police couvre la location touristique des 3 unités, au nom de l''exploitant personne physique.', NULL, 110),
-- ── Encaissement (décidé : père, personne physique, pas de TVA) ──
('Encaissement — Stripe', 'Créer le compte Stripe (père, personne physique)', 'papa',
 '⚠️ Claude ne peut PAS le faire (création de compte + coordonnées bancaires = à faire par le titulaire). Démarche ~15 min : email, identité, IBAN. Choisir « Entreprise individuelle / particulier ».',
 'https://dashboard.stripe.com/register', 120),
('Encaissement — Stripe', 'Transmettre à Claude les clés API TEST (sk_test_…)', 'papa',
 'Dashboard Stripe → Développeurs → Clés API. D''abord les clés TEST pour tout valider sans argent réel.', 'https://dashboard.stripe.com/test/apikeys', 130),
('Encaissement — Stripe', 'Brancher Stripe (test) : paiement Bancontact + cartes + wallets', 'claude',
 'Dès les clés reçues : paiement réel de bout en bout en mode test, puis bascule live sur accord.', NULL, 140),
('Encaissement — Stripe', 'Webhook Stripe (confirmation automatique des paiements)', 'claude', 'Après la mise en ligne (dépend du token Cloudflare).', NULL, 150),
-- ── Mise en ligne ──
('Mise en ligne', 'Token Cloudflare (Workers Scripts:Edit + D1:Edit)', 'julien',
 'dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom. Deux permissions Account : « Workers Scripts:Edit » et « D1:Edit ». À déposer dans le trousseau comme les autres tokens.',
 'https://dash.cloudflare.com/profile/api-tokens', 160),
('Mise en ligne', 'Déployer la plateforme (site + résa + back-office, URL publique)', 'claude',
 'Dès le token : base D1 réelle, Worker, protection du back-office, bandeau « démo » tant que Stripe live n''est pas actif.', NULL, 170),
('Mise en ligne', 'Choisir LE nom de domaine du site (un seul site — décision 18/07)', 'papa',
 'Ex. lesgitesdupremore.be déjà détenu. Le site doit rester portable : données SQLite exportables, pages statiques — changer d''hébergeur reste possible.', NULL, 180),
('Mise en ligne', 'Brancher le domaine + emails (Resend, DKIM) et basculer le WordPress (redirections)', 'claude',
 'Après choix du domaine. Test de délivrabilité Gmail/Outlook avant activation réelle des emails.', NULL, 190),
-- ── Données & contenu ──
('Données & contenu', 'Transmettre la grille tarifaire réelle des 3 unités (+ prix du Domaine entier)', 'papa',
 'Le site affiche des tarifs provisoires. Le système est MODULABLE : saisons, prix/jour, min-nuits, tout se règle ensuite dans Tarifs & saisons.', NULL, 200),
('Données & contenu', 'Confirmer le % des arrhes (30 % par défaut) et le ménage (120/90 € ou 160/130 € ?)', 'papa',
 'Décision actée : ARRHES (pas de caution) — conservées si le locataire annule. Le site actuel et l''ancien brouillon divergent sur le ménage.', NULL, 210),
('Données & contenu', 'CGV + contrat de location : rédaction Claude → validation Julien', 'claude',
 'Régime des arrhes (art. 1590 anc. C. civ. — symétrie : dédit propriétaire = le double), pas de droit de rétractation (art. VI.53, 12° CDE), capacité max, acceptation horodatée dans le flux.', NULL, 220),
('Données & contenu', 'Galerie photos par gîte (au-delà de la photo principale)', 'claude', 'Après le go-live minimum — les photos WordPress existantes sont réutilisables.', NULL, 230);
