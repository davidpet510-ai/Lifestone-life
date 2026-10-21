/*
 * PLACEHOLDER LIMITS – confirm with Heartland/iGROUP carrier instant-decision rules.
 *
 * Decides whether a quote goes down the DIGITAL path (apply online) or the
 * AGENT path (a licensed agent calls). Change the numbers in RULES below;
 * nothing else needs to be touched. This one file is used by the website
 * (in the browser) and by the Netlify functions (on the server), so both
 * always agree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifestoneRouting = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var RULES = {
    minAge: 18,                 // youngest age allowed on the digital path
    maxAge: 60,                 // oldest age allowed on the digital path
    maxCoverage: 1000000,       // highest coverage amount (in dollars) on the digital path
    digitalTypes: ['term'],     // coverage types allowed on the digital path: 'term', 'universal', 'not_sure'
    healthAnswerMustBe: 'no',   // the health screen answer required for the digital path
    allowReplacement: false,    // true = people replacing a policy can still apply online
    digitalStates: null         // null = every state; or a list like ['FL', 'GA'] to limit the digital path
  };

  // Whole years between a YYYY-MM-DD date of birth and today.
  function ageFromDob(dob, today) {
    if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
    var p = dob.split('-').map(Number);
    var now = today || new Date();
    var age = now.getFullYear() - p[0];
    var m = now.getMonth() + 1 - p[1];
    if (m < 0 || (m === 0 && now.getDate() < p[2])) age--;
    return age;
  }

  /*
   * answers: { dob or age, coverage (number), type, health ('yes'/'no'),
   *            replacing ('yes'/'no'), state, talkToAgent (true/false) }
   * returns: { path: 'digital' | 'agent', reasons: [plain-English reasons for the agent path] }
   */
  function decide(answers) {
    var a = answers || {};
    if (a.talkToAgent) return { path: 'agent', reasons: ['Asked to talk to an agent'] };
    var reasons = [];
    var age = a.age != null && a.age !== '' ? Number(a.age) : ageFromDob(a.dob);
    var coverage = Number(a.coverage);

    if (age == null || isNaN(age)) reasons.push('Age missing');
    else if (age < RULES.minAge || age > RULES.maxAge) reasons.push('Age outside ' + RULES.minAge + '–' + RULES.maxAge);
    if (!coverage || isNaN(coverage)) reasons.push('Coverage amount missing');
    else if (coverage > RULES.maxCoverage) reasons.push('Coverage over $' + RULES.maxCoverage.toLocaleString('en-US'));
    if (RULES.digitalTypes.indexOf(a.type) === -1) reasons.push('Coverage type needs an agent');
    if (a.health !== RULES.healthAnswerMustBe) reasons.push('Health screen');
    if (!RULES.allowReplacement && a.replacing !== 'no') reasons.push('Replacing a policy');
    if (RULES.digitalStates && RULES.digitalStates.indexOf(a.state) === -1) reasons.push('State not on digital list');

    return { path: reasons.length ? 'agent' : 'digital', reasons: reasons };
  }

  return { RULES: RULES, decide: decide, ageFromDob: ageFromDob };
});
