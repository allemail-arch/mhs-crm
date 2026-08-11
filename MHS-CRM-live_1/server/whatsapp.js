/* ============================================================
   MHS CRM — WhatsApp lead capture (Baileys, unofficial)
   OPTIONAL module: if the dependency isn't installed or anything
   fails, the core CRM keeps running normally (status.available=false).
   Session is stored on the Railway volume (next to the DB) so it
   survives redeploys — scan the QR only once.
   ============================================================ */
const path = require('node:path');
const fs = require('node:fs');

let baileys = null;
try { baileys = require('@whiskeysockets/baileys'); } catch (e) { /* dep not installed */ }
let qrlib = null;
try { qrlib = require('qrcode'); } catch (e) { /* optional */ }

const S = { available: !!baileys, connected: false, qrDataUrl: null, error: baileys ? null : 'module not installed', me: null, startedAt: null };
let sock = null;
let onLeadCb = null;
let starting = false;
const RECENT = []; // last 20 raw incoming-message events, for debugging only
function pushRecent(entry) { RECENT.unshift({ time: new Date().toISOString(), ...entry }); if (RECENT.length > 20) RECENT.pop(); }

function sessionDir() {
  const base = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname;
  const dir = path.join(base, 'wa-session');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function textOf(message) {
  if (!message) return '';
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.listResponseMessage?.title
    || '';
}

// WhatsApp's newer privacy system routes many personal-chat messages through a
// "@lid" (linked-id) JID instead of the classic "@s.whatsapp.net" phone-number JID.
// We accept both, but for @lid we try to recover the real phone number from the
// alternate fields Baileys attaches when it knows the PN<->LID mapping.
function realDigitsFromKey(key) {
  const candidates = [key.remoteJidAlt, key.senderPn, key.participantAlt, key.remoteJid, key.participant].filter(Boolean);
  for (const c of candidates) {
    if (String(c).endsWith('@s.whatsapp.net')) {
      const d = String(c).split('@')[0].replace(/\D/g, '');
      if (d.length >= 8) return d;
    }
  }
  // fallback: no phone-number JID available (pure @lid) — use the lid's numeric part.
  // This is NOT a real phone number, but keeps the message from being silently dropped.
  const jid = key.remoteJid || '';
  const d = jid.split('@')[0].replace(/\D/g, '');
  return d.length >= 8 ? d : null;
}

async function start() {
  if (!baileys) { S.available = false; return; }
  if (starting) return;
  starting = true;
  try {
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir());
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) {}

    sock = makeWASocket({
      auth: authState,
      version,
      browser: ['MHS CRM', 'Chrome', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    S.startedAt = new Date().toISOString();
    starting = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr && qrlib) { try { S.qrDataUrl = await qrlib.toDataURL(qr); } catch (_) { S.qrDataUrl = null; } }
      if (connection === 'open') {
        S.connected = true; S.qrDataUrl = null; S.error = null;
        S.me = (sock.user && sock.user.id) ? String(sock.user.id).split(':')[0].split('@')[0] : null;
      } else if (connection === 'close') {
        S.connected = false;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const loggedOut = baileys.DisconnectReason && code === baileys.DisconnectReason.loggedOut;
        if (loggedOut) {
          try { fs.rmSync(sessionDir(), { recursive: true, force: true }); } catch (_) {}
          S.qrDataUrl = null; S.me = null;
          setTimeout(start, 1500);
        } else {
          setTimeout(start, 3000); // transient — reconnect
        }
      }
    });

    sock.ev.on('messages.upsert', (ev) => {
      try {
        for (const msg of (ev.messages || [])) {
          const jid = msg.key?.remoteJid || '';
          pushRecent({
            evType: ev.type, jid, fromMe: !!msg.key?.fromMe, hasMessage: !!msg.message,
            remoteJidAlt: msg.key?.remoteJidAlt || null, senderPn: msg.key?.senderPn || null,
            resolvedDigits: msg.message && !msg.key?.fromMe ? realDigitsFromKey(msg.key || {}) : null,
            msgTypes: msg.message ? Object.keys(msg.message) : [], textPreview: textOf(msg.message).slice(0, 60),
          });
        }
        if (ev.type !== 'notify') return;
        for (const msg of (ev.messages || [])) {
          if (!msg.message || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid || '';
          // personal chats only (skip groups "@g.us", status/broadcast) — accept both
          // classic phone-number JIDs and the newer "@lid" privacy JIDs.
          if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
          const digits = realDigitsFromKey(msg.key);
          if (!digits) continue;
          const name = msg.pushName || ('+' + digits);
          const text = textOf(msg.message);
          if (onLeadCb) { try { onLeadCb({ name, phone: '+' + digits, text }); } catch (_) {} }
        }
      } catch (e) { pushRecent({ error: e && e.message ? e.message : String(e) }); }
    });
  } catch (e) {
    S.error = e && e.message ? e.message : String(e);
    starting = false;
    setTimeout(start, 5000);
  }
}

module.exports = {
  init(cb) { onLeadCb = cb; if (baileys) start(); },
  status() { return { available: S.available, connected: S.connected, qr: S.qrDataUrl, error: S.error, me: S.me, recent: RECENT }; },
  async logout() {
    try { if (sock && S.connected) await sock.logout(); } catch (_) {}
    try { if (sock && sock.end) sock.end(undefined); } catch (_) {}
    try { fs.rmSync(sessionDir(), { recursive: true, force: true }); } catch (_) {}
    sock = null; S.connected = false; S.qrDataUrl = null; S.me = null; starting = false;
    setTimeout(start, 1000);
    return true;
  },
};
