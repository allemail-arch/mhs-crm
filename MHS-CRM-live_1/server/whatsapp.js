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
        if (ev.type !== 'notify') return;
        for (const msg of (ev.messages || [])) {
          if (!msg.message || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid || '';
          if (!jid.endsWith('@s.whatsapp.net')) continue; // personal chats only (skip groups/status/broadcast)
          const digits = jid.split('@')[0].replace(/\D/g, '');
          if (!digits) continue;
          const name = msg.pushName || ('+' + digits);
          const text = textOf(msg.message);
          if (onLeadCb) { try { onLeadCb({ name, phone: '+' + digits, text }); } catch (_) {} }
        }
      } catch (_) {}
    });
  } catch (e) {
    S.error = e && e.message ? e.message : String(e);
    starting = false;
    setTimeout(start, 5000);
  }
}

module.exports = {
  init(cb) { onLeadCb = cb; if (baileys) start(); },
  status() { return { available: S.available, connected: S.connected, qr: S.qrDataUrl, error: S.error, me: S.me }; },
  async logout() {
    try { if (sock && S.connected) await sock.logout(); } catch (_) {}
    try { if (sock && sock.end) sock.end(undefined); } catch (_) {}
    try { fs.rmSync(sessionDir(), { recursive: true, force: true }); } catch (_) {}
    sock = null; S.connected = false; S.qrDataUrl = null; S.me = null; starting = false;
    setTimeout(start, 1000);
    return true;
  },
};
