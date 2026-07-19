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

function createLead(data, byName, opts = {}) {
  // dedupe by external_id
  if (data.external_id) {
    const ex = db.prepare('SELECT * FROM leads WHERE external_id=?').get(data.external_id);
    if (ex) return { lead: ex, deduped: true };
  }
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
  db.prepare(`INSERT INTO leads(id,name,phone,email,city,product,source,status,owner_id,website,score,converted,next_followup,external_id)
              VALUES(?,?,?,?,?,?,?, 'Fresh', ?,?,?,0,?,?)`)
    .run(id, data.name || 'Unknown', data.phone || '', data.email || '', data.city || '', product, source, ownerId, data.website || '', score, followup, data.external_id || null);
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
  logAct(lead.id, '📵 Call — No answer', 'Ghanti gayi, koi response nahi', byName);
  const steps = [];
  if (autoOn('autoWaOnMiss')) {
    const msg = `Hi ${String(lead.name).split(' ')[0]}, humne aapko call kiya tha. Aap kab available ho?`;
    const r = await sendWhatsApp(lead.phone, msg);
    logAct(lead.id, '🟢 Auto WhatsApp ' + (r.sent ? 'sent' : '(simulated)'), '"' + msg + '"', 'System');
    steps.push('WhatsApp');
  }
  if (autoOn('autoRnrOnMiss')) {
    db.prepare("UPDATE leads SET status='RNR', next_followup=?, updated_at=datetime('now') WHERE id=?").run(addDays(1), lead.id);
    logAct(lead.id, '↪️ Auto status → RNR', 'Kal ka reminder set', 'System');
    steps.push('RNR + reminder');
  }
  return steps;
}

/* ---------------- reports ---------------- */
function scopeSql(user) {
  if (user.role === 'admin') return { where: '1=1', args: [] };
  if (user.role === 'lead') return { where: "owner_id IN (SELECT id FROM users WHERE team=?)", args: [user.team] };
  return { where: 'owner_id=?', args: [user.id] };
}
function reportSummary(user, from, to) {
  const s = scopeSql(user);
  let where = s.where, args = [...s.args];
  if (from) { where += " AND date(created_at) >= date(?)"; args.push(from); }
  if (to) { where += " AND date(created_at) <= date(?)"; args.push(to); }
  const rows = db.prepare(`SELECT status, source FROM leads WHERE ${where}`).all(...args);
  const total = rows.length;
  const won = rows.filter(r => cfg.STATUS[r.status]?.won).length;
  const open = rows.filter(r => cfg.STATUS[r.status]?.open).length;
  const interested = rows.filter(r => r.status === 'Interested').length;
  const bySource = cfg.SOURCES.map(src => ({ src, n: rows.filter(r => r.source === src).length }));
  const funnel = cfg.STATUS_LIST.map(st => ({ st, n: rows.filter(r => r.status === st).length }));
  return { total, won, open, interested, conv: total ? Math.round(won / total * 100) : 0, bySource, funnel };
}
function reportAgents(user) {
  const teamFilter = user.role === 'admin' ? '' : user.team;
  const sales = activeSales(teamFilter);
  const cols = ['Fresh', 'Follow Up', 'Interested', 'Not Interested', 'Closed Won'];
  return sales.map(u => {
    const rows = db.prepare('SELECT status FROM leads WHERE owner_id=?').all(u.id);
    const counts = {}; cols.forEach(c => counts[c] = rows.filter(r => r.status === c).length);
    return { id: u.id, name: u.name, email: u.email, team: u.team, total: rows.length, counts };
  });
}
function reportActivity(user) {
  const teamFilter = user.role === 'admin' ? '' : user.team;
  const sales = activeSales(teamFilter);
  // connected calls today + talk time, per owner (from the calls table)
  const rows = db.prepare(`SELECT owner_id oid, COUNT(*) c, SUM(talktime) t FROM calls
      WHERE connected=1 AND date(created_at)=date('now') GROUP BY owner_id`).all();
  const cMap = Object.fromEntries(rows.map(r => [r.oid, r]));
  return sales.map(u => {
    const junk = db.prepare("SELECT COUNT(*) n FROM leads WHERE owner_id=? AND status='Junk'").get(u.id).n;
    const c = cMap[u.id] || { c: 0, t: 0 };
    // avg first-response minutes (lead created → first CONNECTED call)
    const resp = db.prepare(`SELECT AVG(mins) m FROM (
        SELECT (julianday(MIN(ca.created_at)) - julianday(l.created_at))*24*60 mins
        FROM leads l JOIN calls ca ON ca.lead_id=l.id
        WHERE l.owner_id=? AND ca.connected=1 GROUP BY l.id)`).get(u.id).m;
    return { id: u.id, name: u.name, team: u.team, callsToday: c.c, talktime: c.t || 0,
      avgRespMin: resp ? Math.max(0, Math.round(resp)) : null, junk, working: c.c > 0 };
  });
}
// per-user + per-team missed / today-due follow-ups
function reportFollowups(user) {
  const teamFilter = user.role === 'admin' ? '' : user.team;
  const sales = activeSales(teamFilter);
  const OPEN = "('Fresh','RNR','Follow Up','Interested')";
  const per = sales.map(u => {
    const missed = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND next_followup IS NOT NULL AND next_followup < date('now') AND status IN ${OPEN}`).get(u.id).n;
    const todayDue = db.prepare(`SELECT COUNT(*) n FROM leads WHERE owner_id=? AND next_followup = date('now') AND status IN ${OPEN}`).get(u.id).n;
    return { id: u.id, name: u.name, team: u.team, missed, todayDue };
  });
  const teams = {};
  per.forEach(x => { const t = teams[x.team] = teams[x.team] || { team: x.team, missed: 0, todayDue: 0 }; t.missed += x.missed; t.todayDue += x.todayDue; });
  return { per: per.sort((a, b) => b.missed - a.missed), teams: Object.values(teams) };
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
      if (rec.until > now) return err(res, 429, 'Bahut galat PIN. ' + Math.ceil((rec.until - now) / 1000) + 's baad try karo.');
      const { pin } = await readBody(req);
      if (!pin) return err(res, 400, 'pin required');
      const users = db.prepare('SELECT * FROM users WHERE active=1').all();
      const u = users.find(x => { try { return verifyPin(pin, x.pin_hash, x.pin_salt); } catch { return false; } });
      if (!u) {
        rec.fails++;
        if (rec.fails >= LOGIN_MAX_FAILS) { rec.until = now + LOGIN_LOCK_MS; rec.fails = 0; }
        loginFails.set(ip, rec);
        return err(res, 401, 'Galat PIN');
      }
      loginFails.delete(ip);
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
        const rows = db.prepare('SELECT id,name,email,role,team,department,phone,active FROM users ORDER BY role, name').all();
        const withLoad = rows.map(u => ({ ...u, leads: db.prepare('SELECT COUNT(*) n FROM leads WHERE owner_id=?').get(u.id).n }));
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

      // leads
      if (p === '/api/leads' && m === 'GET') {
        const s = scopeSql(user);
        let where = s.where, args = [...s.args];
        const q = url.searchParams;
        if (q.get('status')) { where += ' AND status=?'; args.push(q.get('status')); }
        if (q.get('source')) { where += ' AND source=?'; args.push(q.get('source')); }
        if (q.get('owner')) { where += ' AND owner_id=?'; args.push(q.get('owner')); }
        if (q.get('q')) { where += ' AND (name LIKE ? OR phone LIKE ? OR city LIKE ? OR email LIKE ?)'; const t = '%' + q.get('q') + '%'; args.push(t, t, t, t); }
        const rows = db.prepare(`SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC`).all(...args);
        return send(res, 200, { leads: rows.map(r => leadJSON(r)) });
      }
      if (p === '/api/leads' && m === 'POST') {
        const b = await readBody(req);
        if (!b.name) return err(res, 400, 'name required');
        const autoAssign = b.owner_id === 'auto' || !b.owner_id;
        const { lead } = createLead({ ...b, owner_id: autoAssign ? null : b.owner_id }, user.name, { autoAssign });
        return send(res, 200, { ok: true, lead: leadJSON(lead, true) });
      }
      let mm = p.match(/^\/api\/leads\/([^/]+)$/);
      if (mm && m === 'GET') { const r = leadRow(mm[1]); return r ? send(res, 200, { lead: leadJSON(r, true) }) : err(res, 404, 'not found'); }
      if (mm && m === 'PATCH') {
        const b = await readBody(req); const lead = leadRow(mm[1]); if (!lead) return err(res, 404, 'not found');
        if (b.status && b.status !== lead.status) await applyStatusChange(lead, b.status, user.name);
        if (b.owner_id && b.owner_id !== lead.owner_id) { db.prepare('UPDATE leads SET owner_id=? WHERE id=?').run(b.owner_id, lead.id); logAct(lead.id, '🔁 Reassigned to ' + (userById(b.owner_id)?.name || b.owner_id), '', user.name); }
        if (b.next_followup !== undefined) { db.prepare('UPDATE leads SET next_followup=? WHERE id=?').run(b.next_followup || null, lead.id); logAct(lead.id, '⏰ Reminder set', b.next_followup || 'cleared', user.name); }
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
      if (p === '/api/reports/summary' && m === 'GET') return send(res, 200, reportSummary(user, url.searchParams.get('from'), url.searchParams.get('to')));
      if (p === '/api/reports/agents' && m === 'GET') return send(res, 200, { agents: reportAgents(user) });
      if (p === '/api/reports/activity' && m === 'GET') return send(res, 200, { activity: reportActivity(user) });
      if (p === '/api/reports/followups' && m === 'GET') return send(res, 200, reportFollowups(user));

      // connectors
      if (p === '/api/connectors' && m === 'GET') {
        const rows = db.prepare('SELECT * FROM connectors').all().map(c => ({ ...c, connected: !!c.connected, leads: db.prepare('SELECT COUNT(*) n FROM leads WHERE source=?').get(c.src).n }));
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
    teamTarget: at, agentTarget: at };
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
