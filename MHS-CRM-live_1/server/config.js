/* ============================================================
   MHS CRM — shared config (teams, sources, statuses, defaults)
   ============================================================ */

const TEAMS = {
  TPA: { name: 'The Powerful Ads',     code: 'TPA', color: '#2d5be3' },
  TFD: { name: "The Founder's Dream",  code: 'TFD', color: '#7c5cff' },
  MHS: { name: 'My Haul Store',        code: 'MHS', color: '#ff6a00' },
  TPK: { name: 'The Powerful Kitchen', code: 'TPK', color: '#12a150' },
};
const PRODUCTS = Object.keys(TEAMS);

// Lead sources (channels) — with colour + icon. Admin can add more from Settings.
const DEFAULT_SOURCES = [
  { name: 'Facebook',    color: '#1877f2', icon: 'f'  },
  { name: 'Google Ads',  color: '#34a853', icon: 'G'  },
  { name: 'Website',     color: '#ff6a00', icon: 'W'  },
  { name: 'Chatbot',     color: '#00b8d9', icon: 'Cb' },
  { name: 'WhatsApp',    color: '#25d366', icon: 'wa' },
  { name: 'Calendly',    color: '#006bff', icon: 'C'  },
  { name: 'LinkedIn',    color: '#0a66c2', icon: 'in' },
  { name: 'Bulk Upload', color: '#7c5cff', icon: 'B'  },
  { name: 'Manual',      color: '#6b7488', icon: 'M'  },
  { name: 'Others',      color: '#9aa0ac', icon: 'O'  },
];
const SOURCES = DEFAULT_SOURCES.map(s => s.name);

// Lead statuses  (open = still needs action)
const STATUS = {
  'Fresh':          { open: true,  fresh: true },
  'RNR':            { open: true },
  'Follow Up':      { open: true },
  'Interested':     { open: true },
  'Not Interested': { open: false },
  'Junk':           { open: false },
  'Closed Won':     { open: false, won: true },
  'Closed Lost':    { open: false },
};
const STATUS_LIST = Object.keys(STATUS);

// Targets — per agent, per vertical (business rule: min 200 leads, 20 wins each)
const AGENT_TARGET = { leads: 200, interested: 60, closed: 20 };
// Team target auto-scales in the UI = AGENT_TARGET × (agents in that team)
const TEAM_TARGET  = { leads: 200, interested: 60, closed: 20 };

// Default connectors (Admin → Sources & Automation).
// Each maps an incoming source to a product/team for routing.
const DEFAULT_CONNECTORS = [
  { key: 'Meta',     name: 'Meta — Facebook / Instagram Lead Ads', src: 'Facebook', desc: 'FB & Insta lead-form ads',        icon: 'f',  color: '#1877f2', connected: 0, team: 'TPA' },
  { key: 'Website',  name: 'Website Form',                          src: 'Website',  desc: 'myhaulstore.com contact form',   icon: 'W',  color: '#ff6a00', connected: 0, team: 'MHS' },
  { key: 'Calendly', name: 'Calendly',                              src: 'Calendly', desc: 'Demo / booking calls',           icon: 'C',  color: '#006bff', connected: 0, team: 'TFD' },
  { key: 'WhatsApp', name: 'WhatsApp Business API',                 src: 'WhatsApp', desc: 'WA incoming + auto-reply',        icon: 'wa', color: '#25d366', connected: 0, team: 'MHS' },
  { key: 'Landing',  name: 'Landing Pages',                         src: 'Website',  desc: 'Campaign landing pages',          icon: 'L',  color: '#7c5cff', connected: 0, team: 'TPA' },
  { key: 'Other',    name: 'Other Apps — Webhook / Zapier',         src: 'Manual',   desc: 'Kisi bhi app se lead (webhook)',  icon: '+',  color: '#6b7488', connected: 0, team: 'TFD' },
];

// Editable settings (Admin → Settings). Targets are per-agent per-vertical.
const DEFAULT_SETTINGS = { target_leads: 200, target_interested: 60, target_closed: 20 };

// Default automation rules
const DEFAULT_AUTOMATION = {
  roundRobin:    1,   // new lead → auto round-robin assign to team agents
  autoWaOnMiss:  1,   // missed/no-answer → auto WhatsApp
  autoRnrOnMiss: 1,   // missed/no-answer → move to RNR + reminder
  autoFollowup:  1,   // keep an open lead's follow-up reminder alive
};

module.exports = {
  TEAMS, PRODUCTS, SOURCES, DEFAULT_SOURCES, STATUS, STATUS_LIST,
  TEAM_TARGET, AGENT_TARGET, DEFAULT_SETTINGS, DEFAULT_CONNECTORS, DEFAULT_AUTOMATION,
};
