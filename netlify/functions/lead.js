/*
 * POST /.netlify/functions/lead
 * Saves every lead to the Lifestone CRM (Supabase) and alerts the admins.
 *
 *   { action: 'create', source, lead: {...}, consent: {agreed, at, version, text}, utm, page, hp, talkToAgent, status, bestTime, review }
 *     → creates a lead, returns { ok, itemId, token }
 *   { action: 'update', itemId, token, bestTime }
 *     → updates that lead (the token proves the browser created it)
 *
 * `hp` is a hidden honeypot field: real people never fill it, so anything in it is treated as spam.
 * Every lead goes to a licensed agent. No health answers are collected.
 */
const C = require('../lib/common.js');
const db = require('../lib/db.js');
const alerts = require('../lib/alerts.js');

const TYPES = { term: 'Term', universal: 'Universal life', not_sure: 'Not sure' };
const AGENT_SOURCES = ['agent-callback', 'policy-review'];

exports.handler = async (event) => {
  const { body, error } = C.parseBody(event);
  if (error) return error;

  // Spam: answer like a success so bots learn nothing, but save nothing.
  if (body.hp) return C.json(200, { ok: true });

  try {
    if (body.action === 'update') return await update(body);
    if (body.action === 'create') return await create(body);
    return C.json(400, { ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('lead function error:', e.code || '', e.message);
    return C.json(e.code === 'CONFIG' ? 500 : 502, { ok: false, error: 'Could not save right now' });
  }
};

async function create(body) {
  const l = body.lead || {};
  const source = C.clean(body.source, 60) || 'unknown';
  const firstName = C.clean(l.firstName, 80);
  const lastName = C.clean(l.lastName, 80);
  const email = C.clean(l.email, 200).toLowerCase();
  const phone = C.phone11(l.phone);
  const state = C.US_STATES.includes(String(l.state || '').toUpperCase()) ? String(l.state).toUpperCase() : '';
  const consent = C.consentFields(body.consent);
  const emailRequired = !AGENT_SOURCES.includes(source);

  const problems = [];
  if (!firstName || !lastName) problems.push('name');
  if (!phone) problems.push('phone');
  if ((emailRequired && !email) || (email && !C.isEmail(email))) problems.push('email');
  if (!consent) problems.push('consent');
  if (problems.length) return C.json(400, { ok: false, error: 'Missing or invalid: ' + problems.join(', ') });

  const age = l.dob ? C.Age.ageFromDob(C.clean(l.dob, 10)) : null;
  const coverage = Math.min(Math.max(Number(l.coverage) || 0, 0), 100000000) || null;
  const type = TYPES[l.type] ? l.type : '';

  const utm = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = C.clean((body.utm || {})[k], 200);
    if (v) utm[k] = v;
  }
  const details = {};
  for (const k of ['gclid', 'fbclid']) { const v = C.clean((body.utm || {})[k], 300); if (v) details[k] = v; }
  if (body.page) details.page = C.clean(body.page, 200);
  if (body.review && typeof body.review === 'object') {
    details.review = {};
    for (const [k, v] of Object.entries(body.review).slice(0, 12)) details.review[C.clean(k, 30)] = C.clean(String(v), 120);
  }

  const lead = await db.insertLead(Object.assign({
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    state,
    age,
    coverage,
    coverage_label: C.clean(l.coverageLabel, 60),
    coverage_type: TYPES[type] || '',
    goal: C.clean(l.goalLabel, 100),
    interest: C.clean(l.interest, 60),
    replacing: l.replacing === 'yes' ? 'Yes' : l.replacing === 'no' ? 'No' : '',
    path: 'agent',
    status: 'new',
    source,
    best_time: C.clean(body.bestTime, 60),
    utm,
    details
  }, consent));

  await db.addEvent(lead.id, 'created', null, { source });
  console.log('lead created', { id: lead.id, source });
  await alerts.newLead(await db.activeAdmins(), lead);
  return C.json(200, { ok: true, itemId: lead.id, token: C.sign(lead.id) });
}

async function update(body) {
  if (!C.verify(body.itemId, body.token)) return C.json(403, { ok: false, error: 'Not allowed' });
  const before = await db.getLead(body.itemId);
  if (!before) return C.json(404, { ok: false, error: 'Not found' });

  const bestTime = C.clean(body.bestTime, 60);
  if (!bestTime) return C.json(200, { ok: true });

  const lead = await db.updateLead(body.itemId, { best_time: bestTime });
  await db.addEvent(lead.id, 'update', 'Best time to call: ' + bestTime, {});
  console.log('lead updated', { id: lead.id, keys: ['best_time'] });
  return C.json(200, { ok: true });
}
