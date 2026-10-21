/*
 * POST /.netlify/functions/imo-submit
 * Receives the online application from /apply.html.
 *
 * PLACEHOLDER: there is no IMO/carrier API connected yet. For now it:
 *   1. checks the application and strips anything that must never be handled here (SSN, bank, card)
 *   2. logs a redacted summary (field names only, never answers)
 *   3. returns { status: 'pending_manual' } and marks the Monday item
 *      "Application submitted – manual review" so an agent finishes it with the carrier.
 *
 * Body: { itemId, token, contact: {firstName, lastName, email, phone, state, dob, coverage, type}, consent, application: {...} }
 *
 * Only NON-health details (beneficiary, start date, city/state) go to Monday.
 * Height, weight, tobacco, driving and activity answers are only for the carrier.
 */
const M = require('../lib/monday.js');

const FORBIDDEN = /ssn|social|tax.?id|bank|routing|account|card|cvv|iban/i;
const REQUIRED = ['firstName', 'lastName', 'dob', 'gender', 'address', 'city', 'state', 'zip',
  'heightFt', 'heightIn', 'weight', 'tobacco', 'dui', 'violations', 'hazardous', 'beneficiaryName', 'beneficiaryRelationship', 'startDate'];

exports.handler = async (event) => {
  const { body, error } = M.parseBody(event);
  if (error) return error;
  if (body.hp) return M.json(200, { ok: true, status: 'pending_manual' });

  // 1. Never accept SSN / bank / card fields, even if something sends them.
  const app = {};
  for (const [k, v] of Object.entries(body.application || {})) {
    if (FORBIDDEN.test(k)) continue;
    app[k] = M.clean(String(v), 200);
  }
  const missing = REQUIRED.filter((k) => !app[k]);
  if (missing.length) return M.json(400, { ok: false, error: 'Missing: ' + missing.join(', ') });

  // 2. Redacted log: which fields arrived, never their values.
  console.log('imo-submit received', { itemId: body.itemId || null, fields: Object.keys(app) });

  try {
    // 3. Send to the carrier (placeholder for now).
    const result = await submitToCarrier(app, body.contact || {});

    // 4. Record the outcome on the Monday item.
    let itemId = M.verify(body.itemId, body.token) ? body.itemId : null;
    if (!itemId) itemId = await createLeadFromApplication(app, body);
    await recordResult(itemId, result, app);

    return M.json(200, { ok: true, status: result.status });
  } catch (e) {
    console.error('imo-submit error:', e.code || '', e.message);
    return M.json(e.code === 'CONFIG' ? 500 : 502, { ok: false, error: 'Could not submit right now' });
  }
};

/*
 * TODO (IMO/carrier API): replace the body of this function with the real call.
 *   - Read credentials from env vars (e.g. IMO_API_URL, IMO_API_KEY). Never hard-code them.
 *   - Map `app` + `contact` to the carrier's application format.
 *   - The carrier, not this site, collects SSN, payment and e-signature through its own secure link.
 *   - Return one of:
 *       { status: 'approved',  policyNumber, premium }  instant approval
 *       { status: 'referred',  reason }                 needs underwriting review / agent
 *       { status: 'declined',  reason }                 not eligible online
 *       { status: 'pending_manual' }                    no decision yet (current placeholder)
 */
async function submitToCarrier(app, contact) { // eslint-disable-line no-unused-vars
  return { status: 'pending_manual' };
}

/*
 * TODO (IMO/carrier API): when real decisions come back, also decide what the
 * applicant sees next (e.g. send ?decision=approved to /thank-you.html) and
 * whether to alert an agent right away for referred/declined.
 */
async function recordResult(itemId, result, app) {
  const labels = M.CONFIG.statusLabels;
  let status;
  switch (result.status) {
    case 'approved': status = labels.approved; break;            // TODO: store policy number/premium in their own columns if wanted
    case 'referred': status = labels.referred; break;            // TODO: notify the assigned agent
    case 'declined': status = labels.declined; break;            // TODO: notify the assigned agent to offer other options
    default: status = labels.pending_manual;                     // placeholder path: an agent submits it manually
  }
  const summary = [
    'Online application received ' + new Date().toISOString(),
    'Coverage start date: ' + app.startDate,
    'Beneficiary: ' + app.beneficiaryName + ' (' + app.beneficiaryRelationship + ')',
    'Address: ' + app.city + ', ' + app.state + ' ' + app.zip,
    'Carrier result: ' + result.status,
    'Health and lifestyle answers are not stored here. Get them from the applicant or carrier.'
  ].join('\n');
  await M.updateItem(itemId, { status, path: M.CONFIG.pathLabels.digital, application: summary });
}

// Used only if the quiz lead never reached Monday (e.g. the network failed earlier).
async function createLeadFromApplication(app, body) {
  const c = body.contact || {};
  const phone = M.phoneE164(c.phone);
  const email = M.clean(c.email, 200).toLowerCase();
  return M.createItem(app.firstName + ' ' + app.lastName, {
    email: M.isEmail(email) ? email : '',
    phone: phone || '',
    state: app.state,
    age: M.Routing.ageFromDob(app.dob),
    coverage: Number(c.coverage) || null,
    type: M.clean(c.typeLabel, 40),
    path: M.CONFIG.pathLabels.digital,
    status: M.CONFIG.statusLabels.new,
    source: 'apply',
    consent: M.consentText(body.consent)
  });
}
