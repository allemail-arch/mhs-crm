# MHS CRM — Live (Phase 2)

A real, self-hosted lead-management CRM for My Haul Store: PIN login for 200+ users,
role-based access (Admin / Team Lead / Sales), lead capture from every source via
**live webhooks**, round-robin auto-assign, follow-up reminders, call + WhatsApp actions,
missed-call automation, admin reports, and "Closed Won → Customer CRM" push.

Built with **zero external dependencies** — only Node.js 22+ builtins (HTTP server,
SQLite, crypto). No `npm install` needed, so it deploys anywhere Node 22 runs.

---

## 1. Quick start (local)

```bash
cd server
cp .env.example .env          # then edit .env (see section 4)
node seed.js reset            # creates the DB + Admin, Team Lead, 10 Sales, dummy leads
node server.js                # → http://localhost:4000
```

Open http://localhost:4000 and log in.

**Login PINs (demo seed):**

| Role       | Name              | PIN  |
|------------|-------------------|------|
| Admin      | Abhishek Vyas     | 1111 |
| Team Lead  | Rahul Mehta       | 2222 |
| Sales      | Abhishek Bhadoriya| 0001 |
| Sales …    | …                 | 0002–0010 |

> ⚠️ The login screen's "Demo — quick login" dropdown and these fixed PINs are for
> testing only. Before going live: remove the dropdown (in `public/index.html`), and
> reset every user's PIN. Never ship with `1111`.

---

## 2. What is already working (no accounts needed)

- PIN login + JWT sessions, role-based data scoping (Sales see only their leads).
- Leads: create, list, filter, open, status change, reassign, notes, follow-up reminders.
- **Round-robin auto-assign** by product/team.
- **Live webhook endpoints** that receive leads and auto-assign them (see section 5).
- **Missed-call automation**: no-answer → auto-WhatsApp + auto-RNR + reminder.
- **Closed Won → Customer CRM** push (fires a webhook to your other site).
- Admin reports: source-wise, agent-wise, funnel, targets, team activity, Junk alert.
- Connectors & automation toggles.

Actions that need a paid provider (real WhatsApp message, real phone call+recording)
are **simulated and logged** until you add the API keys — the CRM keeps working end to end.

---

## 3. Project structure

```
mhs-crm-live/
├─ server/
│  ├─ server.js         # HTTP server + all API routes + webhooks
│  ├─ db.js             # SQLite schema + helpers
│  ├─ seed.js           # seed users + dummy leads
│  ├─ config.js         # teams, sources, statuses, targets, default connectors
│  ├─ integrations.js   # WhatsApp send + click-to-call (reads API keys from .env)
│  ├─ loadenv.js        # tiny .env loader
│  ├─ .env.example
│  └─ data.db           # created on first seed (gitignored)
└─ public/
   └─ index.html        # the whole frontend (desktop table + mobile app views)
```

---

## 4. Environment config (`server/.env`)

```
PORT=4000
JWT_SECRET=<64-char random>          # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
WEBHOOK_SECRET=<random>              # appended to inbound webhook URLs as ?token=...
META_VERIFY_TOKEN=mhs-verify         # you type this into Meta/WhatsApp webhook setup

# WhatsApp Business (Meta Cloud API or any BSP)
WHATSAPP_TOKEN=
WHATSAPP_PHONE_ID=

# Telephony (click-to-call + recording) — Exotel example
TELEPHONY_PROVIDER=exotel
EXOTEL_SID=
EXOTEL_TOKEN=
EXOTEL_SUBDOMAIN=api.exotel.com
EXOTEL_CALLER_ID=

# Push won leads to your other website's Customer CRM
CUSTOMER_CRM_WEBHOOK=
```

---

## 5. Connecting each lead source (live)

After deploying, your base URL is e.g. `https://crm.myhaulstore.com`.
Give each source the matching URL below. `SECRET` = your `WEBHOOK_SECRET`.

| Source | Where to paste | URL |
|--------|----------------|-----|
| **Website form** | your site's form action / script | `POST https://crm…/webhooks/website?token=SECRET` with JSON `{name,phone,email,city,product}` |
| **Meta (FB/Insta Lead Ads)** | Meta App → Webhooks → `leadgen` | `https://crm…/webhooks/meta` (verify token = `META_VERIFY_TOKEN`) |
| **Calendly** | Calendly → Integrations → Webhooks | `POST https://crm…/webhooks/calendly?token=SECRET` |
| **WhatsApp** | Meta App → WhatsApp → Webhooks | `https://crm…/webhooks/whatsapp` (verify token = `META_VERIFY_TOKEN`) |
| **Landing pages** | same as website | `POST https://crm…/webhooks/website?token=SECRET` |
| **Any other app** | Zapier / Make / Pabbly → Webhook action | `POST https://crm…/webhooks/generic/<yourname>?token=SECRET` with JSON `{name,phone,email,source}` |

Each inbound lead is de-duplicated (by source id) and auto-assigned via round-robin
to the team mapped in **Admin → Sources**.

### What YOU need to create (accounts)
- **Meta App** (developers.facebook.com) + a Facebook Page → for FB/Insta lead ads and WhatsApp.
- **WhatsApp Business API** number (via Meta Cloud API or a BSP: AiSensy / WATI / Interakt / Gupshup / Twilio). Monthly + per-conversation cost.
- **Telephony account** (Exotel / MyOperator / Knowlarity / Twilio) for click-to-call + recording. Monthly + per-minute cost.
- A **host** for this server (see section 6).

---

## 6. Deploy to Railway (recommended, ~10 min)

This repo is Railway-ready: `package.json` sets the start command (`node server/server.js`)
and Node 22, `railway.json` configures the build, and the server **auto-seeds** the demo
data on first boot (no manual seed step). Frontend + API run as ONE service on ONE URL.

1. Put this folder in a **GitHub repo** (or use Railway's "Deploy from local").
2. On railway.app → **New Project → Deploy from GitHub repo** → pick this repo.
3. **Variables** tab → add:
   - `JWT_SECRET` = a long random string
   - `WEBHOOK_SECRET` = another random string
   - `META_VERIFY_TOKEN` = e.g. `mhs-verify`
   - `DB_PATH` = `/data/mhs-crm.db`
   - (later) WhatsApp / telephony / email keys from `.env.example`
   - `PORT` is provided by Railway automatically — don't set it.
4. **Storage** → add a **Volume**, mount path `/data` (so the SQLite DB survives restarts).
5. Deploy. Open the generated URL → log in with Admin PIN `1111`.
   The DB seeds itself on first boot; restarts keep your data.
6. **Custom domain** (optional): Settings → Networking → add your domain. HTTPS is automatic.

> After first login, change the demo PINs and remove the demo dropdown before real use.

**Render** works the same way: New Web Service → Build `npm install` (no-op), Start `node server/server.js`,
add a Disk mounted at `/data`, set the same env vars.

**VPS (Ubuntu) alternative:**
```bash
# install Node 22, then:
git clone <repo> && cd mhs-crm-live
cp server/.env.example server/.env && nano server/.env   # set DB_PATH, secrets
node server/server.js        # auto-seeds; use pm2/systemd + nginx + HTTPS (certbot)
```

Always run behind **HTTPS** (Meta/WhatsApp webhooks require it — Railway gives it free).

---

## 7. Security (200 users)

Built-in protections:
- **PINs hashed** (scrypt) — never stored in plain text.
- **Login brute-force lockout** — 5 wrong PINs from an IP → 5-minute lock (429).
- **XSS-safe frontend** — every user-provided value (lead name, notes, etc.) is HTML-escaped, so a lead named `<script>…` renders as text, never executes.
- **SQL-injection-safe** — all DB queries are parameterized.
- **Server-side auth on every API call** — editing the HTML in the browser cannot bypass role checks; Sales still only get their own leads.
- Webhooks require a secret token; connectors/automation/user & product creation are Admin-only.

You must still:
- Set a strong `JWT_SECRET` and `WEBHOOK_SECRET` (never the dev defaults).
- Serve over **HTTPS** only. Take regular backups of `data.db`.
- Replace demo PINs before launch (and remove the demo login dropdown in `public/index.html`).

---

## 8. Scaling note (Postgres)

The builtin SQLite file is fine for 200 users at normal call-center load. If you later
need multiple server instances or heavy concurrency, swap `db.js` to PostgreSQL (the
`pg` driver is pure-JS). The schema in `db.js` maps 1:1 to Postgres.

---

## 9. Roadmap (next)

1. Plug in real WhatsApp + telephony keys (test each in a staging number).
2. Bulk lead upload (CSV) screen for Admin.
3. Call-recording playback + call-location display on the lead timeline (from provider logs).
4. Notification push to agents (new lead / due follow-up).
5. Audit log + data export.
