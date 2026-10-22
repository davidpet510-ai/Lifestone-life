/*
 * /.netlify/functions/admin — server-side helpers for the dashboard at /admin.
 *
 *   GET  ?action=config                       public Supabase URL + anon key for the dashboard (safe to expose)
 *   POST { action: 'invite', email, fullName, role }   admins only: emails an invite to a new team member
 *   POST { action: 'notify-assign', leadId }           admins only: alerts the agent a lead was just assigned to
 *
 * POST calls must send the dashboard user's login token: Authorization: Bearer <token>.
 * The caller must be an active admin who finished two-step verification.
 */
const C = require('../lib/common.js');
const db = require('../lib/db.js');
const alerts = require('../lib/alerts.js');

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      if ((event.queryStringParameters || {}).action !== 'config') return C.json(400, { ok: false, error: 'Unknown action' });
      return C.json(200, { ok: true, url: C.env('SUPABASE_URL'), anonKey: C.env('SUPABASE_ANON_KEY') });
    }

    const { body, error } = C.parseBody(event);
    if (error) return error;

    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const session = await db.userFromToken(auth.replace(/^Bearer\s+/i, ''));
    if (!session) return C.json(401, { ok: false, error: 'Please sign in again' });
    const me = await db.getProfile(session.user.id);
    if (!me || !me.active || me.role !== 'admin' || session.aal !== 'aal2') return C.json(403, { ok: false, error: 'Admins only' });

    if (body.action === 'invite') return await invite(body, me);
    if (body.action === 'notify-assign') return await notifyAssign(body);
    return C.json(400, { ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('admin function error:', e.code || '', e.message);
    return C.json(e.code === 'CONFIG' ? 500 : 502, { ok: false, error: e.code === 'DB' && e.status === 422 ? 'That email may already have an account' : 'Something went wrong' });
  }
};

async function invite(body, me) {
  const email = C.clean(body.email, 200).toLowerCase();
  const fullName = C.clean(body.fullName, 120);
  const role = body.role === 'admin' ? 'admin' : 'agent';
  if (!C.isEmail(email)) return C.json(400, { ok: false, error: 'Enter a valid email' });

  const user = await db.inviteUser(email, fullName, C.siteUrl() ? C.siteUrl() + '/admin/' : '');
  // The database creates the profile as an agent; promote if asked.
  if (user && user.id && role === 'admin') await db.updateProfile(user.id, { role: 'admin' });
  console.log('team invite sent', { by: me.id, role });
  return C.json(200, { ok: true });
}

async function notifyAssign(body) {
  if (!C.UUID.test(String(body.leadId || ''))) return C.json(400, { ok: false, error: 'Bad lead' });
  const lead = await db.getLead(body.leadId);
  if (!lead || !lead.assigned_to) return C.json(200, { ok: true });
  const agent = await db.getProfile(lead.assigned_to);
  await alerts.assigned(agent, lead);
  return C.json(200, { ok: true });
}
