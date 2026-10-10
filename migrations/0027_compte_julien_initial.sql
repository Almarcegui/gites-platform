-- Compte administrateur initial « julien » (décision Julien, 10/10/2026) :
-- le serveur Infomaniak n'avait pas de compte connu. Mot de passe PROVISOIRE
-- « gites-2026 », à changer dès la première connexion (Réglages › Mon compte).
-- Idempotent : ne touche pas à un compte « julien » déjà présent.
INSERT OR IGNORE INTO admin_users (username, password_hash, active)
VALUES ('julien', 'pbkdf2$30000$h9N+Z80fq+5O3WPUUsUR4A==$z5Gveo7nEuEXbkOIizqnzYBdVbM8FpLQHCyFOPh5Zqs=', 1);
