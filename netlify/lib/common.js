// Shared helpers for the Netlify functions: input cleaning, responses, and signed lead tokens.
const crypto = require('crypto');
const Age = require('../../config/age.js');
const Statuses = require('../../config/lead-statuses.js');

function env(name) {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error('Missing env var ' + name), { code: 'CONFIG' });
  return v;
}

// The browser gets a token with each new lead so it can update only that lead later.
function secret() { return process.env.LEAD_SIGNING_SECRET || env('SUPABASE_SERVICE_ROLE_KEY'); }
function sign(id) { return crypto.createHmac('sha256', secret()).update('lead:' + id).digest('hex').slice(0, 32); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function verify(id, token) {
  if (!UUID.test(String(id || '')) || typeof token !== 'string' || token.length !== 32) return false;
  const a = Buffer.from(sign(id)), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- input cleaning ----------
const clean = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const digits = (v) => String(v || '').replace(/\D/g, '');
function phone11(v) {
  const d = digits(v);
  if (d.length === 10) return '1' + d;
  if (d.length === 11 && d[0] === '1') return d;
  return null;
}
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

// { consent_text, consent_at, consent_version } or null when consent wasn't given.
function consentFields(consent) {
  if (!consent || consent.agreed !== true) return null;
  const at = new Date(clean(consent.at, 40));
  return {
    consent_text: clean(consent.text, 1000),
    consent_at: isNaN(at) ? new Date().toISOString() : at.toISOString(),
    consent_version: clean(consent.version, 20)
  };
}

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (event.httpMethod !== 'POST') return { error: json(405, { ok: false, error: 'Method not allowed' }) };
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  if (raw.length > 20000) return { error: json(413, { ok: false, error: 'Too large' }) };
  try { return { body: JSON.parse(raw) || {} }; } catch (e) { return { error: json(400, { ok: false, error: 'Bad JSON' }) }; }
}

// Where alert links point. Netlify sets URL automatically; SITE_URL overrides it.
function siteUrl() { return (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, ''); }

module.exports = {
  Age, Statuses, env, sign, verify, UUID, json, parseBody, siteUrl,
  clean, digits, phone11, isEmail, US_STATES, consentFields
};
