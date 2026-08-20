/* ============================================================
   MHS CRM — API server (Node builtins only: http, sqlite, crypto)
   Start:  node server.js       (PORT env, default 4000)
   ============================================================ */
require('./loadenv')();                       // tiny .env loader (no dependency)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPin, verifyPin, hashPassword, verifyPassword, uid,
        nowIst, todayIst, addDaysIst, IST_NOW, IST_TODAY, DEFAULT_PASSWORD } = require('./db');
const cfg = require('./config');
const { sendWhatsApp, clickToCall, sendEmail } = require('./integrations');
let wa = { init() {}, status() { return { available: false, connected: false, qr: null, error: 'module load failed' }; }, async logout() { return false; } };
try { wa = require('./whatsapp'); } catch (e) { console.warn('whatsapp module not loaded:', e.message); }

const PORT = process.env.PORT || 4000;
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-CHANGE-ME';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-webhook-secret';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'mhs-verify';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* brute-force protection: lock an IP after too many wrong PINs */
const loginFails = new Map();          // ip -> { fails, until }
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;   // 5 min lockout

/* ---------------- auth tokens (JWT-like, HMAC-signed) ---------------- */
const b64u = (s) => Buffer.from(s).toString('base64url');
function signToken(p) {
  const body = b64u(JSON.stringify({ ...p, exp: Date.now() + 12 * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(tok) {
  if (!tok) return null;
  const [body, sig] = String(tok).split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null; } catch { return null; }
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp < Date.now() ? null : p; } catch { return null; }
}

/* ---------------- helpers ---------------- */
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const err = (res, code, msg) => send(res, code, { error: msg });
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { if (!d) return resolve({}); try { resolve(JSON.parse(d)); } catch { resolve({ __raw: d }); } });
  });
}
const today = () => todayIst();                    // IST calendar date
const addDays = (n) => addDaysIst(n);              // IST calendar date, n days out
const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const activeSales = (team) => db.prepare("SELECT * FROM users WHERE role='sales' AND active=1 AND (?='' OR team=?) ORDER BY id").all(team || '', team || '');

function authUser(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  const p = verifyToken(tok);
  if (!p) return null;
  return userById(p.uid);
}

/* who may bulk-upload leads (manager roles only — Sales never can) */
const IMPORT_ROLES = ['admin', 'super', 'lead'];
/* who may create a lead at all. Sales agents work the leads they are given;
   they no longer see or reach the Add Lead action (UI hides it, this enforces it). */
const ADD_LEAD_ROLES = ['admin', 'super', 'lead'];
/* admin > super (Super Manager) > lead (Manager) > sales */
const ROLES = ['admin', 'super', 'lead', 'sales'];
const ROLE_LABEL = { admin: 'Admin', super: 'Super Manager', lead: 'Manager', sales: 'Sales' };

/* Resolve an Owner cell from an uploaded sheet to a real CRM user.
   Accepts the person's email or their exact name (case / spacing
   insensitive). NEVER a partial match — a fuzzy "Akshay" would be
   ambiguous between two Akshays and silently hand leads to the wrong
   agent, so an unresolvable value is reported instead of guessed. */
function resolveOwnerCell(val) {
  const raw = String(val == null ? '' : val).trim();
  if (!raw) return { id: null, blank: true };
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  const flat = key.replace(/[^a-z0-9]/g, '');
  const users = db.prepare('SELECT id,name,email,team,role,active FROM users').all();
  let hit = users.find(u => String(u.email || '').trim().toLowerCase() === key);
  if (!hit) {
    const nameHits = users.filter(u => String(u.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === key
                                    || String(u.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === flat);
    if (nameHits.length > 1) return { id: null, error: 'more than one user is named "' + raw + '" — use their email instead' };
    hit = nameHits[0];
  }
  if (!hit) return { id: null, error: 'owner "' + raw + '" is not a user in this CRM' };
  if (!hit.active) return { id: null, error: 'owner "' + raw + '" is a deactivated user' };
  return { id: hit.id, user: hit };
}

/* Which product WhatsApp leads belong to (admin-settable, defaults to Pre Sales).
   Every inbound WhatsApp message becomes a Pre Sales lead and is round-robined
   ONLY among Pre Sales agents. */
function presalesProduct() {
  const s = db.prepare("SELECT value FROM settings WHERE key='whatsapp_product'").get();
  const teams = getTeams();
  if (s && s.value && teams[s.value]) return s.value;
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = Object.keys(teams).find(c => norm(c) === 'ps' || norm(c) === 'presales' || norm(teams[c].name) === 'presales');
  return hit || 'PS';
}

/* ---------------- round-robin ---------------- */
/* strict=true → never spill outside the team. Used for WhatsApp/Pre Sales:
   better an unassigned lead an admin can see than a lead silently handed to
   another product's agent. */
function nextAgent(team, strict) {
  let list = activeSales(team);
  if (!list.length && !strict) list = activeSales('');   // fallback: any sales
  if (!list.length) return null;
  let row = db.prepare('SELECT idx FROM rr_state WHERE team=?').get(team) ;
  let idx = row ? row.idx : 0;
  const agent = list[idx % list.length];
  const next = (idx + 1) % 1e9;
  if (row) db.prepare('UPDATE rr_state SET idx=? WHERE team=?').run(next, team);
  else db.prepare('INSERT INTO rr_state(team,idx) VALUES(?,?)').run(team, next);
  return agent;
}

/* ---------------- lead helpers ---------------- */
function logAct(leadId, title, sub, byName) {
  db.prepare(`INSERT INTO activities(lead_id,title,sub,by_name,created_at) VALUES(?,?,?,?,${IST_NOW})`).run(leadId, title, sub || '', byName || 'System');
}
/* Lead assignment history — every hand-over of a lead is recorded here so
   "who gave which lead to whom, and when" is answerable and exportable.
   Written on: manual create, round-robin, import, single/bulk reassign,
   user transfer and webhook capture.                                      */
function logAssign(lead, fromOwner, toOwner, byUser, reason) {
  try {
    if (fromOwner === toOwner) return;
    const f = fromOwner ? userById(fromOwner) : null;
    const t = toOwner ? userById(toOwner) : null;
    db.prepare(`INSERT INTO lead_assignments(lead_id,lead_name,phone,product,from_owner,from_name,to_owner,to_name,by_user,by_name,reason,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,${IST_NOW})`)
      .run(lead.id, lead.name || '', lead.phone || '', lead.product || '',
           fromOwner || null, f ? f.name : (fromOwner ? fromOwner : 'Unassigned'),
           toOwner || null, t ? t.name : (toOwner ? toOwner : 'Unassigned'),
           byUser && byUser.id ? byUser.id : null, byUser && byUser.name ? byUser.name : 'System',
           reason || 'manual');
  } catch (e) { console.warn('assignment log failed:', e.message); }
}
function leadRow(id) { return db.prepare('SELECT * FROM leads WHERE id=?').get(id); }
function leadJSON(row, withActivities) {
  if (!row) return null;
  const owner = row.owner_id ? userById(row.owner_id) : null;
  const out = {
    id: row.id, name: row.name, phone: row.phone, email: row.email, city: row.city,
    product: row.product, source: row.source, status: row.status, website: row.website,
    score: row.score, converted: !!row.converted, next_followup: row.next_followup,
    next_followup_at: row.next_followup_at || (row.next_followup ? row.next_followup + ' 10:00' : null),
    owner_id: row.owner_id, owner_name: owner ? owner.name : '—', owner_team: owner ? owner.team : '',
    created_at: row.created_at, updated_at: row.updated_at,
  };
  if (withActivities) out.activities = db.prepare('SELECT title,sub,by_name,created_at FROM activities WHERE lead_id=? ORDER BY id ASC').all(row.id);
  return out;
}
const autoOn = (key) => { const r = db.prepare('SELECT enabled FROM automation WHERE key=?').get(key); return r ? !!r.enabled : false; };

function connectorForSource(src) { return db.prepare('SELECT * FROM connectors WHERE src=? ORDER BY connected DESC LIMIT 1').get(src); }

function fmtSecs(n) { n = Math.max(0, +n || 0); const m = Math.floor(n / 60), s2 = n % 60; return m ? m + 'm ' + s2 + 's' : s2 + 's'; }
function normPhone(p) { return String(p == null ? '' : p).replace(/\D/g, '').slice(-10); }
function findLeadByPhone(phone) {
  const norm = normPhone(phone);
  if (norm.length < 7) return null;
  return db.prepare("SELECT * FROM leads WHERE deleted=0 AND phone_norm=? ORDER BY created_at DESC").get(norm) || null;
}
function createLead(data, byName, opts = {}) {
  // dedupe by external_id
  if (data.external_id) {
    const ex = db.prepare('SELECT * FROM leads WHERE external_id=?').get(data.external_id);
    if (ex) return { lead: ex, deduped: true };
  }
  // dedupe by phone number — one phone = one lead (unique identity)
  const dupPhone = findLeadByPhone(data.phone);
  if (dupPhone) return { lead: dupPhone, deduped: true };
  const phoneNorm = normPhone(data.phone);
  const source = data.source || 'Manual';
  const conn = connectorForSource(source);
  const product = data.product || (conn ? conn.team : 'MHS');
  let ownerId = data.owner_id || null;
  let assignNote = ownerId ? 'Assigned to ' + (userById(ownerId)?.name || ownerId) : '';
  if (!ownerId && (opts.autoAssign ?? autoOn('roundRobin'))) {
    const a = nextAgent(product, opts.strictTeam);
    if (a) { ownerId = a.id; assignNote = 'Round-robin → ' + a.name; }
    else if (opts.strictTeam) assignNote = '⚠️ No active agent in ' + product + ' — left unassigned';
  }
  const id = data.id || ('L' + uid('').slice(0, 8));
  const followup = autoOn('autoFollowup') ? addDays(1) : null;
  const score = data.score ?? (['Website', 'WhatsApp', 'Calendly'].includes(source) ? 70 : 55);
  db.prepare(`INSERT INTO leads(id,name,phone,phone_norm,email,city,product,source,status,owner_id,website,score,converted,next_followup,next_followup_at,external_id,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?, 'Fresh', ?,?,?,0,?,?,?, ${IST_NOW}, ${IST_NOW})`)
    .run(id, data.name || 'Unknown', data.phone || '', phoneNorm || null, data.email || '', data.city || '', product, source, ownerId, data.website || '', score, followup, followup ? followup + ' 10:00' : null, data.external_id || null);
  logAct(id, 'Lead created', 'Source: ' + source, byName || 'System');
  if (assignNote) logAct(id, '🔁 ' + assignNote, '', 'System');
  const fresh = leadRow(id);
  if (ownerId) logAssign(fresh, null, ownerId, opts.byUser || { name: byName || 'System' },
                         opts.reason || (data.owner_id ? 'manual' : 'round-robin'));
  return { lead: fresh, deduped: false };
}

async function pushToCustomerCRM(lead) {
  const url = process.env.CUSTOMER_CRM_WEBHOOK;
  if (!url) return { pushed: false, simulated: true, reason: 'CUSTOMER_CRM_WEBHOOK not set' };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'won_lead', lead: leadJSON(lead) }) });
    return { pushed: r.ok };
  } catch (e) { return { pushed: false, error: String(e) }; }
}

async function applyStatusChange(lead, newStatus, byName) {
  if (lead.status === newStatus) return;
  const prev = lead.status;
  const st = cfg.STATUS[newStatus] || {};
  let followup = lead.next_followup;
  let converted = lead.converted;
  logAct(lead.id, 'Status: ' + prev + ' → ' + newStatus, '', byName);
  if (st.won) {
    converted = 1; followup = null;
    logAct(lead.id, '🎉 Marked Closed Won', 'Auto-pushed to Customer CRM', byName);
    await pushToCustomerCRM(lead);
  } else if (!st.open) {
    followup = null;
  } else if (!followup && autoOn('autoFollowup')) {
    followup = addDays(2);
  }
  db.prepare('UPDATE leads SET status=?, next_followup=?, converted=?, updated_at=datetime(\'now\') WHERE id=?').run(newStatus, followup, converted, lead.id);
}

async function handleMiss(lead, byName) {
  logAct(lead.id, '📵 Call — No answer', 'Rang out, no response', byName);
  const steps = [];
  if (autoOn('autoWaOnMiss')) {
    const msg = `Hi ${String(lead.name).split(' ')[0]}, we tried calling you. When are you available?`;
    const r = await sendWhatsApp(lead.phone, msg);
    logAct(lead.id, '🟢 Auto WhatsApp ' + (r.sent ? 'sent' : '(simulated)'), '"' + msg + '"', 'System');
    steps.push('WhatsApp');
  }
  if (autoOn('autoRnrOnMiss')) {
    db.prepare("UPDATE leads SET status='RNR', next_followup=?, updated_at=datetime('now','+330 minutes') WHERE id=?").run(addDays(1), lead.id);
    logAct(lead.id, '↪️ Auto status → RNR', 'Reminder set for tomorrow', 'System');
    steps.push('RNR + reminder');
  }
  return steps;
}

/* ---------------- reminders (date + TIME) ----------------
   A sales POC sets a reminder on every call: "call me in 1 hour",
   "call me after 2 days". next_followup_at holds the full IST wall-clock
   'YYYY-MM-DD HH:MM'; next_followup keeps the date so every existing
   overdue / due-today query and report keeps working unchanged.        */
function setReminder(lead, b, byUser) {
  let at = b.next_followup_at !== undefined ? b.next_followup_at : undefined;
  let date = b.next_followup !== undefined ? b.next_followup : undefined;
  if (at) {
    at = String(at).replace('T', ' ').trim().slice(0, 16);
    if (at.length === 10) at += ' 10:00';
    date = at.slice(0, 10);
  } else if (at === '' || at === null) { at = null; date = null; }
  else if (date) { date = String(date).slice(0, 10); at = date + ' 10:00'; }
  else { at = null; date = null; }
  db.prepare('UPDATE leads SET next_followup=?, next_followup_at=? WHERE id=?').run(date, at, lead.id);
  logAct(lead.id, at ? '⏰ Reminder set' : '⏰ Reminder cleared', at || '', (byUser && byUser.name) || 'System');
  lead.next_followup = date; lead.next_followup_at = at;
  return at;
}
/* Reminders due for a user — what the dashboard bell and the "My reminders"
   panel show. Overdue first, then today, then upcoming.                  */
function myReminders(user, limit) {
  const s = scopeSql(user);
  const OPEN = "('Fresh','RNR','Follow Up','Interested')";
  const rows = db.prepare(`SELECT * FROM leads WHERE (${s.where}) AND deleted=0
      AND next_followup IS NOT NULL AND next_followup <> '' AND status IN ${OPEN}
      ORDER BY COALESCE(next_followup_at, next_followup || ' 10:00') ASC LIMIT ?`).all(...s.args, +limit || 200);
  const now = nowIst();                 // 'YYYY-MM-DD HH:MM:SS' IST
  const today = todayIst();
  const out = rows.map(r => {
    const at = r.next_followup_at || (r.next_followup + ' 10:00');
    const owner = r.owner_id ? userById(r.owner_id) : null;
    let bucket = 'upcoming';
    if (at.slice(0, 16) < now.slice(0, 16)) bucket = 'overdue';
    else if (at.slice(0, 10) === today) bucket = 'today';
    return { id: r.id, name: r.name, phone: r.phone, product: r.product, source: r.source,
      status: r.status, at, date: r.next_followup, bucket,
      owner_id: r.owner_id, owner_name: owner ? owner.name : '—' };
  });
  return { now, today, reminders: out,
    counts: { overdue: out.filter(x => x.bucket === 'overdue').length,
              today: out.filter(x => x.bucket === 'today').length,
              upcoming: out.filter(x => x.bucket === 'upcoming').length } };
}

/* ---------------- reporting tree / data scope ----------------
   Roles, top to bottom:
     admin  — sees everything
     super  — Super Manager: sees the Managers reporting to them,
              plus every agent under those Managers
     lead   — Manager: sees the agents reporting to them
     sales  — sees only their own leads
   The link is users.manager_id, so the tree can be any depth (a Super
   Manager may even sit under another Super Manager). The walk is
   cycle-guarded — a bad manager_id loop must never hang a request.      */
const MANAGER_ROLES = ['admin', 'super', 'lead'];
/* every user id at or below `user` in the reporting tree (includes self) */
function visibleUserIds(user) {
  const ids = new Set([user.id]);
  if (user.role === 'sales') return [...ids];
  const kids = db.prepare('SELECT id FROM users WHERE manager_id=?');
  const stack = [user.id];
  while (stack.length) {
    const cur = stack.pop();
    for (const r of kids.all(cur)) if (!ids.has(r.id)) { ids.add(r.id); stack.push(r.id); }
  }
  // legacy fallback: a Manager with nobody assigned yet keeps seeing their product's agents
  if (user.role === 'lead' && ids.size === 1 && user.team) {
    db.prepare("SELECT id FROM users WHERE role='sales' AND team=?").all(user.team).forEach(r => ids.add(r.id));
  }
  return [...ids];
}
function scopeSql(user) {
  if (user.role === 'admin') return { where: '1=1', args: [] };
  if (user.role === 'sales') return { where: 'owner_id=?', args: [user.id] };
  const ids = visibleUserIds(user);
  return { where: `owner_id IN (${ids.map(() => '?').join(',')})`, args: ids };
}
/* every user (any role) this user may look at — used by Team, Attendance, User list */
function usersForUser(user) {
  if (user.role === 'admin') return db.prepare('SELECT * FROM users ORDER BY role, name').all();
  const ids = new Set(visibleUserIds(user));
  return db.prepare('SELECT * FROM users ORDER BY role, name').all().filter(u => ids.has(u.id));
}
// sales agents visible to a user (admin=all, manager/super=everyone under them, sales=self)
function salesForUser(user) {
  if (user.role === 'admin') return activeSales('');
  if (user.role === 'sales') return [user];
  const ids = new Set(visibleUserIds(user));
  return db.prepare("SELECT * FROM users WHERE role='sales' AND active=1 ORDER BY id").all().filter(u => ids.has(u.id));
}
/* Managers visible to this user, each with their own team roster.
   Powers Team → "manager-wise" view and the Super Manager dashboard. */
function managerTree(user) {
  const scope = new Set(visibleUserIds(user));
  const all = db.prepare('SELECT id,name,email,role,team,department,phone,manager_id,active FROM users ORDER BY name').all();
  const visible = user.role === 'admin' ? all : all.filter(u => scope.has(u.id));
  const leadCount = db.prepare('SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0');
  const decorate = (u) => ({ ...u, active: !!u.active, leads: leadCount.get(u.id).n });
  const managers = visible.filter(u => u.role === 'lead').map(m => {
    const members = visible.filter(u => u.role === 'sales' && u.manager_id === m.id).map(decorate);
    return { ...decorate(m), members,
      teamSize: members.length,
      teamLeads: members.reduce((a, x) => a + x.leads, 0),
      superName: (all.find(x => x.id === m.manager_id) || {}).name || null };
  });
  const supers = visible.filter(u => u.role === 'super').map(s => {
    const mine = managers.filter(m => m.manager_id === s.id);
    return { ...decorate(s), managers: mine.map(m => ({ id: m.id, name: m.name, teamSize: m.teamSize, teamLeads: m.teamLeads })),
      managerCount: mine.length,
      teamSize: mine.reduce((a, m) => a + m.teamSize, 0),
      teamLeads: mine.reduce((a, m) => a + m.teamLeads, 0) };
  });
  const unassigned = visible.filter(u => u.role === 'sales' && !visible.some(m => m.role === 'lead' && m.id === u.manager_id)).map(decorate);
  return { supers, managers, unassigned, all: visible.map(decorate) };
}
// unified lead filter: role scope + date/source/department/employee
function leadWhere(user, f) {
  f = f || {};
  const s = scopeSql(user);
  let where = '(' + s.where + ') AND deleted=0', args = [...s.args];
  if (f.from) { where += " AND date(created_at) >= date(?)"; args.push(f.from); }
  if (f.to) { where += " AND date(created_at) <= date(?)"; args.push(f.to); }
  if (f.source) { where += " AND source=?"; args.push(f.source); }
  if (f.owner) { where += " AND owner_id=?"; args.push(f.owner); }
  if (f.department) { where += " AND owner_id IN (SELECT id FROM users WHERE department=?)"; args.push(f.department); }
  if (f.team) { where += " AND owner_id IN (SELECT id FROM users WHERE team=?)"; args.push(f.team); }
  return { where, args };
}
function getDepartments() {
  return db.prepare("SELECT DISTINCT department d FROM users WHERE department IS NOT NULL AND department<>'' ORDER BY department").all().map(r => r.d);
}
function reportSummary(user, f) {
  const w = leadWhere(user, f);
  const rows = db.prepare(`SELECT status, source FROM leads WHERE ${w.where}`).all(...w.args);
  const total = rows.length;
  const won = rows.filter(r => cfg.STATUS[r.status]?.won).length;
  const open = rows.filter(r => cfg.STATUS[r.status]?.open).length;
  const interested = rows.filter(r => r.status === 'Interested').length;
  // count ALL sources actually present (so imported leads with custom sources like "New Lead" are included)
  const srcMap = {};
  rows.forEach(r => { const s = (r.source && String(r.source).trim()) || 'Others'; srcMap[s] = (srcMap[s] || 0) + 1; });
  const bySource = Object.keys(srcMap).map(src => ({ src, n: srcMap[src] })).sort((a, b) => b.n - a.n);
  // Sales funnel = 5 core pipeline stages (RNR/Junk/Lost are side-states, tracked elsewhere)
  const CORE_STAGES = ['Fresh', 'Follow Up', 'Interested', 'Not Interested', 'Closed Won'];
  const funnel = CORE_STAGES.map(st => ({ st, n: rows.filter(r => r.status === st).length }));
  // for a sales agent: today's own calls + talk time (for the dashboard card)
  let myTodayCalls = 0, myTodayTalk = 0;
  if (user.role === 'sales') {
    const c = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(talktime),0) t FROM calls WHERE owner_id=? AND date(created_at)=date('now','+330 minutes')").get(user.id);
    myTodayCalls = c.n; myTodayTalk = c.t;
  }
  return { total, won, open, interested, conv: total ? Math.round(won / total * 100) : 0, bySource, funnel, myTodayCalls, myTodayTalk };
}
function reportAgents(user, f) {
  f = f || {};
  let sales = salesForUser(user);
  if (f.department) sales = sales.filter(u => u.department === f.department);
  if (f.team) sales = sales.filter(u => u.team === f.team);
  if (f.owner) sales = sales.filter(u => u.id === f.owner);
  const cols = ['Fresh', 'Follow Up', 'Interested', 'Not Interested', 'Closed Won'];
  return sales.map(u => {
    let w = 'owner_id=? AND deleted=0', a = [u.id];
    if (f.from) { w += " AND date(created_at)>=date(?)"; a.push(f.from); }
    if (f.to) { w += " AND date(created_at)<=date(?)"; a.push(f.to); }
    if (f.source) { w += " AND source=?"; a.push(f.source); }
    const rows = db.prepare('SELECT status FROM leads WHERE ' + w).all(...a);
    const counts = {}; cols.forEach(c => counts[c] = rows.filter(r => r.status === c).length);
    return { id: u.id, name: u.name, email: u.email, team: u.team, department: u.department, total: rows.length, counts };
  });
}
function reportActivity(user, f) {
  f = f || {};
  let sales = salesForUser(user);
  if (f.department) sales = sales.filter(u => u.department === f.department);
  if (f.team) sales = sales.filter(u => u.team === f.team);
  if (f.owner) sales = sales.filter(u => u.id === f.owner);
  // connected calls today + talk time, per owner (from the calls table)
  const rows = db.prepare(`SELECT owner_id oid, COUNT(*) c, SUM(talktime) t FROM calls
      WHERE connected=1 AND date(created_at)=date('now','+330 minutes') GROUP BY owner_id`).all();
  const cMap = Object.fromEntries(rows.map(r => [r.oid, r]));
  return sales.map(u => {
    const junk = db.prepare("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND status='Junk' AND deleted=0").get(u.id).n;
    const c = cMap[u.id] || { c: 0, t: 0 };
    // avg first-response minutes for TODAY's leads (lead created today → first CONNECTED call).
    // Restricted to today so old bulk-imported leads don't inflate the number.
    const resp = db.prepare(`SELECT AVG(mins) m FROM (
        SELECT (julianday(MIN(ca.created_at)) - julianday(l.created_at))*24*60 mins
        FROM leads l JOIN calls ca ON ca.lead_id=l.id
        WHERE l.owner_id=? AND l.deleted=0 AND ca.connected=1 AND date(l.created_at)=date('now','+330 minutes') GROUP BY l.id)`).get(u.id).m;
    return { id: u.id, name: u.name, team: u.team, callsToday: c.c, talktime: c.t || 0,
      avgRespMin: resp ? Math.max(0, Math.round(resp)) : null, junk, working: c.c > 0 };
  });
}
// LSQ-style daily report: per agent — calls, connected, durations, pipeline counts, overdue tasks (for a date)
function reportDaily(user, f) {
  f = f || {};
  const today = todayIst();
  const from = f.from || f.date || today;
  const to = f.to || f.date || today;
  let sales = salesForUser(user);
  if (f.department) sales = sales.filter(u => u.department === f.department);
  if (f.team) sales = sales.filter(u => u.team === f.team);
  if (f.owner) sales = sales.filter(u => u.id === f.owner);
  const OPEN = "('Fresh','RNR','Follow Up','Interested')";
  const rows = sales.map(u => {
    const call = db.prepare(`SELECT COUNT(*) calls,
        SUM(CASE WHEN connected=1 THEN 1 ELSE 0 END) conn,
        SUM(CASE WHEN connected=1 THEN talktime ELSE 0 END) dur
        FROM calls WHERE owner_id=? AND date(created_at)>=date(?) AND date(created_at)<=date(?)`).get(u.id, from, to);
    const st = {};
    db.prepare("SELECT status, COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0 GROUP BY status").all(u.id).forEach(r => st[r.status] = r.n);
    const totalOpp = db.prepare("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0").get(u.id).n;
    const overdue = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0 AND next_followup IS NOT NULL AND next_followup < date('now','+330 minutes') AND status IN ${OPEN}`).get(u.id).n;
    const conn = call.conn || 0, dur = call.dur || 0;
    return {
      id: u.id, name: u.name, email: u.email || '', team: u.team,
      calls: call.calls || 0, connected: conn, duration: dur, avg: conn ? Math.round(dur / conn) : 0,
      totalOpp, fresh: st['Fresh'] || 0, rnr: st['RNR'] || 0, followup: st['Follow Up'] || 0, interested: st['Interested'] || 0,
      notInterested: st['Not Interested'] || 0, won: st['Closed Won'] || 0, overdue,
    };
  });
  return { from, to, date: from, rows };
}
// per-user + per-team missed / today-due follow-ups
function reportFollowups(user, f) {
  f = f || {};
  let sales = salesForUser(user);
  if (f.department) sales = sales.filter(u => u.department === f.department);
  if (f.team) sales = sales.filter(u => u.team === f.team);
  if (f.owner) sales = sales.filter(u => u.id === f.owner);
  const OPEN = "('Fresh','RNR','Follow Up','Interested')";
  const per = sales.map(u => {
    const missed = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0 AND next_followup IS NOT NULL AND next_followup < date('now','+330 minutes') AND status IN ${OPEN}`).get(u.id).n;
    const todayDue = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0 AND next_followup = date('now','+330 minutes') AND status IN ${OPEN}`).get(u.id).n;
    return { id: u.id, name: u.name, team: u.team, missed, todayDue };
  });
  const teams = {};
  per.forEach(x => { const t = teams[x.team] = teams[x.team] || { team: x.team, missed: 0, todayDue: 0 }; t.missed += x.missed; t.todayDue += x.todayDue; });
  return { per: per.sort((a, b) => b.missed - a.missed), teams: Object.values(teams) };
}

// attendance: who logged in today (present) vs not (absent), + department-wise
function reportAttendance(user) {
  const users = usersForUser(user).filter(u => u.active)
    .map(u => ({ id: u.id, name: u.name, role: u.role, team: u.team, department: u.department }))
    .sort((a, b) => String(a.department || '').localeCompare(String(b.department || '')) || String(a.name).localeCompare(String(b.name)));
  const todays = db.prepare("SELECT user_id, MAX(created_at) last, COUNT(*) c FROM logins WHERE date(created_at)=date('now','+330 minutes') GROUP BY user_id").all();
  const lastMap = Object.fromEntries(todays.map(r => [r.user_id, r]));
  const per = users.map(u => ({ id: u.id, name: u.name, role: u.role, team: u.team, department: u.department || '—',
    present: !!lastMap[u.id], lastLogin: lastMap[u.id] ? lastMap[u.id].last : null, logins: lastMap[u.id] ? lastMap[u.id].c : 0 }));
  const byDept = {};
  per.forEach(p => { const d = byDept[p.department] = byDept[p.department] || { department: p.department, present: 0, absent: 0, total: 0 }; d.total++; p.present ? d.present++ : d.absent++; });
  const present = per.filter(p => p.present).length;
  return { present, absent: per.length - present, total: per.length, byDept: Object.values(byDept), per };
}
// leads distribution: per agent, leads assigned in range (default today) + status breakdown
function reportLeadsDist(user, f) {
  f = f || {};
  const from = f.from || todayIst();
  const to = f.to || from;
  let sales = salesForUser(user);
  if (f.team) sales = sales.filter(u => u.team === f.team);
  if (f.department) sales = sales.filter(u => u.department === f.department);
  const cols = cfg.STATUS_LIST;
  const per = sales.map(u => {
    const rows = db.prepare("SELECT status FROM leads WHERE owner_id=? AND deleted=0 AND date(created_at)>=date(?) AND date(created_at)<=date(?)").all(u.id, from, to);
    const counts = {}; cols.forEach(c => counts[c] = rows.filter(r => r.status === c).length);
    return { id: u.id, name: u.name, department: u.department || '—', team: u.team, total: rows.length, counts };
  });
  return { from, to, cols, per };
}

// deleted-leads report: total + per user + department-wise + recent list (scoped)
function reportDeletions(user) {
  const ids = user.role === 'admin' ? null : visibleUserIds(user);
  const ph = ids ? ids.map(() => '?').join(',') : '';
  const w = ids ? ` WHERE deleted_by IN (${ph})` : '';
  const a = ids || [];
  const total = db.prepare('SELECT COUNT(*) n FROM lead_deletions' + w).get(...a).n;
  const per = db.prepare("SELECT deleted_by_name name, COALESCE(department,'—') department, COUNT(*) c FROM lead_deletions" + w + " GROUP BY deleted_by ORDER BY c DESC").all(...a);
  const byDept = db.prepare("SELECT COALESCE(department,'—') department, COUNT(*) c FROM lead_deletions" + w + " GROUP BY department ORDER BY c DESC").all(...a);
  const recent = db.prepare('SELECT lead_name, phone, deleted_by_name, department, created_at FROM lead_deletions' + w + ' ORDER BY id DESC LIMIT 100').all(...a);
  return { total, per, byDept, recent };
}

/* CLOSED LEADS report — how many leads were actually closed, by whom, and
   every closed client clickable so the POC's work can be inspected.
   "Closed" = Closed Won + Closed Lost; won/lost are counted separately.  */
function reportClosed(user, f) {
  f = f || {};
  const w = leadWhere(user, f);
  let where = w.where + " AND status IN ('Closed Won','Closed Lost')", args = [...w.args];
  if (f.closedType === 'won') where += " AND status='Closed Won'";
  if (f.closedType === 'lost') where += " AND status='Closed Lost'";
  const rows = db.prepare(`SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT 2000`).all(...args);
  const leads = rows.map(r => {
    const o = r.owner_id ? userById(r.owner_id) : null;
    const calls = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(talktime),0) t FROM calls WHERE lead_id=?').get(r.id);
    return { id: r.id, name: r.name, phone: r.phone, email: r.email, city: r.city,
      product: r.product, source: r.source, status: r.status,
      owner_id: r.owner_id, owner_name: o ? o.name : '—', owner_team: o ? o.team : '',
      created_at: r.created_at, closed_at: r.updated_at,
      calls: calls.n, talktime: calls.t };
  });
  const won = leads.filter(l => l.status === 'Closed Won').length;
  const perAgent = {};
  leads.forEach(l => {
    const k = l.owner_id || '—';
    const x = perAgent[k] = perAgent[k] || { id: l.owner_id, name: l.owner_name, team: l.owner_team, won: 0, lost: 0, total: 0 };
    x.total++; l.status === 'Closed Won' ? x.won++ : x.lost++;
  });
  return { total: leads.length, won, lost: leads.length - won,
    perAgent: Object.values(perAgent).sort((a, b) => b.won - a.won), leads };
}

/* LEAD ASSIGNMENT HISTORY — who assigned which lead to whom and when.
   Scoped like everything else, filterable, and exportable to a sheet.   */
function reportAssignments(user, f) {
  f = f || {};
  let where = '1=1', args = [];
  if (user.role !== 'admin') {
    const ids = visibleUserIds(user);
    const ph = ids.map(() => '?').join(',');
    where += ` AND (to_owner IN (${ph}) OR from_owner IN (${ph}) OR by_user IN (${ph}))`;
    args.push(...ids, ...ids, ...ids);
  }
  if (f.from) { where += ' AND date(created_at)>=date(?)'; args.push(f.from); }
  if (f.to) { where += ' AND date(created_at)<=date(?)'; args.push(f.to); }
  if (f.owner) { where += ' AND to_owner=?'; args.push(f.owner); }
  if (f.by) { where += ' AND by_user=?'; args.push(f.by); }
  if (f.reason) { where += ' AND reason=?'; args.push(f.reason); }
  if (f.q) { where += ' AND (lead_name LIKE ? OR phone LIKE ?)'; const t = '%' + f.q + '%'; args.push(t, t); }
  const rows = db.prepare(`SELECT * FROM lead_assignments WHERE ${where} ORDER BY id DESC LIMIT 5000`).all(...args);
  const byUserMap = {};
  rows.forEach(r => {
    const k = r.by_user || '—';
    const x = byUserMap[k] = byUserMap[k] || { id: r.by_user, name: r.by_name || 'System', assigned: 0 };
    x.assigned++;
  });
  const toMap = {};
  rows.forEach(r => {
    const k = r.to_owner || '—';
    const x = toMap[k] = toMap[k] || { id: r.to_owner, name: r.to_name || 'Unassigned', received: 0 };
    x.received++;
  });
  return { total: rows.length, rows,
    byUser: Object.values(byUserMap).sort((a, b) => b.assigned - a.assigned),
    toUser: Object.values(toMap).sort((a, b) => b.received - a.received) };
}
// user-list report: counts by role + department-wise + full list
function reportUsersList(user) {
  const users = usersForUser(user).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role,
    team: u.team, department: u.department, manager_id: u.manager_id, active: u.active }));
  const counts = { total: users.length, admin: 0, super: 0, lead: 0, sales: 0 };
  users.forEach(u => { counts[u.role] = (counts[u.role] || 0) + 1; });
  const byDept = {};
  users.forEach(u => { const d = u.department || '—'; const x = byDept[d] = byDept[d] || { department: d, admin: 0, super: 0, lead: 0, sales: 0, total: 0 }; x[u.role] = (x[u.role] || 0) + 1; x.total++; });
  return { counts, byDept: Object.values(byDept), users };
}

/* ---------------- static ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let fp = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fp.startsWith(PUBLIC_DIR)) return err(res, 403, 'forbidden');
  fs.readFile(fp, (e, data) => {
    if (e) { fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => { if (e2) return err(res, 404, 'not found'); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2); }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(data);
  });
}

/* ---------------- webhook → lead mapping ---------------- */
function checkWebhookSecret(url) { return url.searchParams.get('token') === WEBHOOK_SECRET; }

function mapMetaLead(payload) {
  // Meta leadgen webhook: entry[].changes[].value.{leadgen_id, field_data:[{name,values}]}
  try {
    const v = payload.entry?.[0]?.changes?.[0]?.value || {};
    const f = {}; (v.field_data || []).forEach(x => f[x.name] = (x.values || [])[0]);
    return { external_id: 'meta_' + (v.leadgen_id || uid('')), name: f.full_name || f.name || 'FB Lead',
      phone: f.phone_number || f.phone || '', email: f.email || '', city: f.city || '', source: 'Facebook' };
  } catch { return null; }
}
function mapCalendly(payload) {
  const p = payload.payload || payload;
  return { name: p.name || p.invitee?.name || 'Calendly Lead', email: p.email || p.invitee?.email || '',
    phone: (p.questions_and_answers || []).find(q => /phone/i.test(q.question))?.answer || '', source: 'Calendly',
    external_id: 'cal_' + (p.uri ? crypto.createHash('md5').update(p.uri).digest('hex').slice(0, 12) : uid('')) };
}

/* ---------------- router ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;
  try {
    // ---------- WEBHOOKS (public) ----------
    if (p === '/webhooks/meta' && m === 'GET') {
      if (url.searchParams.get('hub.verify_token') === VERIFY_TOKEN) { res.writeHead(200); return res.end(url.searchParams.get('hub.challenge') || ''); }
      return err(res, 403, 'bad verify token');
    }
    if (p === '/webhooks/whatsapp' && m === 'GET') {
      if (url.searchParams.get('hub.verify_token') === VERIFY_TOKEN) { res.writeHead(200); return res.end(url.searchParams.get('hub.challenge') || ''); }
      return err(res, 403, 'bad verify token');
    }
    if (p.startsWith('/webhooks/') && m === 'POST') {
      const body = await readBody(req);
      let data = null;
      if (p === '/webhooks/meta') data = mapMetaLead(body);
      else if (p === '/webhooks/calendly') { if (!checkWebhookSecret(url)) return err(res, 401, 'bad token'); data = mapCalendly(body); }
      else if (p === '/webhooks/website') { if (!checkWebhookSecret(url)) return err(res, 401, 'bad token'); data = { name: body.name, phone: body.phone, email: body.email, city: body.city, product: body.product, website: body.website, source: 'Website', external_id: body.external_id }; }
      else if (p === '/webhooks/whatsapp') {
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const contact = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
        if (!msg) { res.writeHead(200); return res.end('EVENT_RECEIVED'); }
        data = { name: contact?.profile?.name || 'WhatsApp Lead', phone: msg.from, source: 'WhatsApp',
                 product: presalesProduct(), external_id: 'wa_' + msg.from };
      }
      else if (p.startsWith('/webhooks/generic/')) { if (!checkWebhookSecret(url)) return err(res, 401, 'bad token'); data = { name: body.name, phone: body.phone, email: body.email, city: body.city, product: body.product, source: body.source || 'Manual', external_id: body.external_id }; }
      if (!data || !data.name) return err(res, 400, 'could not parse lead');
      const isWa = p === '/webhooks/whatsapp';
      const { lead, deduped } = createLead(data, 'Webhook (' + p.split('/')[2] + ')', isWa ? { strictTeam: true, reason: 'webhook' } : { reason: 'webhook' });
      return send(res, 200, { ok: true, deduped, lead_id: lead.id, owner: userById(lead.owner_id)?.name || null });
    }

    // ---------- AUTH (email + password) ----------
    if (p === '/api/login' && m === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const rec = loginFails.get(ip) || { fails: 0, until: 0 };
      if (rec.until > now) return err(res, 429, 'Too many failed attempts. Try again in ' + Math.ceil((rec.until - now) / 1000) + 's.');
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return err(res, 400, 'Email and password are both required');
      const u = db.prepare('SELECT * FROM users WHERE active=1 AND lower(email)=?').get(email);
      const ok = u && verifyPassword(password, u.pwd_hash, u.pwd_salt);
      if (!ok) {
        rec.fails++;
        if (rec.fails >= LOGIN_MAX_FAILS) { rec.until = now + LOGIN_LOCK_MS; rec.fails = 0; }
        loginFails.set(ip, rec);
        // deliberately vague: never reveal whether the email exists
        return err(res, 401, 'Wrong email or password');
      }
      loginFails.delete(ip);
      try { db.prepare(`INSERT INTO logins(user_id,created_at) VALUES(?,${IST_NOW})`).run(u.id); } catch (e) {}
      return send(res, 200, { token: signToken({ uid: u.id, role: u.role, team: u.team }), user: publicUser(u) });
    }

    // everything below /api needs auth
    if (p.startsWith('/api/')) {
      const user = authUser(req);
      if (!user) return err(res, 401, 'unauthorized');

      if (p === '/api/me' && m === 'GET') return send(res, 200, { user: publicUser(user), config: publicConfig() });
      // every user changes their OWN password from their dashboard
      if (p === '/api/me/password' && m === 'POST') {
        const b = await readBody(req);
        const current = String(b.current || ''), next = String(b.password || '');
        if (!verifyPassword(current, user.pwd_hash, user.pwd_salt)) return err(res, 400, 'Your current password is wrong');
        if (next.length < 6) return err(res, 400, 'New password must be at least 6 characters');
        if (next === current) return err(res, 400, 'New password must be different from the current one');
        if (next === DEFAULT_PASSWORD) return err(res, 400, 'Please choose something other than the default password');
        const { hash, salt } = hashPassword(next);
        db.prepare('UPDATE users SET pwd_hash=?, pwd_salt=?, pwd_changed=1 WHERE id=?').run(hash, salt, user.id);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/config' && m === 'GET') return send(res, 200, publicConfig());

      // products / teams
      if (p === '/api/teams' && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
        if (!code || !b.name) return err(res, 400, 'code & name required');
        if (db.prepare('SELECT code FROM teams WHERE code=?').get(code)) return err(res, 409, 'code already exists');
        db.prepare('INSERT INTO teams(code,name,color) VALUES(?,?,?)').run(code, b.name, b.color || '#2d5be3');
        return send(res, 200, { ok: true, code });
      }
      if (p.match(/^\/api\/teams\/([^/]+)$/) && m === 'PATCH') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const code = p.split('/').pop(); const b = await readBody(req);
        if (b.name) db.prepare('UPDATE teams SET name=? WHERE code=?').run(b.name, code);
        if (b.color) db.prepare('UPDATE teams SET color=? WHERE code=?').run(b.color, code);
        if (b.active !== undefined) db.prepare('UPDATE teams SET active=? WHERE code=?').run(b.active ? 1 : 0, code);
        return send(res, 200, { ok: true });
      }

      // lead sources
      if (p === '/api/sources' && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        if (!b.name) return err(res, 400, 'name required');
        db.prepare('INSERT OR REPLACE INTO sources(name,color,icon,active) VALUES(?,?,?,1)').run(b.name, b.color || '#6b7488', b.icon || String(b.name).slice(0, 2));
        return send(res, 200, { ok: true });
      }

      // settings (targets)
      if (p === '/api/settings' && m === 'GET') return send(res, 200, { settings: getSettings() });
      if (p === '/api/settings' && m === 'PATCH') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        const up = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
        for (const k of ['target_leads', 'target_interested', 'target_closed']) if (b[k] !== undefined) up.run(k, String(b[k]));
        if (b.whatsapp_product !== undefined) {
          const wp = String(b.whatsapp_product).trim();
          if (!getTeams()[wp]) return err(res, 400, 'unknown product: ' + wp);
          up.run('whatsapp_product', wp);
        }
        return send(res, 200, { ok: true, settings: getSettings() });
      }

      // users
      if (p === '/api/users' && m === 'GET') {
        // a Manager / Super Manager only ever sees the people under them
        const rows = usersForUser(user).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role,
          team: u.team, department: u.department, phone: u.phone, manager_id: u.manager_id,
          active: u.active, pwd_changed: u.pwd_changed }));
        const withLoad = rows.map(u => ({ ...u, pwd_changed: !!u.pwd_changed, can_login: !!(u.email && String(u.email).includes('@')),
          leads: db.prepare('SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0').get(u.id).n }));
        return send(res, 200, { users: withLoad });
      }
      if (p === '/api/users' && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        // email IS the login id now, so it is mandatory and must be unique
        if (!b.name) return err(res, 400, 'name required');
        if (!email || !email.includes('@')) return err(res, 400, 'A valid email is required — it is the login id');
        if (db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email)) return err(res, 409, 'That email is already used by another user');
        const password = String(b.password || DEFAULT_PASSWORD);
        if (password.length < 6) return err(res, 400, 'Password must be at least 6 characters');
        const role = String(b.role || 'sales');
        if (!ROLES.includes(role)) return err(res, 400, 'unknown role: ' + role);
        const pw = hashPassword(password);
        const pn = hashPin(b.pin || Math.floor(1000 + Math.random() * 9000));   // legacy NOT NULL columns
        const id = uid('u');
        db.prepare(`INSERT INTO users(id,name,email,role,team,department,phone,manager_id,pin_hash,pin_salt,pwd_hash,pwd_salt,pwd_changed,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,${IST_NOW})`)
          .run(id, b.name, email, role, b.team || 'MHS', b.department || null, b.phone || null,
               b.manager_id || null, pn.hash, pn.salt, pw.hash, pw.salt);
        return send(res, 200, { ok: true, id, email, password });
      }
      // transfer a user's leads to another user (data transfer when agent leaves/changes)
      let um = p.match(/^\/api\/users\/([^/]+)\/transfer$/);
      if (um && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req); const fromId = um[1]; const toId = b.to;
        const to = db.prepare('SELECT * FROM users WHERE id=?').get(toId);
        if (!to) return err(res, 400, 'target user not found');
        if (fromId === toId) return err(res, 400, 'source and target are the same user');
        const moving = db.prepare('SELECT * FROM leads WHERE owner_id=? AND deleted=0').all(fromId);
        const r = db.prepare('UPDATE leads SET owner_id=? WHERE owner_id=? AND deleted=0').run(toId, fromId);
        for (const l of moving) logAssign(l, fromId, toId, user, 'transfer');
        return send(res, 200, { ok: true, moved: r.changes, to: to.name });
      }
      // edit a user (name/email/phone/role/team/department, optional PIN reset)
      um = p.match(/^\/api\/users\/([^/]+)$/);
      if (um && m === 'PATCH') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE id=?').get(um[1]);
        if (!u) return err(res, 404, 'user not found');
        if (b.email !== undefined && String(b.email).trim() !== '') {
          const em = String(b.email).trim().toLowerCase();
          const clash = db.prepare('SELECT id FROM users WHERE lower(email)=? AND id<>?').get(em, u.id);
          if (clash) return err(res, 409, 'That email is already used by another user');
          b.email = em;
        }
        if (b.role !== undefined && !ROLES.includes(String(b.role))) return err(res, 400, 'unknown role: ' + b.role);
        // a user must never end up reporting to themselves, directly or in a loop
        if (b.manager_id) {
          if (b.manager_id === u.id) return err(res, 400, 'A user cannot report to themselves');
          let cur = b.manager_id, hops = 0;
          while (cur && hops++ < 50) {
            if (cur === u.id) return err(res, 400, 'That would create a reporting loop');
            cur = (db.prepare('SELECT manager_id FROM users WHERE id=?').get(cur) || {}).manager_id;
          }
        }
        const sets = [], args = [];
        for (const f of ['name', 'email', 'role', 'team', 'department', 'phone', 'manager_id']) {
          if (b[f] !== undefined) { sets.push(f + '=?'); args.push(b[f] === '' ? null : b[f]); }
        }
        if (b.pin) { const { hash, salt } = hashPin(b.pin); sets.push('pin_hash=?', 'pin_salt=?'); args.push(hash, salt); }
        // admin password reset — the user is then nudged to change it themselves
        if (b.password) {
          if (String(b.password).length < 6) return err(res, 400, 'Password must be at least 6 characters');
          const pw = hashPassword(String(b.password));
          sets.push('pwd_hash=?', 'pwd_salt=?', 'pwd_changed=?'); args.push(pw.hash, pw.salt, 0);
        }
        if (!sets.length) return send(res, 200, { ok: true });
        args.push(u.id);
        db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?').run(...args);
        return send(res, 200, { ok: true });
      }
      // delete a user (admin). Cannot delete self or the last admin. Their leads are unassigned.
      if (um && m === 'DELETE') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(um[1]);
        if (!u) return err(res, 404, 'user not found');
        if (u.id === user.id) return err(res, 400, 'You cannot delete your own account');
        if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n <= 1) return err(res, 400, 'Cannot delete the last admin');
        const openLeads = db.prepare('SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0').get(u.id).n;
        const reports = db.prepare('SELECT COUNT(*) n FROM users WHERE manager_id=?').get(u.id).n;
        db.prepare('DELETE FROM users WHERE id=?').run(u.id);
        db.prepare('UPDATE leads SET owner_id=NULL WHERE owner_id=?').run(u.id);
        // their reports are left without a manager rather than silently re-parented
        db.prepare('UPDATE users SET manager_id=NULL WHERE manager_id=?').run(u.id);
        return send(res, 200, { ok: true, unassigned: openLeads, orphaned: reports });
      }

      // WhatsApp lead capture (Baileys) — admin only
      if (p === '/api/whatsapp/status' && m === 'GET') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        return send(res, 200, wa.status());
      }
      if (p === '/api/whatsapp/logout' && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        await wa.logout();
        return send(res, 200, { ok: true });
      }

      // clear seeded sample/demo data (leads L1000..L1099 + their calls/activities) — admin only
      if (p === '/api/admin/clear-sample' && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const ids = db.prepare("SELECT id FROM leads WHERE id GLOB 'L10[0-9][0-9]'").all().map(r => r.id);
        const delLead = db.prepare('DELETE FROM leads WHERE id=?');
        const delAct = db.prepare('DELETE FROM activities WHERE lead_id=?');
        const delCall = db.prepare('DELETE FROM calls WHERE lead_id=?');
        let n = 0; for (const id of ids) { delAct.run(id); delCall.run(id); delLead.run(id); n++; }
        return send(res, 200, { ok: true, removed: n });
      }
      // bulk soft-delete leads (mark-all → delete)
      if (p === '/api/leads/bulk-delete' && m === 'POST') {
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
        if (!ids.length) return err(res, 400, 'no leads selected');
        let deleted = 0;
        const del = db.prepare("UPDATE leads SET deleted=1, deleted_by=?, deleted_at=datetime('now','+330 minutes') WHERE id=? AND deleted=0");
        const logDel = db.prepare(`INSERT INTO lead_deletions(lead_id,lead_name,phone,deleted_by,deleted_by_name,department,created_at) VALUES(?,?,?,?,?,?,${IST_NOW})`);
        for (const id of ids) {
          const lead = leadRow(id);
          if (!lead || lead.deleted) continue;
          del.run(user.id, id);
          logDel.run(lead.id, lead.name, lead.phone, user.id, user.name, user.department || null);
          deleted++;
        }
        return send(res, 200, { ok: true, deleted });
      }
      // bulk change owner (transfer selected leads to an agent)
      if (p === '/api/leads/bulk-assign' && m === 'POST') {
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
        const to = b.to; const toUser = to ? userById(to) : null;
        if (!ids.length) return err(res, 400, 'no leads selected');
        if (!toUser) return err(res, 400, 'choose an agent');
        let moved = 0; const upd = db.prepare("UPDATE leads SET owner_id=? WHERE id=? AND deleted=0");
        for (const id of ids) { const lead = leadRow(id); if (!lead || lead.deleted) continue; const prev = lead.owner_id; upd.run(to, id); logAct(id, '🔁 Reassigned to ' + toUser.name, '', user.name); logAssign(lead, prev, to, user, 'bulk'); moved++; }
        return send(res, 200, { ok: true, moved, to: toUser.name });
      }
      // bulk change product/team for selected leads (fixes leads imported into the wrong product)
      if (p === '/api/leads/bulk-product' && m === 'POST') {
        if (user.role === 'sales') return err(res, 403, 'admin or team lead only');
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
        const product = b.product ? String(b.product).trim() : '';
        if (!ids.length) return err(res, 400, 'no leads selected');
        const teams = getTeams();
        if (!teams[product]) return err(res, 400, 'unknown product: ' + product);
        const reassign = !!b.reassign;
        let moved = 0, reassigned = 0; const byAgent = {};
        const upd = db.prepare("UPDATE leads SET product=?, updated_at=datetime('now','+330 minutes') WHERE id=? AND deleted=0");
        const updOwner = db.prepare('UPDATE leads SET owner_id=? WHERE id=?');
        for (const id of ids) {
          const lead = leadRow(id);
          if (!lead || lead.deleted || lead.product === product) continue;
          const from = lead.product;
          upd.run(product, id);
          logAct(id, '📦 Product: ' + (from || '—') + ' → ' + product, '', user.name);
          moved++;
          if (reassign) {
            const a = nextAgent(product);
            if (a && a.id !== lead.owner_id) {
              updOwner.run(a.id, id);
              logAct(id, '🔁 Round-robin → ' + a.name, 'after product change', 'System');
              reassigned++;
              byAgent[a.name] = (byAgent[a.name] || 0) + 1;
            }
          }
        }
        return send(res, 200, { ok: true, moved, reassigned, product, byAgent });
      }
      // bulk change stage/status for selected leads
      if (p === '/api/leads/bulk-status' && m === 'POST') {
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
        const status = b.status;
        if (!ids.length) return err(res, 400, 'no leads selected');
        if (!cfg.STATUS[status]) return err(res, 400, 'invalid status');
        if (status === 'Fresh' && user.role === 'sales') return err(res, 403, 'Sales agents cannot set status to Fresh');
        let changed = 0;
        for (const id of ids) { const lead = leadRow(id); if (!lead || lead.deleted || lead.status === status) continue; await applyStatusChange(lead, status, user.name); changed++; }
        return send(res, 200, { ok: true, changed });
      }

      // leads
      if (p === '/api/leads' && m === 'GET') {
        const s = scopeSql(user);
        let where = '(' + s.where + ') AND deleted=0', args = [...s.args];
        const q = url.searchParams;
        if (q.get('status')) { where += ' AND status=?'; args.push(q.get('status')); }
        if (q.get('source')) { where += ' AND source=?'; args.push(q.get('source')); }
        if (q.get('owner')) { where += ' AND owner_id=?'; args.push(q.get('owner')); }
        if (q.get('product')) { where += ' AND product=?'; args.push(q.get('product')); }
        if (q.get('team')) { where += ' AND owner_id IN (SELECT id FROM users WHERE team=?)'; args.push(q.get('team')); }
        if (q.get('open')) { where += " AND status IN ('Fresh','RNR','Follow Up','Interested')"; }
        if (q.get('overdue')) { where += " AND next_followup IS NOT NULL AND next_followup < date('now','+330 minutes') AND status IN ('Fresh','RNR','Follow Up','Interested')"; }
        if (q.get('duetoday')) { where += " AND next_followup = date('now','+330 minutes') AND status IN ('Fresh','RNR','Follow Up','Interested')"; }
         if (q.get('todayfresh')) { where += " AND status='Fresh' AND date(created_at)=date('now','+330 minutes')"; }
        if (q.get('dateFrom')) { where += " AND date(created_at)>=?"; args.push(q.get('dateFrom')); }
        if (q.get('dateTo')) { where += " AND date(created_at)<=?"; args.push(q.get('dateTo')); }
        if (q.get('q')) { where += ' AND (name LIKE ? OR phone LIKE ? OR city LIKE ? OR email LIKE ?)'; const t = '%' + q.get('q') + '%'; args.push(t, t, t, t); }
        const rows = db.prepare(`SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { leads: rows.map(r => leadJSON(r)) });
      }
      if (p === '/api/leads' && m === 'POST') {
        if (!ADD_LEAD_ROLES.includes(user.role)) return err(res, 403, 'Only Admin and Managers can add leads');
        const b = await readBody(req);
        if (!b.name) return err(res, 400, 'name required');
        if (normPhone(b.phone).length < 7) return err(res, 400, 'A valid phone number is required');
        const autoAssign = b.owner_id === 'auto' || !b.owner_id;
        const { lead, deduped } = createLead({ ...b, owner_id: autoAssign ? null : b.owner_id }, user.name, { autoAssign, byUser: user });
        if (deduped) { const o = userById(lead.owner_id); return send(res, 200, { duplicate: true, owner_name: o ? o.name : '—', lead: leadJSON(lead, true) }); }
        return send(res, 200, { ok: true, lead: leadJSON(lead, true) });
      }
      // bulk import (Excel/CSV) → each lead round-robin auto-assigned.
      // A lead is NEVER imported into a guessed product: either the row names a
      // real product or the whole import is forced into one chosen in the UI.
      // Anything unresolvable is rejected and reported back, not defaulted.
      if (p === '/api/leads/bulk' && m === 'POST') {
        // uploading leads is a manager job: Admin + Team Lead only, never Sales
        if (!IMPORT_ROLES.includes(user.role)) return err(res, 403, 'Only Admin and Team Lead can upload leads');
        const b = await readBody(req);
        const list = Array.isArray(b.leads) ? b.leads : [];
        if (!list.length) return err(res, 400, 'no leads to import');
        if (list.length > 5000) return err(res, 400, 'max 5000 leads per import');
        const teams = getTeams();
        const forced = b.product ? String(b.product).trim() : '';
        if (forced && !teams[forced]) return err(res, 400, 'unknown product: ' + forced);
        // optional single POC for the whole import — otherwise round-robin as before
        const pocId = b.owner_id ? String(b.owner_id).trim() : '';
        let poc = null;
        if (pocId) {
          poc = userById(pocId);
          if (!poc) return err(res, 400, 'unknown agent');
          if (!poc.active) return err(res, 400, poc.name + ' is not an active user');
        }
        let created = 0, skipped = 0, duplicates = 0, badProduct = 0, badOwner = 0, ownerNamed = 0;
        const byAgent = {}, byProduct = {}, problems = [], dupPhones = [], ownerTeamWarn = [];
        for (let i = 0; i < list.length; i++) {
          const row = list[i] || {};
          const rowNo = row.__row || (i + 2);
          const nm = String(row.name || '').trim();
          if (!nm) { skipped++; problems.push({ row: rowNo, why: 'no name' }); continue; }
          if (normPhone(row.phone).length < 7) { skipped++; problems.push({ row: rowNo, name: nm, why: 'phone missing or invalid' }); continue; }
          const wanted = forced || String(row.product || '').trim();
          if (!wanted) { badProduct++; problems.push({ row: rowNo, name: nm, why: 'no product in the row — choose a product for the import' }); continue; }
          if (!teams[wanted]) { badProduct++; problems.push({ row: rowNo, name: nm, why: 'product "' + wanted + '" does not exist in this CRM' }); continue; }
          /* Owner precedence: the single-POC dropdown wins, then the sheet's
             Owner column, then round-robin. A named-but-unknown owner is a
             mistake in the sheet, so the row is rejected rather than quietly
             round-robined to someone else. */
          let rowOwner = null;
          if (!poc) {
            const oc = resolveOwnerCell(row.owner != null ? row.owner : row.owner_id);
            if (oc.error) { badOwner++; problems.push({ row: rowNo, name: nm, why: oc.error }); continue; }
            if (oc.id) {
              rowOwner = oc.user;
              if (oc.user.team && oc.user.team !== wanted) {
                if (ownerTeamWarn.length < 200) ownerTeamWarn.push({ row: rowNo, name: nm, owner: oc.user.name, owner_team: oc.user.team, product: wanted });
              }
            }
          }
          const { lead, deduped } = createLead({
            name: nm, phone: row.phone, email: row.email, city: row.city,
            product: wanted, source: row.source || 'Bulk Upload',
            owner_id: (poc && poc.id) || (rowOwner && rowOwner.id) || null,
          }, user.name + ' (import)', { autoAssign: !poc && !rowOwner, byUser: user, reason: 'import' });
          if (deduped) {
            duplicates++;
            if (dupPhones.length < 200) dupPhones.push({ row: rowNo, name: nm, phone: String(row.phone || ''),
              existing_product: lead.product, existing_owner: userById(lead.owner_id)?.name || '—' });
            continue;
          }
          created++;
          if (rowOwner) ownerNamed++;          // count only rows that actually became a lead
          byProduct[wanted] = (byProduct[wanted] || 0) + 1;
          const on = userById(lead.owner_id)?.name || '—';
          byAgent[on] = (byAgent[on] || 0) + 1;
        }
        return send(res, 200, { ok: true, created, skipped, duplicates, badProduct, badOwner, ownerNamed, byAgent, byProduct,
          assignedTo: poc ? poc.name : null, ownerTeamWarn,
          dupPhones, problems: problems.slice(0, 200), problemsTotal: problems.length });
      }
      // global search — find any lead + who owns it (available to all roles)
      if (p === '/api/leads/search' && m === 'GET') {
        const qq = (url.searchParams.get('q') || '').trim();
        if (qq.length < 1) return send(res, 200, { leads: [] });
        const t = '%' + qq + '%';
        const rows = db.prepare(`SELECT id,name,phone,email,city,product,source,status,owner_id FROM leads
          WHERE deleted=0 AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR city LIKE ?) ORDER BY created_at DESC LIMIT 50`).all(t, t, t, t);
        return send(res, 200, { leads: rows.map(r => { const o = userById(r.owner_id); return { ...r, owner_name: o ? o.name : '—', owner_team: o ? o.team : '' }; }) });
      }
      let mm = p.match(/^\/api\/leads\/([^/]+)$/);
      if (mm && m === 'DELETE') {
        const lead = leadRow(mm[1]); if (!lead) return err(res, 404, 'not found');
        if (!lead.deleted) {
          db.prepare("UPDATE leads SET deleted=1, deleted_by=?, deleted_at=datetime('now','+330 minutes') WHERE id=?").run(user.id, lead.id);
          db.prepare(`INSERT INTO lead_deletions(lead_id,lead_name,phone,deleted_by,deleted_by_name,department,created_at) VALUES(?,?,?,?,?,?,${IST_NOW})`)
            .run(lead.id, lead.name, lead.phone, user.id, user.name, user.department || null);
        }
        return send(res, 200, { ok: true });
      }
      if (mm && m === 'GET') { const r = leadRow(mm[1]); return r ? send(res, 200, { lead: leadJSON(r, true) }) : err(res, 404, 'not found'); }
      if (mm && m === 'PATCH') {
        const b = await readBody(req); const lead = leadRow(mm[1]); if (!lead) return err(res, 404, 'not found');
        // sales agents cannot move a lead back to Fresh (admin/lead can)
        if (b.status === 'Fresh' && user.role === 'sales') return err(res, 403, 'Sales agents cannot set status to Fresh');
        // reminder is mandatory when moving a lead to RNR / Follow Up / Interested
        const REMINDER_STATUSES = ['RNR', 'Follow Up', 'Interested'];
        if (b.status && REMINDER_STATUSES.includes(b.status) && !b.next_followup && !b.next_followup_at && !lead.next_followup) {
          return err(res, 400, 'reminder_required');
        }
        // apply the follow-up date first so applyStatusChange doesn't overwrite it
        if (b.next_followup !== undefined || b.next_followup_at !== undefined) setReminder(lead, b, user);
        if (b.status && b.status !== lead.status) await applyStatusChange(lead, b.status, user.name);
        if (b.product !== undefined && b.product !== lead.product) {
          const teams = getTeams();
          if (!teams[b.product]) return err(res, 400, 'unknown product: ' + b.product);
          db.prepare('UPDATE leads SET product=? WHERE id=?').run(b.product, lead.id);
          logAct(lead.id, '📦 Product: ' + (lead.product || '—') + ' → ' + b.product, '', user.name);
        }
        if (b.owner_id && b.owner_id !== lead.owner_id) {
          const prevOwner = lead.owner_id;
          db.prepare('UPDATE leads SET owner_id=? WHERE id=?').run(b.owner_id, lead.id);
          logAct(lead.id, '🔁 Reassigned to ' + (userById(b.owner_id)?.name || b.owner_id), '', user.name);
          logAssign(leadRow(lead.id), prevOwner, b.owner_id, user, 'manual');
        }
        return send(res, 200, { ok: true, lead: leadJSON(leadRow(lead.id), true) });
      }
      mm = p.match(/^\/api\/leads\/([^/]+)\/(activity|call|miss|whatsapp|email)$/);
      if (mm && m === 'POST') {
        const lead = leadRow(mm[1]); if (!lead) return err(res, 404, 'not found');
        const act = mm[2]; const b = await readBody(req);
        if (act === 'activity') { logAct(lead.id, b.title || '📝 Note', b.sub || '', user.name); }
        else if (act === 'call') {
          // In-CRM calling: the browser/phone places the call, the CRM keeps the log.
          // The client sends the measured talk time, a disposition and an optional
          // note; status + reminder can be set in the same round trip so the POC
          // never has to remember a second step after hanging up.
          const r = await clickToCall(user.phone || '', lead.phone);
          const connected = b.connected === undefined ? 1 : (b.connected ? 1 : 0);
          const talktime = Math.max(0, Math.min(24 * 3600, +b.talktime || 0));
          const outcome = String(b.outcome || '').trim().slice(0, 60) || (connected ? 'Connected' : 'Not connected');
          const notes = String(b.notes || b.note || '').trim().slice(0, 1000);
          db.prepare(`INSERT INTO calls(lead_id,owner_id,by_user,connected,talktime,outcome,notes,direction,created_at)
                      VALUES(?,?,?,?,?,?,?,'outbound',${IST_NOW})`)
            .run(lead.id, lead.owner_id || user.id, user.id, connected, talktime, outcome, notes);
          logAct(lead.id, '📞 Call — ' + outcome,
                 (connected ? 'Talk time ' + fmtSecs(talktime) : 'Not connected') + (notes ? ' • ' + notes : '') + (r.simulated ? '' : ' • via telephony'),
                 user.name);
          if (b.next_followup_at !== undefined || b.next_followup !== undefined) setReminder(lead, b, user);
          if (b.status && b.status !== lead.status) {
            if (b.status === 'Fresh' && user.role === 'sales') return err(res, 403, 'Sales agents cannot set status to Fresh');
            await applyStatusChange(leadRow(lead.id), b.status, user.name);
          }
        }
        else if (act === 'miss') { db.prepare(`INSERT INTO calls(lead_id,owner_id,connected,talktime,created_at) VALUES(?,?,0,0,${IST_NOW})`).run(lead.id, lead.owner_id); const steps = await handleMiss(lead, user.name); return send(res, 200, { ok: true, steps, lead: leadJSON(leadRow(lead.id), true) }); }
        else if (act === 'whatsapp') { const r = await sendWhatsApp(lead.phone, b.text || 'Hi ' + lead.name); logAct(lead.id, '🟢 WhatsApp ' + (r.sent ? 'sent' : 'opened (simulated)'), b.text || '', user.name); }
        else if (act === 'email') { const r = await sendEmail(lead.email, b.subject || 'From My Haul Store', b.text || ''); logAct(lead.id, '✉️ Email ' + (r.sent ? 'sent' : 'composed (simulated)'), b.subject || '', user.name); }
        return send(res, 200, { ok: true, lead: leadJSON(leadRow(lead.id), true) });
      }

      // reports
      if (p.startsWith('/api/reports/') && m === 'GET') {
        const q = url.searchParams;
        const f = { from: q.get('from'), to: q.get('to'), source: q.get('source'), department: q.get('department'),
                    owner: q.get('owner'), team: q.get('team'), date: q.get('date') };
        if (p === '/api/reports/daily') return send(res, 200, reportDaily(user, f));
        if (p === '/api/reports/summary') return send(res, 200, reportSummary(user, f));
        if (p === '/api/reports/agents') return send(res, 200, { agents: reportAgents(user, f) });
        if (p === '/api/reports/activity') return send(res, 200, { activity: reportActivity(user, f) });
        if (p === '/api/reports/followups') return send(res, 200, reportFollowups(user, f));
        if (p === '/api/reports/attendance') return send(res, 200, reportAttendance(user));
        if (p === '/api/reports/leads-distribution') return send(res, 200, reportLeadsDist(user, f));
        if (p === '/api/reports/deletions') return send(res, 200, reportDeletions(user));
        if (p === '/api/reports/users') return send(res, 200, reportUsersList(user));
        if (p === '/api/reports/closed') return send(res, 200, reportClosed(user, { ...f, closedType: q.get('closedType') }));
        if (p === '/api/reports/assignments') return send(res, 200, reportAssignments(user, { ...f, by: q.get('by'), reason: q.get('reason'), q: q.get('q') }));
      }

      // reminders (date + time) for the signed-in user's dashboard
      if (p === '/api/reminders' && m === 'GET') {
        return send(res, 200, myReminders(user, url.searchParams.get('limit')));
      }
      // manager-wise team structure (Team page + Super Manager view)
      if (p === '/api/team/structure' && m === 'GET') {
        return send(res, 200, managerTree(user));
      }
      // set / clear a lead's reminder without touching anything else
      mm = p.match(/^\/api\/leads\/([^/]+)\/reminder$/);
      if (mm && m === 'POST') {
        const lead = leadRow(mm[1]); if (!lead) return err(res, 404, 'not found');
        const b = await readBody(req);
        setReminder(lead, b, user);
        return send(res, 200, { ok: true, lead: leadJSON(leadRow(lead.id), true) });
      }

      // call history / recordings — scoped (sales=own, lead=their agents, admin=all)
      if (p === '/api/calls' && m === 'GET') {
        const q = url.searchParams;
        let where = '1=1', args = [];
        if (user.role === 'sales') { where += ' AND c.owner_id=?'; args.push(user.id); }
        else if (user.role === 'lead') { const ids = salesForUser(user).map(u => u.id); ids.push('__none__'); where += ` AND c.owner_id IN (${ids.map(() => '?').join(',')})`; args.push(...ids); }
        if (q.get('owner')) { where += ' AND c.owner_id=?'; args.push(q.get('owner')); }
        if (q.get('from')) { where += ' AND date(c.created_at)>=date(?)'; args.push(q.get('from')); }
        if (q.get('to')) { where += ' AND date(c.created_at)<=date(?)'; args.push(q.get('to')); }
        if (q.get('lead')) { where += ' AND c.lead_id=?'; args.push(q.get('lead')); }
        const rows = db.prepare(`SELECT c.id, c.lead_id, c.owner_id, c.by_user, c.connected, c.talktime, c.outcome, c.notes,
          c.recording_url, c.created_at, l.name lead_name, l.phone, l.product, l.status
          FROM calls c LEFT JOIN leads l ON l.id=c.lead_id WHERE ${where} ORDER BY c.id DESC LIMIT 500`).all(...args);
        const rich = rows.map(r => { const o = userById(r.owner_id); const by = r.by_user ? userById(r.by_user) : null;
          return { id: r.id, lead_id: r.lead_id, lead_name: r.lead_name || '—', phone: r.phone || '',
            product: r.product || '', status: r.status || '', agent: o ? o.name : '—',
            by_name: by ? by.name : (o ? o.name : '—'), connected: !!r.connected, talktime: r.talktime || 0,
            outcome: r.outcome || (r.connected ? 'Connected' : 'Not connected'), notes: r.notes || '',
            created_at: r.created_at, recording: r.recording_url || null }; });
        return send(res, 200, { calls: rich });
      }

      // connectors
      if (p === '/api/connectors' && m === 'GET') {
        const rows = db.prepare('SELECT * FROM connectors').all().map(c => ({ ...c, connected: !!c.connected, leads: db.prepare('SELECT COUNT(*) n FROM leads WHERE source=? AND deleted=0').get(c.src).n }));
        return send(res, 200, { connectors: rows });
      }
      mm = p.match(/^\/api\/connectors\/([^/]+)$/);
      if (mm && m === 'PATCH') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        db.prepare('UPDATE connectors SET connected=? WHERE key=?').run(b.connected ? 1 : 0, mm[1]);
        return send(res, 200, { ok: true });
      }

      // automation
      if (p === '/api/automation' && m === 'GET') {
        const rows = db.prepare('SELECT key,enabled FROM automation').all();
        return send(res, 200, { automation: Object.fromEntries(rows.map(r => [r.key, !!r.enabled])) });
      }
      if (p === '/api/automation' && m === 'PATCH') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        db.prepare('UPDATE automation SET enabled=? WHERE key=?').run(b.enabled ? 1 : 0, b.key);
        return send(res, 200, { ok: true });
      }

      return err(res, 404, 'api route not found');
    }

    // ---------- static frontend ----------
    return serveStatic(req, res, p);
  } catch (e) {
    console.error('ERR', e);
    return err(res, 500, 'server error: ' + e.message);
  }
});

function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, team: u.team,
  department: u.department, manager_id: u.manager_id || null, pwd_changed: !!u.pwd_changed }; }
function getTeams() {
  const rows = db.prepare('SELECT code,name,color FROM teams WHERE active=1 ORDER BY code').all();
  const o = {}; rows.forEach(r => o[r.code] = { name: r.name, code: r.code, color: r.color }); return o;
}
function getSources() { return db.prepare('SELECT name,color,icon FROM sources WHERE active=1 ORDER BY rowid').all(); }
function getSettings() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s = {}; rows.forEach(r => s[r.key] = r.value); return s;
}
function getAgentTarget() {
  const s = getSettings();
  return { leads: +(s.target_leads || 200), interested: +(s.target_interested || 60), closed: +(s.target_closed || 20) };
}
function publicConfig() {
  const teams = getTeams();
  const at = getAgentTarget();
  return { teams, products: Object.keys(teams), sources: getSources(), statuses: cfg.STATUS_LIST,
    departments: getDepartments(), teamTarget: at, agentTarget: at,
    whatsappProduct: presalesProduct(), importRoles: IMPORT_ROLES, addLeadRoles: ADD_LEAD_ROLES,
    roles: ROLES, roleLabels: ROLE_LABEL,
    // the server clock in IST — the UI checks it against the device clock so a
    // wrongly-set laptop can never silently show the wrong dates/times
    serverNow: nowIst(), serverToday: todayIst() };
}

// auto-seed on first boot (fresh deploy) so the app is usable immediately
try {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n === 0) { console.log('Empty database — seeding demo data…'); require('./seed')(false); }
} catch (e) { console.error('seed check failed:', e.message); }

server.listen(PORT, () => {
  if (SECRET.includes('CHANGE-ME')) console.warn('⚠️  JWT_SECRET not set — using insecure dev secret. Set it in .env for production.');
  console.log(`MHS CRM server → http://localhost:${PORT}`);
});

// WhatsApp lead capture: each incoming WhatsApp message → lead (dedupe by phone) + message on timeline
try {
  wa.init(({ name, phone, text }) => {
    try {
      const { lead } = createLead({ name, phone, source: 'WhatsApp', product: presalesProduct(),
        external_id: 'wa_' + phone }, 'WhatsApp (live)', { strictTeam: true, reason: 'webhook' });
      if (lead && text) logAct(lead.id, '🟢 WhatsApp: "' + String(text).slice(0, 280) + '"', 'Incoming message', name);
    } catch (e) { console.warn('wa lead create failed:', e.message); }
  });
} catch (e) { console.warn('wa.init failed:', e.message); }
