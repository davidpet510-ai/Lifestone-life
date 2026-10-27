/*
 * Lead statuses, shared by the Netlify functions and the admin dashboard.
 * If you add a status here, also add it to the leads_status_check list in supabase/schema.sql.
 *
 * group decides which dashboard tab a lead shows under:
 *   inbox    needs someone to act
 *   working  an agent is on it
 *   won      approved or issued
 *   closed   finished without a policy (shown in the dashboard's Archive)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifestoneStatuses = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var STATUSES = [
    { key: 'new',           label: 'New',                       group: 'inbox' },
    { key: 'contacted',     label: 'Contacted',                 group: 'working' },
    { key: 'quoted',        label: 'Quoted',                    group: 'working' },
    { key: 'app_submitted', label: 'Application submitted',     group: 'working' },
    { key: 'approved',      label: 'Approved',                  group: 'won' },
    { key: 'issued',        label: 'Policy issued',             group: 'won' },
    { key: 'declined',      label: 'Declined',                  group: 'closed' },
    { key: 'unreachable',   label: 'Unable to reach',           group: 'closed' },
    { key: 'not_interested',label: 'Not interested',            group: 'closed' },
    { key: 'bought_elsewhere', label: 'Bought elsewhere',       group: 'closed' },
    { key: 'duplicate',     label: 'Duplicate / test',          group: 'closed' }
  ];

  var byKey = {};
  STATUSES.forEach(function (s) { byKey[s.key] = s; });

  return {
    STATUSES: STATUSES,
    label: function (key) { return byKey[key] ? byKey[key].label : key; },
    group: function (key) { return byKey[key] ? byKey[key].group : 'inbox'; },
    isValid: function (key) { return !!byKey[key]; }
  };
});
