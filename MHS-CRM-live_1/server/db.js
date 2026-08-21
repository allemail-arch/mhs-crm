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

/* ============================================================
   TIME ZONE — the whole CRM runs on IST (Asia/Kolkata, UTC+5:30)
   SQLite's datetime('now') is UTC, and the server may sit in any
   region (Railway = UTC), so every timestamp used to land 5h30m
   behind real Indian clock time: leads created after 05:30 IST
   showed yesterday's date, "today" counters reset at 05:30, and
   activity timelines showed the wrong hour.
   Rule from here on: ALL stored timestamps are IST wall-clock.
   - JS side  → nowIst() / todayIst() / addDaysIst()
   - SQL side → datetime('now','+330 minutes') via IST_NOW / IST_TODAY
   ============================================================ */
const IST_MINUTES = 330;
const IST_SHIFT = "'+330 minutes'";
const IST_NOW = `datetime('now',${IST_SHIFT})`;     // 'YYYY-MM-DD HH:MM:SS' IST
const IST_TODAY = `date('now',${IST_SHIFT})`;       // 'YYYY-MM-DD' IST
const istDate = () => new Date(Date.now() + IST_MINUTES * 60000);
function nowIst() { return istDate().toISOString().slice(0, 19).replace('T', ' '); }
function todayIst() { return istDate().toISOString().slice(0, 10); }
function addDaysIst(n) { return new Date(Date.now() + IST_MINUTES * 60000 + (+n || 0) * 86400000).toISOString().slice(0, 10); }

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
    created_at TEXT DEFAULT (datetime('now','+330 minutes'))
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
    created_at    TEXT DEFAULT (datetime('now','+330 minutes')),
    updated_at    TEXT DEFAULT (datetime('now','+330 minutes'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    sub        TEXT,
    by_name    TEXT,
    created_at TEXT DEFAULT (datetime('now','+330 minutes'))
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
    created_at TEXT DEFAULT (datetime('now','+330 minutes'))
  );
  CREATE INDEX IF NOT EXISTS idx_calls_owner ON calls(owner_id);

  CREATE TABLE IF NOT EXISTS logins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    created_at TEXT DEFAULT (datetime('now','+330 minutes'))
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
    created_at    TEXT DEFAULT (datetime('now','+330 minutes'))
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
// migrate any Hinglish connector description to English (existing DBs)
try { db.prepare("UPDATE connectors SET descr='Lead from any app (webhook)' WHERE key='Other' AND descr LIKE '%Kisi bhi%'").run(); } catch (e) {}
// normalized phone column for phone-based dedupe (one phone = one lead)
try { db.exec('ALTER TABLE leads ADD COLUMN phone_norm TEXT'); } catch (e) {}
try {
  const rows = db.prepare("SELECT id, phone FROM leads WHERE (phone_norm IS NULL OR phone_norm='') AND phone IS NOT NULL AND phone<>''").all();
  const upd = db.prepare('UPDATE leads SET phone_norm=? WHERE id=?');
  for (const r of rows) { const n = String(r.phone || '').replace(/\D/g, '').slice(-10); if (n) upd.run(n, r.id); }
} catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_phonenorm ON leads(phone_norm)'); } catch (e) {}
// manager_id: who this user reports to.
//   sales → their Manager (role 'lead');  lead → their Super Manager (role 'super')
try { db.exec('ALTER TABLE users ADD COLUMN manager_id TEXT'); } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id)'); } catch (e) {}

/* ---------- reminders with a TIME, not just a date ----------
   Clients say "call me in 1 hour" / "call me after 2 days". A date-only
   next_followup could not express the first one, so a second column holds
   the full IST wall-clock 'YYYY-MM-DD HH:MM'. next_followup (date) stays in
   place and is kept in sync, so every existing overdue/due-today query and
   report keeps working untouched.                                          */
try { db.exec('ALTER TABLE leads ADD COLUMN next_followup_at TEXT'); } catch (e) {}
try {
  db.prepare(`UPDATE leads SET next_followup_at = next_followup || ' 10:00'
              WHERE next_followup IS NOT NULL AND next_followup <> ''
                AND (next_followup_at IS NULL OR next_followup_at = '')`).run();
} catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_followup_at ON leads(next_followup_at)'); } catch (e) {}

/* ---------- call log: disposition + note (in-CRM calling) ---------- */
for (const col of ['outcome TEXT', 'notes TEXT', 'by_user TEXT', 'direction TEXT DEFAULT \'outbound\'', 'recording_url TEXT']) {
  try { db.exec('ALTER TABLE calls ADD COLUMN ' + col); } catch (e) {}
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id)'); } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at)'); } catch (e) {}

/* ---------- lead assignment history (who gave which lead to whom, when) ---------- */
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id       TEXT,
    lead_name     TEXT,
    phone         TEXT,
    product       TEXT,
    from_owner    TEXT,
    from_name     TEXT,
    to_owner      TEXT,
    to_name       TEXT,
    by_user       TEXT,
    by_name       TEXT,
    reason        TEXT,          -- manual | round-robin | import | bulk | transfer | webhook
    created_at    TEXT DEFAULT (datetime('now','+330 minutes'))
  );
  CREATE INDEX IF NOT EXISTS idx_assign_lead ON lead_assignments(lead_id);
  CREATE INDEX IF NOT EXISTS idx_assign_to   ON lead_assignments(to_owner);
  CREATE INDEX IF NOT EXISTS idx_assign_by   ON lead_assignments(by_user);
  CREATE INDEX IF NOT EXISTS idx_assign_time ON lead_assignments(created_at);
`);

/* ---------- lead source -> product routing ----------
   Routing used to live only on the six built-in connectors (connectors.team),
   so a source added later ("New Lead", "Justdial") had nowhere to say which
   product its leads belong to and silently fell back to MHS. A source now
   carries its own product; the connector stays as the fallback.        */
try { db.exec('ALTER TABLE sources ADD COLUMN team TEXT'); } catch (e) {}
/* seed each source's product from its connector once, so nothing changes
   behaviour on the day this ships */
try {
  const done = db.prepare("SELECT value FROM settings WHERE key='src_team_v1'").get();
  if (!done) {
    const rows = db.prepare("SELECT s.name n, (SELECT c.team FROM connectors c WHERE c.src=s.name ORDER BY c.connected DESC LIMIT 1) t FROM sources s").all();
    const upd = db.prepare('UPDATE sources SET team=? WHERE name=?');
    let n = 0;
    for (const r of rows) if (r.t) { upd.run(r.t, r.n); n++; }
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('src_team_v1','1')").run();
    console.log('source routing: ' + n + ' source(s) mapped to their connector product');
  }
} catch (e) { console.error('source routing migration failed:', e.message); }

/* ---------- 'Pre Sales' lead source ---------- */
try { db.prepare("INSERT OR IGNORE INTO sources(name,color,icon) VALUES('Pre Sales','#00b8d9','PS')").run(); } catch (e) {}

/* ---------- login is now EMAIL + PASSWORD (the PIN keypad is gone) ---------- */
for (const col of ['pwd_hash TEXT', 'pwd_salt TEXT', 'pwd_changed INTEGER DEFAULT 0']) {
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch (e) {}
}
const DEFAULT_PASSWORD = '123456';
/* Give every existing user the default password ONCE. One scrypt call is
   reused for all of them (same known default → a per-user salt buys nothing
   and 200 scrypt runs would stall boot for ~20s). Each user re-salts the
   moment they change their own password.                                   */
try {
  const flag = db.prepare("SELECT value FROM settings WHERE key='pwd_default_v1'").get();
  if (!flag) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(DEFAULT_PASSWORD, salt, 32).toString('hex');
    const r = db.prepare("UPDATE users SET pwd_hash=?, pwd_salt=?, pwd_changed=0 WHERE pwd_hash IS NULL OR pwd_hash=''").run(hash, salt);
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('pwd_default_v1','1')").run();
    console.log('password migration: ' + r.changes + ' users set to the default password (' + DEFAULT_PASSWORD + ')');
  }
} catch (e) { console.error('password migration failed:', e.message); }

/* ---------- Pre Sales product/team — WhatsApp leads route only here ---------- */
try {
  const existing = db.prepare('SELECT code,name FROM teams').all();
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let ps = existing.find(t => norm(t.code) === 'ps' || norm(t.code) === 'presales' || norm(t.name) === 'presales');
  if (!ps) {
    db.prepare("INSERT OR IGNORE INTO teams(code,name,color) VALUES('PS','Pre Sales','#00b8d9')").run();
    ps = { code: 'PS' };
    console.log("created product 'PS' (Pre Sales) for WhatsApp lead routing");
  }
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('whatsapp_product',?)").run(ps.code);
} catch (e) { console.error('pre-sales team setup failed:', e.message); }

/* ---------- one-time UTC → IST shift of every stored timestamp ----------
   Rows written before this release hold UTC. Shifting them +5:30 puts the
   whole database on one clock so "today", date ranges and timelines agree.
   Guarded by a settings flag so it can never run twice.                   */
try {
  const done = db.prepare("SELECT value FROM settings WHERE key='tz_ist_v1'").get();
  if (!done) {
    const shift = (table, col) => {
      try {
        const r = db.prepare(`UPDATE ${table} SET ${col}=datetime(${col},'+330 minutes')
                              WHERE ${col} IS NOT NULL AND length(${col})>=19`).run();
        return r.changes;
      } catch (e) { return 0; }
    };
    let total = 0;
    total += shift('leads', 'created_at') + shift('leads', 'updated_at') + shift('leads', 'deleted_at');
    total += shift('activities', 'created_at');
    total += shift('calls', 'created_at');
    total += shift('logins', 'created_at');
    total += shift('lead_deletions', 'created_at');
    total += shift('users', 'created_at');
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('tz_ist_v1','1')").run();
    console.log('timezone migration: ' + total + ' timestamps shifted UTC → IST');
  }
} catch (e) { console.error('timezone migration failed:', e.message); }

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
/* passwords use the same scrypt scheme as the old PINs, own columns */
function hashPassword(pwd, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
  return { hash, salt };
}
function verifyPassword(pwd, hash, salt) {
  if (!hash || !salt) return false;
  const h = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)); } catch { return false; }
}

module.exports = { db, hashPin, verifyPin, hashPassword, verifyPassword, uid, DB_PATH,
  nowIst, todayIst, addDaysIst, IST_NOW, IST_TODAY, IST_MINUTES, DEFAULT_PASSWORD };
