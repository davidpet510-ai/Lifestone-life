/*
 * POST /.netlify/functions/lead
 * Saves every lead to Monday.com.
 *
 *   { action: 'create', source, lead: {...}, consent: {agreed, at, version}, utm, page, hp, talkToAgent, status, bestTime, review }
 *     → creates an item, returns { ok, itemId, token, path }
 *   { action: 'update', itemId, token, status, bestTime, path }
 *     → updates that item (the token proves the browser created it)
 *
 * `hp` is a hidden honeypot field: real people never fill it, so anything in it is treated as spam.
 * The health screen answer is only used to choose the path. It is never stored or logged.
 */
const M = require('../lib/monday.js');

const TYPES = { term: 'Term', universal: 'Universal life', not_sure: 'Not sure' };
const AGENT_SOURCES = ['agent-callback', 'policy-review'];

exports.handler = async (event) => {
  const { body, error } = M.parseBody(event);
  if (error) return error;

  // Spam: answer like a success so bots learn nothing, but save nothing.
  if (body.hp) return M.json(200, { ok: true, path: 'agent' });

  try {
    if (body.action === 'update') return await update(body);
    if (body.action === 'create') return await create(body);
    return M.json(400, { ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('lead function error:', e.code || '', e.message);
    return M.json(e.code === 'CONFIG' ? 500 : 502, { ok: false, error: 'Could not save right now' });
  }
};

async function create(body) {
  const l = body.lead || {};
  const source = M.clean(body.source, 60) || 'unknown';
  const firstName = M.clean(l.firstName, 80);
  const lastName = M.clean(l.lastName, 80);
  const email = M.clean(l.email, 200).toLowerCase();
  const phone = M.phoneE164(l.phone);
  const state = M.US_STATES.includes(String(l.state || '').toUpperCase()) ? String(l.state).toUpperCase() : '';
  const consent = M.consentText(body.consent);
  const emailRequired = !AGENT_SOURCES.includes(source);

  const problems = [];
  if (!firstName || !lastName) problems.push('name');
  if (!phone) problems.push('phone');
  if ((emailRequired && !email) || (email && !M.isEmail(email))) problems.push('email');
  if (!consent) problems.push('consent');
  if (problems.length) return M.json(400, { ok: false, error: 'Missing or invalid: ' + problems.join(', ') });

  const age = l.dob ? M.Routing.ageFromDob(M.clean(l.dob, 10)) : null;
  const coverage = Math.min(Math.max(Number(l.coverage) || 0, 0), 100000000) || null;
  const type = TYPES[l.type] ? l.type : '';
  const forcedAgent = body.talkToAgent === true || AGENT_SOURCES.includes(source);
  const decision = M.Routing.decide({
    age, coverage, type, state, talkToAgent: forcedAgent,
    health: l.health === 'no' ? 'no' : l.health === 'yes' ? 'yes' : '',
    replacing: l.replacing === 'no' ? 'no' : l.replacing === 'yes' ? 'yes' : ''
  });

  const utm = body.utm || {};
  const notes = [
    l.goalLabel && 'Goal: ' + M.clean(l.goalLabel, 100),
    l.interest && 'Interested in: ' + M.clean(l.interest, 60),
    l.coverageLabel && !coverage && 'Coverage: ' + M.clean(l.coverageLabel, 60),
    body.review && 'Policy review answers: ' + Object.entries(body.review).map(([k, v]) => M.clean(k, 30) + ' = ' + M.clean(v, 80)).join('; '),
    utm.utm_term && 'UTM term: ' + M.clean(utm.utm_term),
    utm.utm_content && 'UTM content: ' + M.clean(utm.utm_content),
    utm.gclid && 'gclid: ' + M.clean(utm.gclid),
    utm.fbclid && 'fbclid: ' + M.clean(utm.fbclid),
    body.page && 'Page: ' + M.clean(body.page, 200)
  ].filter(Boolean).join('\n');

  const fields = {
    email, phone, state, age, coverage,
    type: TYPES[type] || '',
    path: M.CONFIG.pathLabels[decision.path],
    status: M.CONFIG.statusLabels[body.status === 'abandoned' ? 'abandoned' : 'new'],
    source, consent,
    utmSource: M.clean(utm.utm_source), utmMedium: M.clean(utm.utm_medium), utmCampaign: M.clean(utm.utm_campaign),
    goal: M.clean(l.goalLabel, 100),
    replacing: l.replacing === 'yes' ? 'Yes' : l.replacing === 'no' ? 'No' : '',
    bestTime: M.clean(body.bestTime, 60),
    reason: decision.path === 'agent' ? decision.reasons.join('; ') : '',
    notes
  };

  const itemId = await M.createItem(firstName + ' ' + lastName, fields);
  console.log('lead created', { itemId, source, path: decision.path });
  return M.json(200, { ok: true, itemId, token: M.sign(itemId), path: decision.path });
}

async function update(body) {
  if (!M.verify(body.itemId, body.token)) return M.json(403, { ok: false, error: 'Not allowed' });
  const fields = {};
  if (body.status === 'abandoned' || body.status === 'new') fields.status = M.CONFIG.statusLabels[body.status];
  if (body.bestTime) fields.bestTime = M.clean(body.bestTime, 60);
  if (body.path === 'agent') { fields.path = M.CONFIG.pathLabels.agent; fields.reason = 'Asked to talk to an agent'; fields.status = M.CONFIG.statusLabels.new; }
  await M.updateItem(body.itemId, fields);
  console.log('lead updated', { itemId: body.itemId, keys: Object.keys(fields) });
  return M.json(200, { ok: true });
}
