/* ============================================================
   MHS CRM — API server (Node builtins only: http, sqlite, crypto)
   Start:  node server.js       (PORT env, default 4000)
   ============================================================ */
require('./loadenv')();                       // tiny .env loader (no dependency)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPin, verifyPin, uid } = require('./db');
const cfg = require('./config');
const { sendWhatsApp, clickToCall, sendEmail } = require('./integrations');

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
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
const userById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const activeSales = (team) => db.prepare("SELECT * FROM users WHERE role='sales' AND active=1 AND (?='' OR team=?) ORDER BY id").all(team || '', team || '');

function authUser(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  const p = verifyToken(tok);
  if (!p) return null;
  return userById(p.uid);
}

/* ---------------- round-robin ---------------- */
function nextAgent(team) {
  let list = activeSales(team);
  if (!list.length) list = activeSales('');           // fallback: any sales
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
  db.prepare('INSERT INTO activities(lead_id,title,sub,by_name) VALUES(?,?,?,?)').run(leadId, title, sub || '', byName || 'System');
}
function leadRow(id) { return db.prepare('SELECT * FROM leads WHERE id=?').get(id); }
function leadJSON(row, withActivities) {
  if (!row) return null;
  const owner = row.owner_id ? userById(row.owner_id) : null;
  const out = {
    id: row.id, name: row.name, phone: row.phone, email: row.email, city: row.city,
    product: row.product, source: row.source, status: row.status, website: row.website,
    score: row.score, converted: !!row.converted, next_followup: row.next_followup,
    owner_id: row.owner_id, owner_name: owner ? owner.name : '—', owner_team: owner ? owner.team : '',
    created_at: row.created_at, updated_at: row.updated_at,
  };
  if (withActivities) out.activities = db.prepare('SELECT title,sub,by_name,created_at FROM activities WHERE lead_id=? ORDER BY id ASC').all(row.id);
  return out;
}
const autoOn = (key) => { const r = db.prepare('SELECT enabled FROM automation WHERE key=?').get(key); return r ? !!r.enabled : false; };

function connectorForSource(src) { return db.prepare('SELECT * FROM connectors WHERE src=? ORDER BY connected DESC LIMIT 1').get(src); }

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
    const a = nextAgent(product);
    if (a) { ownerId = a.id; assignNote = 'Round-robin → ' + a.name; }
  }
  const id = data.id || ('L' + uid('').slice(0, 8));
  const followup = autoOn('autoFollowup') ? addDays(1) : null;
  const score = data.score ?? (['Website', 'WhatsApp', 'Calendly'].includes(source) ? 70 : 55);
  db.prepare(`INSERT INTO leads(id,name,phone,phone_norm,email,city,product,source,status,owner_id,website,score,converted,next_followup,external_id)
              VALUES(?,?,?,?,?,?,?,?, 'Fresh', ?,?,?,0,?,?)`)
    .run(id, data.name || 'Unknown', data.phone || '', phoneNorm || null, data.email || '', data.city || '', product, source, ownerId, data.website || '', score, followup, data.external_id || null);
  logAct(id, 'Lead created', 'Source: ' + source, byName || 'System');
  if (assignNote) logAct(id, '🔁 ' + assignNote, '', 'System');
  return { lead: leadRow(id), deduped: false };
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
    db.prepare("UPDATE leads SET status='RNR', next_followup=?, updated_at=datetime('now') WHERE id=?").run(addDays(1), lead.id);
    logAct(lead.id, '↪️ Auto status → RNR', 'Reminder set for tomorrow', 'System');
    steps.push('RNR + reminder');
  }
  return steps;
}

/* ---------------- reports ---------------- */
function scopeSql(user) {
  if (user.role === 'admin') return { where: '1=1', args: [] };
  // Team Lead sees ONLY the sales agents assigned to them (manager_id). Falls back to whole team if none assigned yet.
  if (user.role === 'lead') {
    const assigned = db.prepare("SELECT COUNT(*) n FROM users WHERE role='sales' AND manager_id=?").get(user.id).n;
    if (assigned > 0) return { where: "owner_id IN (SELECT id FROM users WHERE manager_id=?)", args: [user.id] };
    return { where: "owner_id IN (SELECT id FROM users WHERE team=?)", args: [user.team] };
  }
  return { where: 'owner_id=?', args: [user.id] };
}
// sales agents visible to a user (admin=all, lead=their assigned agents or team fallback)
function salesForUser(user) {
  if (user.role === 'lead') {
    const mine = db.prepare("SELECT * FROM users WHERE role='sales' AND active=1 AND manager_id=? ORDER BY id").all(user.id);
    if (mine.length) return mine;
    return activeSales(user.team);
  }
  return activeSales('');
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
  const bySource = cfg.SOURCES.map(src => ({ src, n: rows.filter(r => r.source === src).length }));
  // Sales funnel = 5 core pipeline stages (RNR/Junk/Lost are side-states, tracked elsewhere)
  const CORE_STAGES = ['Fresh', 'Follow Up', 'Interested', 'Not Interested', 'Closed Won'];
  const funnel = CORE_STAGES.map(st => ({ st, n: rows.filter(r => r.status === st).length }));
  return { total, won, open, interested, conv: total ? Math.round(won / total * 100) : 0, bySource, funnel };
}
function reportAgents(user, f) {
  f = f || {};
  let sales = salesForUser(user);
  if (f.department) sales = sales.filter(u => u.department === f.department);
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
  if (f.owner) sales = sales.filter(u => u.id === f.owner);
  // connected calls today + talk time, per owner (from the calls table)
  const rows = db.prepare(`SELECT owner_id oid, COUNT(*) c, SUM(talktime) t FROM calls
      WHERE connected=1 AND date(created_at)=date('now') GROUP BY owner_id`).all();
  const cMap = Object.fromEntries(rows.map(r => [r.oid, r]));
  return sales.map(u => {
    const junk = db.prepare("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND status='Junk' AND deleted=0").get(u.id).n;
    const c = cMap[u.id] || { c: 0, t: 0 };
    // avg first-response minutes (lead created → first CONNECTED call)
    const resp = db.prepare(`SELECT AVG(mins) m FROM (
        SELECT (julianday(MIN(ca.created_at)) - julianday(l.created_at))*24*60 mins
        FROM leads l JOIN calls ca ON ca.lead_id=l.id
        WHERE l.owner_id=? AND l.deleted=0 AND ca.connected=1 GROUP BY l.id)`).get(u.id).m;
    return { id: u.id, name: u.name, team: u.team, callsToday: c.c, talktime: c.t || 0,
      avgRespMin: resp ? Math.max(0, Math.round(resp)) : null, junk, working: c.c > 0 };
  });
}
// per-user + per-team missed / today-due follow-ups
function reportFollowups(user, f) {
  f = f || {};
  let sales = salesForUser(user);
  if (f.department) sales = sales.filter(u => u.department === f.department);
  if (f.owner) sales = sales.filter(u => u.id === f.owner);
  const OPEN = "('Fresh','RNR','Follow Up','Interested')";
  const per = sales.map(u => {
    const missed = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0 AND next_followup IS NOT NULL AND next_followup < date('now') AND status IN ${OPEN}`).get(u.id).n;
    const todayDue = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0 AND next_followup = date('now') AND status IN ${OPEN}`).get(u.id).n;
    return { id: u.id, name: u.name, team: u.team, missed, todayDue };
  });
  const teams = {};
  per.forEach(x => { const t = teams[x.team] = teams[x.team] || { team: x.team, missed: 0, todayDue: 0 }; t.missed += x.missed; t.todayDue += x.todayDue; });
  return { per: per.sort((a, b) => b.missed - a.missed), teams: Object.values(teams) };
}

// attendance: who logged in today (present) vs not (absent), + department-wise
function reportAttendance(user) {
  const users = db.prepare("SELECT id,name,role,team,department FROM users WHERE active=1 ORDER BY department, name").all();
  const todays = db.prepare("SELECT user_id, MAX(created_at) last, COUNT(*) c FROM logins WHERE date(created_at)=date('now') GROUP BY user_id").all();
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
  const from = f.from || new Date().toISOString().slice(0, 10);
  const to = f.to || from;
  const sales = salesForUser(user);
  const cols = cfg.STATUS_LIST;
  const per = sales.map(u => {
    const rows = db.prepare("SELECT status FROM leads WHERE owner_id=? AND deleted=0 AND date(created_at)>=date(?) AND date(created_at)<=date(?)").all(u.id, from, to);
    const counts = {}; cols.forEach(c => counts[c] = rows.filter(r => r.status === c).length);
    return { id: u.id, name: u.name, department: u.department || '—', team: u.team, total: rows.length, counts };
  });
  return { from, to, cols, per };
}

// deleted-leads report: total + per user + department-wise + recent list
function reportDeletions(user) {
  const total = db.prepare('SELECT COUNT(*) n FROM lead_deletions').get().n;
  const per = db.prepare("SELECT deleted_by_name name, COALESCE(department,'—') department, COUNT(*) c FROM lead_deletions GROUP BY deleted_by ORDER BY c DESC").all();
  const byDept = db.prepare("SELECT COALESCE(department,'—') department, COUNT(*) c FROM lead_deletions GROUP BY department ORDER BY c DESC").all();
  const recent = db.prepare('SELECT lead_name, phone, deleted_by_name, department, created_at FROM lead_deletions ORDER BY id DESC LIMIT 100').all();
  return { total, per, byDept, recent };
}
// user-list report: counts by role + department-wise + full list
function reportUsersList(user) {
  const users = db.prepare('SELECT id,name,email,role,team,department,active FROM users ORDER BY role, department, name').all();
  const counts = { total: users.length, admin: 0, lead: 0, sales: 0 };
  users.forEach(u => { counts[u.role] = (counts[u.role] || 0) + 1; });
  const byDept = {};
  users.forEach(u => { const d = u.department || '—'; const x = byDept[d] = byDept[d] || { department: d, admin: 0, lead: 0, sales: 0, total: 0 }; x[u.role] = (x[u.role] || 0) + 1; x.total++; });
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
        data = { name: contact?.profile?.name || 'WhatsApp Lead', phone: msg.from, source: 'WhatsApp', external_id: 'wa_' + msg.from };
      }
      else if (p.startsWith('/webhooks/generic/')) { if (!checkWebhookSecret(url)) return err(res, 401, 'bad token'); data = { name: body.name, phone: body.phone, email: body.email, city: body.city, product: body.product, source: body.source || 'Manual', external_id: body.external_id }; }
      if (!data || !data.name) return err(res, 400, 'could not parse lead');
      const { lead, deduped } = createLead(data, 'Webhook (' + p.split('/')[2] + ')');
      return send(res, 200, { ok: true, deduped, lead_id: lead.id, owner: userById(lead.owner_id)?.name || null });
    }

    // ---------- AUTH ----------
    if (p === '/api/login' && m === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const rec = loginFails.get(ip) || { fails: 0, until: 0 };
      if (rec.until > now) return err(res, 429, 'Too many wrong PINs. Try again in ' + Math.ceil((rec.until - now) / 1000) + 's.');
      const { pin } = await readBody(req);
      if (!pin) return err(res, 400, 'pin required');
      const users = db.prepare('SELECT * FROM users WHERE active=1').all();
      const u = users.find(x => { try { return verifyPin(pin, x.pin_hash, x.pin_salt); } catch { return false; } });
      if (!u) {
        rec.fails++;
        if (rec.fails >= LOGIN_MAX_FAILS) { rec.until = now + LOGIN_LOCK_MS; rec.fails = 0; }
        loginFails.set(ip, rec);
        return err(res, 401, 'Wrong PIN');
      }
      loginFails.delete(ip);
      try { db.prepare('INSERT INTO logins(user_id) VALUES(?)').run(u.id); } catch (e) {}
      return send(res, 200, { token: signToken({ uid: u.id, role: u.role, team: u.team }), user: publicUser(u) });
    }

    // everything below /api needs auth
    if (p.startsWith('/api/')) {
      const user = authUser(req);
      if (!user) return err(res, 401, 'unauthorized');

      if (p === '/api/me' && m === 'GET') return send(res, 200, { user: publicUser(user), config: publicConfig() });
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
        return send(res, 200, { ok: true, settings: getSettings() });
      }

      // users
      if (p === '/api/users' && m === 'GET') {
        const rows = db.prepare('SELECT id,name,email,role,team,department,phone,manager_id,active FROM users ORDER BY role, name').all();
        const withLoad = rows.map(u => ({ ...u, leads: db.prepare('SELECT COUNT(*) n FROM leads WHERE owner_id=? AND deleted=0').get(u.id).n }));
        return send(res, 200, { users: withLoad });
      }
      if (p === '/api/users' && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req);
        if (!b.name || !b.pin) return err(res, 400, 'name & pin required');
        const { hash, salt } = hashPin(b.pin);
        const id = uid('u');
        db.prepare('INSERT INTO users(id,name,email,role,team,department,phone,pin_hash,pin_salt) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, b.name, b.email || null, b.role || 'sales', b.team || 'MHS', b.department || null, b.phone || null, hash, salt);
        return send(res, 200, { ok: true, id });
      }
      // transfer a user's leads to another user (data transfer when agent leaves/changes)
      let um = p.match(/^\/api\/users\/([^/]+)\/transfer$/);
      if (um && m === 'POST') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req); const fromId = um[1]; const toId = b.to;
        const to = db.prepare('SELECT * FROM users WHERE id=?').get(toId);
        if (!to) return err(res, 400, 'target user not found');
        if (fromId === toId) return err(res, 400, 'source and target are the same user');
        const r = db.prepare('UPDATE leads SET owner_id=? WHERE owner_id=? AND deleted=0').run(toId, fromId);
        return send(res, 200, { ok: true, moved: r.changes, to: to.name });
      }
      // edit a user (name/email/phone/role/team/department, optional PIN reset)
      um = p.match(/^\/api\/users\/([^/]+)$/);
      if (um && m === 'PATCH') {
        if (user.role !== 'admin') return err(res, 403, 'admin only');
        const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE id=?').get(um[1]);
        if (!u) return err(res, 404, 'user not found');
        const sets = [], args = [];
        for (const f of ['name', 'email', 'role', 'team', 'department', 'phone', 'manager_id']) {
          if (b[f] !== undefined) { sets.push(f + '=?'); args.push(b[f] === '' ? null : b[f]); }
        }
        if (b.pin) { const { hash, salt } = hashPin(b.pin); sets.push('pin_hash=?', 'pin_salt=?'); args.push(hash, salt); }
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
        db.prepare('DELETE FROM users WHERE id=?').run(u.id);
        db.prepare('UPDATE leads SET owner_id=NULL WHERE owner_id=?').run(u.id);
        return send(res, 200, { ok: true, unassigned: openLeads });
      }

      // bulk soft-delete leads (mark-all → delete)
      if (p === '/api/leads/bulk-delete' && m === 'POST') {
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
        if (!ids.length) return err(res, 400, 'no leads selected');
        let deleted = 0;
        const del = db.prepare("UPDATE leads SET deleted=1, deleted_by=?, deleted_at=datetime('now') WHERE id=? AND deleted=0");
        const logDel = db.prepare('INSERT INTO lead_deletions(lead_id,lead_name,phone,deleted_by,deleted_by_name,department) VALUES(?,?,?,?,?,?)');
        for (const id of ids) {
          const lead = leadRow(id);
          if (!lead || lead.deleted) continue;
          del.run(user.id, id);
          logDel.run(lead.id, lead.name, lead.phone, user.id, user.name, user.department || null);
          deleted++;
        }
        return send(res, 200, { ok: true, deleted });
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
        if (q.get('open')) { where += " AND status IN ('Fresh','RNR','Follow Up','Interested')"; }
        if (q.get('overdue')) { where += " AND next_followup IS NOT NULL AND next_followup < date('now') AND status IN ('Fresh','RNR','Follow Up','Interested')"; }
        if (q.get('duetoday')) { where += " AND next_followup = date('now') AND status IN ('Fresh','RNR','Follow Up','Interested')"; }
        if (q.get('q')) { where += ' AND (name LIKE ? OR phone LIKE ? OR city LIKE ? OR email LIKE ?)'; const t = '%' + q.get('q') + '%'; args.push(t, t, t, t); }
        const rows = db.prepare(`SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { leads: rows.map(r => leadJSON(r)) });
      }
      if (p === '/api/leads' && m === 'POST') {
        const b = await readBody(req);
        if (!b.name) return err(res, 400, 'name required');
        if (normPhone(b.phone).length < 7) return err(res, 400, 'A valid phone number is required');
        const autoAssign = b.owner_id === 'auto' || !b.owner_id;
        const { lead, deduped } = createLead({ ...b, owner_id: autoAssign ? null : b.owner_id }, user.name, { autoAssign });
        if (deduped) { const o = userById(lead.owner_id); return send(res, 200, { duplicate: true, owner_name: o ? o.name : '—', lead: leadJSON(lead, true) }); }
        return send(res, 200, { ok: true, lead: leadJSON(lead, true) });
      }
      // bulk import (Excel/CSV) → each lead round-robin auto-assigned
      if (p === '/api/leads/bulk' && m === 'POST') {
        const b = await readBody(req);
        const list = Array.isArray(b.leads) ? b.leads : [];
        if (!list.length) return err(res, 400, 'no leads to import');
        if (list.length > 5000) return err(res, 400, 'max 5000 leads per import');
        let created = 0, skipped = 0, duplicates = 0; const byAgent = {};
        for (const row of list) {
          if (!row || !String(row.name || '').trim()) { skipped++; continue; }
          const { lead, deduped } = createLead({
            name: row.name, phone: row.phone, email: row.email, city: row.city,
            product: row.product, source: row.source || 'Bulk Upload',
            owner_id: row.owner_id || null,
          }, user.name + ' (import)', { autoAssign: true });
          if (deduped) { duplicates++; continue; }
          created++;
          const on = userById(lead.owner_id)?.name || '—';
          byAgent[on] = (byAgent[on] || 0) + 1;
        }
        return send(res, 200, { ok: true, created, skipped, duplicates, byAgent });
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
          db.prepare("UPDATE leads SET deleted=1, deleted_by=?, deleted_at=datetime('now') WHERE id=?").run(user.id, lead.id);
          db.prepare('INSERT INTO lead_deletions(lead_id,lead_name,phone,deleted_by,deleted_by_name,department) VALUES(?,?,?,?,?,?)')
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
        if (b.status && REMINDER_STATUSES.includes(b.status) && !b.next_followup && !lead.next_followup) {
          return err(res, 400, 'reminder_required');
        }
        // apply the follow-up date first so applyStatusChange doesn't overwrite it
        if (b.next_followup !== undefined) { db.prepare('UPDATE leads SET next_followup=? WHERE id=?').run(b.next_followup || null, lead.id); logAct(lead.id, '⏰ Reminder set', b.next_followup || 'cleared', user.name); lead.next_followup = b.next_followup || null; }
        if (b.status && b.status !== lead.status) await applyStatusChange(lead, b.status, user.name);
        if (b.owner_id && b.owner_id !== lead.owner_id) { db.prepare('UPDATE leads SET owner_id=? WHERE id=?').run(b.owner_id, lead.id); logAct(lead.id, '🔁 Reassigned to ' + (userById(b.owner_id)?.name || b.owner_id), '', user.name); }
        return send(res, 200, { ok: true, lead: leadJSON(leadRow(lead.id), true) });
      }
      mm = p.match(/^\/api\/leads\/([^/]+)\/(activity|call|miss|whatsapp|email)$/);
      if (mm && m === 'POST') {
        const lead = leadRow(mm[1]); if (!lead) return err(res, 404, 'not found');
        const act = mm[2]; const b = await readBody(req);
        if (act === 'activity') { logAct(lead.id, b.title || '📝 Note', b.sub || '', user.name); }
        else if (act === 'call') {
          const r = await clickToCall(user.phone || '', lead.phone);
          const connected = b.connected === undefined ? 1 : (b.connected ? 1 : 0);
          const talktime = Math.max(0, +b.talktime || 0);
          db.prepare('INSERT INTO calls(lead_id,owner_id,connected,talktime) VALUES(?,?,?,?)').run(lead.id, lead.owner_id, connected, talktime);
          logAct(lead.id, '📞 Call ' + (connected ? 'connected' : 'not connected'), (connected ? 'talktime ' + talktime + 's • ' : '') + 'recording ON • location logged' + (r.simulated ? ' (simulated)' : ''), user.name);
        }
        else if (act === 'miss') { db.prepare('INSERT INTO calls(lead_id,owner_id,connected,talktime) VALUES(?,?,0,0)').run(lead.id, lead.owner_id); const steps = await handleMiss(lead, user.name); return send(res, 200, { ok: true, steps, lead: leadJSON(leadRow(lead.id), true) }); }
        else if (act === 'whatsapp') { const r = await sendWhatsApp(lead.phone, b.text || 'Hi ' + lead.name); logAct(lead.id, '🟢 WhatsApp ' + (r.sent ? 'sent' : 'opened (simulated)'), b.text || '', user.name); }
        else if (act === 'email') { const r = await sendEmail(lead.email, b.subject || 'From My Haul Store', b.text || ''); logAct(lead.id, '✉️ Email ' + (r.sent ? 'sent' : 'composed (simulated)'), b.subject || '', user.name); }
        return send(res, 200, { ok: true, lead: leadJSON(leadRow(lead.id), true) });
      }

      // reports
      if (p.startsWith('/api/reports/') && m === 'GET') {
        const q = url.searchParams;
        const f = { from: q.get('from'), to: q.get('to'), source: q.get('source'), department: q.get('department'), owner: q.get('owner') };
        if (p === '/api/reports/summary') return send(res, 200, reportSummary(user, f));
        if (p === '/api/reports/agents') return send(res, 200, { agents: reportAgents(user, f) });
        if (p === '/api/reports/activity') return send(res, 200, { activity: reportActivity(user, f) });
        if (p === '/api/reports/followups') return send(res, 200, reportFollowups(user, f));
        if (p === '/api/reports/attendance') return send(res, 200, reportAttendance(user));
        if (p === '/api/reports/leads-distribution') return send(res, 200, reportLeadsDist(user, f));
        if (p === '/api/reports/deletions') return send(res, 200, reportDeletions(user));
        if (p === '/api/reports/users') return send(res, 200, reportUsersList(user));
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

function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, team: u.team }; }
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
    departments: getDepartments(), teamTarget: at, agentTarget: at };
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
