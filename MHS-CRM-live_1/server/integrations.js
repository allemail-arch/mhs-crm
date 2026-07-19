/* ============================================================
   MHS CRM — outbound integrations (WhatsApp send, click-to-call).
   These read API keys from environment (.env). If a provider is
   not configured, the call is logged as a simulated action so the
   CRM keeps working end-to-end until you plug in real keys.
   Node 22 has global fetch — no dependency needed.
   ============================================================ */

/* ---- WhatsApp (Meta Cloud API by default; any BSP works) ----
   Env needed:
     WHATSAPP_TOKEN         (permanent access token)
     WHATSAPP_PHONE_ID      (phone number id)
   Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
*/
async function sendWhatsApp(toPhone, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const to = String(toPhone || '').replace(/[^\d]/g, '');
  if (!token || !phoneId) {
    return { sent: false, simulated: true, reason: 'WhatsApp not configured (set WHATSAPP_TOKEN, WHATSAPP_PHONE_ID)', to, text };
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    const data = await r.json();
    return { sent: r.ok, response: data, to, text };
  } catch (e) {
    return { sent: false, error: String(e), to, text };
  }
}

/* ---- Click-to-call + recording (Exotel by default) ----
   Env needed (Exotel example):
     TELEPHONY_PROVIDER=exotel
     EXOTEL_SID, EXOTEL_TOKEN, EXOTEL_SUBDOMAIN, EXOTEL_CALLER_ID
   Recording + call location come from the provider's call logs.
*/
async function clickToCall(agentPhone, leadPhone) {
  const provider = process.env.TELEPHONY_PROVIDER;
  if (provider === 'exotel') {
    const sid = process.env.EXOTEL_SID, tok = process.env.EXOTEL_TOKEN;
    const sub = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
    const caller = process.env.EXOTEL_CALLER_ID;
    if (!sid || !tok || !caller) return { placed: false, simulated: true, reason: 'Exotel not fully configured' };
    try {
      const auth = Buffer.from(sid + ':' + tok).toString('base64');
      const body = new URLSearchParams({ From: agentPhone, To: leadPhone, CallerId: caller, Record: 'true' });
      const r = await fetch(`https://${sub}/v1/Accounts/${sid}/Calls/connect.json`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await r.json();
      return { placed: r.ok, response: data };
    } catch (e) { return { placed: false, error: String(e) }; }
  }
  return { placed: false, simulated: true, reason: 'Telephony not configured (set TELEPHONY_PROVIDER + provider keys)' };
}

/* ---- Email (SMTP via provider HTTP API, or simulated) ----
   Simplest live option: a transactional email API (Resend/Brevo/SendGrid).
   Env: EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM
*/
async function sendEmail(to, subject, text) {
  const url = process.env.EMAIL_API_URL, key = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM;
  if (!url || !key || !from || !to) {
    return { sent: false, simulated: true, reason: 'Email not configured (set EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM)', to, subject };
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    return { sent: r.ok, to, subject };
  } catch (e) { return { sent: false, error: String(e), to, subject }; }
}

module.exports = { sendWhatsApp, clickToCall, sendEmail };
