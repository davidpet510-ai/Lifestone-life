// Shared helpers for the Netlify functions: Monday.com API, lead fields, and signed item tokens.
const crypto = require('crypto');
const CONFIG = require('../../config/monday-columns.js');
const Routing = require('../../config/routing-rules.js');

const API_URL = 'https://api.monday.com/v2';
const COLS = CONFIG.columns;

function env(name) {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error('Missing env var ' + name), { code: 'CONFIG' });
  return v;
}

async function gql(query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: env('MONDAY_API_TOKEN') },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors || json.error_message) {
    // Log Monday's error message only, never the lead data.
    const msg = (json.errors && json.errors.map((e) => e.message).join('; ')) || json.error_message || 'HTTP ' + res.status;
    throw Object.assign(new Error('Monday API: ' + msg), { code: 'MONDAY' });
  }
  return json.data;
}

// Turns { email: 'a@b.com', status: 'New', ... } into Monday's column_values format.
function columnValues(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    const col = COLS[key];
    if (!col || value === undefined || value === null || value === '') continue;
    switch (col.type) {
      case 'email': out[col.id] = { email: value, text: value }; break;
      case 'phone': out[col.id] = { phone: value, countryShortName: 'US' }; break;
      case 'numbers': out[col.id] = String(value); break;
      case 'status': out[col.id] = { label: value }; break;
      case 'long_text': out[col.id] = { text: value }; break;
      default: out[col.id] = String(value).slice(0, 2000);
    }
  }
  return out;
}

async function createItem(name, fields) {
  const data = await gql(
    'mutation ($board: ID!, $name: String!, $cols: JSON!) { create_item (board_id: $board, item_name: $name, column_values: $cols, create_labels_if_missing: true) { id } }',
    { board: env('MONDAY_BOARD_ID'), name: name.slice(0, 255), cols: JSON.stringify(columnValues(fields)) }
  );
  return data.create_item.id;
}

async function updateItem(itemId, fields) {
  const cols = columnValues(fields);
  if (!Object.keys(cols).length) return;
  await gql(
    'mutation ($board: ID!, $item: ID!, $cols: JSON!) { change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols, create_labels_if_missing: true) { id } }',
    { board: env('MONDAY_BOARD_ID'), item: String(itemId), cols: JSON.stringify(cols) }
  );
}

// The browser gets a token with each new item so it can update only that item later.
function secret() { return process.env.LEAD_SIGNING_SECRET || env('MONDAY_API_TOKEN'); }
function sign(itemId) { return crypto.createHmac('sha256', secret()).update('lead:' + itemId).digest('hex').slice(0, 32); }
function verify(itemId, token) {
  if (!/^\d{1,20}$/.test(String(itemId || '')) || typeof token !== 'string' || token.length !== 32) return false;
  const a = Buffer.from(sign(itemId)), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- input cleaning ----------
const clean = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const digits = (v) => String(v || '').replace(/\D/g, '');
function phoneE164(v) {
  const d = digits(v);
  if (d.length === 10) return '1' + d;
  if (d.length === 11 && d[0] === '1') return d;
  return null;
}
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

function consentText(consent) {
  if (!consent || consent.agreed !== true) return '';
  const at = clean(consent.at, 40) || new Date().toISOString();
  return 'Yes – ' + at + (consent.version ? ' (v' + clean(consent.version, 20) + ')' : '');
}

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (event.httpMethod !== 'POST') return { error: json(405, { ok: false, error: 'Method not allowed' }) };
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  if (raw.length > 20000) return { error: json(413, { ok: false, error: 'Too large' }) };
  try { return { body: JSON.parse(raw) }; } catch (e) { return { error: json(400, { ok: false, error: 'Bad JSON' }) }; }
}

module.exports = {
  CONFIG, Routing, createItem, updateItem, sign, verify, json, parseBody,
  clean, digits, phoneE164, isEmail, US_STATES, consentText
};
