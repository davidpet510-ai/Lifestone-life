/*
 * Monday.com board columns used by the Netlify functions.
 * `id` must match the column ID on your board exactly.
 * Run `node scripts/setup-monday-board.js` once to create all of these on the board
 * with these exact IDs. If you create columns by hand instead, Monday gives them its
 * own IDs: copy each one here (column menu → "Column ID" when Developer Mode is on).
 *
 * Never add columns for SSN, bank/card details or detailed health answers.
 */
module.exports = {
  columns: {
    email:       { id: 'lead_email',     type: 'email',     title: 'Email' },
    phone:       { id: 'lead_phone',     type: 'phone',     title: 'Phone' },
    state:       { id: 'lead_state',     type: 'text',      title: 'State' },
    age:         { id: 'lead_age',       type: 'numbers',   title: 'Age' },
    coverage:    { id: 'lead_coverage',  type: 'numbers',   title: 'Coverage amount' },
    type:        { id: 'lead_type',      type: 'text',      title: 'Coverage type' },
    path:        { id: 'lead_path',      type: 'status',    title: 'Path' },
    status:      { id: 'lead_status',    type: 'status',    title: 'Status' },
    source:      { id: 'lead_source',    type: 'text',      title: 'Source page' },
    consent:     { id: 'lead_consent',   type: 'text',      title: 'Consent' },
    utmSource:   { id: 'utm_source',     type: 'text',      title: 'UTM source' },
    utmMedium:   { id: 'utm_medium',     type: 'text',      title: 'UTM medium' },
    utmCampaign: { id: 'utm_campaign',   type: 'text',      title: 'UTM campaign' },
    goal:        { id: 'lead_goal',      type: 'text',      title: 'Goal' },
    replacing:   { id: 'lead_replacing', type: 'text',      title: 'Replacing a policy' },
    bestTime:    { id: 'lead_best_time', type: 'text',      title: 'Best time to call' },
    reason:      { id: 'lead_reason',    type: 'text',      title: 'Why agent path' },
    application: { id: 'lead_app',       type: 'long_text', title: 'Application summary' },
    notes:       { id: 'lead_notes',     type: 'long_text', title: 'Notes' }
  },

  // Labels written to the status columns (Monday adds any that are missing).
  pathLabels: { digital: 'Digital', agent: 'Agent' },
  statusLabels: {
    new: 'New',
    abandoned: 'Abandoned – agent follow up',
    pending_manual: 'Application submitted – manual review',
    approved: 'Approved',
    referred: 'Referred – agent follow up',
    declined: 'Declined – agent follow up'
  }
};
