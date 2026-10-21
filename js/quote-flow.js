/*
 * Lifestone Life quote flow (browser side).
 * - Runs any quiz form marked with data-lq-steps (homepage hero card and the quote section)
 * - Validates each step, decides digital vs. agent with config/routing-rules.js
 * - Saves every lead through the Netlify "lead" function before moving on
 * - Remembers UTM parameters and retries leads that failed to send
 * Needs config/routing-rules.js loaded first.
 */
(function () {
  var LEAD_URL = '/.netlify/functions/lead';
  var CONSENT_VERSION = '2026-10-21';
  var CONSENT_TEXT = 'By checking this box, I agree to be contacted by Lifestone Life and its licensed agents at the number provided, including by calls and texts that may use automated technology. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out.';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];

  // ---------- small storage helpers (storage can be blocked, so never throw) ----------
  function read(store, key) { try { return JSON.parse(window[store].getItem(key)); } catch (e) { return null; } }
  function write(store, key, val) { try { window[store].setItem(key, JSON.stringify(val)); } catch (e) {} }
  function drop(store, key) { try { window[store].removeItem(key); } catch (e) {} }

  // ---------- UTM capture (latest campaign wins, kept for the visit) ----------
  function captureUtm() {
    var q = new URLSearchParams(location.search), found = {};
    UTM_KEYS.forEach(function (k) { if (q.get(k)) found[k] = q.get(k).slice(0, 200); });
    if (Object.keys(found).length) write('sessionStorage', 'lq_utm', found);
  }
  function getUtm() { return read('sessionStorage', 'lq_utm') || {}; }

  // ---------- sending ----------
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status); return j; }); });
  }
  // Tries twice; if it still fails, keeps the lead in this browser and retries on the next page load.
  function sendLead(body, url) {
    url = url || LEAD_URL;
    body.utm = body.utm || getUtm();
    body.page = body.page || location.pathname;
    return post(url, body).catch(function () { return post(url, body); }).catch(function () {
      var q = read('localStorage', 'lq_queue') || [];
      q.push({ url: url, body: body, at: Date.now() });
      write('localStorage', 'lq_queue', q.slice(-20));
      return null;
    });
  }
  function flushQueue() {
    var q = read('localStorage', 'lq_queue') || [];
    if (!q.length) return;
    drop('localStorage', 'lq_queue');
    q.forEach(function (item) {
      post(item.url, item.body).catch(function () {
        var again = read('localStorage', 'lq_queue') || [];
        again.push(item); write('localStorage', 'lq_queue', again.slice(-20));
      });
    });
  }
  // For page exits: keeps going after the page closes.
  function beacon(body, url) {
    url = url || LEAD_URL;
    body.utm = body.utm || getUtm();
    body.page = body.page || location.pathname;
    var data = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([data], { type: 'application/json' }))) return;
    try { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true }); } catch (e) {}
  }

  function consentRecord() { return { agreed: true, at: new Date().toISOString(), version: CONSENT_VERSION, text: CONSENT_TEXT }; }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function validPhone(s) { var d = digits(s); return d.length === 10 || (d.length === 11 && d[0] === '1'); }
  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }

  // ---------- quiz ----------
  function initQuiz(form, opts) {
    opts = opts || {};
    var R = window.LifestoneRouting;
    var steps = [].slice.call(form.querySelectorAll('[data-lq-step]'));
    var current = 0, sending = false;

    // Choice buttons write into a hidden input with the same name.
    form.querySelectorAll('[data-lq-choice]').forEach(function (group) {
      var name = group.getAttribute('data-lq-choice');
      var input = form.querySelector('input[type="hidden"][name="' + name + '"]');
      if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = name; group.appendChild(input); }
      group.querySelectorAll('[data-value]').forEach(function (btn) {
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', function (e) {
          group.querySelectorAll('[data-value]').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
          btn.setAttribute('aria-pressed', 'true');
          input.value = btn.getAttribute('data-value');
          input.setAttribute('data-label', btn.textContent.trim());
          var step = btn.closest('[data-lq-step]'), i = steps.indexOf(step);
          clearError(step);
          if (e.isTrusted && step.hasAttribute('data-lq-auto') && i < steps.length - 1 && !problem(step)) {
            setTimeout(function () { if (current === i) show(i + 1); }, 320);
          }
        });
      });
    });

    function errorBox(step) { return step.querySelector('[data-lq-error]'); }
    function clearError(step) { var b = errorBox(step); if (b) b.style.display = 'none'; step.querySelectorAll('[aria-invalid]').forEach(function (f) { f.removeAttribute('aria-invalid'); }); }
    function fail(step, field, msg) {
      var b = errorBox(step); if (b) { b.textContent = msg; b.style.display = 'block'; }
      if (field) { field.setAttribute('aria-invalid', 'true'); if (field.focus && field.type !== 'hidden') field.focus(); }
      return msg;
    }
    // Returns an error message for the step, or '' when it is complete.
    function problem(step, report) {
      var groups = step.querySelectorAll('[data-lq-choice][data-required]');
      for (var g = 0; g < groups.length; g++) {
        var hidden = form.querySelector('input[type="hidden"][name="' + groups[g].getAttribute('data-lq-choice') + '"]');
        if (!hidden || !hidden.value) return report ? fail(step, null, groups[g].getAttribute('data-msg') || 'Please choose one to continue.') : 'x';
      }
      var fields = step.querySelectorAll('input:not([type="hidden"]):not([data-hp]), select');
      for (var f = 0; f < fields.length; f++) {
        var el = fields[f], v = (el.value || '').trim(), msg = '';
        if (el.type === 'checkbox') { if (el.required && !el.checked) msg = el.getAttribute('data-msg') || 'Please check the box to continue.'; }
        else if (el.required && !v) msg = el.getAttribute('data-msg') || 'Please fill in this field.';
        else if (v && el.type === 'email' && !validEmail(v)) msg = 'Please enter a valid email address.';
        else if (v && el.name === 'phone' && !validPhone(v)) msg = 'Please enter a 10-digit phone number.';
        else if (v && el.name === 'dob') {
          var age = R.ageFromDob(v);
          if (age == null || age < 0 || age > 110) msg = 'Please enter a valid date of birth.';
          else if (age < 18) msg = 'You must be at least 18 to get a quote.';
        }
        else if (v && el.pattern && !new RegExp('^(?:' + el.pattern + ')$').test(v)) msg = el.getAttribute('data-msg-format') || 'Please check this field.';
        else if (v && el.type === 'number' && ((el.min !== '' && Number(v) < Number(el.min)) || (el.max !== '' && Number(v) > Number(el.max)))) msg = el.getAttribute('data-msg-format') || 'Please check this number.';
        else if (v && el.type === 'date' && el.name !== 'dob' && ((el.min && v < el.min) || (el.max && v > el.max))) msg = el.getAttribute('data-msg-format') || 'Please choose a date in the allowed range.';
        if (msg) return report ? fail(step, el, msg) : msg;
      }
      return '';
    }

    function show(i, initial) {
      current = i;
      steps.forEach(function (s, k) { s.hidden = k !== i; });
      if (opts.onStep) opts.onStep(i, steps.length);
      var h = steps[i].querySelector('[data-lq-focus]');
      if (h && !initial) h.focus({ preventScroll: true });
      if (opts.scrollTo) opts.scrollTo.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function answers() {
      var out = {}, fd = new FormData(form);
      fd.forEach(function (v, k) { if (typeof v === 'string') out[k] = v.trim(); });
      form.querySelectorAll('input[type="hidden"][data-label]').forEach(function (h) { out[h.name + '_label'] = h.getAttribute('data-label'); });
      form.querySelectorAll('select[name]').forEach(function (s) { if (s.selectedIndex > 0) out[s.name + '_label'] = s.options[s.selectedIndex].text; });
      return out;
    }

    // Saves what we have so far, for the "talk to someone" page.
    function savePartial() {
      var a = answers(); delete a.consent; delete a.website;
      a.source = form.getAttribute('data-source') || 'unknown';
      write('sessionStorage', 'lq_partial', a);
    }

    form.querySelectorAll('[data-lq-next]').forEach(function (b) {
      b.addEventListener('click', function () { var s = steps[current]; clearError(s); if (!problem(s, true)) show(current + 1); });
    });
    form.querySelectorAll('[data-lq-back]').forEach(function (b) {
      b.addEventListener('click', function () { if (current > 0) show(current - 1); });
    });
    form.querySelectorAll('[data-lq-talk]').forEach(function (a) { a.addEventListener('click', savePartial); });
    form.addEventListener('input', function (e) { var s = e.target.closest('[data-lq-step]'); if (s) clearError(s); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return;
      for (var i = 0; i < steps.length; i++) { clearError(steps[i]); if (problem(steps[i])) { show(i); problem(steps[i], true); return; } }
      var a = answers();
      var btn0 = form.querySelector('[type="submit"]'), label0 = btn0 ? btn0.innerHTML : '';
      // Pages like apply.html handle their own submit; return false from onSubmit to re-enable the form.
      if (opts.onSubmit) {
        sending = true; if (btn0) { btn0.disabled = true; btn0.textContent = 'Sending…'; }
        Promise.resolve(opts.onSubmit(a)).catch(function () { return false; }).then(function (ok) {
          if (ok === false) { sending = false; if (btn0) { btn0.disabled = false; btn0.innerHTML = label0; } }
        });
        return;
      }
      var lead = {
        firstName: a.first_name, lastName: a.last_name, email: a.email, phone: a.phone,
        state: a.state, dob: a.dob, coverage: Number(a.coverage) || null, coverageLabel: a.coverage_label,
        type: a.type, typeLabel: a.type_label, goal: a.goal, goalLabel: a.goal_label,
        health: a.health, replacing: a.replacing, interest: a.interest || ''
      };
      var decision = R.decide({ dob: lead.dob, coverage: lead.coverage, type: lead.type, health: lead.health, replacing: lead.replacing, state: lead.state });
      var consent = consentRecord();
      var btn = form.querySelector('[type="submit"]'), label = btn ? btn.innerHTML : '';
      sending = true; if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

      sendLead({ action: 'create', source: form.getAttribute('data-source') || 'homepage', lead: lead, consent: consent, hp: (form.querySelector('[data-hp]') || {}).value || '' })
        .then(function (res) {
          var path = (res && res.path) || decision.path;
          write('sessionStorage', 'lq_lead', {
            itemId: res && res.itemId, token: res && res.token, path: path, source: form.getAttribute('data-source'),
            firstName: lead.firstName, lastName: lead.lastName, email: lead.email, phone: lead.phone, state: lead.state,
            dob: lead.dob, coverage: lead.coverage, coverageLabel: lead.coverageLabel, type: lead.type, typeLabel: lead.typeLabel, consent: consent
          });
          drop('sessionStorage', 'lq_partial');
          location.href = path === 'digital' ? 'apply.html' : 'agent-callback.html';
        })
        .catch(function () { sending = false; if (btn) { btn.disabled = false; btn.innerHTML = label; } });
    });

    var api = {
      show: show,
      set: function (name, value) {
        var group = form.querySelector('[data-lq-choice="' + name + '"]');
        if (group) { var b = group.querySelector('[data-value="' + value + '"]'); if (b) b.click(); return; }
        var field = form.querySelector('[name="' + name + '"]'); if (field) field.value = value;
      },
      // Opens the first step that still needs an answer.
      goToFirstIncomplete: function () { for (var i = 0; i < steps.length; i++) { if (problem(steps[i])) { show(i); return; } } show(steps.length - 1); }
    };
    form.lq = api;
    show(0, true);
    return api;
  }

  captureUtm();
  flushQueue();

  window.LifestoneQuote = {
    initQuiz: initQuiz, sendLead: sendLead, beacon: beacon, flushQueue: flushQueue,
    getLead: function () { return read('sessionStorage', 'lq_lead'); },
    setLead: function (v) { write('sessionStorage', 'lq_lead', v); },
    getPartial: function () { return read('sessionStorage', 'lq_partial'); },
    consentRecord: consentRecord, CONSENT_TEXT: CONSENT_TEXT,
    validPhone: validPhone, validEmail: validEmail
  };
})();
