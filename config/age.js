/*
 * Age from a date of birth, shared by the website (in the browser) and the Netlify functions.
 * Every lead goes to a licensed agent, so there is no online-vs-agent routing anymore.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifestoneAge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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
  return { ageFromDob: ageFromDob };
});
