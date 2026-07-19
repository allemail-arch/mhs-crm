/* ============================================================
   MHS CRM — database (Node builtin SQLite, zero deps)
   Swap to Postgres later by replacing this module's query layer.
   ============================================================ */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_CONNECTORS, DEFAULT_AUTOMATION, DEFAULT_SOURCES, DEFAULT_SETTINGS, TEAMS } = require('./config');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT UNIQUE,
    role       TEXT NOT NULL,            -- admin | lead | sales
    team       TEXT,                     -- TPA | TFD | MHS | TPK | -
    department TEXT,                     -- free text (e.g. Pre Sales, TFD Sales)
    phone      TEXT,
    pin_hash   TEXT NOT NULL,
    pin_salt   TEXT NOT NULL,
    active     INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    phone         TEXT,
    email         TEXT,
    city          TEXT,
    product       TEXT,                  -- TPA | TFD | MHS | TPK
    source        TEXT,                  -- Facebook | Website | ...
    status        TEXT DEFAULT 'Fresh',
    owner_id      TEXT,
    website       TEXT,
    score         INTEGER DEFAULT 50,
    converted     INTEGER DEFAULT 0,
    next_followup TEXT,                  -- ISO date (yyyy-mm-dd) or null
    external_id   TEXT,                  -- id from source (e.g. Meta leadgen id) for dedupe
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    sub        TEXT,
    by_name    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS connectors (
    key       TEXT PRIMARY KEY,
    name      TEXT, src TEXT, descr TEXT, icon TEXT, color TEXT,
    connected INTEGER DEFAULT 0,
    team      TEXT,
    config    TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS automation (
    key     TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS rr_state (
    team TEXT PRIMARY KEY,
    idx  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS teams (
    code   TEXT PRIMARY KEY,
    name   TEXT NOT NULL,
    color  TEXT DEFAULT '#2d5be3',
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sources (
    name   TEXT PRIMARY KEY,
    color  TEXT DEFAULT '#6b7488',
    icon   TEXT DEFAULT 'S',
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    TEXT NOT NULL,
    owner_id   TEXT,
    connected  INTEGER DEFAULT 1,
    talktime   INTEGER DEFAULT 0,   -- seconds
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_calls_owner ON calls(owner_id);

  CREATE TABLE IF NOT EXISTS logins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_logins_user ON logins(user_id);

  CREATE TABLE IF NOT EXISTS lead_deletions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id       TEXT,
    lead_name     TEXT,
    phone         TEXT,
    deleted_by    TEXT,
    deleted_by_name TEXT,
    department    TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_owner  ON leads(owner_id);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_act_lead     ON activities(lead_id);
`);

// seed connectors + automation defaults (idempotent)
const insConn = db.prepare(`INSERT OR IGNORE INTO connectors(key,name,src,descr,icon,color,connected,team) VALUES(?,?,?,?,?,?,?,?)`);
for (const c of DEFAULT_CONNECTORS) insConn.run(c.key, c.name, c.src, c.desc, c.icon, c.color, c.connected, c.team);
const insAuto = db.prepare(`INSERT OR IGNORE INTO automation(key,enabled) VALUES(?,?)`);
for (const [k, v] of Object.entries(DEFAULT_AUTOMATION)) insAuto.run(k, v);
const insTeam = db.prepare(`INSERT OR IGNORE INTO teams(code,name,color) VALUES(?,?,?)`);
for (const [code, t] of Object.entries(TEAMS)) insTeam.run(code, t.name, t.color);
const insSrc = db.prepare(`INSERT OR IGNORE INTO sources(name,color,icon) VALUES(?,?,?)`);
for (const s of DEFAULT_SOURCES) insSrc.run(s.name, s.color, s.icon);
const insSet = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, String(v));

// add soft-delete columns to leads if missing (for existing DBs)
for (const col of ['deleted INTEGER DEFAULT 0', 'deleted_by TEXT', 'deleted_at TEXT']) {
  try { db.exec('ALTER TABLE leads ADD COLUMN ' + col); } catch (e) {}
}

/* ---------- helpers ---------- */
function hashPin(pin, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { hash, salt };
}
function verifyPin(pin, hash, salt) {
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}
function uid(prefix) {
  return (prefix || 'id') + '_' + crypto.randomBytes(6).toString('hex');
}

module.exports = { db, hashPin, verifyPin, uid, DB_PATH };
