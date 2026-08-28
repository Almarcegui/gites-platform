-- Migration 0019 — Conditions générales de location, version 3.0.
--
-- Décision du propriétaire du 28/08/2026 : plus aucune mention, côté client,
-- des draps et du linge, de la taxe de séjour, du statut TVA ni d'un numéro
-- d'enregistrement. Le linge reste compris dans les frais généraux sans être
-- nommé.
--
-- Deux effets, indissociables :
--   1. le texte des CGV passe en version 3.0 (13 articles au lieu de 14, les
--      anciens articles 1 et 11 étant réécrits ou supprimés) pour les deux
--      domaines,
--   2. tourist_tax_cents_per_person_night est posé à 0 sur les deux domaines,
--      pour que la ligne de taxe disparaisse de tout devis, voucher et email.
--      computeQuote (src/core/pricing.ts) n'émet la ligne kind tax que si le
--      montant est strictement positif, la mise à 0 suffit donc.
--
-- Le texte est stocké en TEXTE BRUT, sans balisage : c'est la même chaîne qui
-- est affichée dans le tunnel, reprise sur le voucher en ligne, hachée comme
-- preuve d'acceptation et jointe en clair au mail de confirmation. Les titres
-- d'articles sont des lignes « Article N » isolées, ce dont le tunnel se sert
-- pour les afficher en gras (public/book/cgv.js).
--
-- RÈGLE DE RÉDACTION DU PROJET respectée ici : le littéral ne contient aucun
-- point-virgule ni aucun double tiret. Les phrases du texte source qui en
-- comportaient ont été reformulées, point-virgule remplacé par un point ou une
-- virgule, sans changement de sens. Les apostrophes sont doublées.
--
-- COHÉRENCE AVEC LES RÉGLAGES, vérifiée réglage par réglage :
--   article 4.1  pourcentage d'arrhes NON figé dans le texte, il renvoie au
--                pourcentage affiché lors de la réservation, qui est celui de
--                l'unité réservée (migration 0015, valeur en vigueur 50)
--   article 4.2  solde à 30 jours = balance_due_days
--   article 5.1  aucune caution = caution_cents remis à 0 par la migration 0007
--   article 8.1  18 h / 18 h = checkin_time et checkout_time posés par la
--                migration 0009
--
-- INSERT OR REPLACE plutôt qu'UPDATE : la migration est ainsi rejouable et
-- pose la valeur même si la ligne manque. Pas de rollback dans ce projet.

INSERT OR REPLACE INTO settings (property_id, key, value) VALUES
  (1, 'cgv_text', 'CONDITIONS GÉNÉRALES DE LOCATION

Version 3.0 — 28 août 2026. Le texte intégral est affiché avant toute réservation. L''acceptation est enregistrée avec sa version, sa date, son heure et l''adresse IP du réservant.

Article 1 — Parties et objet

Les présentes conditions régissent la location saisonnière des hébergements meublés de tourisme suivants : La Maison du Scieur et La Scierie (Hameau du Pré Moré, 6890 Redu, commune de Libin), ainsi que Le Moulin de Braives (Braives), ci-après « l''hébergement ».

L''exploitant est Jean-Philippe de Cartier d''Yves, personne physique domiciliée Rue des Barbouillons 12, 6929 Daverdisse (ci-après « le propriétaire »).

Le « locataire » est la personne majeure qui effectue la réservation. Elle se porte fort du respect des présentes par tous les occupants.

Article 2 — Réservation et formation du contrat

2.1. La réservation s''effectue en ligne. Le contrat est formé lorsque le locataire a (a) accepté les présentes conditions et (b) payé les arrhes visées à l''article 4. Une confirmation écrite (voucher) est adressée au locataire.

2.2. Toute option non confirmée par le paiement des arrhes dans le délai indiqué lors de la réservation est libérée automatiquement, sans formalité.

Article 3 — Prix

3.1. Le prix affiché au moment de la réservation est ferme et comprend la mise à disposition de l''hébergement, les charges usuelles (eau, électricité, chauffage), les frais généraux de séjour (ménage et charges) et les options choisies. Le détail est ventilé ligne par ligne dans le devis avant paiement.

3.2. Les prix s''entendent en euros. Aucun coût supplémentaire obligatoire n''est ajouté après la formation du contrat.

Article 4 — Arrhes et paiement du solde

4.1. À la réservation, le locataire verse des arrhes au sens de l''article 1590 de l''ancien Code civil, égales au pourcentage fixé pour l''hébergement réservé et affiché lors de la réservation (50 % du prix total, sauf mention contraire sur la fiche de l''hébergement).

4.2. Le solde est exigible au plus tard 30 jours avant l''arrivée. À défaut de paiement du solde à l''échéance et après rappel resté sans effet pendant 7 jours, le propriétaire peut résoudre le contrat aux torts du locataire, les arrhes lui restant acquises.

4.3. Si la réservation intervient moins de 30 jours avant l''arrivée, la totalité du prix est payable à la réservation. La part correspondant aux arrhes, au pourcentage propre à l''hébergement, en suit le régime.

Article 5 — Annulation et dédit

5.1. Aucune caution n''est demandée. Les arrhes tiennent lieu de garantie d''engagement réciproque.

5.2. Dédit du locataire : si le locataire annule, pour quelque raison que ce soit, les arrhes restent définitivement acquises au propriétaire. Les sommes payées au-delà des arrhes (le solde) lui sont restituées dans les 14 jours. Le non-présenté (« no-show ») et l''arrivée écourtée valent annulation sans restitution du prix du séjour entamé.

5.3. Dédit du propriétaire : si le propriétaire annule la réservation en dehors d''un cas de force majeure, il restitue au locataire le double des arrhes reçues, conformément à l''article 1590 de l''ancien Code civil, à l''exclusion de toute autre indemnité.

5.4. Le locataire est invité à souscrire une assurance annulation auprès de l''assureur de son choix. Elle n''est pas proposée par le propriétaire.

Article 6 — Absence de droit de rétractation

Conformément à l''article VI.53, 12°, du Code de droit économique, le droit de rétractation ne s''applique pas aux prestations de logement fournies à une date déterminée. La réservation est donc ferme dès sa confirmation, sous le seul régime de l''article 5.

Article 7 — Capacité et usage

7.1. Le nombre d''occupants, bébés compris pour la sécurité incendie, ne peut excéder la capacité maximale indiquée pour l''hébergement réservé. Le propriétaire peut refuser l''accès aux occupants surnuméraires ou résoudre le contrat sans restitution en cas de dépassement dissimulé.

7.2. L''hébergement est destiné au séjour touristique exclusivement : pas de fête ou d''événement non convenu par écrit, pas de sous-location, pas d''établissement de domicile. Il est interdit de fumer à l''intérieur.

Article 8 — Arrivée, départ, état de l''hébergement

8.1. Arrivée à partir de 18 h, départ avant 18 h, sauf accord écrit contraire. Les horaires sont lus des réglages de l''hébergement et affichés lors de la réservation.

8.2. L''hébergement est remis propre et en bon état. Le locataire signale toute anomalie dans les 24 h de l''arrivée. À défaut, l''hébergement est présumé conforme. Il restitue les lieux rangés, la vaisselle propre et les déchets triés selon les consignes locales. Les frais généraux ne couvrent pas la remise en ordre anormale.

Article 9 — Dommages et responsabilité

9.1. Le locataire répond des dégradations et pertes causées pendant le séjour par lui-même ou ses occupants. Les dommages constatés sont documentés (photos, relevé contradictoire dans la mesure du possible) et facturés au coût réel de réparation ou de remplacement.

9.2. Le locataire vérifie que sa responsabilité civile (assurance familiale, extension « villégiature ») couvre la location de vacances.

9.3. La responsabilité du propriétaire est limitée aux dommages causés par un défaut de l''hébergement qui lui est imputable. Elle ne couvre pas les effets personnels des occupants ni les nuisances extérieures indépendantes de sa volonté.

Article 10 — Animaux

Les animaux sont admis sur demande préalable adressée au propriétaire avant la réservation et acceptée par écrit. Un supplément éventuel est affiché dans les options. Un animal non annoncé peut être refusé à l''arrivée. Le locataire répond des dommages et du nettoyage supplémentaire qu''il occasionne.

Article 11 — Données personnelles

Les données du locataire (identité, coordonnées, contenu des échanges, données de réservation et de paiement) sont traitées par le propriétaire aux seules fins de gestion de la réservation, du séjour et des obligations légales, en ce compris la tenue du registre des personnes hébergées imposée par la loi. Elles ne sont ni vendues ni transmises à des tiers hors prestataires techniques nécessaires (hébergement, paiement). Le locataire ne reçoit de messages commerciaux que s''il y a consenti. Droits d''accès, de rectification et d''effacement : par écrit à l''adresse de contact indiquée sur le site.

Article 12 — Force majeure

Si un événement de force majeure, au sens du droit belge, rend le séjour impossible, chaque partie est libérée : les sommes versées, arrhes comprises, sont restituées au locataire dans les 14 jours, sans autre indemnité de part ni d''autre. L''article 5.3 ne s''applique pas à ce cas.

Article 13 — Droit applicable et litiges

Les présentes sont régies par le droit belge. Avant toute action, les parties recherchent une solution amiable. Les litiges relèvent des tribunaux compétents en vertu du droit commun. À l''égard d''un locataire consommateur, les règles impératives de compétence et de protection lui restent acquises.'),
  (2, 'cgv_text', 'CONDITIONS GÉNÉRALES DE LOCATION

Version 3.0 — 28 août 2026. Le texte intégral est affiché avant toute réservation. L''acceptation est enregistrée avec sa version, sa date, son heure et l''adresse IP du réservant.

Article 1 — Parties et objet

Les présentes conditions régissent la location saisonnière des hébergements meublés de tourisme suivants : La Maison du Scieur et La Scierie (Hameau du Pré Moré, 6890 Redu, commune de Libin), ainsi que Le Moulin de Braives (Braives), ci-après « l''hébergement ».

L''exploitant est Jean-Philippe de Cartier d''Yves, personne physique domiciliée Rue des Barbouillons 12, 6929 Daverdisse (ci-après « le propriétaire »).

Le « locataire » est la personne majeure qui effectue la réservation. Elle se porte fort du respect des présentes par tous les occupants.

Article 2 — Réservation et formation du contrat

2.1. La réservation s''effectue en ligne. Le contrat est formé lorsque le locataire a (a) accepté les présentes conditions et (b) payé les arrhes visées à l''article 4. Une confirmation écrite (voucher) est adressée au locataire.

2.2. Toute option non confirmée par le paiement des arrhes dans le délai indiqué lors de la réservation est libérée automatiquement, sans formalité.

Article 3 — Prix

3.1. Le prix affiché au moment de la réservation est ferme et comprend la mise à disposition de l''hébergement, les charges usuelles (eau, électricité, chauffage), les frais généraux de séjour (ménage et charges) et les options choisies. Le détail est ventilé ligne par ligne dans le devis avant paiement.

3.2. Les prix s''entendent en euros. Aucun coût supplémentaire obligatoire n''est ajouté après la formation du contrat.

Article 4 — Arrhes et paiement du solde

4.1. À la réservation, le locataire verse des arrhes au sens de l''article 1590 de l''ancien Code civil, égales au pourcentage fixé pour l''hébergement réservé et affiché lors de la réservation (50 % du prix total, sauf mention contraire sur la fiche de l''hébergement).

4.2. Le solde est exigible au plus tard 30 jours avant l''arrivée. À défaut de paiement du solde à l''échéance et après rappel resté sans effet pendant 7 jours, le propriétaire peut résoudre le contrat aux torts du locataire, les arrhes lui restant acquises.

4.3. Si la réservation intervient moins de 30 jours avant l''arrivée, la totalité du prix est payable à la réservation. La part correspondant aux arrhes, au pourcentage propre à l''hébergement, en suit le régime.

Article 5 — Annulation et dédit

5.1. Aucune caution n''est demandée. Les arrhes tiennent lieu de garantie d''engagement réciproque.

5.2. Dédit du locataire : si le locataire annule, pour quelque raison que ce soit, les arrhes restent définitivement acquises au propriétaire. Les sommes payées au-delà des arrhes (le solde) lui sont restituées dans les 14 jours. Le non-présenté (« no-show ») et l''arrivée écourtée valent annulation sans restitution du prix du séjour entamé.

5.3. Dédit du propriétaire : si le propriétaire annule la réservation en dehors d''un cas de force majeure, il restitue au locataire le double des arrhes reçues, conformément à l''article 1590 de l''ancien Code civil, à l''exclusion de toute autre indemnité.

5.4. Le locataire est invité à souscrire une assurance annulation auprès de l''assureur de son choix. Elle n''est pas proposée par le propriétaire.

Article 6 — Absence de droit de rétractation

Conformément à l''article VI.53, 12°, du Code de droit économique, le droit de rétractation ne s''applique pas aux prestations de logement fournies à une date déterminée. La réservation est donc ferme dès sa confirmation, sous le seul régime de l''article 5.

Article 7 — Capacité et usage

7.1. Le nombre d''occupants, bébés compris pour la sécurité incendie, ne peut excéder la capacité maximale indiquée pour l''hébergement réservé. Le propriétaire peut refuser l''accès aux occupants surnuméraires ou résoudre le contrat sans restitution en cas de dépassement dissimulé.

7.2. L''hébergement est destiné au séjour touristique exclusivement : pas de fête ou d''événement non convenu par écrit, pas de sous-location, pas d''établissement de domicile. Il est interdit de fumer à l''intérieur.

Article 8 — Arrivée, départ, état de l''hébergement

8.1. Arrivée à partir de 18 h, départ avant 18 h, sauf accord écrit contraire. Les horaires sont lus des réglages de l''hébergement et affichés lors de la réservation.

8.2. L''hébergement est remis propre et en bon état. Le locataire signale toute anomalie dans les 24 h de l''arrivée. À défaut, l''hébergement est présumé conforme. Il restitue les lieux rangés, la vaisselle propre et les déchets triés selon les consignes locales. Les frais généraux ne couvrent pas la remise en ordre anormale.

Article 9 — Dommages et responsabilité

9.1. Le locataire répond des dégradations et pertes causées pendant le séjour par lui-même ou ses occupants. Les dommages constatés sont documentés (photos, relevé contradictoire dans la mesure du possible) et facturés au coût réel de réparation ou de remplacement.

9.2. Le locataire vérifie que sa responsabilité civile (assurance familiale, extension « villégiature ») couvre la location de vacances.

9.3. La responsabilité du propriétaire est limitée aux dommages causés par un défaut de l''hébergement qui lui est imputable. Elle ne couvre pas les effets personnels des occupants ni les nuisances extérieures indépendantes de sa volonté.

Article 10 — Animaux

Les animaux sont admis sur demande préalable adressée au propriétaire avant la réservation et acceptée par écrit. Un supplément éventuel est affiché dans les options. Un animal non annoncé peut être refusé à l''arrivée. Le locataire répond des dommages et du nettoyage supplémentaire qu''il occasionne.

Article 11 — Données personnelles

Les données du locataire (identité, coordonnées, contenu des échanges, données de réservation et de paiement) sont traitées par le propriétaire aux seules fins de gestion de la réservation, du séjour et des obligations légales, en ce compris la tenue du registre des personnes hébergées imposée par la loi. Elles ne sont ni vendues ni transmises à des tiers hors prestataires techniques nécessaires (hébergement, paiement). Le locataire ne reçoit de messages commerciaux que s''il y a consenti. Droits d''accès, de rectification et d''effacement : par écrit à l''adresse de contact indiquée sur le site.

Article 12 — Force majeure

Si un événement de force majeure, au sens du droit belge, rend le séjour impossible, chaque partie est libérée : les sommes versées, arrhes comprises, sont restituées au locataire dans les 14 jours, sans autre indemnité de part ni d''autre. L''article 5.3 ne s''applique pas à ce cas.

Article 13 — Droit applicable et litiges

Les présentes sont régies par le droit belge. Avant toute action, les parties recherchent une solution amiable. Les litiges relèvent des tribunaux compétents en vertu du droit commun. À l''égard d''un locataire consommateur, les règles impératives de compétence et de protection lui restent acquises.');

INSERT OR REPLACE INTO settings (property_id, key, value) VALUES
  (1, 'tourist_tax_cents_per_person_night', '0'),
  (2, 'tourist_tax_cents_per_person_night', '0');
