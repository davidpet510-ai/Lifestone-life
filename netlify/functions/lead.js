/*
 * POST /.netlify/functions/lead
 * Saves every lead to the Lifestone CRM (Supabase) and alerts the admins.
 *
 *   { action: 'create', source, lead: {...}, consent: {agreed, at, version, text}, utm, page, hp, talkToAgent, status, bestTime, review }
 *     → creates a lead, returns { ok, itemId, token, path }
 *   { action: 'update', itemId, token, status, bestTime, path }
 *     → updates that lead (the token proves the browser created it)
 *
 * `hp` is a hidden honeypot field: real people never fill it, so anything in it is treated as spam.
 * The health screen answer is only used to choose the path. It is never stored or logged.
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
  if (body.hp) return C.json(200, { ok: true, path: 'agent' });

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

  const age = l.dob ? C.Routing.ageFromDob(C.clean(l.dob, 10)) : null;
  const coverage = Math.min(Math.max(Number(l.coverage) || 0, 0), 100000000) || null;
  const type = TYPES[l.type] ? l.type : '';
  const forcedAgent = body.talkToAgent === true || AGENT_SOURCES.includes(source);
  const decision = C.Routing.decide({
    age, coverage, type, state, talkToAgent: forcedAgent,
    health: l.health === 'no' ? 'no' : l.health === 'yes' ? 'yes' : '',
    replacing: l.replacing === 'no' ? 'no' : l.replacing === 'yes' ? 'yes' : ''
  });

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
    path: decision.path,
    status: body.status === 'abandoned' ? 'abandoned' : 'new',
    reason: decision.path === 'agent' ? decision.reasons.join('; ') : '',
    source,
    best_time: C.clean(body.bestTime, 60),
    utm,
    details
  }, consent));

  await db.addEvent(lead.id, 'created', null, { source, path: decision.path });
  console.log('lead created', { id: lead.id, source, path: decision.path });
  await alerts.newLead(await db.activeAdmins(), lead);
  return C.json(200, { ok: true, itemId: lead.id, token: C.sign(lead.id), path: decision.path });
}

async function update(body) {
  if (!C.verify(body.itemId, body.token)) return C.json(403, { ok: false, error: 'Not allowed' });
  const before = await db.getLead(body.itemId);
  if (!before) return C.json(404, { ok: false, error: 'Not found' });

  const fields = {};
  // Only move a lead to "abandoned" while nobody has worked it yet.
  if (body.status === 'abandoned' && before.status === 'new') fields.status = 'abandoned';
  if (body.bestTime) fields.best_time = C.clean(body.bestTime, 60);
  if (body.path === 'agent' && before.path !== 'agent') {
    fields.path = 'agent';
    fields.reason = 'Asked to talk to an agent';
    if (before.status === 'abandoned') fields.status = 'new';
  }
  if (!Object.keys(fields).length) return C.json(200, { ok: true });

  const lead = await db.updateLead(body.itemId, fields);
  if (fields.status) await db.addEvent(lead.id, 'status', null, { from: before.status, to: fields.status, by: 'website' });
  if (fields.path) await db.addEvent(lead.id, 'path', 'Asked to talk to an agent', { from: before.path, to: 'agent' });
  if (fields.best_time) await db.addEvent(lead.id, 'update', 'Best time to call: ' + fields.best_time, {});
  console.log('lead updated', { id: lead.id, keys: Object.keys(fields) });

  if (fields.status === 'abandoned' || fields.path) {
    const recipients = await db.activeAdmins();
    if (lead.assigned_to) recipients.push(await db.getProfile(lead.assigned_to));
    await (fields.path ? alerts.wantsAgent : alerts.newLead)(dedupe(recipients), lead);
  }
  return C.json(200, { ok: true });
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => p && !seen.has(p.id) && seen.add(p.id));
}
