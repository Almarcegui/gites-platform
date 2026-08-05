-- Comptes du back-office en base (gérés depuis la page Utilisateurs) + sessions
-- + réglages clé/valeur (jetons Beds24 modifiables sans redéploiement).
-- Le secret ADMIN_TOKEN reste un accès de secours (break-glass) hors base.

CREATE TABLE admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- minuscules, [a-z0-9._-]
  password_hash TEXT NOT NULL,                        -- pbkdf2$<iter>$<selB64>$<hashB64>
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,                        -- sha256 hex du jeton (jamais le jeton en clair)
  user_id    INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_admin_sessions_user ON admin_sessions(user_id);
CREATE INDEX idx_admin_sessions_exp  ON admin_sessions(expires_at);

-- NB : « settings » (0001) est PAR DOMAINE (property_id, key) — celle-ci est
-- GLOBALE à l'application, d'où le nom distinct.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
