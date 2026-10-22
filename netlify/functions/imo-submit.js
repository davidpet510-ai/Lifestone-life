/*
 * POST /.netlify/functions/imo-submit
 * Receives the online application from /apply.html.
 *
 * PLACEHOLDER: there is no IMO/carrier API connected yet. For now it:
 *   1. checks the application and strips anything that must never be handled here (SSN, bank, card)
 *   2. logs a redacted summary (field names only, never answers)
 *   3. returns { status: 'pending_manual' } and marks the lead
 *      "Application submitted" so an agent finishes it with the carrier.
 *
 * Body: { itemId, token, contact: {firstName, lastName, email, phone, state, dob, coverage, type}, consent, application: {...} }
 *
 * Only NON-health details (beneficiary, start date, city/state) are saved to the CRM.
 * Height, weight, tobacco, driving and activity answers are only for the carrier.
 */
const C = require('../lib/common.js');
const db = require('../lib/db.js');
const alerts = require('../lib/alerts.js');

const FORBIDDEN = /ssn|social|tax.?id|bank|routing|account|card|cvv|iban/i;
const REQUIRED = ['firstName', 'lastName', 'dob', 'gender', 'address', 'city', 'state', 'zip',
  'heightFt', 'heightIn', 'weight', 'tobacco', 'dui', 'violations', 'hazardous', 'beneficiaryName', 'beneficiaryRelationship', 'startDate'];

exports.handler = async (event) => {
  const { body, error } = C.parseBody(event);
  if (error) return error;
  if (body.hp) return C.json(200, { ok: true, status: 'pending_manual' });

  // 1. Never accept SSN / bank / card fields, even if something sends them.
  const app = {};
  for (const [k, v] of Object.entries(body.application || {})) {
    if (FORBIDDEN.test(k)) continue;
    app[k] = C.clean(String(v), 200);
  }
  const missing = REQUIRED.filter((k) => !app[k]);
  if (missing.length) return C.json(400, { ok: false, error: 'Missing: ' + missing.join(', ') });

  // 2. Redacted log: which fields arrived, never their values.
  console.log('imo-submit received', { itemId: body.itemId || null, fields: Object.keys(app) });

  try {
    // 3. Send to the carrier (placeholder for now).
    const result = await submitToCarrier(app, body.contact || {});

    // 4. Record the outcome on the lead.
    let leadId = C.verify(body.itemId, body.token) ? body.itemId : null;
    if (leadId && !(await db.getLead(leadId))) leadId = null;
    if (!leadId) leadId = await createLeadFromApplication(app, body);
    await recordResult(leadId, result, app);

    return C.json(200, { ok: true, status: result.status });
  } catch (e) {
    console.error('imo-submit error:', e.code || '', e.message);
    return C.json(e.code === 'CONFIG' ? 500 : 502, { ok: false, error: 'Could not submit right now' });
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
 * applicant sees next (e.g. send ?decision=approved to /thank-you.html).
 */
async function recordResult(leadId, result, app) {
  const STATUS = { approved: 'approved', referred: 'referred', declined: 'declined' };
  const status = STATUS[result.status] || 'app_submitted';   // pending_manual: an agent submits it with the carrier
  const before = await db.getLead(leadId);
  const application = {
    received_at: new Date().toISOString(),
    carrier_result: result.status,
    coverage_start: app.startDate,
    beneficiary: app.beneficiaryName,
    beneficiary_relationship: app.beneficiaryRelationship,
    address: app.address,
    city: app.city,
    state: app.state,
    zip: app.zip,
    gender: app.gender,
    note: 'Health and lifestyle answers are not stored here. Get them from the applicant or carrier.'
  };
  const lead = await db.updateLead(leadId, { status, path: 'digital', application });
  await db.addEvent(leadId, 'application', 'Online application submitted. Carrier result: ' + result.status, { result: result.status });
  if (before && before.status !== status) await db.addEvent(leadId, 'status', null, { from: before.status, to: status, by: 'website' });

  const recipients = await db.activeAdmins();
  if (lead.assigned_to) recipients.push(await db.getProfile(lead.assigned_to));
  const seen = new Set();
  await alerts.application(recipients.filter((p) => p && !seen.has(p.id) && seen.add(p.id)), lead, result.status);
}

// Used only if the quiz lead never reached the CRM (e.g. the network failed earlier).
async function createLeadFromApplication(app, body) {
  const c = body.contact || {};
  const email = C.clean(c.email, 200).toLowerCase();
  const lead = await db.insertLead(Object.assign({
    first_name: app.firstName,
    last_name: app.lastName,
    email: C.isEmail(email) ? email : '',
    phone: C.phone11(c.phone) || '',
    state: app.state,
    age: C.Routing.ageFromDob(app.dob),
    coverage: Number(c.coverage) || null,
    coverage_type: C.clean(c.typeLabel, 40),
    path: 'digital',
    status: 'new',
    source: 'apply'
  }, C.consentFields(body.consent) || {}));
  await db.addEvent(lead.id, 'created', null, { source: 'apply', path: 'digital' });
  return lead.id;
}
