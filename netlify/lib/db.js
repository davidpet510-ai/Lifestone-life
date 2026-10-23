// Supabase access for the Netlify functions, using the service key (bypasses row-level security).
// Never send this key to the browser.
const { env } = require('./common.js');

function base() { return env('SUPABASE_URL').replace(/\/$/, ''); }

// Works with both key styles: legacy JWT keys ("eyJ…") go in Authorization too; new "sb_secret_…" keys only in apikey.
function serviceHeaders(extra) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return Object.assign(h, extra || {});
}

async function call(path, opts) {
  const res = await fetch(base() + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    // Log Supabase's error message only, never the lead data.
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || 'HTTP ' + res.status;
    throw Object.assign(new Error('Supabase: ' + msg), { code: 'DB', status: res.status });
  }
  return data;
}

const rest = (path, method, body, prefer) => call('/rest/v1' + path, {
  method,
  headers: serviceHeaders(prefer ? { Prefer: prefer } : null),
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function insertLead(row) {
  const rows = await rest('/leads', 'POST', row, 'return=representation');
  return rows[0];
}
async function updateLead(id, fields) {
  const rows = await rest('/leads?id=eq.' + encodeURIComponent(id), 'PATCH', fields, 'return=representation');
  return rows[0] || null;
}
async function getLead(id) {
  const rows = await rest('/leads?select=*&id=eq.' + encodeURIComponent(id), 'GET');
  return rows[0] || null;
}
async function addEvent(leadId, kind, body, meta, actor) {
  await rest('/lead_events', 'POST', { lead_id: leadId, kind, body: body || null, meta: meta || {}, actor: actor || null }, 'return=minimal');
}
async function getProfile(id) {
  const rows = await rest('/profiles?select=*&id=eq.' + encodeURIComponent(id), 'GET');
  return rows[0] || null;
}
async function activeAdmins() {
  return rest('/profiles?select=*&active=eq.true&role=eq.admin', 'GET');
}
async function updateProfile(id, fields) {
  await rest('/profiles?id=eq.' + encodeURIComponent(id), 'PATCH', fields, 'return=minimal');
}

// Checks a dashboard user's login token with Supabase. Returns { user, aal } or null.
async function userFromToken(token) {
  if (!token) return null;
  try {
    const user = await call('/auth/v1/user', { headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: 'Bearer ' + token } });
    if (!user || !user.id) return null;
    // The token was just validated by Supabase, so its payload can be read as-is.
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { user, aal: payload.aal || 'aal1' };
  } catch (e) {
    return null;
  }
}

// Sends a Supabase invite email; the person sets a password from the link.
async function inviteUser(email, fullName, redirectTo) {
  const q = redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : '';
  return call('/auth/v1/invite' + q, { method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ email, data: { full_name: fullName } }) });
}

// Sign-in status for every account (who has finished setting up), from Supabase's admin API.
async function authUsers() {
  const out = await call('/auth/v1/admin/users?per_page=1000', { headers: serviceHeaders() });
  return (out && out.users) || [];
}

// Emails a fresh link that lets the person (re)set their password. Works for invites that expired.
async function sendSetupLink(email, redirectTo) {
  const q = redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : '';
  return call('/auth/v1/recover' + q, { method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ email }) });
}

module.exports = { insertLead, updateLead, getLead, addEvent, getProfile, activeAdmins, updateProfile, userFromToken, inviteUser, authUsers, sendSetupLink };
