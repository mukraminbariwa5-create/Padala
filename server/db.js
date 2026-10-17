// SQLite database (Node's built-in node:sqlite, no packages needed).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  username    TEXT NOT NULL,
  ip          TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, at);
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  key_check   TEXT NOT NULL,           -- proves a pasted team key is the right one; reveals nothing about it
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash  TEXT PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_by     INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','sent','handed_over','paid')),
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id, updated_at);
CREATE TABLE IF NOT EXISTS blobs (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,           -- keyed hash of the content: same file = same id, without revealing the file
  chunk_count INTEGER NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,  -- encrypted bytes stored
  received    INTEGER NOT NULL DEFAULT 0,  -- pieces stored so far
  complete    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, id)
);
CREATE TABLE IF NOT EXISTS versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  manifest      TEXT NOT NULL,         -- blob id of the encrypted file list
  note          TEXT,                  -- encrypted
  file_count    INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL,
  sent_bytes    INTEGER NOT NULL,
  changed_count INTEGER NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, number)
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('text','version','status','download','created')),
  body        TEXT,                    -- encrypted for text messages
  meta        TEXT,                    -- JSON
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, id);
-- Which stored file pieces each version uses, so deleting a project can free the space it used.
-- (Ids are keyed fingerprints; the server already sees them when pieces are uploaded.)
CREATE TABLE IF NOT EXISTS version_blobs (
  version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  blob_id     TEXT NOT NULL,
  PRIMARY KEY (version_id, blob_id)
);
CREATE INDEX IF NOT EXISTS idx_version_blobs_blob ON version_blobs(blob_id);
-- Where to send notifications when the app is closed (one row per device that turned them on).
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- Each member's copy of a team key, locked with a key made from their password on their device.
-- The server can't open these; they let a person's other devices unlock the team after signing in.
CREATE TABLE IF NOT EXISTS key_wraps (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  wrapped     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, team_id)
);
CREATE TABLE IF NOT EXISTS downloads (
  version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  PRIMARY KEY (version_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_id     INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'padala.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  // Added later: a random salt per user for the password-made lock on team key backups.
  // Added later (each only if missing, so older databases upgrade in place):
  const addColumn = (table, name, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  addColumn('users', 'wrap_salt', 'TEXT');     // salt for the keys made from the password / recovery code
  addColumn('users', 'amk_pw', 'TEXT');        // the account key, locked with the password (on the device)
  addColumn('users', 'amk_rc', 'TEXT');        // the account key, locked with the recovery code
  addColumn('users', 'recovery_hash', 'TEXT'); // scrypt hash of the recovery code (to allow a reset)
  addColumn('teams', 'keep_versions', 'INTEGER');  // keep only the newest N versions per project (NULL: keep all)
  addColumn('users', 'avatar', 'BLOB');           // profile photo (small image, resized on the device)
  addColumn('users', 'avatar_type', 'TEXT');
  addColumn('users', 'avatar_v', 'INTEGER');      // changes with each new photo, so browsers fetch the new one
  addColumn('messages', 'reply_to', 'INTEGER');   // the message this one replies to
  addColumn('messages', 'deleted_at', 'INTEGER'); // deleted by its author (the text is erased)
  addColumn('push_subs', 'lang', "TEXT NOT NULL DEFAULT 'en'"); // language of the notices ('en' or 'fil')
  addColumn('key_wraps', 'scheme', "TEXT NOT NULL DEFAULT 'pw'"); // 'pw': locked with the password key (old), 'amk': with the account key

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    raw: db,
    all: (sql, ...p) => stmt(sql).all(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}
