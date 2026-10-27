/*
 * Lifestone CRM dashboard (/admin).
 *
 * Talks to Supabase directly from the browser with the public anon key. What each person
 * can see is enforced by the database (supabase/schema.sql), not by this file:
 *   admins see every lead; agents see only leads assigned to them; nothing loads
 *   until two-step verification is done.
 *
 * Routes: #/home, #/leads, #/lead/<id>, #/tasks, #/policies, #/reports, #/archive, #/team (admins), #/settings
 */
(function () {
  'use strict';

  var S = window.LifestoneStatuses;
  var IDLE_MINUTES = 60;          // sign out after this long without activity (unless "keep me signed in")
  var REMEMBER_DAYS = 30;         // "keep me signed in" lasts this long, then sign in once more
  var REMEMBER_KEY = 'lq_crm_remember';

  // "Keep me signed in": when on, the login is kept in this browser (localStorage) for up to
  // REMEMBER_DAYS with no idle sign-out. When off, it lives only until the browser closes
  // (sessionStorage) and the idle sign-out applies.
  function remembered() { var until = Number(savedPref(REMEMBER_KEY, '0')); return until > Date.now(); }
  function setRemember(on) {
    try {
      if (on) localStorage.setItem(REMEMBER_KEY, String(Date.now() + REMEMBER_DAYS * 86400000));
      else localStorage.removeItem(REMEMBER_KEY);
    } catch (e) { /* storage blocked: falls back to a browser-session login */ }
  }
  var sessionStore = {
    getItem: function (k) {
      try { return (remembered() ? localStorage : sessionStorage).getItem(k); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try {
        var keep = remembered();
        (keep ? localStorage : sessionStorage).setItem(k, v);
        (keep ? sessionStorage : localStorage).removeItem(k);
      } catch (e) { /* ignore */ }
    },
    removeItem: function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
      try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ }
    }
  };
  var REFRESH_SECONDS = 45;       // how often the lead list checks for new leads
  var LEAD_LIMIT = 2000;
  var REQUEST_TIMEOUT = 20000;    // give up on a database request after 20 seconds
  var SLOW_MSG = 'The database is responding slowly right now. This is usually a short Supabase hiccup. Try again in a minute.';

  // Adds a time limit to a Supabase query so a slow server can't leave the page hanging.
  function timed(query) {
    return (typeof query.abortSignal === 'function' && window.AbortSignal && AbortSignal.timeout) ? query.abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT)) : query;
  }

  var sb = null;                  // Supabase client
  var me = null;                  // my profile row
  var team = [];                  // all profiles I can see
  var leads = [];                 // leads I can see
  var tasks = [];                 // open tasks (and ones done in the last 30 days) I can see
  var policies = [];              // policies on leads I can see
  var leadsLoadedAt = 0;
  var view = { q: '', path: '', agent: '', temp: '', fu: '', tag: '', mode: savedPref('lq_crm_view', 'board') };
  var selected = {};              // leads ticked in the list view, for bulk changes
  var archiveQ = '';
  var dragging = false;
  var refreshTimer = null;

  // Capture what kind of email link brought us here before Supabase reads (and clears) the URL.
  var hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  var linkType = hashParams.get('type');                 // invite | recovery | magiclink | signup
  var linkError = hashParams.get('error_description');

  // Per-person view preferences (list or board). Safe if storage is blocked.
  function savedPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
  function savePref(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } }

  // ---------- small helpers ----------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function phone10(p) { var d = digits(p); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; }
  function fmtPhone(p) { var d = phone10(p); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || ''); }
  function money(n) { return n ? '$' + Number(n).toLocaleString('en-US') : ''; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function ago(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function personName(id) {
    var p = team.find(function (t) { return t.id === id; });
    return p ? (p.full_name || p.email) : '';
  }
  function isAdmin() { return me && me.role === 'admin'; }
  var SOURCE_NAMES = { 'homepage-hero': 'Homepage quiz', 'homepage-quote': 'Quote form', 'policy-review': 'Policy review', 'agent-callback': 'Callback request', import: 'Imported' };
  function statusChip(key) { return '<span class="chip chip-' + esc(S.group(key)) + '">' + esc(S.label(key)) + '</span>'; }
  function niceError(err) {
    var m = (err && (err.message || err.error_description)) || String(err || 'Something went wrong');
    if (/abort|timed? ?out|timeout|52[0-9]|upstream|gateway/i.test(m) || (err && err.name === 'AbortError')) return SLOW_MSG;
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Can’t reach the server. Check your connection and try again.';
    return m;
  }

  var toastTimer;
  function toast(msg, kind) {
    var t = $('#ad-toast');
    t.textContent = msg;
    t.className = 'ad-toast' + (kind ? ' ad-toast-' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }

  function render(html) {
    var main = $('#ad-main');
    main.innerHTML = html;
    return main;
  }

  function setTop(visible) {
    $('#ad-top').hidden = !visible;
    if (!visible) return;
    $('#ad-me-name').textContent = (me.full_name || me.email) + (isAdmin() ? ' · Admin' : '');
    $$('[data-admin]').forEach(function (el) { el.hidden = !isAdmin(); });
  }

  function markNav(name) {
    $$('.ad-nav a').forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-nav') === name); });
  }

  // ---------- startup ----------
  async function boot() {
    var cfg;
    try {
      var res = await fetch('/.netlify/functions/admin?action=config', { cache: 'no-store' });
      cfg = await res.json();
      if (!cfg.ok) throw new Error(cfg.error || 'Setup incomplete');
    } catch (e) {
      render(card('Dashboard not set up yet',
        '<p>The dashboard can’t find its database settings. Add <code>SUPABASE_URL</code>, <code>SUPABASE_ANON_KEY</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> in Netlify, then redeploy.</p>'));
      return;
    }
    // "Keep me signed in" ran out: remove the saved login so it can't be reused.
    if (savedPref(REMEMBER_KEY, '') && !remembered()) {
      try {
        Object.keys(localStorage).forEach(function (k) { if (/^sb-.*-auth-token/.test(k)) localStorage.removeItem(k); });
        localStorage.removeItem(REMEMBER_KEY);
      } catch (e) { /* ignore */ }
    }
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storage: sessionStore }
    });
    sb.auth.onAuthStateChange(function (event) {
      if (event === 'PASSWORD_RECOVERY') linkType = 'recovery';
      if (event === 'SIGNED_OUT') { me = null; showLogin(); }
    });
    window.addEventListener('hashchange', route);
    $('#ad-signout').addEventListener('click', signOut);
    initGlobalSearch();
    watchIdle();
    setInterval(checkDueTasks, 60000);
    await gate();
  }

  // Decides which screen to show: login → set password → two-step → app.
  // Only one runs at a time, so repeated clicks can't stack up requests.
  var gating = null;
  function gate() {
    if (gating) return gating;
    gating = gateOnce().catch(function (e) { showRetry(niceError(e)); }).then(function () { gating = null; });
    return gating;
  }
  async function gateOnce() {
    var sess = (await sb.auth.getSession()).data.session;
    if (linkError) { var m = linkError; linkError = null; history.replaceState(null, '', '#/'); return showLinkProblem(m); }
    if (!sess) return showLogin();
    if (linkType === 'invite' || linkType === 'recovery') return showSetPassword(linkType);

    var aal = (await sb.auth.mfa.getAuthenticatorAssuranceLevel()).data;
    if (!aal || aal.currentLevel !== 'aal2') {
      var factors = (await sb.auth.mfa.listFactors()).data || {};
      var verified = (factors.totp || []).filter(function (f) { return f.status === 'verified'; });
      return verified.length ? showMfaChallenge(verified[0]) : showMfaEnroll();
    }

    setTop(false);
    render(card('Signing you in…', '<div class="ad-loading">Loading your dashboard…</div>'));
    var prof = await timed(sb.from('profiles').select('*').eq('id', sess.user.id)).maybeSingle();
    if (prof.error) return showRetry(niceError(prof.error));
    if (!prof.data) return showBlocked('We couldn’t find your profile. Ask an admin to check your account.');
    if (!prof.data.active) return showBlocked('Your account is turned off. Ask an admin to turn it back on.');
    me = prof.data;
    try { await loadTeam(); } catch (e) { me = null; return showRetry(niceError(e)); }
    setTop(true);
    if (!location.hash || location.hash === '#/' || location.hash.indexOf('access_token') !== -1) history.replaceState(null, '', '#/home');
    route();
  }

  async function signOut() {
    stopRefresh();
    await sb.auth.signOut();
    setRemember(false);
    me = null; leads = []; team = []; tasks = []; policies = []; templates = null;
    history.replaceState(null, '', '#/');
    showLogin();
  }

  function watchIdle() {
    var last = Date.now();
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(function (ev) {
      window.addEventListener(ev, function () { last = Date.now(); }, { passive: true });
    });
    setInterval(function () {
      if (me && !remembered() && Date.now() - last > IDLE_MINUTES * 60000) {
        signOut().then(function () { toast('Signed out after ' + IDLE_MINUTES + ' minutes without activity.'); });
      }
    }, 30000);
  }

  // ---------- search everything (top bar) ----------
  // Leads (active and archived) are searched from what's already loaded; files and notes
  // are looked up in the database. Each person only ever gets results they're allowed to see.
  var gsTimer = null, gsSeq = 0;

  function initGlobalSearch() {
    var input = $('#gs-input'), box = $('#gs-results');
    input.addEventListener('focus', function () { if (me && !leads.length) loadLeads().catch(function () {}); });
    input.addEventListener('input', function () {
      clearTimeout(gsTimer);
      gsTimer = setTimeout(function () { runSearch(input.value); }, 180);
    });
    input.addEventListener('keydown', function (e) {
      var items = $$('.gs-item', box), cur = items.indexOf($('.gs-item.on', box));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        var next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur <= 0 ? items.length - 1 : cur - 1);
        items.forEach(function (it, i) { it.classList.toggle('on', i === next); it.setAttribute('aria-selected', i === next ? 'true' : 'false'); });
        items[next].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        var pick = $('.gs-item.on', box) || items[0];
        if (pick) { e.preventDefault(); goSearch(pick.getAttribute('href')); }
      } else if (e.key === 'Escape') {
        closeSearch(true);
      }
    });
    box.addEventListener('click', function (e) {
      var a = e.target.closest('.gs-item');
      if (a) { e.preventDefault(); goSearch(a.getAttribute('href')); }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('#gs')) closeSearch(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && me && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  function goSearch(href) {
    closeSearch(true);
    $('#gs-input').blur();
    if (location.hash === href) route(); else location.hash = href;
  }

  function closeSearch(clear) {
    var input = $('#gs-input'), box = $('#gs-results');
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    if (clear) input.value = '';
  }

  function hit(text, q) { return String(text || '').toLowerCase().indexOf(q) !== -1; }
  function likePattern(q) { return '%' + q.replace(/[\\%_]/g, function (c) { return '\\' + c; }) + '%'; }
  function mark(text, q) {
    var t = String(text || ''), i = t.toLowerCase().indexOf(q);
    if (!q || i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }

  async function runSearch(raw) {
    var q = raw.trim().toLowerCase(), qd = digits(q), box = $('#gs-results'), input = $('#gs-input');
    var seq = ++gsSeq;
    if (q.length < 2) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }

    var leadHits = leads.filter(function (l) {
      return hit(l.first_name + ' ' + l.last_name, q) || hit(l.email, q) || (qd.length >= 3 && digits(l.phone).indexOf(qd) !== -1) ||
        (q.length === 2 && (l.state || '').toLowerCase() === q);
    });
    var active = leadHits.filter(function (l) { return !isArchived(l); }).slice(0, 6);
    var archived = leadHits.filter(isArchived).slice(0, 4);
    var people = isAdmin() ? team.filter(function (p) { return hit(p.full_name, q) || hit(p.email, q); }).slice(0, 3) : [];
    var polHits = policies.filter(function (p) { return hit(p.policy_number, q) || hit(p.carrier, q); }).slice(0, 4);
    var taskHits = openTasks().filter(function (x) { return hit(x.title, q); }).slice(0, 4);
    draw([], []);   // show lead results right away, files and notes fill in after

    var pat = likePattern(raw.trim());
    var res = await Promise.all([
      sb.from('lead_files').select('id,lead_id,name,created_at').ilike('name', pat).order('created_at', { ascending: false }).limit(5),
      sb.from('lead_events').select('id,lead_id,body,created_at').eq('kind', 'note').ilike('body', pat).order('created_at', { ascending: false }).limit(5)
    ]).catch(function () { return [{}, {}]; });
    if (seq !== gsSeq) return;   // a newer search already started
    draw((res[0] && res[0].data) || [], (res[1] && res[1].data) || []);

    function leadName(id) { var l = leads.find(function (x) { return x.id === id; }); return l ? l.first_name + ' ' + l.last_name : 'a lead'; }
    function item(href, main, sub) { return '<a class="gs-item" role="option" aria-selected="false" href="' + esc(href) + '"><span class="gs-main">' + main + '</span>' + (sub ? '<span class="gs-sub">' + sub + '</span>' : '') + '</a>'; }
    function group(title, html) { return html ? '<div class="gs-group"><p class="gs-title">' + esc(title) + '</p>' + html + '</div>' : ''; }

    function draw(files, notes) {
      var html =
        group('Leads', active.map(function (l) {
          return item('#/lead/' + l.id, mark(l.first_name + ' ' + l.last_name, q), esc(S.label(l.status)) + ' · ' + esc(fmtPhone(l.phone)) + (l.state ? ' · ' + esc(l.state) : ''));
        }).join('')) +
        group('Archived', archived.map(function (l) {
          return item('#/lead/' + l.id, mark(l.first_name + ' ' + l.last_name, q), esc(S.label(l.status)) + ' · ' + esc(fmtPhone(l.phone)));
        }).join('')) +
        group('Policies', polHits.map(function (p) {
          return item('#/lead/' + p.lead_id, mark(p.carrier + (p.policy_number ? ' · #' + p.policy_number : ''), q), esc(pStatus(p.status).label) + ' · ' + esc(leadName(p.lead_id)));
        }).join('')) +
        group('Tasks', taskHits.map(function (x) {
          return item(x.lead_id ? '#/lead/' + x.lead_id : '#/tasks', mark(x.title, q), esc(dueText(x.due_at)));
        }).join('')) +
        group('Files', files.map(function (f) {
          return item('#/lead/' + f.lead_id, mark(f.name, q), 'on ' + esc(leadName(f.lead_id)) + ' · ' + esc(ago(f.created_at)));
        }).join('')) +
        group('Notes', notes.map(function (n) {
          var body = String(n.body || ''), i = body.toLowerCase().indexOf(q), start = Math.max(0, i - 30);
          var snip = (start ? '…' : '') + body.slice(start, start + 90) + (body.length > start + 90 ? '…' : '');
          return item('#/lead/' + n.lead_id, mark(snip, q), 'note on ' + esc(leadName(n.lead_id)) + ' · ' + esc(ago(n.created_at)));
        }).join('')) +
        group('Team', people.map(function (p) {
          return item('#/team', mark(p.full_name || p.email, q), esc(p.role === 'admin' ? 'Admin' : 'Agent') + ' · ' + esc(p.email));
        }).join(''));
      box.innerHTML = html || '<p class="gs-none">No matches for “' + esc(raw.trim()) + '”.</p>';
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      var first = $('.gs-item', box);
      if (first) { first.classList.add('on'); first.setAttribute('aria-selected', 'true'); }
    }
  }

  // ---------- auth screens ----------
  function card(title, inner, sub) {
    return '<section class="auth"><div class="auth-card">' +
      '<div class="auth-brand"><img src="/images/logo.png" width="44" height="40" alt=""><span><b>Lifestone</b><small>CRM</small></span></div>' +
      '<h1>' + esc(title) + '</h1>' + (sub ? '<p class="auth-sub">' + sub + '</p>' : '') + inner + '</div></section>';
  }

  function formError(form, msg) {
    var e = $('.form-error', form);
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function showLogin(message) {
    stopRefresh();
    setTop(false);
    var main = render(card('Sign in', '' +
      '<form id="f-login" novalidate>' +
      '<label class="fld">Email<input name="email" type="email" autocomplete="username" required></label>' +
      '<label class="fld">Password<input name="password" type="password" autocomplete="current-password" required></label>' +
      '<label class="check remember"><input type="checkbox" name="remember" checked> Keep me signed in on this device for ' + REMEMBER_DAYS + ' days</label>' +
      '<p class="hint remember-hint">Untick on shared or public computers.</p>' +
      '<p class="form-error" role="alert"' + (message ? '' : ' hidden') + '>' + esc(message || '') + '</p>' +
      '<button class="btn btn-primary btn-wide" type="submit">Sign in</button>' +
      '<button class="ad-link-btn auth-alt" type="button" id="forgot">Forgot your password?</button>' +
      '</form>', 'For Lifestone team members only.'));
    var f = $('#f-login', main);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', f);
      formError(f, '');
      if (!f.email.value || !f.password.value) return formError(f, 'Enter your email and password.');
      busy(btn, true, 'Signing in…');
      setRemember(f.remember.checked);   // decides where the login is stored, so it must come first
      var r = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      busy(btn, false);
      if (r.error) return formError(f, /invalid/i.test(r.error.message) ? 'That email and password don’t match.' : niceError(r.error));
      gate();
    });
    $('#forgot', main).addEventListener('click', async function () {
      var email = f.email.value.trim();
      if (!email) return formError(f, 'Type your email above first, then tap “Forgot your password?”');
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/admin/' });
      if (r.error) return formError(f, niceError(r.error));
      formError(f, '');
      toast('If that email has an account, a reset link is on its way.');
    });
    f.email.focus();
  }

  // An invite or reset link that expired or was already used.
  function showLinkProblem(detail) {
    stopRefresh();
    setTop(false);
    var main = render(card('This link has expired', '' +
      '<p>For security, setup links only work for a limited time and only once' + (/expired|invalid/i.test(detail) ? '' : ' (' + esc(detail) + ')') + '.</p>' +
      '<p>Enter your email and we’ll send you a fresh link to set your password.</p>' +
      '<form id="f-relink" novalidate>' +
      '<label class="fld">Email<input name="email" type="email" autocomplete="email" required></label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn btn-primary btn-wide" type="submit">Email me a new link</button>' +
      '<button class="ad-link-btn auth-alt" type="button" id="have-pw">I already have a password</button></form>',
      'No problem, it only takes a minute.'));
    var f = $('#f-relink', main);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      var email = f.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return formError(f, 'Enter the email address your invite was sent to.');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Sending…');
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/admin/' });
      busy(btn, false);
      if (r.error) return formError(f, /rate|seconds|too many/i.test(r.error.message) ? 'A link was just sent. Wait a minute, then try again.' : niceError(r.error));
      render(card('Check your email', '<p>If <b>' + esc(email) + '</b> has a Lifestone account, a new link is on its way. Open it within the hour and you’ll be able to set your password.</p>' +
        '<p class="hint">Don’t see it? Check spam, or ask your admin to tap “Resend invite” on the Team page.</p>'));
    });
    $('#have-pw', main).addEventListener('click', function () { showLogin(); });
  }

  function showSetPassword(kind) {
    setTop(false);
    var main = render(card(kind === 'invite' ? 'Welcome to Lifestone' : 'Set your password', '' +
      '<form id="f-pass" novalidate>' +
      (kind === 'invite' ? '<label class="fld">Your name<input name="full_name" autocomplete="name" required></label>' : '') +
      '<label class="fld">New password<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>' +
      '<label class="fld">Type it again<input name="password2" type="password" autocomplete="new-password" required></label>' +
      '<p class="hint">At least 10 characters.</p>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn btn-primary btn-wide" type="submit">Save password</button></form>',
      kind === 'invite' ? 'Set a password to finish your account. Next you’ll turn on two-step verification.' : ''));
    var f = $('#f-pass', main);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      if (f.password.value.length < 10) return formError(f, 'Use at least 10 characters.');
      if (f.password.value !== f.password2.value) return formError(f, 'The two passwords don’t match.');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Saving…');
      var upd = { password: f.password.value };
      if (f.full_name && f.full_name.value.trim()) upd.data = { full_name: f.full_name.value.trim() };
      var r = await sb.auth.updateUser(upd);
      busy(btn, false);
      if (r.error) return formError(f, niceError(r.error));
      linkType = null;
      history.replaceState(null, '', '#/');
      toast('Password saved.', 'ok');
      gate();
    });
  }

  async function showMfaEnroll() {
    setTop(false);
    render(card('Turn on two-step verification', '<div class="ad-loading">Preparing…</div>'));
    // Clear any half-finished setup from an earlier visit.
    var all = ((await sb.auth.mfa.listFactors()).data || {}).all || [];
    for (var i = 0; i < all.length; i++) if (all[i].status === 'unverified') await sb.auth.mfa.unenroll({ factorId: all[i].id });
    var en = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator ' + new Date().toISOString().slice(0, 16) });
    if (en.error) return showBlocked(niceError(en.error));
    var main = render(card('Turn on two-step verification', '' +
      '<ol class="steps">' +
      '<li>Install an authenticator app on your phone, like <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> or <b>1Password</b>.</li>' +
      '<li>In the app, add an account and scan this code.</li>' +
      '</ol>' +
      '<div class="qr"><img alt="QR code for your authenticator app" src="' + esc(en.data.totp.qr_code) + '"></div>' +
      '<details class="manual"><summary>Can’t scan? Enter this key instead</summary><code>' + esc(en.data.totp.secret) + '</code></details>' +
      '<form id="f-mfa" novalidate>' +
      '<label class="fld">3. Enter the 6-digit code from the app<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn btn-primary btn-wide" type="submit">Turn on</button></form>',
      'Every login needs your password plus a code from your phone. This keeps client information safe.'));
    bindMfaForm($('#f-mfa', main), en.data.id);
  }

  function showMfaChallenge(factor) {
    setTop(false);
    var main = render(card('Enter your code', '' +
      '<form id="f-mfa" novalidate>' +
      '<label class="fld">6-digit code from your authenticator app<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn btn-primary btn-wide" type="submit">Continue</button>' +
      '<button class="ad-link-btn auth-alt" type="button" id="mfa-out">Use a different account</button></form>',
      'Lost your phone? Ask an admin to reset your two-step verification.'));
    bindMfaForm($('#f-mfa', main), factor.id);
    $('#mfa-out', main).addEventListener('click', signOut);
  }

  function bindMfaForm(f, factorId) {
    f.code.focus();
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      var code = digits(f.code.value);
      if (code.length !== 6) return formError(f, 'Enter the 6-digit code.');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Checking…');
      var r = await sb.auth.mfa.challengeAndVerify({ factorId: factorId, code: code });
      if (r.error) {
        busy(btn, false);
        f.code.select();
        return formError(f, /invalid|expired/i.test(r.error.message) ? 'That code didn’t work. Codes change every 30 seconds, so try the newest one.' : niceError(r.error));
      }
      gate();   // the form is replaced by a "Signing you in…" screen, so it can't be submitted twice
    });
  }

  // Something timed out or failed to load: explain, and offer to try again.
  function showRetry(msg) {
    setTop(false);
    var main = render(card('Taking longer than usual', '<p>' + esc(msg) + '</p>' +
      '<button class="btn btn-primary btn-wide" type="button" id="b-retry">Try again</button>' +
      '<button class="ad-link-btn auth-alt" type="button" id="b-out">Sign out</button>'));
    $('#b-retry', main).addEventListener('click', function () { render(card('Signing you in…', '<div class="ad-loading">Loading your dashboard…</div>')); gate(); });
    $('#b-out', main).addEventListener('click', signOut);
  }

  function showBlocked(msg) {
    setTop(false);
    var main = render(card('Can’t open the dashboard', '<p>' + esc(msg) + '</p><button class="btn btn-ghost btn-wide" type="button" id="b-out">Sign out</button>'));
    $('#b-out', main).addEventListener('click', signOut);
  }

  // ---------- data ----------
  async function loadTeam() {
    var r = await timed(sb.from('profiles').select('id,email,full_name,phone,role,active,alert_email,alert_sms,created_at').order('created_at'));
    if (r.error) throw r.error;
    team = r.data || [];
  }

  // Only one lead load at a time; extra calls share the one in progress.
  var leadsLoading = null;
  function loadLeads() {
    if (!leadsLoading) leadsLoading = loadLeadsOnce().then(function () { leadsLoading = null; }, function (e) { leadsLoading = null; throw e; });
    return leadsLoading;
  }
  async function loadLeadsOnce() {
    var res = await Promise.all([
      timed(sb.from('leads')
        .select('id,created_at,updated_at,first_name,last_name,email,phone,state,age,coverage,coverage_label,coverage_type,path,status,source,assigned_to,last_contacted_at,' +
          'dob,city,zip,temperature,tags,do_not_contact,contact_attempts')
        .order('created_at', { ascending: false }).limit(LEAD_LIMIT)),
      loadExtras().catch(function () { /* the leads still load */ })
    ]);
    var r = res[0];
    if (r.error) throw r.error;
    var before = leads.length && leadsLoadedAt ? leads[0].created_at : null;
    leads = r.data || [];
    leadsLoadedAt = Date.now();
    if (before) {
      var fresh = leads.filter(function (l) { return l.created_at > before; }).length;
      if (fresh) toast(fresh === 1 ? '1 new lead just came in.' : fresh + ' new leads just came in.', 'ok');
    }
    var waiting = leads.filter(function (l) { return S.group(l.status) === 'inbox'; }).length;
    document.title = (waiting ? '(' + waiting + ') ' : '') + 'Lifestone CRM';
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(function () {
      if (document.hidden || !me) return;
      if (dragging) return;
      loadLeads().then(function () { if (!dragging) refreshView(); }).catch(function () {});
    }, REFRESH_SECONDS * 1000);
  }
  function stopRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

  function showLoadError(e) {
    var main = render('<div class="page"><div class="empty"><p><b>Couldn’t load this page.</b></p><p class="muted">' + esc(niceError(e)) + '</p>' +
      '<p><button class="btn btn-primary" type="button" id="p-retry">Try again</button></p></div></div>');
    $('#p-retry', main).addEventListener('click', route);
  }

  // ---------- routing ----------
  function route() {
    if (!me) return;
    var h = location.hash || '#/home';
    var m;
    if ((m = h.match(/^#\/lead\/([0-9a-f-]{36})$/i))) { markNav('leads'); return showLead(m[1]); }
    if (h === '#/leads') { markNav('leads'); return showLeads(); }
    if (h === '#/archive') { markNav('archive'); return showArchive(); }
    if (h === '#/tasks') { markNav('tasks'); return showTasks(); }
    if (h === '#/policies') { markNav('policies'); return showPolicies(); }
    if (h === '#/reports') { markNav('reports'); return showReports(); }
    if (h === '#/team' && isAdmin()) { markNav('team'); return showTeam(); }
    if (h === '#/settings') { markNav('settings'); return showSettings(); }
    markNav('home');
    showHome();
  }

  // Redraws whichever list page is open after the periodic refresh.
  function refreshView() {
    var h = location.hash;
    checkDueTasks();
    if (h === '#/leads') drawLeadRows();
    else if (h === '#/archive') drawArchive();
    else if (h === '#/tasks') { if (!$('.modal-wrap')) drawTasks(); }
    else if (h === '#/policies') { if (!$('.modal-wrap')) drawPolicies(); }
    else if (h === '#/home' || h === '' || h === '#/') drawHome();
  }

  function isArchived(l) { return S.group(l.status) === 'closed'; }
  var OPEN = S.STATUSES.filter(function (st) { return st.group !== 'closed'; });
  var REASONS = S.STATUSES.filter(function (st) { return st.group === 'closed'; });

  // Stage choices: active stages first, then "Archive as …" reasons.
  function stageOptions(current) {
    var opt = function (st) { return '<option value="' + st.key + '"' + (st.key === current ? ' selected' : '') + '>' + esc(st.label) + '</option>'; };
    return '<optgroup label="Active">' + OPEN.map(opt).join('') + '</optgroup>' +
      '<optgroup label="Archive as…">' + REASONS.map(opt).join('') + '</optgroup>';
  }

  // ---------- leads list (grouped by stage, like Monday) ----------
  async function showLeads() {
    render('<div class="ad-loading">Loading leads…</div>');
    try { await loadLeads(); } catch (e) { return showLoadError(e); }
    startRefresh();
    var allTags = [];
    leads.forEach(function (l) { (l.tags || []).forEach(function (t) { if (allTags.indexOf(t) === -1) allTags.push(t); }); });
    allTags.sort();
    if (allTags.indexOf(view.tag) === -1) view.tag = '';
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Leads</h1><p class="muted" id="lead-sum"></p></div>' +
      '<div class="head-actions"><div class="seg" role="group" aria-label="View">' +
      '<button type="button" data-mode="board">Board</button><button type="button" data-mode="list">List</button></div>' +
      '<button class="btn btn-ghost" type="button" id="refresh">Refresh</button></div></div>' +
      '<div class="filters">' +
      '<input type="search" id="f-q" placeholder="Search name, phone or email" aria-label="Search leads">' +
      (isAdmin() ? '<select id="f-agent" aria-label="Assigned to"><option value="">Everyone</option><option value="none">Unassigned</option>' +
        team.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.full_name || p.email) + '</option>'; }).join('') + '</select>' : '') +
      '<select id="f-temp" aria-label="Temperature"><option value="">Hot, warm or cold</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select>' +
      '<select id="f-fu" aria-label="Follow-up"><option value="">Any follow-up</option><option value="overdue">Follow-up overdue</option><option value="today">Follow-up due today</option><option value="none">No follow-up scheduled</option></select>' +
      (allTags.length ? '<select id="f-tag" aria-label="Tag"><option value="">Any tag</option>' + allTags.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select>' : '') +
      '<a class="archive-link" href="#/archive">Archive <span id="archive-count"></span></a>' +
      '</div>' +
      '<div id="lead-rows"></div><div class="bulk" id="bulk" role="region" aria-label="Change selected leads" hidden></div></div>');

    $('#f-q', main).value = view.q;
    if ($('#f-agent', main)) $('#f-agent', main).value = view.agent;
    $('#f-q', main).addEventListener('input', function (e) { view.q = e.target.value; drawLeadRows(); });
    if ($('#f-agent', main)) $('#f-agent', main).addEventListener('change', function (e) { view.agent = e.target.value; drawLeadRows(); });
    [['#f-temp', 'temp'], ['#f-fu', 'fu'], ['#f-tag', 'tag']].forEach(function (x) {
      var el = $(x[0], main);
      if (!el) return;
      el.value = view[x[1]];
      el.addEventListener('change', function (e) { view[x[1]] = e.target.value; drawLeadRows(); });
    });
    $('#refresh', main).addEventListener('click', function () { loadLeads().then(drawLeadRows); });
    $$('[data-mode]', main).forEach(function (b) {
      b.addEventListener('click', function () { view.mode = b.getAttribute('data-mode'); savePref('lq_crm_view', view.mode); drawLeadRows(); });
    });
    drawLeadRows();
  }

  function filtered() {
    var q = view.q.trim().toLowerCase(), qd = digits(q);
    return leads.filter(function (l) {
      if (view.agent === 'none' && l.assigned_to) return false;
      if (view.agent && view.agent !== 'none' && l.assigned_to !== view.agent) return false;
      if (view.temp && l.temperature !== view.temp) return false;
      if (view.tag && (l.tags || []).indexOf(view.tag) === -1) return false;
      if (view.fu) {
        var nt = nextTaskFor(l.id);
        if (view.fu === 'none' && nt) return false;
        if (view.fu === 'overdue' && !(nt && isOverdue(nt))) return false;
        if (view.fu === 'today' && !(nt && new Date(nt.due_at).getTime() < startOf('day').getTime() + 86400000)) return false;
      }
      if (!q) return true;
      return (l.first_name + ' ' + l.last_name).toLowerCase().indexOf(q) !== -1 ||
        (l.email || '').toLowerCase().indexOf(q) !== -1 ||
        (qd.length >= 3 && digits(l.phone).indexOf(qd) !== -1);
    });
  }

  // Which stage groups each person has collapsed, remembered on this device.
  var collapsed = (function () { try { return JSON.parse(savedPref('lq_crm_collapsed', '{}')) || {}; } catch (e) { return {}; } })();

  function stagesShown() {
    return OPEN;
  }

  function drawLeadRows() {
    var box = $('#lead-rows');
    if (!box) return;
    var board = view.mode === 'board';
    $$('[data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === view.mode ? 'true' : 'false'); });
    box.closest('.page').classList.toggle('page-wide', board);
    var active = leads.filter(function (l) { return !isArchived(l); }).length;
    $('#lead-sum').textContent = active + (active === 1 ? ' active lead' : ' active leads') + (isAdmin() ? '' : ' assigned to you') + ' · updated ' + ago(new Date(leadsLoadedAt).toISOString());
    var archived = leads.length - active;
    $('#archive-count').textContent = archived ? '(' + archived + ')' : '';
    drawBulk();
    if (board) return drawBoard(box);
    drawGroups(box);
  }

  // Bar at the bottom of the list when leads are ticked: move or assign them all at once.
  function drawBulk() {
    var bar = $('#bulk');
    if (!bar) return;
    Object.keys(selected).forEach(function (id) { if (!leadById(id)) delete selected[id]; });
    var ids = Object.keys(selected);
    bar.hidden = !ids.length || view.mode === 'board';
    if (bar.hidden) return;
    bar.innerHTML = '<b>' + plural(ids.length, 'lead') + ' selected</b>' +
      '<select data-bulk="status" aria-label="Move selected leads to"><option value="">Move to…</option>' + stageOptions('') + '</select>' +
      (isAdmin() ? '<select data-bulk="assign" aria-label="Assign selected leads"><option value="">Assign to…</option><option value="__none">Unassigned</option>' + teamOptions('') + '</select>' : '') +
      '<button type="button" class="ad-link-btn" data-bulk-clear>Clear</button>';
    $$('[data-bulk]', bar).forEach(function (sel) {
      sel.addEventListener('change', function () { if (sel.value) runBulk(sel.getAttribute('data-bulk'), sel.value); });
    });
    $('[data-bulk-clear]', bar).addEventListener('click', function () { selected = {}; drawLeadRows(); });
  }

  async function runBulk(kind, value) {
    var ids = Object.keys(selected), done = 0, failed = 0, bar = $('#bulk');
    bar.innerHTML = '<b>Updating ' + plural(ids.length, 'lead') + '…</b>';
    for (var i = 0; i < ids.length; i++) {
      var r = kind === 'status' ? await sb.rpc('lead_set_status', { p_lead: ids[i], p_status: value })
        : await sb.rpc('lead_assign', { p_lead: ids[i], p_agent: value === '__none' ? null : value });
      if (r.error) failed++; else { done++; if (kind === 'assign' && value !== '__none') notifyAssign(ids[i]); }
    }
    selected = {};
    await loadLeads().catch(function () {});
    drawLeadRows();
    toast(plural(done, 'lead') + (kind === 'status' ? ' moved to ' + S.label(value) : value === '__none' ? ' unassigned' : ' assigned to ' + personName(value)) + '.' + (failed ? ' ' + failed + ' couldn’t be changed.' : ''), failed ? 'err' : 'ok');
  }

  function statusSelect(l) {
    return '<select class="pill st-' + esc(l.status) + '" data-act="status" aria-label="Stage for ' + esc(l.first_name) + '">' +
      stageOptions(l.status) + '</select>';
  }

  function assignSelect(l) {
    return '<select class="who" data-act="assign" aria-label="Assign ' + esc(l.first_name) + '"><option value="">Unassigned</option>' +
      team.filter(function (p) { return p.active || p.id === l.assigned_to; }).map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === l.assigned_to ? ' selected' : '') + '>' + esc(p.full_name || p.email) + '</option>';
      }).join('') + '</select>';
  }

  function drawGroups(box) {
    var base = filtered();
    if (!leads.some(function (l) { return !isArchived(l); })) {
      box.innerHTML = '<div class="empty"><p><b>No active leads.</b></p><p class="muted">' + (isAdmin() ? 'New leads from the website will show up here.' : 'Leads assigned to you will show up here.') + '</p></div>';
      return;
    }
    var head = '<thead><tr><th class="c-name">Name</th><th class="c-stage">Stage</th>' + (isAdmin() ? '<th class="c-who">Assigned</th>' : '') +
      '<th class="c-phone">Phone</th><th class="c-cov">Coverage</th><th class="c-time">Received</th><th class="c-time">Last contact</th></tr></thead>';
    box.innerHTML = stagesShown().map(function (st) {
      var items = base.filter(function (l) { return l.status === st.key; });
      var total = items.reduce(function (sum, l) { return sum + (Number(l.coverage) || 0); }, 0);
      var shut = !!collapsed[st.key];
      return '<section class="grp st-' + esc(st.key) + (shut ? ' is-shut' : '') + '" data-group="' + esc(st.key) + '">' +
        '<button type="button" class="grp-head" aria-expanded="' + (!shut) + '">' +
        '<span class="grp-caret" aria-hidden="true"></span><span class="grp-name">' + esc(st.label) + '</span>' +
        '<span class="grp-count">' + items.length + (items.length === 1 ? ' lead' : ' leads') + '</span>' +
        (total ? '<span class="grp-sum">' + esc(money(total)) + '</span>' : '') + '</button>' +
        '<div class="grp-body"' + (shut ? ' hidden' : '') + '>' +
        (items.length ? '<div class="table-wrap"><table class="leads">' + head + '<tbody>' + items.map(function (l) {
          return '<tr data-id="' + esc(l.id) + '" tabindex="0">' +
            '<td data-label="Name"><label class="sel"><input type="checkbox" data-sel' + (selected[l.id] ? ' checked' : '') + ' aria-label="Select ' + esc(fullName(l)) + '"></label>' +
            '<a href="#/lead/' + esc(l.id) + '" class="lead-name">' + esc(l.first_name + ' ' + l.last_name) + '</a> ' + tempDot(l.temperature) +
            '<small>' + esc([l.state, l.age ? 'age ' + l.age : '', l.source].filter(Boolean).join(' · ')) + '</small></td>' +
            '<td data-label="Stage">' + statusSelect(l) + '</td>' +
            (isAdmin() ? '<td data-label="Assigned">' + assignSelect(l) + '</td>' : '') +
            '<td data-label="Phone">' + esc(fmtPhone(l.phone)) + '</td>' +
            '<td data-label="Coverage"><span>' + esc(money(l.coverage) || l.coverage_label || '—') + (l.coverage_type ? '<small>' + esc(l.coverage_type) + '</small>' : '') + '</span></td>' +
            '<td data-label="Received" title="' + esc(fmtDate(l.created_at)) + '">' + esc(ago(l.created_at)) + '</td>' +
            '<td data-label="Last contact">' + (l.last_contacted_at ? esc(ago(l.last_contacted_at)) : '<span class="warn">Never</span>') +
            '<small>' + (nextTaskLabel(l.id) || '<span class="muted">No follow-up</span>') + '</small></td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>' : '<p class="grp-empty">No leads in this stage.</p>') +
        '</div></section>';
    }).join('');

    $$('.grp-head', box).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sec = btn.closest('.grp'), key = sec.getAttribute('data-group');
        var shut = !sec.classList.contains('is-shut');
        sec.classList.toggle('is-shut', shut);
        $('.grp-body', sec).hidden = shut;
        btn.setAttribute('aria-expanded', String(!shut));
        if (shut) collapsed[key] = 1; else delete collapsed[key];
        savePref('lq_crm_collapsed', JSON.stringify(collapsed));
      });
    });
    $$('tr[data-id]', box).forEach(function (tr) {
      var id = tr.getAttribute('data-id');
      var go = function () { location.hash = '#/lead/' + id; };
      tr.addEventListener('click', function (e) { if (!e.target.closest('a, select, input, label')) go(); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === tr) go(); });
      $('[data-act=status]', tr).addEventListener('change', function (e) { moveLead(id, e.target.value); });
      $('[data-sel]', tr).addEventListener('change', function (e) { if (e.target.checked) selected[id] = 1; else delete selected[id]; drawBulk(); });
      var who = $('[data-act=assign]', tr);
      if (who) who.addEventListener('change', function (e) { assignLead(id, e.target.value || null); });
    });
  }

  async function assignLead(id, agent) {
    var l = leads.find(function (x) { return x.id === id; });
    if (!l) return;
    var before = l.assigned_to;
    l.assigned_to = agent;
    drawLeadRows();
    var r = await sb.rpc('lead_assign', { p_lead: id, p_agent: agent });
    if (r.error) { l.assigned_to = before; drawLeadRows(); return toast(niceError(r.error), 'err'); }
    if (agent) notifyAssign(id);
    toast(agent ? l.first_name + ' assigned to ' + personName(agent) + '.' : l.first_name + ' unassigned.', 'ok');
  }

  // ---------- board (kanban) ----------
  // One column per status. Drag a card to another column (desktop) or use its
  // "Move to" menu (touch screens) to change the stage. Changes go through
  // lead_set_status, so they're permission-checked and recorded in the history.
  function drawBoard(box) {
    var base = filtered();
    var cols = OPEN.slice();
    // Phones show one column at a time, so skip empty ones there.
    if (window.innerWidth < 760) {
      var withLeads = cols.filter(function (st) { return base.some(function (l) { return l.status === st.key; }); });
      if (withLeads.length) cols = withLeads;
    }
    box.innerHTML = '<div class="board">' + cols.map(function (st) {
      var items = base.filter(function (l) { return l.status === st.key; });
      var total = items.reduce(function (sum, l) { return sum + (Number(l.coverage) || 0); }, 0);
      return '<section class="col col-' + esc(st.group) + '" data-status="' + esc(st.key) + '" aria-label="' + esc(st.label) + '">' +
        '<header class="col-head"><h2>' + esc(st.label) + '</h2><span class="col-count">' + items.length + '</span>' +
        (total ? '<span class="col-sum">' + esc(money(total)) + '</span>' : '') + '</header>' +
        '<div class="col-body" data-drop="' + esc(st.key) + '">' +
        (items.length ? items.map(cardHtml).join('') : '<p class="col-empty">No leads</p>') +
        '</div></section>';
    }).join('') + '</div>' +
      // Shown at the bottom of the screen while a card is being dragged.
      '<div class="col-body archive-drop" data-drop="__archive">Drop here to archive</div>';

    $$('.card', box).forEach(function (card) {
      var id = card.getAttribute('data-id');
      card.addEventListener('click', function (e) { if (!e.target.closest('select, a, label')) location.hash = '#/lead/' + id; });
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === card) location.hash = '#/lead/' + id; });
      card.addEventListener('dragstart', function (e) {
        dragging = true;
        card.classList.add('is-dragging');
        document.body.classList.add('is-dragging-card');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
      });
      card.addEventListener('dragend', function () { dragging = false; card.classList.remove('is-dragging'); document.body.classList.remove('is-dragging-card'); $$('.col-body.is-over').forEach(function (c) { c.classList.remove('is-over'); }); });
      var move = $('select', card);
      move.addEventListener('change', function () { moveLead(id, move.value); });
    });
    $$('.col-body', box).forEach(function (zone) {
      zone.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; zone.classList.add('is-over'); });
      zone.addEventListener('dragleave', function (e) { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault();
        zone.classList.remove('is-over');
        dragging = false;
        document.body.classList.remove('is-dragging-card');
        var id = e.dataTransfer.getData('text/plain'), to = zone.getAttribute('data-drop');
        if (to === '__archive') return pickReason(id);
        moveLead(id, to);
      });
    });
  }

  function cardHtml(l) {
    var initials = '';
    if (isAdmin() && l.assigned_to) {
      initials = personName(l.assigned_to).split(/[\s@]+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('');
    }
    return '<article class="card" draggable="true" tabindex="0" data-id="' + esc(l.id) + '">' +
      '<div class="card-top"><b class="card-name">' + esc(l.first_name + ' ' + l.last_name) + '</b><span class="card-badges">' + tempDot(l.temperature) + '</span></div>' +
      '<div class="card-meta">' + esc([money(l.coverage) || l.coverage_label, l.coverage_type].filter(Boolean).join(' · ') || 'Coverage not given') + '</div>' +
      '<div class="card-meta">' + esc(fmtPhone(l.phone)) + (l.state ? ' · ' + esc(l.state) : '') + '</div>' +
      (nextTaskLabel(l.id) ? '<div class="card-next">Next: ' + nextTaskLabel(l.id) + '</div>' : '') +
      '<div class="card-foot"><span title="' + esc(fmtDate(l.created_at)) + '">In ' + esc(ago(l.created_at)) + '</span>' +
      '<span>' + (l.last_contacted_at ? 'Contacted ' + esc(ago(l.last_contacted_at)) + (l.contact_attempts > 1 ? ' · ' + l.contact_attempts + ' tries' : '') : '<span class="warn">Not contacted</span>') + '</span>' +
      (isAdmin() ? (initials ? '<span class="avatar" title="' + esc(personName(l.assigned_to)) + '">' + esc(initials) + '</span>' : '<span class="avatar avatar-none" title="Unassigned">?</span>') : '') +
      '</div>' +
      '<label class="card-move"><span>Move to</span><select aria-label="Move ' + esc(l.first_name) + ' to another stage">' +
      stageOptions(l.status) + '</select></label></article>';
  }

  async function moveLead(id, status) {
    var l = leads.find(function (x) { return x.id === id; });
    if (!l || !status || l.status === status) return refreshView();
    var before = l.status;
    l.status = status;                     // show it right away
    refreshView();
    var r = await sb.rpc('lead_set_status', { p_lead: id, p_status: status });
    if (r.error) {
      l.status = before;
      refreshView();
      return toast(niceError(r.error), 'err');
    }
    l.updated_at = new Date().toISOString();
    if (isArchived(l) && S.group(before) !== 'closed') toast(l.first_name + ' archived (' + S.label(status) + '). Find them under Archive.', 'ok');
    else if (!isArchived(l) && S.group(before) === 'closed') toast(l.first_name + ' restored to ' + S.label(status) + '.', 'ok');
    else toast(l.first_name + ' moved to ' + S.label(status) + '.', 'ok');
  }

  // Small dialog asking why a lead is being archived.
  function pickReason(id) {
    var l = leads.find(function (x) { return x.id === id; });
    if (!l) return;
    var dlg = document.createElement('div');
    dlg.className = 'modal-wrap';
    dlg.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">' +
      '<h2 id="m-title">Archive ' + esc(l.first_name + ' ' + l.last_name) + '?</h2><p class="muted">Pick what happened. You can restore them from the Archive anytime.</p>' +
      '<div class="reasons">' + REASONS.map(function (st) { return '<button type="button" class="reason st-' + st.key + '" data-reason="' + st.key + '">' + esc(st.label) + '</button>'; }).join('') + '</div>' +
      '<button type="button" class="btn btn-ghost btn-wide" data-cancel>Cancel</button></div>';
    var close = function () { dlg.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    dlg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-reason]');
      if (b) { close(); moveLead(id, b.getAttribute('data-reason')); }
      else if (e.target === dlg || e.target.closest('[data-cancel]')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(dlg);
    $('.reason', dlg).focus();
  }

  // ---------- archive ----------
  async function showArchive() {
    render('<div class="ad-loading">Loading archive…</div>');
    try { await loadLeads(); } catch (e) { return showLoadError(e); }
    startRefresh();
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Archive</h1><p class="muted" id="arch-sum"></p></div></div>' +
      '<div class="filters"><input type="search" id="a-q" placeholder="Search archived leads" aria-label="Search archived leads"></div>' +
      '<div id="arch-rows"></div></div>');
    $('#a-q', main).value = archiveQ;
    $('#a-q', main).addEventListener('input', function (e) { archiveQ = e.target.value; drawArchive(); });
    drawArchive();
  }

  function drawArchive() {
    var box = $('#arch-rows');
    if (!box) return;
    var q = archiveQ.trim().toLowerCase(), qd = digits(q);
    var all = leads.filter(isArchived);
    var list = all.filter(function (l) {
      if (!q) return true;
      return (l.first_name + ' ' + l.last_name).toLowerCase().indexOf(q) !== -1 || (l.email || '').toLowerCase().indexOf(q) !== -1 ||
        (qd.length >= 3 && digits(l.phone).indexOf(qd) !== -1);
    }).sort(function (a, b) { return (b.updated_at || '') > (a.updated_at || '') ? 1 : -1; });
    $('#arch-sum').textContent = all.length + (all.length === 1 ? ' archived lead' : ' archived leads') + '. Dead leads stay here for your records and can be restored anytime.';
    if (!all.length) {
      box.innerHTML = '<div class="empty"><p><b>The archive is empty.</b></p><p class="muted">When a lead goes nowhere, set its stage to an “Archive as…” reason, or drag it to Archive on the board.</p></div>';
      return;
    }
    var head = '<thead><tr><th class="c-name">Name</th><th class="c-stage">Reason</th>' + (isAdmin() ? '<th class="c-who">Was assigned to</th>' : '') +
      '<th class="c-phone">Phone</th><th class="c-cov">Coverage</th><th class="c-time">Came in</th><th class="c-time">Archived</th><th class="c-act"><span class="sr">Restore</span></th></tr></thead>';
    box.innerHTML = REASONS.map(function (st) {
      var items = list.filter(function (l) { return l.status === st.key; });
      if (!items.length) return '';
      return '<section class="grp st-' + esc(st.key) + '"><div class="grp-head grp-static"><span class="grp-name">' + esc(st.label) + '</span>' +
        '<span class="grp-count">' + items.length + (items.length === 1 ? ' lead' : ' leads') + '</span></div>' +
        '<div class="grp-body"><div class="table-wrap"><table class="leads">' + head + '<tbody>' + items.map(function (l) {
          return '<tr data-id="' + esc(l.id) + '" tabindex="0">' +
            '<td data-label="Name"><a href="#/lead/' + esc(l.id) + '" class="lead-name">' + esc(l.first_name + ' ' + l.last_name) + '</a>' +
            '<small>' + esc([l.state, l.age ? 'age ' + l.age : '', l.source].filter(Boolean).join(' · ')) + '</small></td>' +
            '<td data-label="Reason"><select class="pill st-' + esc(l.status) + '" data-act="status" aria-label="Reason for ' + esc(l.first_name) + '">' + stageOptions(l.status) + '</select></td>' +
            (isAdmin() ? '<td data-label="Was assigned to">' + (l.assigned_to ? esc(personName(l.assigned_to)) : '<span class="muted">Nobody</span>') + '</td>' : '') +
            '<td data-label="Phone">' + esc(fmtPhone(l.phone)) + '</td>' +
            '<td data-label="Coverage">' + esc(money(l.coverage) || l.coverage_label || '—') + '</td>' +
            '<td data-label="Came in" title="' + esc(fmtDate(l.created_at)) + '">' + esc(ago(l.created_at)) + '</td>' +
            '<td data-label="Archived" title="' + esc(fmtDate(l.updated_at)) + '">' + esc(ago(l.updated_at)) + '</td>' +
            '<td><button type="button" class="btn btn-ghost btn-sm" data-act="restore">Restore</button></td></tr>';
        }).join('') + '</tbody></table></div></div></section>';
    }).join('') || '<div class="empty"><p><b>No matches.</b></p></div>';

    $$('tr[data-id]', box).forEach(function (tr) {
      var id = tr.getAttribute('data-id');
      tr.addEventListener('click', function (e) { if (!e.target.closest('a, select, button')) location.hash = '#/lead/' + id; });
      $('[data-act=status]', tr).addEventListener('change', function (e) { moveLead(id, e.target.value); });
      $('[data-act=restore]', tr).addEventListener('click', function () {
        var l = leads.find(function (x) { return x.id === id; });
        moveLead(id, l && l.last_contacted_at ? 'contacted' : 'new');
      });
    });
  }

  // ---------- dashboard (home) ----------
  async function showHome() {
    render('<div class="ad-loading">Loading dashboard…</div>');
    try { await loadLeads(); } catch (e) { return showLoadError(e); }
    startRefresh();
    render('<div class="page" id="home"></div>');
    drawHome();
    loadActivity();
  }

  function startOf(unit) {
    var d = new Date(); d.setHours(0, 0, 0, 0);
    if (unit === 'week') d.setDate(d.getDate() - 6);
    if (unit === 'month') d.setDate(1);
    return d;
  }

  function drawHome() {
    var root = $('#home');
    if (!root) return;
    var now = Date.now(), DAY = 86400000;
    var weekAgo = now - 7 * DAY, twoWeeksAgo = now - 14 * DAY, monthStart = startOf('month').getTime();
    var t = function (iso) { return iso ? new Date(iso).getTime() : 0; };
    var active = leads.filter(function (l) { return !isArchived(l); });
    var inbox = leads.filter(function (l) { return S.group(l.status) === 'inbox'; });
    var stale = inbox.filter(function (l) { return !l.last_contacted_at && now - t(l.created_at) > DAY; });
    var thisWeek = leads.filter(function (l) { return t(l.created_at) >= weekAgo; }).length;
    var lastWeek = leads.filter(function (l) { return t(l.created_at) >= twoWeeksAgo && t(l.created_at) < weekAgo; }).length;
    var pipeline = active.filter(function (l) { return S.group(l.status) !== 'won'; }).reduce(function (s2, l) { return s2 + (Number(l.coverage) || 0); }, 0);
    var won = leads.filter(function (l) { return S.group(l.status) === 'won'; });
    var wonMonth = won.filter(function (l) { return t(l.updated_at) >= monthStart; }).length;
    var closed = leads.filter(isArchived).length;
    var rate = won.length + closed ? Math.round(won.length / (won.length + closed) * 100) : null;
    var hour = new Date().getHours();
    var hello = (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') + (me.full_name ? ', ' + me.full_name.split(' ')[0] : '');

    function tile(label, value, sub, href, tone) {
      return '<a class="tile' + (tone ? ' tile-' + tone : '') + '" href="' + href + '"><span class="tile-label">' + esc(label) + '</span>' +
        '<span class="tile-value">' + esc(value) + '</span>' + (sub ? '<span class="tile-sub">' + sub + '</span>' : '') + '</a>';
    }
    var diff = thisWeek - lastWeek;

    // New leads per day, last 14 days (one series, one color).
    var days = [];
    for (var i = 13; i >= 0; i--) {
      var d0 = startOf('day').getTime() - i * DAY;
      days.push({ d: new Date(d0), n: leads.filter(function (l) { var x = t(l.created_at); return x >= d0 && x < d0 + DAY; }).length });
    }
    var maxN = Math.max(1, Math.max.apply(null, days.map(function (x) { return x.n; })));
    var chart = '<div class="bars" role="img" aria-label="New leads per day for the last 14 days">' + days.map(function (x) {
      var label = x.d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ': ' + x.n + (x.n === 1 ? ' lead' : ' leads');
      return '<div class="bar-slot" tabindex="0" data-tip="' + esc(label) + '"><span class="bar" data-h="' + (x.n ? Math.max(6, x.n / maxN * 100) : 0) + '"></span>' +
        '<span class="bar-x">' + (x.d.getDay() === 1 || x === days[0] || x === days[13] ? esc(x.d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })) : '') + '</span></div>';
    }).join('') + '</div><div class="bar-tip" aria-hidden="true"></div>';

    function hbars(rows, total) {
      if (!rows.length) return '<p class="muted">Nothing yet.</p>';
      var max = Math.max.apply(null, rows.map(function (r) { return r.n; })) || 1;
      return '<ul class="hbars">' + rows.map(function (r) {
        return '<li><a href="' + (r.href || '#/leads') + '"><span class="hb-label">' + esc(r.label) + '</span><span class="hb-track"><span class="hb-fill" data-w="' + (r.n / max * 100) + '"></span></span>' +
          '<span class="hb-n">' + r.n + (total ? ' <small>' + Math.round(r.n / total * 100) + '%</small>' : '') + '</span></a></li>';
      }).join('') + '</ul>';
    }
    var stageRows = OPEN.map(function (st) { return { label: st.label, n: leads.filter(function (l) { return l.status === st.key; }).length }; }).filter(function (r) { return r.n; });
    var srcCount = {};
    leads.forEach(function (l) { var k = l.source || 'unknown'; srcCount[k] = (srcCount[k] || 0) + 1; });
    var NAMES = SOURCE_NAMES;
    var srcRows = Object.keys(srcCount).map(function (k) { return { label: NAMES[k] || k, n: srcCount[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 6);

    var follow = stale.concat(inbox.filter(function (l) { return stale.indexOf(l) === -1; }))
      .sort(function (a, b) { return t(a.created_at) - t(b.created_at); }).slice(0, 6);

    // Tasks and policies.
    var endToday = startOf('day').getTime() + DAY;
    var mineDue = myOpenTasks().filter(function (x) { return t(x.due_at) < endToday; }).sort(byDue);
    var overdueN = mineDue.filter(isOverdue).length;
    var pendingPols = policies.filter(function (p) { return pStatus(p.status).group === 'pending'; });
    var placedMonth = policies.filter(function (p) { return p.status === 'in_force' && p.placed_on && localDay(p.placed_on).getTime() >= monthStart; });
    var sumAnnual = function (list) { return list.reduce(function (s2, p) { return s2 + annual(p); }, 0); };

    // Coming up: birthdays, price-age changes, policy anniversaries, stuck applications.
    var soon = [], horizon = now + 30 * DAY;
    leads.forEach(function (l) {
      if (!l.dob || isArchived(l)) return;
      var b = nextBirthday(l.dob).getTime();
      if (b - now < 14 * DAY) soon.push({ t: b, l: l, what: 'Birthday', more: 'turns ' + ageOn(l.dob, new Date(b)) });
      var g = S.group(l.status);
      if (g === 'inbox' || g === 'working') {
        var u = nextAgeUp(l.dob).getTime();
        if (u < horizon) soon.push({ t: u, l: l, what: 'Price age goes up', more: 'apply before then' });
      }
    });
    policies.forEach(function (p) {
      if (p.status === 'in_force' && p.effective_on) {
        var a = nextBirthday(p.effective_on).getTime();
        if (a < horizon && a > localDay(p.effective_on).getTime()) soon.push({ t: a, l: leadById(p.lead_id), what: 'Policy anniversary', more: p.carrier + ', good time for a review' });
      }
      if (pStatus(p.status).group === 'pending' && inPolicyStatusDays(p) > 30) soon.push({ t: 0, l: leadById(p.lead_id), what: 'Stuck ' + inPolicyStatusDays(p) + ' days', more: p.carrier + ' · ' + pStatus(p.status).label });
    });
    soon = soon.filter(function (x) { return x.l; }).sort(function (a, b) { return a.t - b.t; }).slice(0, 8);
    function dayLabel(ms) {
      if (!ms) return 'Needs a nudge';
      var dd = Math.round((dayStart(ms) - startOf('day')) / DAY);
      return dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    var workload = '';
    if (isAdmin()) {
      var people = team.filter(function (p) { return p.active; });
      workload = '<section class="panel"><h2>Team workload</h2><div class="table-wrap"><table class="team-load"><thead><tr><th>Agent</th><th>Open</th><th>Needs action</th><th>Overdue tasks</th><th>Won</th><th>Archived</th></tr></thead><tbody>' +
        '<tr><td><b>Unassigned</b></td><td>' + active.filter(function (l) { return !l.assigned_to && S.group(l.status) !== 'won'; }).length + '</td><td>' + inbox.filter(function (l) { return !l.assigned_to; }).length + '</td><td>—</td><td>—</td><td>—</td></tr>' +
        people.map(function (p) {
          var mine = leads.filter(function (l) { return l.assigned_to === p.id; });
          return '<tr><td>' + esc(p.full_name || p.email) + '</td><td>' + mine.filter(function (l) { var g = S.group(l.status); return g === 'inbox' || g === 'working'; }).length + '</td>' +
            '<td>' + mine.filter(function (l) { return S.group(l.status) === 'inbox'; }).length + '</td>' +
            '<td>' + openTasks().filter(function (x) { return x.assigned_to === p.id && isOverdue(x); }).length + '</td><td>' + mine.filter(function (l) { return S.group(l.status) === 'won'; }).length + '</td>' +
            '<td>' + mine.filter(isArchived).length + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }

    root.innerHTML =
      '<div class="page-head"><div><h1>' + esc(hello) + '</h1><p class="muted">' + esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) +
      (isAdmin() ? ' · Everything across the team' : ' · Your leads') + '</p></div>' +
      '<a class="btn btn-primary" href="#/leads">Open leads</a></div>' +
      '<div class="tiles tiles-4">' +
      tile('New this week', String(thisWeek), (diff === 0 ? 'Same as last week' : (diff > 0 ? '▲ ' + diff : '▼ ' + (-diff)) + ' vs last week'), '#/leads') +
      tile('Needs action', String(inbox.length), 'New, not worked yet', '#/leads', inbox.length ? 'gold' : '') +
      tile('Waiting 24h+', String(stale.length), stale.length ? 'Not contacted yet' : 'Everyone’s been contacted', '#/leads', stale.length ? 'alert' : '') +
      tile('My tasks today', String(mineDue.length), overdueN ? overdueN + ' overdue' : (mineDue.length ? 'None overdue' : 'Nothing due'), '#/tasks', overdueN ? 'alert' : '') +
      tile('Pending apps', String(pendingPols.length), money0(sumAnnual(pendingPols)) + ' annual premium', '#/policies', pendingPols.length ? 'gold' : '') +
      tile('Placed this month', money0(sumAnnual(placedMonth)), wonMonth + (wonMonth === 1 ? ' lead won' : ' leads won') + ' this month', '#/policies', placedMonth.length || wonMonth ? 'good' : '') +
      tile('Open pipeline', money(pipeline) || '$0', 'Coverage still in play', '#/leads') +
      tile('Close rate', rate == null ? '—' : rate + '%', 'Won ÷ (won + archived)', '#/reports') +
      '</div>' +
      '<div class="home-grid">' +
      '<section class="panel myday"><div class="panel-head"><h2>My day</h2><a class="ad-link-btn" href="#/tasks">All tasks</a></div>' +
      (mineDue.length ? '<ul class="tasks">' + mineDue.slice(0, 8).map(function (x) { return taskItem(x); }).join('') + '</ul>' +
        (mineDue.length > 8 ? '<p class="hint"><a href="#/tasks">' + (mineDue.length - 8) + ' more</a></p>' : '')
        : '<p class="muted">Nothing due today. Add follow-ups from any lead and they’ll show up here.</p>') + '</section>' +
      '<section class="panel follow"><h2>Follow up now</h2>' + (follow.length ? '<ul class="follow-list">' + follow.map(function (l) {
        var tel = phone10(l.phone);
        return '<li><a class="fl-main" href="#/lead/' + esc(l.id) + '"><b>' + esc(l.first_name + ' ' + l.last_name) + '</b><span>' + statusChip(l.status) + ' · in ' + esc(ago(l.created_at)) +
          (l.last_contacted_at ? '' : ' · <span class="warn">not contacted</span>') + '</span></a>' +
          (tel ? '<a class="btn btn-ghost btn-sm" href="tel:+1' + esc(tel) + '" data-call="' + esc(l.id) + '">Call</a>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="muted">Nothing waiting. Nice work.</p>') + '</section>' +
      '<section class="panel"><h2>Coming up</h2>' + (soon.length ? '<ul class="follow-list">' + soon.map(function (x) {
        return '<li><a class="fl-main" href="#/lead/' + esc(x.l.id) + '"><b>' + esc(fullName(x.l)) + '</b><span><b class="cu-what">' + esc(x.what) + '</b> · ' + esc(dayLabel(x.t)) + ' · ' + esc(x.more) + '</span></a></li>';
      }).join('') + '</ul>' : '<p class="muted">Birthdays, price-age changes and policy anniversaries show up here once leads have a date of birth and policies are added.</p>') + '</section>' +
      '<section class="panel"><h2>New leads, last 14 days</h2>' + chart + '</section>' +
      '<section class="panel"><h2>Pipeline by stage</h2>' + hbars(stageRows) + '</section>' +
      '<section class="panel"><h2>Where leads come from</h2>' + hbars(srcRows, leads.length) +
      '</section>' +
      workload +
      '<section class="panel activity"><h2>Recent activity</h2><ol class="timeline" id="activity"><li class="muted">Loading…</li></ol></section>' +
      '</div>';

    $$('.follow [data-call]', root).forEach(function (a) {
      a.addEventListener('click', function () { sb.rpc('lead_log_contact', { p_lead: a.getAttribute('data-call'), p_via: 'call' }); });
    });
    bindTasks($('.myday', root), drawHome);
    // Sizes are set from script: the admin pages' security policy blocks inline style attributes.
    $$('[data-h]', root).forEach(function (el) { el.style.height = el.getAttribute('data-h') + '%'; });
    $$('[data-w]', root).forEach(function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
    var tip = $('.bar-tip', root), wrap = $('.bars', root);
    $$('.bar-slot', root).forEach(function (slot) {
      var show = function () {
        tip.textContent = slot.getAttribute('data-tip');
        tip.style.left = (slot.offsetLeft + slot.offsetWidth / 2) + 'px';
        tip.classList.add('on');
      };
      slot.addEventListener('mouseenter', show);
      slot.addEventListener('focus', show);
      slot.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
      slot.addEventListener('blur', function () { tip.classList.remove('on'); });
    });
    if (wrap) wrap.parentNode.style.position = 'relative';
    if (lastActivity) drawActivity(lastActivity);
  }

  var lastActivity = null;
  async function loadActivity() {
    var r = await sb.from('lead_events').select('*').order('created_at', { ascending: false }).limit(12);
    lastActivity = r.data || [];
    drawActivity(lastActivity);
  }
  function drawActivity(events) {
    var box = $('#activity');
    if (!box) return;
    if (!events.length) { box.innerHTML = '<li class="muted">No activity yet.</li>'; return; }
    box.innerHTML = events.map(function (e) {
      var l = leads.find(function (x) { return x.id === e.lead_id; });
      var name = l ? '<a href="#/lead/' + esc(l.id) + '">' + esc(l.first_name + ' ' + l.last_name) + '</a>' : 'a lead';
      return eventItem(e).replace('<div class="tl-text">', '<div class="tl-text"><span class="tl-lead">' + name + ':</span> ');
    }).join('');
  }

  // ---------- one lead ----------
  var VIA = { note: 'Note', call: 'Call', text: 'Text', email: 'Email', meeting: 'Meeting' };
  var OUTCOMES = {
    call: [['no_answer', 'No answer'], ['voicemail', 'Left voicemail'], ['spoke', 'Talked'], ['appointment', 'Set appointment'], ['bad_number', 'Bad number']],
    text: [['sent', 'Sent'], ['replied', 'They replied']],
    email: [['sent', 'Sent'], ['replied', 'They replied']],
    meeting: [['spoke', 'Met'], ['appointment', 'Set next meeting']]
  };
  var OUTCOME_TEXT = { no_answer: 'no answer', voicemail: 'left a voicemail', spoke: 'talked', appointment: 'set an appointment', bad_number: 'bad number', sent: 'sent', replied: 'they replied' };

  // o: { quiet: redraw without the loading screen, composer: 'call' | 'text' | ... , ask: show "How did the call go?" }
  async function showLead(id, o) {
    o = o || {};
    stopRefresh();
    if (!o.quiet) render('<div class="ad-loading">Loading lead…</div>');
    var res;
    try {
      res = await Promise.all([
        timed(sb.from('leads').select('*').eq('id', id)).maybeSingle(),
        timed(sb.from('lead_events').select('*').eq('lead_id', id).order('created_at', { ascending: false })),
        timed(sb.from('lead_files').select('*').eq('lead_id', id).order('created_at', { ascending: false })),
        loadExtras().catch(function () {}),
        leads.length ? null : loadLeads().catch(function () {})
      ]);
    } catch (e) { return showLoadError(e); }
    var r = res[0];
    if (r.error) return showLoadError(r.error);
    if (!r.data) {
      return render('<div class="page"><a href="#/leads" class="back">← All leads</a><div class="empty"><p><b>Lead not found.</b></p><p class="muted">It may have been reassigned to someone else.</p></div></div>');
    }
    if (location.hash !== '#/lead/' + id) return;   // they moved on while it loaded
    var l = r.data;
    var copy = leadById(id);
    if (copy) Object.keys(copy).forEach(function (k) { if (k in l) copy[k] = l[k]; });
    var events = res[1].data || [], files = res[2].data || [];
    var leadTasks = tasks.filter(function (t) { return t.lead_id === id; }).sort(byDue);
    var openT = leadTasks.filter(function (t) { return !t.done_at; }), doneT = leadTasks.filter(function (t) { return t.done_at; });
    var pols = policies.filter(function (p) { return p.lead_id === id; });
    var dupes = leads.filter(function (x) {
      return x.id !== id && ((digits(l.phone).length >= 10 && digits(x.phone) === digits(l.phone)) || (l.email && x.email && x.email.toLowerCase() === l.email.toLowerCase()));
    });
    var d = l.details || {}, u = l.utm || {};
    var reload = function (opt) { return showLead(id, Object.assign({ quiet: true }, opt || {})); };
    var openStage = S.group(l.status) === 'inbox' || S.group(l.status) === 'working';

    function rows(list) {
      var out = list.filter(function (x) { return x[1] !== '' && x[1] != null; });
      return out.length ? '<dl>' + out.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + (x[2] ? x[1] : esc(x[1])) + '</dd>'; }).join('') + '</dl>' : '<p class="muted">Nothing recorded.</p>';
    }

    var tel = phone10(l.phone), dnc = !!l.do_not_contact;
    var ageUp = l.dob ? nextAgeUp(l.dob) : null;
    var ageUpDays = ageUp ? Math.round((ageUp - dayStart(new Date())) / 86400000) : null;
    var main = render('<div class="page">' +
      '<a href="#/leads" class="back">← All leads</a>' +
      '<div class="lead-head">' +
      '<div><h1>' + esc(fullName(l)) + '</h1>' +
      '<p class="muted">' + statusChip(l.status) + ' ' + tempDot(l.temperature) + ' <span>Received ' + esc(fmtDate(l.created_at)) + '</span></p>' +
      ((l.tags || []).length ? '<p class="lead-tags">' + tagChips(l.tags) + '</p>' : '') + '</div>' +
      '<div class="lead-actions">' +
      (!dnc && tel ? '<a class="btn btn-primary" data-contact="call" href="tel:+1' + esc(tel) + '">Call</a>' +
        '<button class="btn btn-ghost" type="button" data-msg="sms">Text</button>' : '') +
      (!dnc && l.email ? '<button class="btn btn-ghost" type="button" data-msg="email">Email</button>' : '') +
      '<button class="btn btn-ghost" type="button" id="l-edit">Edit details</button>' +
      '</div></div>' +

      (dnc ? '<div class="dnc-note"><b>Do not contact.</b> This person asked us to stop calling, texting and emailing, so the contact buttons are hidden. To undo, use Edit details.</div>' : '') +
      (dupes.length ? '<div class="dup-note"><b>Possible duplicate:</b> ' + dupes.slice(0, 3).map(function (x) {
        return '<a href="#/lead/' + esc(x.id) + '">' + esc(fullName(x)) + '</a> (' + esc(S.label(x.status)) + ')';
      }).join(', ') + ' has the same phone or email. If it’s the same person, archive the extra one as “Duplicate / test”.</div>' : '') +
      (isArchived(l) ? '<div class="archived-note">This lead is archived (' + esc(S.label(l.status)) + '). Pick an active stage below to restore it.</div>' : '') +
      '<div class="lead-controls">' +
      '<label class="fld fld-inline">Stage<select id="l-status">' + stageOptions(l.status) + '</select></label>' +
      (isAdmin() ? '<label class="fld fld-inline">Assigned to<select id="l-assign"><option value="">Unassigned</option>' + team.filter(function (p) { return p.active || p.id === l.assigned_to; }).map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === l.assigned_to ? ' selected' : '') + '>' + esc((p.full_name || p.email) + (p.role === 'admin' ? ' (admin)' : '')) + '</option>';
      }).join('') + '</select></label>' : '') +
      '<div class="fld fld-inline">Temperature<div class="seg seg-sm temp-seg" role="group" aria-label="Temperature">' + ['hot', 'warm', 'cold'].map(function (k) {
        return '<button type="button" class="tb-' + k + '" data-temp="' + k + '" aria-pressed="' + (l.temperature === k) + '">' + TEMPS[k] + '</button>';
      }).join('') + '</div></div>' +
      '</div>' +

      '<div class="lead-grid"><div class="lead-info">' +
      '<section class="panel span2"><div class="panel-head"><h2>Policies</h2><button class="btn btn-ghost btn-sm" type="button" id="add-pol">Add policy</button></div>' +
      (pols.length ? '<ul class="pol-list">' + pols.map(policyCard).join('') + '</ul>'
        : '<p class="muted">No policies yet. When ' + esc(l.first_name) + ' applies, add the policy here to track underwriting, the premium and your commission.</p>') + '</section>' +
      '<section class="panel"><h2>Contact</h2>' + rows([
        ['Phone', tel ? (dnc ? esc(fmtPhone(l.phone)) : '<a href="tel:+1' + esc(tel) + '">' + esc(fmtPhone(l.phone)) + '</a>') : esc(l.phone), true],
        ['Email', l.email ? (dnc ? esc(l.email) : '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>') : '', true],
        ['Date of birth', l.dob ? fmtDay(l.dob) + ' (age ' + ageOn(l.dob) + ')' : ''],
        ['Age', l.dob ? '' : l.age],
        ['Price age goes up', ageUp && openStage ? fmtDay(isoDay(ageUp)) + (ageUpDays <= 45 ? ' (in ' + plural(ageUpDays, 'day') + ')' : '') : ''],
        ['State', l.state], ['City', [l.city, l.zip].filter(Boolean).join(' ')], ['Best time to call', l.best_time],
        ['Last contact', l.last_contacted_at ? fmtDate(l.last_contacted_at) : 'Never'],
        ['Contact attempts', l.contact_attempts || 0]
      ]) + (ageUp && openStage && ageUpDays <= 45 ? '<p class="hint">Many carriers price by the nearest birthday, so rates usually go up on that date. Try to get the application in before then.</p>' : '') + '</section>' +
      '<section class="panel"><h2>What they’re looking for</h2>' + rows([
        ['Coverage', money(l.coverage) || l.coverage_label], ['Type', l.coverage_type], ['Interested in', l.interest],
        ['Goal', l.goal], ['Replacing a policy', l.replacing]
      ]) + '</section>' +
      (d.review ? '<section class="panel"><h2>Policy review answers</h2>' + rows(Object.keys(d.review).map(function (k) { return [k.replace(/_/g, ' '), d.review[k]]; })) + '</section>' : '') +
      '<section class="panel"><h2>Consent</h2>' + rows([
        ['Agreed', l.consent_at ? fmtDate(l.consent_at) : 'Not recorded'], ['Version', l.consent_version]
      ]) + (l.consent_text ? '<p class="consent-text">“' + esc(l.consent_text) + '”</p>' : '') + '</section>' +
      '<section class="panel"><h2>Where they came from</h2>' + rows([
        ['Form', l.source], ['Page', d.page], ['Ad source', u.utm_source], ['Medium', u.utm_medium], ['Campaign', u.utm_campaign],
        ['Ad term', u.utm_term], ['Ad content', u.utm_content], ['Google click ID', d.gclid ? 'Yes' : ''], ['Facebook click ID', d.fbclid ? 'Yes' : '']
      ]) + '</section>' +
      '</div>' +

      '<div class="lead-side">' +
      '<section class="panel lead-tasks"><div class="panel-head"><h2>Tasks</h2><button class="btn btn-ghost btn-sm" type="button" id="add-task">Add task</button></div>' +
      (openT.length ? '<ul class="tasks">' + openT.map(function (t) { return taskItem(t, { noLead: true }); }).join('') + '</ul>'
        : '<p class="muted">No follow-up scheduled.' + (openStage && !dnc ? ' <span class="warn">Add one so this lead doesn’t slip through.</span>' : '') + '</p>') +
      (doneT.length ? '<details class="done-tasks"><summary>' + plural(doneT.length, 'finished task') + '</summary><ul class="tasks">' +
        doneT.map(function (t) { return taskItem(t, { noLead: true }); }).join('') + '</ul></details>' : '') + '</section>' +
      filesPanel(files) +
      '<section class="panel"><h2>Notes &amp; history</h2>' + composerHtml(o.composer, o.ask) +
      '<div id="history"></div></section></div></div></div>');

    $('#l-status', main).addEventListener('change', async function (e) {
      var r2 = await sb.rpc('lead_set_status', { p_lead: id, p_status: e.target.value });
      if (r2.error) { toast(niceError(r2.error), 'err'); e.target.value = l.status; return; }
      toast('Status updated.', 'ok');
      if (copy) copy.status = e.target.value;
      reload();
    });
    if ($('#l-assign', main)) $('#l-assign', main).addEventListener('change', async function (e) {
      var agent = e.target.value || null;
      var r2 = await sb.rpc('lead_assign', { p_lead: id, p_agent: agent });
      if (r2.error) { toast(niceError(r2.error), 'err'); e.target.value = l.assigned_to || ''; return; }
      if (agent) notifyAssign(id);
      toast(agent ? 'Assigned to ' + personName(agent) + '. They’ll get an alert.' : 'Lead unassigned.', 'ok');
      if (copy) copy.assigned_to = agent;
      reload();
    });
    $$('[data-temp]', main).forEach(function (b) {
      b.addEventListener('click', async function () {
        var k = b.getAttribute('data-temp'), next = l.temperature === k ? '' : k;
        var r2 = await sb.rpc('lead_update_details', { p_lead: id, p: { temperature: next } });
        if (r2.error) return toast(niceError(r2.error), 'err');
        if (copy) copy.temperature = next;
        reload();
      });
    });
    $$('[data-contact]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        // Let the phone app open, log the attempt, then ask how it went.
        sb.rpc('lead_log_contact', { p_lead: id, p_via: btn.getAttribute('data-contact') }).then(function () {
          setTimeout(function () { if (location.hash === '#/lead/' + id) reload({ composer: 'call', ask: true }); }, 1500);
        });
      });
    });
    $$('[data-msg]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        messageModal(l, btn.getAttribute('data-msg'), function (via) { if (location.hash === '#/lead/' + id) reload({ composer: via }); });
      });
    });
    $('#l-edit', main).addEventListener('click', function () { detailsModal(l, reload); });
    $('#add-pol', main).addEventListener('click', function () { policyModal({ leadId: id, lead: l, onSave: reload }); });
    $$('.pol-list [data-pol]', main).forEach(function (li) {
      var p = pols.find(function (x) { return x.id === li.getAttribute('data-pol'); });
      var open = function () { policyModal({ policy: p, lead: l, onSave: reload }); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
    });
    $('#add-task', main).addEventListener('click', function () { taskModal({ leadId: id, lead: l, onSave: reload }); });
    bindTasks($('.lead-tasks', main), reload);
    bindFiles(main, id, files);
    bindComposer(main, l, o.composer, reload);
    if (histView.lead !== id) histView = { lead: id, filter: 'all', open: false };
    drawHistory(events);
  }

  // History shows the latest few entries; the rest fold away behind "Show all".
  // The filter and open/closed choice stick while you stay on the same lead.
  var HISTORY_SHOWN = 5;
  var histView = { lead: null, filter: 'all', open: false };
  var HISTORY_FILTERS = [
    ['all', 'All', function () { return true; }],
    ['notes', 'Notes', function (e) { return e.kind === 'note' || (e.kind === 'contact' && e.body); }],
    ['contact', 'Calls & texts', function (e) { return e.kind === 'contact'; }],
    ['task', 'Tasks', function (e) { return e.kind === 'task'; }],
    ['changes', 'Changes', function (e) { return ['note', 'contact', 'task'].indexOf(e.kind) === -1; }]
  ];

  function drawHistory(events) {
    var box = $('#history');
    if (!box) return;
    var filters = HISTORY_FILTERS.map(function (f) { return { key: f[0], label: f[1], items: events.filter(f[2]) }; })
      .filter(function (f) { return f.key === 'all' || f.items.length; });
    var cur = filters.find(function (f) { return f.key === histView.filter; }) || filters[0];
    var list = cur.items, more = list.length - HISTORY_SHOWN;
    box.innerHTML = (events.length > HISTORY_SHOWN ? '<div class="hist-filters" role="group" aria-label="Show in history">' + filters.map(function (f) {
      return '<button type="button" class="chip-btn' + (f === cur ? ' on' : '') + '" data-hf="' + f.key + '" aria-pressed="' + (f === cur) + '">' +
        esc(f.label) + ' <span class="hf-n">' + f.items.length + '</span></button>';
    }).join('') + '</div>' : '') +
      (list.length ? '<ol class="timeline">' + (histView.open ? list : list.slice(0, HISTORY_SHOWN)).map(eventItem).join('') + '</ol>' : '<p class="muted">Nothing here yet.</p>') +
      (more > 0 ? '<button type="button" class="hist-more" data-hmore aria-expanded="' + histView.open + '">' +
        (histView.open ? 'Show less' : 'Show ' + plural(more, 'older entry', 'older entries')) + '</button>' : '');
    $$('[data-hf]', box).forEach(function (b) {
      b.addEventListener('click', function () { histView.filter = b.getAttribute('data-hf'); histView.open = false; drawHistory(events); });
    });
    var btn = $('[data-hmore]', box);
    if (btn) btn.addEventListener('click', function () {
      histView.open = !histView.open;
      drawHistory(events);
      if (!histView.open) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // Notes and call/text logging in one box.
  function composerHtml(mode, ask) {
    mode = OUTCOMES[mode] ? mode : 'note';
    return '<div class="composer"><div class="seg seg-sm seg-wrap" role="group" aria-label="What are you adding?">' + Object.keys(VIA).map(function (k) {
      return '<button type="button" data-via="' + k + '" aria-pressed="' + (k === mode) + '">' + (k === 'note' ? 'Note' : 'Log ' + VIA[k].toLowerCase()) + '</button>';
    }).join('') + '</div>' +
      '<form id="f-note" class="note-form" novalidate>' +
      '<p class="cmp-ask" id="cmp-ask"' + (mode === 'call' && ask ? '' : ' hidden') + '>How did the call go?</p>' +
      '<div class="outcomes" id="outcomes" role="radiogroup" aria-label="How it went"></div>' +
      '<label class="sr" for="note">Note</label><textarea id="note" name="note" rows="3"></textarea>' +
      '<div class="cmp-foot"><label class="fu" id="fu-wrap">Next step <select name="fu"><option value="">No follow-up</option><option value="hour">Try again in 1 hour</option>' +
      '<option value="tomorrow">Tomorrow 9 AM</option><option value="2days">In 2 days</option><option value="week">Next Monday</option><option value="pick">Pick a time…</option></select></label>' +
      '<button class="btn btn-primary" type="submit">Add note</button></div>' +
      '<p class="form-error" role="alert" hidden></p></form></div>';
  }

  function bindComposer(main, l, mode, reload) {
    var f = $('#f-note', main), cur = OUTCOMES[mode] ? mode : 'note';
    function setMode(k) {
      cur = k;
      $$('[data-via]', main).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-via') === k)); });
      var outs = OUTCOMES[k] || [];
      $('#outcomes', f).innerHTML = outs.map(function (x) { return '<label class="out"><input type="radio" name="outcome" value="' + x[0] + '"><span>' + esc(x[1]) + '</span></label>'; }).join('');
      $('#outcomes', f).hidden = !outs.length;
      $('#fu-wrap', f).hidden = k === 'note';
      f.fu.value = '';
      $('#note', f).placeholder = k === 'note' ? 'Add a note: what you talked about, next steps…' : 'Notes (optional)';
      $('button[type=submit]', f).textContent = k === 'note' ? 'Add note' : 'Save';
      if (k !== 'call') $('#cmp-ask', f).hidden = true;
      formError(f, '');
    }
    $$('[data-via]', main).forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-via')); }); });
    f.addEventListener('change', function (e) {
      if (e.target.name !== 'outcome') return;
      var v = e.target.value;
      if (v === 'appointment') f.fu.value = 'pick';
      else if ((v === 'no_answer' || v === 'voicemail') && !f.fu.value) f.fu.value = 'tomorrow';
    });
    setMode(cur);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      var text = $('#note', f).value.trim(), btn = $('button[type=submit]', f), r2;
      if (cur === 'note') {
        if (!text) return formError(f, 'Write a note first.');
        busy(btn, true, 'Saving…');
        r2 = await sb.rpc('lead_add_note', { p_lead: l.id, p_body: text });
        busy(btn, false);
        if (r2.error) return formError(f, niceError(r2.error));
        return reload();
      }
      var picked = $('input[name=outcome]:checked', f);
      if (!picked) return formError(f, 'Pick how it went.');
      var out = picked.value, fu = f.fu.value;
      busy(btn, true, 'Saving…');
      r2 = await sb.rpc('lead_log_activity', { p_lead: l.id, p_via: cur, p_outcome: out, p_note: text });
      if (r2.error) { busy(btn, false); return formError(f, niceError(r2.error)); }
      if (fu && fu !== 'pick') {
        var due = presetDue(fu);
        var r3 = await sb.rpc('task_save', {
          p_id: null, p_lead: l.id, p_kind: 'call', p_title: (out === 'no_answer' || out === 'voicemail' ? 'Call back ' : 'Follow up with ') + fullName(l),
          p_notes: '', p_due: due.toISOString(), p_assignee: me.id
        });
        toast(r3.error ? 'Logged, but the follow-up didn’t save: ' + niceError(r3.error) : 'Logged. Follow-up set for ' + dueText(due) + '.', r3.error ? 'err' : 'ok');
      } else {
        toast('Logged.', 'ok');
      }
      if (out === 'bad_number') toast('Logged. Tip: fix the number with Edit details, or archive the lead as Unable to reach.', 'ok');
      await reload();
      if (fu === 'pick') taskModal({ leadId: l.id, lead: l, kind: out === 'appointment' ? 'appointment' : 'call', onSave: reload });
    });
  }

  // ---------- files on a lead ----------
  // Stored in the private "lead-files" bucket under <lead id>/. The database only lets
  // people who can see the lead upload, list or download its files.
  var FILE_TYPES = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain', csv: 'text/csv'
  };
  var MAX_FILE = 25 * 1024 * 1024;

  function fileSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function fileIcon(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return ext === 'pdf' ? 'PDF' : /^(jpe?g|png|webp|hei[cf])$/.test(ext) ? 'IMG' : /^docx?$/.test(ext) ? 'DOC' : /^xlsx?|csv$/.test(ext) ? 'XLS' : 'TXT';
  }

  function filesPanel(files) {
    return '<section class="panel files"><h2>Files <span class="muted">(' + files.length + ')</span></h2>' +
      '<label class="dropzone" id="dropzone"><input type="file" id="file-input" multiple accept="' + Object.keys(FILE_TYPES).map(function (x) { return '.' + x; }).join(',') + '">' +
      '<b>Add files</b><span>or drag them here. PDF, photos, Word, Excel, up to 25 MB each.</span></label>' +
      '<p class="upload-status" id="upload-status" role="status" hidden></p>' +
      (files.length ? '<ul class="file-list">' + files.map(function (f) {
        var canRemove = isAdmin() || f.uploaded_by === me.id;
        return '<li data-file="' + esc(f.id) + '"><span class="file-ic">' + fileIcon(f.name) + '</span>' +
          '<span class="file-main"><button type="button" class="file-name" data-dl>' + esc(f.name) + '</button>' +
          '<small>' + esc(fileSize(f.size)) + ' · ' + esc(personName(f.uploaded_by) || 'Someone') + ' · ' + esc(ago(f.created_at)) + '</small></span>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-dl>Download</button>' +
          (canRemove ? '<button type="button" class="ad-link-btn file-rm" data-rm aria-label="Remove ' + esc(f.name) + '">Remove</button>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="muted">No files yet. Add policy documents, IDs or anything else for this client.</p>') +
      '</section>';
  }

  function bindFiles(main, leadId, files) {
    var input = $('#file-input', main), zone = $('#dropzone', main), status = $('#upload-status', main);
    input.addEventListener('change', function () { uploadFiles(leadId, Array.prototype.slice.call(input.files), status); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('is-over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      uploadFiles(leadId, Array.prototype.slice.call(e.dataTransfer.files || []), status);
    });
    $$('.file-list li', main).forEach(function (li) {
      var f = files.find(function (x) { return x.id === li.getAttribute('data-file'); });
      $$('[data-dl]', li).forEach(function (b) { b.addEventListener('click', function () { downloadFile(f); }); });
      var rm = $('[data-rm]', li);
      if (rm) rm.addEventListener('click', function () { removeFile(leadId, f); });
    });
  }

  async function uploadFiles(leadId, list, status) {
    if (!list.length) return;
    var done = 0, problems = [];
    status.hidden = false;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      var type = FILE_TYPES[ext];
      if (!type) { problems.push(file.name + ': that file type isn’t allowed'); continue; }
      if (file.size > MAX_FILE) { problems.push(file.name + ': over 25 MB'); continue; }
      status.textContent = 'Uploading ' + (i + 1) + ' of ' + list.length + ': ' + file.name + '…';
      var safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file.' + ext;
      var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      var path = leadId + '/' + id + '-' + safe;
      var up = await sb.storage.from('lead-files').upload(path, file, { contentType: type, upsert: false });
      if (up.error) { problems.push(file.name + ': ' + niceError(up.error)); continue; }
      var rec = await sb.rpc('lead_file_added', { p_lead: leadId, p_path: path, p_name: file.name, p_size: file.size, p_mime: type });
      if (rec.error) {
        await sb.storage.from('lead-files').remove([path]);   // don't leave an unlisted file behind
        problems.push(file.name + ': ' + niceError(rec.error));
        continue;
      }
      done++;
    }
    if (problems.length) toast(problems.join(' · '), 'err');
    else toast(done === 1 ? 'File added.' : done + ' files added.', 'ok');
    if (location.hash === '#/lead/' + leadId) showLead(leadId);
  }

  async function downloadFile(f) {
    var r = await sb.storage.from('lead-files').createSignedUrl(f.path, 60, { download: f.name });
    if (r.error || !r.data) return toast(niceError(r.error || 'Could not open the file'), 'err');
    var a = document.createElement('a');
    a.href = r.data.signedUrl;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function removeFile(leadId, f) {
    if (!confirm('Remove “' + f.name + '” from this lead? This can’t be undone.')) return;
    var r = await sb.storage.from('lead-files').remove([f.path]);
    if (r.error) return toast(niceError(r.error), 'err');
    var r2 = await sb.rpc('lead_file_removed', { p_file: f.id });
    if (r2.error) return toast(niceError(r2.error), 'err');
    toast('File removed.', 'ok');
    showLead(leadId);
  }

  function eventItem(e) {
    var who = e.actor ? personName(e.actor) || 'A team member' : 'Website';
    var m = e.meta || {}, text;
    switch (e.kind) {
      case 'created': text = m.source === 'import' ? 'Imported from a spreadsheet.' : 'Lead came in from <b>' + esc(SOURCE_NAMES[m.source] || m.source || 'the website') + '</b>.'; break;
      case 'status': text = 'Status changed from <b>' + esc(S.label(m.from)) + '</b> to <b>' + esc(S.label(m.to)) + '</b>' + (m.auto ? ' to match the policy' : '') + '.'; break;
      case 'assigned': text = m.to ? 'Assigned to <b>' + esc(m.name) + '</b>.' : 'Unassigned.'; break;
      case 'contact':
        text = m.outcome != null && m.outcome !== '' ? '<b>' + esc(VIA[m.via] || 'Contact') + ':</b> ' + esc(OUTCOME_TEXT[m.outcome] || m.outcome) + '.'
          : ({ call: 'Tapped Call.', text: 'Tapped Text.', email: 'Tapped Email.', meeting: 'Met.' }[m.via] || 'Contact attempt.');
        if (e.body) text += '<span class="note-body">' + esc(e.body) + '</span>';
        break;
      case 'task':
        text = m.action === 'done' ? 'Completed <b>' + esc(e.body) + '</b>.' : m.action === 'reopened' ? 'Reopened <b>' + esc(e.body) + '</b>.'
          : 'Scheduled <b>' + esc(e.body) + '</b>' + (m.due ? ' for ' + esc(dueText(m.due)) : '') + '.';
        break;
      case 'policy':
        text = m.action === 'added' ? 'Added a <b>' + esc(e.body) + '</b> policy (' + esc(pStatus(m.status).label) + ').'
          : m.action === 'removed' ? 'Removed the <b>' + esc(e.body) + '</b> policy.'
          : '<b>' + esc(e.body) + '</b> policy moved from ' + esc(pStatus(m.from).label) + ' to <b>' + esc(pStatus(m.status).label) + '</b>.';
        break;
      case 'update':
        var FIELDS = { first_name: 'first name', last_name: 'last name', phone: 'phone', email: 'email', state: 'state', city: 'city', zip: 'ZIP', dob: 'date of birth',
          age: 'age', best_time: 'best time to call', coverage: 'coverage', coverage_type: 'coverage type', temperature: 'temperature', tags: 'tags' };
        var changed = (m.fields || []).filter(function (f) { return f !== 'do_not_contact'; }).map(function (f) { return FIELDS[f] || f; });
        text = (m.do_not_contact === true ? 'Marked <b>Do not contact</b>. ' : m.do_not_contact === false ? 'Turned off Do not contact. ' : '') +
          (changed.length ? 'Updated ' + esc(changed.join(', ')) + '.' : '');
        break;
      case 'path': text = 'Switched to the agent path: ' + esc(e.body || '') + '.'; break;
      case 'note': text = '<span class="note-body">' + esc(e.body) + '</span>'; break;
      case 'file': text = (m.action === 'removed' ? 'Removed file ' : 'Added file ') + '<b>' + esc(e.body || '') + '</b>.'; break;
      default: text = esc(e.body || e.kind);
    }
    return '<li class="tl-' + esc(e.kind) + '"><div class="tl-meta"><b>' + esc(who) + '</b> · <time title="' + esc(fmtDate(e.created_at)) + '">' + esc(ago(e.created_at)) + '</time></div><div class="tl-text">' + text + '</div></li>';
  }

  async function notifyAssign(leadId) {
    try {
      var token = (await sb.auth.getSession()).data.session.access_token;
      await fetch('/.netlify/functions/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'notify-assign', leadId: leadId })
      });
    } catch (e) { /* the assignment itself already saved */ }
  }

  // ---------- shared bits for tasks, policies, client details ----------
  var TEMPS = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };
  function tempDot(t) { return TEMPS[t] ? '<span class="temp temp-' + esc(t) + '" title="' + esc(TEMPS[t]) + ' lead">' + esc(TEMPS[t]) + '</span>' : ''; }
  function tagChips(list) { return (list || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(''); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dayStart(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function isoDay(d) { var x = new Date(d); return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate()); }
  function hhmm(d) { var x = new Date(d); return pad2(x.getHours()) + ':' + pad2(x.getMinutes()); }
  function fmtTime(d) { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  // Date-only values ("2026-11-15") are shown as that calendar day in any time zone.
  function localDay(s) { return s ? new Date(String(s).slice(0, 10) + 'T12:00:00') : null; }
  function fmtDay(s) { return s ? localDay(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
  function parseLocal(day, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
    var p = day.split('-'), q = (time || '09:00').split(':');
    return new Date(+p[0], +p[1] - 1, +p[2], +q[0] || 0, +q[1] || 0);
  }
  function dueText(iso) {
    var d = new Date(iso), days = Math.round((dayStart(d) - dayStart(new Date())) / 86400000);
    var day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
      : days > 1 && days < 7 ? d.toLocaleDateString('en-US', { weekday: 'long' }) : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return day + ' ' + fmtTime(d);
  }
  function money0(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function leadById(id) { return leads.find(function (x) { return x.id === id; }) || null; }
  function fullName(l) { return l ? l.first_name + ' ' + l.last_name : ''; }
  function byName(a, b) { return fullName(a).localeCompare(fullName(b)); }

  // Birthdays. Many carriers price on "age nearest birthday", so the price age goes up
  // about six months after each birthday: a good deadline to get an application in.
  function ageOn(dob, when) {
    var b = localDay(dob), w = when || new Date(), a = w.getFullYear() - b.getFullYear();
    if (w.getMonth() < b.getMonth() || (w.getMonth() === b.getMonth() && w.getDate() < b.getDate())) a--;
    return a;
  }
  function nextBirthday(dob, from) {
    var b = localDay(dob), f = dayStart(from || new Date());
    var n = new Date(f.getFullYear(), b.getMonth(), b.getDate());
    if (n < f) n.setFullYear(n.getFullYear() + 1);
    return n;
  }
  function nextAgeUp(dob, from) {
    var half = localDay(dob);
    half.setMonth(half.getMonth() + 6);
    return nextBirthday(isoDay(half), from);
  }

  // A small dialog. Closes on Escape, the Cancel button ([data-close]) or a click outside.
  function openModal(html, wide) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = '<div class="modal' + (wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    var before = document.activeElement;
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    function close() {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (before && before.focus && document.body.contains(before)) before.focus();
    }
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    $$('[data-close]', wrap).forEach(function (b) { b.addEventListener('click', close); });
    var first = $('.modal input:not([type=hidden]):not([type=radio]), .modal select, .modal textarea', wrap) || $('.modal button', wrap);
    if (first) first.focus();
    return { el: wrap, close: close };
  }
  function fld(label, control, cls) { return '<label class="fld' + (cls ? ' ' + cls : '') + '">' + label + control + '</label>'; }
  function opts(list, current, blank) {
    return (blank != null ? '<option value="">' + esc(blank) + '</option>' : '') + list.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(current == null ? '' : current) ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
  }
  function teamOptions(current, includeMeLabel) {
    return team.filter(function (p) { return p.active || p.id === current; }).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === current ? ' selected' : '') + '>' + esc((p.full_name || p.email) + (includeMeLabel && p.id === me.id ? ' (you)' : '')) + '</option>';
    }).join('');
  }

  var STATES = [['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
    ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
    ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
    ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
    ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
    ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
    ['WI', 'Wisconsin'], ['WY', 'Wyoming']];

  // ---------- tasks & appointments ----------
  var TASK_KINDS = { call: 'Call', text: 'Text', email: 'Email', appointment: 'Appointment', todo: 'To-do' };
  var PRESETS = [['hour', 'In 1 hour'], ['today', 'Today 5 PM'], ['tomorrow', 'Tomorrow 9 AM'], ['2days', 'In 2 days'], ['week', 'Next Monday 9 AM']];
  function presetDue(key) {
    var d = new Date();
    if (key === 'hour') { d.setMinutes(Math.ceil((d.getMinutes() + 60) / 15) * 15, 0, 0); return d; }
    if (key === 'today') { d.setHours(17, 0, 0, 0); return d; }
    if (key === 'tomorrow') d.setDate(d.getDate() + 1);
    if (key === '2days') d.setDate(d.getDate() + 2);
    if (key === 'week') d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d;
  }
  function presetsNow() { return PRESETS.filter(function (p) { return p[0] !== 'today' || new Date().getHours() < 16; }); }

  function openTasks() { return tasks.filter(function (t) { return !t.done_at; }); }
  function myOpenTasks() { return openTasks().filter(function (t) { return t.assigned_to === me.id; }); }
  function byDue(a, b) { return a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0; }
  function nextTaskFor(leadId) { return openTasks().filter(function (t) { return t.lead_id === leadId; }).sort(byDue)[0] || null; }
  function isOverdue(t) { return !t.done_at && new Date(t.due_at).getTime() < Date.now(); }
  function nextTaskLabel(leadId) {
    var t = nextTaskFor(leadId);
    if (!t) return '';
    return '<span class="next' + (isOverdue(t) ? ' over' : '') + '">' + esc(TASK_KINDS[t.kind]) + ' ' + esc(isOverdue(t) ? 'overdue' : dueText(t.due_at)) + '</span>';
  }

  function updateTaskBadge() {
    var b = $('#nav-tasks');
    if (!b || !me) return;
    var end = dayStart(new Date()).getTime() + 86400000;
    var n = myOpenTasks().filter(function (t) { return new Date(t.due_at).getTime() < end; }).length;
    b.textContent = n;
    b.hidden = !n;
  }

  // While the dashboard is open, pop up a reminder when one of my tasks comes due.
  var remindedNow = {};
  function checkDueTasks() {
    if (!me) return;
    var now = Date.now();
    myOpenTasks().forEach(function (t) {
      var due = new Date(t.due_at).getTime();
      if (due <= now && now - due < 10 * 60000 && !remindedNow[t.id]) {
        remindedNow[t.id] = 1;
        var l = leadById(t.lead_id);
        toast('Due now: ' + t.title + (l && t.title.indexOf(l.first_name) === -1 ? ' (' + fullName(l) + ')' : ''), 'ok');
      }
    });
    updateTaskBadge();
  }

  // Tasks and policies load alongside the leads. If those tables aren't set up yet
  // (part 5 of the database setup), the rest of the dashboard still works.
  var extrasMissing = false;
  async function loadExtras() {
    var since = new Date(Date.now() - 30 * 86400000).toISOString();
    var res = await Promise.all([
      timed(sb.from('tasks').select('*').or('done_at.is.null,done_at.gt.' + since).order('due_at', { ascending: true }).limit(3000)),
      timed(sb.from('policies').select('*').order('created_at', { ascending: false }).limit(3000))
    ]);
    extrasMissing = !!(res[0].error || res[1].error);
    if (!res[0].error) tasks = res[0].data || [];
    if (!res[1].error) policies = res[1].data || [];
    updateTaskBadge();
  }

  function taskTitle(kind, l) {
    var who = l ? ' ' + fullName(l) : '';
    return { call: 'Call', text: 'Text', email: 'Email', appointment: 'Appointment with', todo: 'Follow up with' }[kind] + who;
  }

  // New or edit task. opts: { task, leadId, lead, kind, due, onSave }
  function taskModal(o) {
    o = o || {};
    var t = o.task || null;
    var leadId = t ? t.lead_id : (o.leadId || '');
    var lead = o.lead || (leadId ? leadById(leadId) : null);
    var kind = t ? t.kind : (o.kind || 'call');
    var due = t ? new Date(t.due_at) : (o.due || presetDue('tomorrow'));
    var who = t ? t.assigned_to : (isAdmin() && lead && lead.assigned_to ? lead.assigned_to : me.id);
    var pickLead = !t && !leadId;
    var choices = pickLead ? leads.filter(function (l) { return !isArchived(l); }).sort(byName) : [];
    var m = openModal('<h2>' + (t ? 'Edit task' : 'New task') + '</h2>' + (lead ? '<p class="muted modal-sub">For <b>' + esc(fullName(lead)) + '</b></p>' : '') +
      '<form class="mform" novalidate>' +
      '<div class="kind-pick" role="radiogroup" aria-label="Type">' + Object.keys(TASK_KINDS).map(function (k) {
        return '<label><input type="radio" name="kind" value="' + k + '"' + (k === kind ? ' checked' : '') + '><span>' + TASK_KINDS[k] + '</span></label>';
      }).join('') + '</div>' +
      fld('What needs to happen', '<input name="what" maxlength="200" autocomplete="off" value="' + esc(t ? t.title : taskTitle(kind, lead)) + '">') +
      (pickLead ? fld('Lead <span class="opt">(optional)</span>', '<select name="lead"><option value="">No lead</option>' + choices.map(function (l) {
        return '<option value="' + esc(l.id) + '">' + esc(fullName(l)) + '</option>';
      }).join('') + '</select>') : '') +
      '<div class="fld"><span>When</span><div class="chips">' + presetsNow().map(function (p) {
        return '<button type="button" class="chip-btn" data-preset="' + p[0] + '">' + esc(p[1]) + '</button>';
      }).join('') + '</div>' +
      '<div class="two"><input type="date" name="d" aria-label="Date" value="' + isoDay(due) + '"><input type="time" name="tm" aria-label="Time" step="300" value="' + hhmm(due) + '"></div></div>' +
      (isAdmin() ? fld('Assigned to', '<select name="who">' + teamOptions(who, true) + '</select>') : '') +
      fld('Notes <span class="opt">(optional)</span>', '<textarea name="notes" rows="2" maxlength="2000">' + esc(t ? t.notes : '') + '</textarea>') +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="submit">' + (t ? 'Save' : 'Add task') + '</button>' +
      '<button class="btn btn-ghost" type="button" data-close>Cancel</button>' +
      (t ? '<button class="ad-link-btn danger" type="button" data-remove>Remove task</button>' : '') + '</div></form>');
    var f = $('form', m.el), touched = !!t;
    var curLead = function () { return f.lead ? leadById(f.lead.value) : lead; };
    f.what.addEventListener('input', function () { touched = true; });
    $$('input[name=kind]', f).forEach(function (r) {
      r.addEventListener('change', function () { if (!touched) f.what.value = taskTitle(r.value, curLead()); });
    });
    if (f.lead) f.lead.addEventListener('change', function () {
      if (!touched) f.what.value = taskTitle(f.kind.value, curLead());
      var l = curLead();
      if (f.who && l && l.assigned_to) f.who.value = l.assigned_to;
    });
    $$('[data-preset]', f).forEach(function (b) {
      b.addEventListener('click', function () {
        var d = presetDue(b.getAttribute('data-preset'));
        f.d.value = isoDay(d);
        f.tm.value = hhmm(d);
        $$('[data-preset]', f).forEach(function (x) { x.classList.toggle('on', x === b); });
      });
    });
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      var when = parseLocal(f.d.value, f.tm.value);
      if (!f.what.value.trim()) return formError(f, 'Say what needs to happen.');
      if (!when) return formError(f, 'Pick a date and time.');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Saving…');
      var r = await sb.rpc('task_save', {
        p_id: t ? t.id : null, p_lead: t ? null : ((f.lead ? f.lead.value : leadId) || null), p_kind: f.kind.value,
        p_title: f.what.value.trim(), p_notes: f.notes.value, p_due: when.toISOString(), p_assignee: f.who ? f.who.value : (t ? t.assigned_to : me.id)
      });
      busy(btn, false);
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      toast(t ? 'Task saved.' : 'Task added for ' + dueText(when) + '.', 'ok');
      await loadExtras().catch(function () {});
      if (o.onSave) o.onSave();
    });
    var rm = $('[data-remove]', f);
    if (rm) rm.addEventListener('click', async function () {
      if (!confirm('Remove this task?')) return;
      var r = await sb.rpc('task_remove', { p_id: t.id });
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      tasks = tasks.filter(function (x) { return x.id !== t.id; });
      updateTaskBadge();
      toast('Task removed.', 'ok');
      if (o.onSave) o.onSave();
    });
  }

  function taskItem(t, o) {
    o = o || {};
    var over = isOverdue(t), l = t.lead_id ? leadById(t.lead_id) : null;
    var tel = l && !l.do_not_contact ? phone10(l.phone) : '';
    var bits = [];
    if (!o.noLead && t.lead_id) bits.push(l ? '<a href="#/lead/' + esc(l.id) + '">' + esc(fullName(l)) + '</a>' : 'a lead');
    bits.push('<span class="' + (over ? 'over' : '') + '">' + esc(t.done_at ? 'Done ' + ago(t.done_at) : (over ? 'Overdue · ' : '') + (o.timeOnly ? fmtTime(t.due_at) : dueText(t.due_at))) + '</span>');
    if (isAdmin() && t.assigned_to !== me.id) bits.push(esc(personName(t.assigned_to) || 'Unassigned'));
    return '<li class="task' + (over ? ' is-over' : '') + (t.done_at ? ' is-done' : '') + '" data-task="' + esc(t.id) + '">' +
      '<input type="checkbox" class="tk-check" data-done aria-label="Mark ' + esc(t.title) + ' as done"' + (t.done_at ? ' checked' : '') + '>' +
      '<span class="tk-kind tk-' + esc(t.kind) + '">' + esc(TASK_KINDS[t.kind] || t.kind) + '</span>' +
      '<div class="tk-main"><b>' + esc(t.title) + '</b><small>' + bits.join(' · ') + '</small>' +
      (t.notes && !o.compact ? '<span class="tk-notes">' + esc(t.notes) + '</span>' : '') + '</div>' +
      '<div class="tk-acts">' + (tel && !t.done_at && t.kind === 'call' && !o.compact ? '<a class="btn btn-ghost btn-sm" href="tel:+1' + esc(tel) + '" data-call="' + esc(l.id) + '">Call</a>' : '') +
      '<button type="button" class="ad-link-btn" data-edit>Edit</button></div></li>';
  }

  function bindTasks(root, after) {
    $$('li[data-task]', root).forEach(function (li) {
      var t = tasks.find(function (x) { return x.id === li.getAttribute('data-task'); });
      if (!t) return;
      $('[data-done]', li).addEventListener('change', async function (e) {
        var done = e.target.checked;
        li.classList.toggle('is-done', done);
        var r = await sb.rpc('task_set_done', { p_id: t.id, p_done: done });
        if (r.error) { e.target.checked = !done; li.classList.toggle('is-done', !done); return toast(niceError(r.error), 'err'); }
        t.done_at = done ? new Date().toISOString() : null;
        updateTaskBadge();
        toast(done ? 'Done. Nice work.' : 'Task reopened.', 'ok');
        setTimeout(after, 500);
      });
      $('[data-edit]', li).addEventListener('click', function () { taskModal({ task: t, onSave: after }); });
      var call = $('[data-call]', li);
      if (call) call.addEventListener('click', function () { sb.rpc('lead_log_contact', { p_lead: call.getAttribute('data-call'), p_via: 'call' }); });
    });
  }

  var taskView = { show: 'open', who: 'me', kind: '', mode: savedPref('lq_crm_tasks', 'list'), weekStart: null };

  async function showTasks() {
    render('<div class="ad-loading">Loading tasks…</div>');
    try { await loadLeads(); } catch (e) { return showLoadError(e); }
    startRefresh();
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Tasks</h1><p class="muted" id="task-sum"></p></div>' +
      '<div class="head-actions"><div class="seg" role="group" aria-label="View">' +
      '<button type="button" data-tmode="list">List</button><button type="button" data-tmode="week">Week</button></div>' +
      '<button class="btn btn-primary" type="button" id="new-task">New task</button></div></div>' +
      (extrasMissing ? setupNote() : '') +
      '<div class="filters">' +
      '<select id="t-show" aria-label="Show"><option value="open">To do</option><option value="done">Done (last 30 days)</option></select>' +
      (isAdmin() ? '<select id="t-who" aria-label="Whose tasks"><option value="me">My tasks</option><option value="all">Everyone’s tasks</option>' +
        team.filter(function (p) { return p.id !== me.id && p.active; }).map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.full_name || p.email) + '</option>'; }).join('') + '</select>' : '') +
      '<select id="t-kind" aria-label="Type"><option value="">All types</option>' + Object.keys(TASK_KINDS).map(function (k) { return '<option value="' + k + '">' + TASK_KINDS[k] + '</option>'; }).join('') + '</select>' +
      '</div><div id="task-rows"></div></div>');
    $('#t-show', main).value = taskView.show;
    $('#t-kind', main).value = taskView.kind;
    if ($('#t-who', main)) $('#t-who', main).value = taskView.who;
    $('#t-show', main).addEventListener('change', function (e) { taskView.show = e.target.value; drawTasks(); });
    $('#t-kind', main).addEventListener('change', function (e) { taskView.kind = e.target.value; drawTasks(); });
    if ($('#t-who', main)) $('#t-who', main).addEventListener('change', function (e) { taskView.who = e.target.value; drawTasks(); });
    $$('[data-tmode]', main).forEach(function (b) {
      b.addEventListener('click', function () { taskView.mode = b.getAttribute('data-tmode'); savePref('lq_crm_tasks', taskView.mode); drawTasks(); });
    });
    $('#new-task', main).addEventListener('click', function () { taskModal({ onSave: drawTasks }); });
    drawTasks();
  }

  function setupNote() {
    return '<div class="archived-note">Tasks and policies need one more database step. An admin needs to run <code>supabase/parts/5-agent-tools.sql</code> in Supabase.</div>';
  }

  function taskFilter() {
    return tasks.filter(function (t) {
      if (taskView.kind && t.kind !== taskView.kind) return false;
      if (!isAdmin() || taskView.who === 'me') return t.assigned_to === me.id || (!isAdmin() && t.created_by === me.id);
      if (taskView.who === 'all') return true;
      return t.assigned_to === taskView.who;
    });
  }

  function drawTasks() {
    var box = $('#task-rows');
    if (!box) return;
    $$('[data-tmode]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-tmode') === taskView.mode ? 'true' : 'false'); });
    $('#t-show').hidden = taskView.mode === 'week';
    var list = taskFilter();
    var open = list.filter(function (t) { return !t.done_at; });
    var over = open.filter(isOverdue).length;
    $('#task-sum').textContent = plural(open.length, 'open task') + (over ? ' · ' + over + ' overdue' : '') + ' · reminders go out by email/text when one is due';
    if (taskView.mode === 'week') return drawWeek(box, list);

    var groups;
    if (taskView.show === 'done') {
      groups = [{ key: 'done', label: 'Done', items: list.filter(function (t) { return t.done_at; }).sort(function (a, b) { return a.done_at < b.done_at ? 1 : -1; }) }];
    } else {
      var today = dayStart(new Date()).getTime(), DAY = 86400000;
      var when = function (t) { return new Date(t.due_at).getTime(); };
      open.sort(byDue);
      groups = [
        { key: 'over', label: 'Overdue', items: open.filter(isOverdue) },
        { key: 'today', label: 'Today', items: open.filter(function (t) { return !isOverdue(t) && when(t) < today + DAY; }) },
        { key: 'tomorrow', label: 'Tomorrow', items: open.filter(function (t) { return when(t) >= today + DAY && when(t) < today + 2 * DAY; }) },
        { key: 'week', label: 'Next 7 days', items: open.filter(function (t) { return when(t) >= today + 2 * DAY && when(t) < today + 8 * DAY; }) },
        { key: 'later', label: 'Later', items: open.filter(function (t) { return when(t) >= today + 8 * DAY; }) }
      ];
    }
    var html = groups.map(function (g) {
      if (!g.items.length) return '';
      return '<section class="tgroup tg-' + g.key + '"><h2>' + esc(g.label) + ' <span class="muted">' + g.items.length + '</span></h2>' +
        '<ul class="tasks">' + g.items.map(function (t) { return taskItem(t); }).join('') + '</ul></section>';
    }).join('');
    box.innerHTML = html || '<div class="empty"><p><b>' + (taskView.show === 'done' ? 'Nothing done in the last 30 days.' : 'You’re all caught up.') + '</b></p>' +
      '<p class="muted">Add follow-ups from a lead’s page or with New task. You’ll get a reminder when each one is due.</p></div>';
    bindTasks(box, drawTasks);
  }

  // A simple 7-day calendar of tasks and appointments.
  function drawWeek(box, list) {
    var start = taskView.weekStart || dayStart(new Date()), DAY = 86400000;
    var days = [];
    for (var i = 0; i < 7; i++) days.push(new Date(start.getTime() + i * DAY));
    var todayKey = isoDay(new Date());
    var label = days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' + days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    box.innerHTML = '<div class="week-nav"><button type="button" class="btn btn-ghost btn-sm" data-wk="-7">← Back</button><b>' + esc(label) + '</b>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-wk="7">Next →</button><button type="button" class="ad-link-btn" data-wk="0">This week</button></div>' +
      '<div class="week">' + days.map(function (d) {
        var key = isoDay(d);
        var items = list.filter(function (t) { return isoDay(t.due_at) === key; }).sort(byDue);
        return '<section class="wday' + (key === todayKey ? ' is-today' : '') + '"><h3>' + esc(d.toLocaleDateString('en-US', { weekday: 'short' })) +
          ' <small>' + esc(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</small></h3>' +
          (items.length ? '<ul class="tasks tasks-mini">' + items.map(function (t) { return taskItem(t, { compact: true, timeOnly: true }); }).join('') + '</ul>' : '<p class="wempty">Nothing planned</p>') +
          '<button type="button" class="ad-link-btn" data-add-day="' + key + '">+ Add</button></section>';
      }).join('') + '</div>';
    $$('[data-wk]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var n = +b.getAttribute('data-wk');
        taskView.weekStart = n ? new Date((taskView.weekStart || dayStart(new Date())).getTime() + n * DAY) : null;
        drawTasks();
      });
    });
    $$('[data-add-day]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var d = parseLocal(b.getAttribute('data-add-day'), '10:00');
        taskModal({ due: d, onSave: drawTasks });
      });
    });
    bindTasks(box, drawTasks);
  }

  // ---------- policies (pending business) ----------
  var POLICY_STATUSES = [
    { key: 'submitted', label: 'Submitted', group: 'pending' },
    { key: 'underwriting', label: 'In underwriting', group: 'pending' },
    { key: 'approved', label: 'Approved', group: 'pending' },
    { key: 'issued', label: 'Issued, not yet paid', group: 'pending' },
    { key: 'in_force', label: 'In force (paid)', group: 'active' },
    { key: 'declined', label: 'Declined', group: 'closed' },
    { key: 'withdrawn', label: 'Withdrawn / not taken', group: 'closed' },
    { key: 'lapsed', label: 'Lapsed', group: 'closed' }
  ];
  var PMODES = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['semiannual', 'Every 6 months'], ['annual', 'Yearly'], ['single', 'Single payment']];
  var PMODE_SHORT = { monthly: '/mo', quarterly: '/qtr', semiannual: '/6 mo', annual: '/yr', single: ' once' };
  var PMODE_X = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1, single: 1 };
  var POLICY_TYPES = ['Term', 'Whole life', 'Universal life', 'Indexed universal life (IUL)', 'Guaranteed universal life (GUL)', 'Final expense',
    'Return of premium term', 'Mortgage protection', 'Annuity', 'Other'];
  var RATE_CLASSES = ['Preferred Plus', 'Preferred', 'Standard Plus', 'Standard', 'Preferred Tobacco', 'Standard Tobacco', 'Table rated', 'Graded / modified', 'Guaranteed issue'];
  var CARRIERS = ['American General (Corebridge)', 'Americo', 'Assurity', 'Banner Life (Legal & General)', 'Ethos', 'Fidelity & Guaranty (F&G)', 'Foresters Financial',
    'Gerber Life', 'John Hancock', 'Lincoln Financial', 'Mutual of Omaha', 'Nationwide', 'North American', 'Pacific Life', 'Principal', 'Protective', 'Prudential',
    'Royal Neighbors of America', 'SBLI', 'Securian (Minnesota Life)', 'Symetra', 'Transamerica', 'United Home Life', 'William Penn'];
  var REQS = ['Signed application', 'Phone interview', 'Paramed exam', 'Labs (blood/urine)', 'APS (doctor records)', 'HIPAA authorization', 'Replacement forms',
    'Bank draft form', 'Delivery receipt', 'First premium collected'];

  function pStatus(key) { return POLICY_STATUSES.find(function (s) { return s.key === key; }) || { key: key, label: key, group: 'pending' }; }
  function pChip(key) { return '<span class="pchip ps-' + esc(key) + '">' + esc(pStatus(key).label) + '</span>'; }
  function annual(p) { return Number(p.annual_premium) || 0; }
  function commission(p) { return p.commission_pct ? annual(p) * Number(p.commission_pct) / 100 : 0; }
  function reqsLeft(p) { return (p.requirements || []).filter(function (r) { return !r.done; }); }
  function premiumText(p) { return p.modal_premium ? '$' + Number(p.modal_premium).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (PMODE_SHORT[p.payment_mode] || '') : ''; }
  function inPolicyStatusDays(p) { return Math.floor((Date.now() - new Date(p.status_changed_at).getTime()) / 86400000); }
  function policyStatusOptions(current) {
    return [['pending', 'Pending'], ['active', 'Placed'], ['closed', 'Closed']].map(function (g) {
      return '<optgroup label="' + g[1] + '">' + POLICY_STATUSES.filter(function (s) { return s.group === g[0]; }).map(function (s) {
        return '<option value="' + s.key + '"' + (s.key === current ? ' selected' : '') + '>' + esc(s.label) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }
  // Everything policy_save needs, from a saved row, with optional changes.
  function policyPayload(p, change) {
    var out = {};
    ['carrier', 'product', 'policy_type', 'term_years', 'policy_number', 'face_amount', 'modal_premium', 'payment_mode', 'status',
      'submitted_on', 'effective_on', 'rate_class', 'beneficiary', 'commission_pct', 'writing_agent', 'notes'].forEach(function (k) {
      out[k] = p[k] == null ? '' : String(p[k]);
    });
    out.requirements = p.requirements || [];
    return Object.assign(out, change || {});
  }

  async function savePolicyStatus(p, status, after) {
    var r = await sb.rpc('policy_save', { p_id: p.id, p_lead: null, p: policyPayload(p, { status: status }) });
    if (r.error) { toast(niceError(r.error), 'err'); return after(); }
    toast(p.carrier + ' policy: ' + pStatus(status).label + '.', 'ok');
    await Promise.all([loadExtras(), loadLeads()]).catch(function () {});
    after();
  }

  // Add or edit a policy. o: { policy, leadId, lead, onSave }
  function policyModal(o) {
    var p = o.policy || {}, isNew = !o.policy;
    var lead = o.lead || leadById(p.lead_id || o.leadId);
    var reqs = (isNew ? [{ label: 'Signed application', done: true }] : (p.requirements || [])).map(function (r) { return { label: r.label, done: !!r.done }; });
    var terms = [10, 15, 20, 25, 30, 35, 40].map(function (n) { return [n, n + ' years']; });
    var types = POLICY_TYPES.slice();
    if (p.policy_type && types.indexOf(p.policy_type) === -1) types.push(p.policy_type);
    var classes = RATE_CLASSES.slice();
    if (p.rate_class && classes.indexOf(p.rate_class) === -1) classes.push(p.rate_class);
    var m = openModal('<h2>' + (isNew ? 'Add a policy' : 'Edit policy') + '</h2>' + (lead ? '<p class="muted modal-sub">For <b>' + esc(fullName(lead)) + '</b></p>' : '') +
      '<form class="mform" novalidate><div class="grid2">' +
      fld('Carrier', '<input name="carrier" list="carrier-list" autocomplete="off" required value="' + esc(p.carrier || '') + '">') +
      '<datalist id="carrier-list">' + CARRIERS.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
      fld('Product name <span class="opt">(optional)</span>', '<input name="product" autocomplete="off" placeholder="e.g. Term 20" value="' + esc(p.product || '') + '">') +
      fld('Type', '<select name="policy_type">' + opts(types, p.policy_type || (isNew ? 'Term' : ''), '—') + '</select>') +
      fld('Term length', '<select name="term_years">' + opts(terms, p.term_years, '—') + '</select>') +
      fld('Face amount', '<input name="face_amount" inputmode="numeric" placeholder="$500,000" value="' + esc(p.face_amount ? money(p.face_amount) : (isNew && lead && lead.coverage ? money(lead.coverage) : '')) + '">') +
      '<div class="fld"><span>Premium</span><div class="two"><input name="modal_premium" inputmode="decimal" aria-label="Premium amount" placeholder="$45.00" value="' + esc(p.modal_premium || '') + '">' +
      '<select name="payment_mode" aria-label="How often">' + opts(PMODES, p.payment_mode || 'monthly') + '</select></div></div>' +
      fld('Status', '<select name="status">' + policyStatusOptions(p.status || 'submitted') + '</select>') +
      fld('Policy number <span class="opt">(when issued)</span>', '<input name="policy_number" autocomplete="off" value="' + esc(p.policy_number || '') + '">') +
      fld('Application submitted', '<input type="date" name="submitted_on" value="' + esc(p.submitted_on || (isNew ? isoDay(new Date()) : '')) + '">') +
      fld('Effective date', '<input type="date" name="effective_on" value="' + esc(p.effective_on || '') + '">') +
      fld('Rate class', '<select name="rate_class">' + opts(classes, p.rate_class, 'Not known yet') + '</select>') +
      fld('Beneficiary', '<input name="beneficiary" autocomplete="off" placeholder="e.g. Raj Shah (spouse)" value="' + esc(p.beneficiary || '') + '">') +
      fld('First-year commission %', '<input name="commission_pct" inputmode="decimal" placeholder="e.g. 90" value="' + esc(p.commission_pct || '') + '"><small class="hint" id="comm-est"></small>') +
      (isAdmin() ? fld('Writing agent', '<select name="writing_agent">' + teamOptions(p.writing_agent || (lead && lead.assigned_to) || me.id, true) + '</select>') : '') +
      '</div>' +
      '<fieldset class="reqs"><legend>Underwriting requirements</legend><ul class="req-list" id="req-list"></ul>' +
      '<div class="req-add"><input id="req-new" list="req-dl" placeholder="Add a requirement" aria-label="Add a requirement"><button type="button" class="btn btn-ghost btn-sm" id="req-add">Add</button></div>' +
      '<datalist id="req-dl">' + REQS.map(function (r) { return '<option value="' + esc(r) + '">'; }).join('') + '</datalist>' +
      '<div class="chips" id="req-chips"></div></fieldset>' +
      fld('Notes <span class="opt">(optional)</span>', '<textarea name="notes" rows="2" maxlength="4000">' + esc(p.notes || '') + '</textarea>') +
      '<p class="hint">Don’t enter SSNs, bank or card numbers, or health details here.</p>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="submit">' + (isNew ? 'Add policy' : 'Save') + '</button>' +
      '<button class="btn btn-ghost" type="button" data-close>Cancel</button>' +
      (isNew ? '' : '<button class="ad-link-btn danger" type="button" data-remove>Remove policy</button>') + '</div></form>', true);
    var f = $('form', m.el);

    function drawReqs() {
      $('#req-list', f).innerHTML = reqs.length ? reqs.map(function (r, i) {
        return '<li><label class="check"><input type="checkbox" data-i="' + i + '"' + (r.done ? ' checked' : '') + '> <span>' + esc(r.label) + '</span></label>' +
          '<button type="button" class="ad-link-btn" data-x="' + i + '" aria-label="Remove ' + esc(r.label) + '">Remove</button></li>';
      }).join('') : '<li class="muted">No requirements yet.</li>';
      var have = reqs.map(function (r) { return r.label.toLowerCase(); });
      $('#req-chips', f).innerHTML = REQS.filter(function (r) { return have.indexOf(r.toLowerCase()) === -1; }).map(function (r) {
        return '<button type="button" class="chip-btn" data-req="' + esc(r) + '">+ ' + esc(r) + '</button>';
      }).join('');
      $$('[data-i]', f).forEach(function (c) { c.addEventListener('change', function () { reqs[+c.getAttribute('data-i')].done = c.checked; }); });
      $$('[data-x]', f).forEach(function (b) { b.addEventListener('click', function () { reqs.splice(+b.getAttribute('data-x'), 1); drawReqs(); }); });
      $$('[data-req]', f).forEach(function (b) { b.addEventListener('click', function () { reqs.push({ label: b.getAttribute('data-req'), done: false }); drawReqs(); }); });
    }
    function addReq() {
      var v = $('#req-new', f).value.trim();
      if (!v) return;
      reqs.push({ label: v.slice(0, 120), done: false });
      $('#req-new', f).value = '';
      drawReqs();
    }
    $('#req-add', f).addEventListener('click', addReq);
    $('#req-new', f).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addReq(); } });
    drawReqs();

    function num(v) { return Number(String(v || '').replace(/[^0-9.]/g, '')) || 0; }
    function estimate() {
      var yearly = num(f.modal_premium.value) * PMODE_X[f.payment_mode.value];
      var pct = num(f.commission_pct.value);
      $('#comm-est', f).textContent = yearly ? money0(yearly) + ' a year' + (pct ? ' · about ' + money0(yearly * pct / 100) + ' first-year commission' : '') : '';
    }
    ['input', 'change'].forEach(function (ev) { f.addEventListener(ev, estimate); });
    estimate();

    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      if (!f.carrier.value.trim()) return formError(f, 'Enter the carrier.');
      var payload = {
        carrier: f.carrier.value.trim(), product: f.product.value, policy_type: f.policy_type.value, term_years: f.term_years.value,
        face_amount: String(num(f.face_amount.value) || ''), modal_premium: String(num(f.modal_premium.value) || ''), payment_mode: f.payment_mode.value,
        status: f.status.value, policy_number: f.policy_number.value, submitted_on: f.submitted_on.value, effective_on: f.effective_on.value,
        rate_class: f.rate_class.value, beneficiary: f.beneficiary.value, commission_pct: String(num(f.commission_pct.value) || ''),
        requirements: reqs, notes: f.notes.value
      };
      if (f.writing_agent) payload.writing_agent = f.writing_agent.value;
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Saving…');
      var r = await sb.rpc('policy_save', { p_id: isNew ? null : p.id, p_lead: isNew ? (lead ? lead.id : o.leadId) : null, p: payload });
      busy(btn, false);
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      toast(isNew ? 'Policy added.' : 'Policy saved.', 'ok');
      await Promise.all([loadExtras(), loadLeads()]).catch(function () {});
      if (o.onSave) o.onSave();
    });
    var rm = $('[data-remove]', f);
    if (rm) rm.addEventListener('click', async function () {
      if (!confirm('Remove this ' + p.carrier + ' policy? Use this for mistakes. For a declined or lapsed policy, change its status instead.')) return;
      var r = await sb.rpc('policy_remove', { p_id: p.id });
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      toast('Policy removed.', 'ok');
      await loadExtras().catch(function () {});
      if (o.onSave) o.onSave();
    });
  }

  function policyCard(p) {
    var left = reqsLeft(p), total = (p.requirements || []).length;
    return '<li class="pol" data-pol="' + esc(p.id) + '" tabindex="0">' +
      '<div class="pol-top"><b>' + esc(p.carrier) + '</b>' + pChip(p.status) + '</div>' +
      '<div class="pol-meta">' + esc([p.product, p.policy_type, p.term_years ? p.term_years + ' yr' : ''].filter(Boolean).join(' · ') || 'Product not entered') + '</div>' +
      '<div class="pol-nums">' + (p.face_amount ? '<span><small>Face</small>' + esc(money(Math.round(p.face_amount))) + '</span>' : '') +
      (p.modal_premium ? '<span><small>Premium</small>' + esc(premiumText(p)) + '</span>' : '') +
      (p.policy_number ? '<span><small>Policy #</small>' + esc(p.policy_number) + '</span>' : '') + '</div>' +
      (total && pStatus(p.status).group === 'pending' ? '<div class="pol-req' + (left.length ? '' : ' ok') + '">' +
        (left.length ? esc(left.length + ' of ' + total + ' requirements open: ' + left.slice(0, 2).map(function (r) { return r.label; }).join(', ') + (left.length > 2 ? '…' : '')) : 'All requirements done') + '</div>' : '') +
      '</li>';
  }

  var polView = { tab: 'pending', q: '', agent: '' };

  async function showPolicies() {
    render('<div class="ad-loading">Loading policies…</div>');
    try { await loadLeads(); } catch (e) { return showLoadError(e); }
    startRefresh();
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Policies</h1><p class="muted">Pending business and policies in force. Add a policy from a lead’s page.</p></div></div>' +
      (extrasMissing ? setupNote() : '') +
      '<div class="tiles tiles-4" id="pol-tiles"></div>' +
      '<div class="tabs" role="tablist" id="pol-tabs"></div>' +
      '<div class="filters"><input type="search" id="p-q" placeholder="Search client, carrier or policy number" aria-label="Search policies">' +
      (isAdmin() ? '<select id="p-agent" aria-label="Writing agent"><option value="">All agents</option>' + teamOptions('') + '</select>' : '') + '</div>' +
      '<div id="pol-rows"></div></div>');
    $('#p-q', main).value = polView.q;
    $('#p-q', main).addEventListener('input', function (e) { polView.q = e.target.value; drawPolicies(); });
    if ($('#p-agent', main)) { $('#p-agent', main).value = polView.agent; $('#p-agent', main).addEventListener('change', function (e) { polView.agent = e.target.value; drawPolicies(); }); }
    drawPolicies();
  }

  function drawPolicies() {
    var box = $('#pol-rows');
    if (!box) return;
    var mine = policies.filter(function (p) { return !polView.agent || p.writing_agent === polView.agent; });
    var pending = mine.filter(function (p) { return pStatus(p.status).group === 'pending'; });
    var monthStart = startOf('month'), yearStart = new Date(new Date().getFullYear(), 0, 1);
    var placedMonth = mine.filter(function (p) { return p.status === 'in_force' && p.placed_on && localDay(p.placed_on) >= monthStart; });
    var paidYear = mine.filter(function (p) { return (p.status === 'in_force') && p.placed_on && localDay(p.placed_on) >= yearStart; });
    var openReqs = pending.reduce(function (n, p) { return n + reqsLeft(p).length; }, 0);
    var sum = function (list, fn) { return list.reduce(function (s, p) { return s + fn(p); }, 0); };
    function tile(label, value, sub, tone) {
      return '<div class="tile' + (tone ? ' tile-' + tone : '') + '"><span class="tile-label">' + esc(label) + '</span><span class="tile-value">' + esc(value) + '</span><span class="tile-sub">' + esc(sub) + '</span></div>';
    }
    $('#pol-tiles').innerHTML =
      tile('Pending business', String(pending.length), money0(sum(pending, annual)) + ' annual premium', pending.length ? 'gold' : '') +
      tile('Open requirements', String(openReqs), openReqs ? 'Across pending policies' : 'Nothing waiting', openReqs ? 'alert' : '') +
      tile('Placed this month', money0(sum(placedMonth, annual)), plural(placedMonth.length, 'policy', 'policies') + ' · annual premium', placedMonth.length ? 'good' : '') +
      tile('Est. commission this year', money0(sum(paidYear, commission)), 'First-year, on paid policies');

    var tabs = [['pending', 'Pending'], ['active', 'In force'], ['closed', 'Closed'], ['all', 'All']];
    $('#pol-tabs').innerHTML = tabs.map(function (t) {
      var n = t[0] === 'all' ? mine.length : mine.filter(function (p) { return pStatus(p.status).group === t[0]; }).length;
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (polView.tab === t[0]) + '">' + t[1] + ' <i>' + n + '</i></button>';
    }).join('');
    $$('[data-tab]', $('#pol-tabs')).forEach(function (b) { b.addEventListener('click', function () { polView.tab = b.getAttribute('data-tab'); drawPolicies(); }); });

    var q = polView.q.trim().toLowerCase();
    var list = mine.filter(function (p) {
      if (polView.tab !== 'all' && pStatus(p.status).group !== polView.tab) return false;
      if (!q) return true;
      return hit(fullName(leadById(p.lead_id)), q) || hit(p.carrier, q) || hit(p.policy_number, q) || hit(p.product, q);
    });
    if (!policies.length) {
      box.innerHTML = '<div class="empty"><p><b>No policies yet.</b></p><p class="muted">When a client applies, open their lead and choose <b>Add policy</b>. Track the carrier, premium, underwriting requirements and commission here.</p></div>';
      return;
    }
    var head = '<thead><tr><th class="c-name">Client</th><th>Carrier</th><th>Face</th><th>Premium</th><th class="c-stage">Status</th><th>In status</th><th>Requirements</th>' +
      (isAdmin() ? '<th>Agent</th>' : '') + '</tr></thead>';
    var shown = POLICY_STATUSES.filter(function (s) { return list.some(function (p) { return p.status === s.key; }); });
    box.innerHTML = shown.map(function (s) {
      var items = list.filter(function (p) { return p.status === s.key; });
      return '<section class="grp ps-' + s.key + '"><div class="grp-head grp-static"><span class="grp-name">' + esc(s.label) + '</span>' +
        '<span class="grp-count">' + plural(items.length, 'policy', 'policies') + '</span><span class="grp-sum">' + money0(sum(items, annual)) + '/yr</span></div>' +
        '<div class="grp-body"><div class="table-wrap"><table class="leads pols">' + head + '<tbody>' + items.map(function (p) {
          var l = leadById(p.lead_id), left = reqsLeft(p), total = (p.requirements || []).length, days = inPolicyStatusDays(p);
          var slow = s.group === 'pending' && days > 30;
          return '<tr data-pol="' + esc(p.id) + '" tabindex="0">' +
            '<td data-label="Client">' + (l ? '<a class="lead-name" href="#/lead/' + esc(l.id) + '">' + esc(fullName(l)) + '</a>' : '<span class="muted">Hidden lead</span>') +
            '<small>' + esc(p.policy_number ? 'Policy # ' + p.policy_number : 'No policy number yet') + '</small></td>' +
            '<td data-label="Carrier"><b>' + esc(p.carrier) + '</b><small>' + esc([p.product, p.policy_type, p.term_years ? p.term_years + ' yr' : ''].filter(Boolean).join(' · ')) + '</small></td>' +
            '<td data-label="Face">' + esc(p.face_amount ? money(Math.round(p.face_amount)) : '—') + '</td>' +
            '<td data-label="Premium">' + esc(premiumText(p) || '—') + (p.annual_premium && p.payment_mode !== 'annual' ? '<small>' + esc(money0(p.annual_premium)) + '/yr</small>' : '') + '</td>' +
            '<td data-label="Status"><select class="pill ps-' + esc(p.status) + '" data-pstatus aria-label="Status of ' + esc(p.carrier) + ' policy">' + policyStatusOptions(p.status) + '</select></td>' +
            '<td data-label="In status"><span class="' + (slow ? 'warn' : '') + '">' + plural(days, 'day') + '</span></td>' +
            '<td data-label="Requirements">' + (total ? (left.length ? esc(left.length + ' open') + '<small>' + esc(left[0].label) + (left.length > 1 ? ' +' + (left.length - 1) : '') + '</small>' : '<span class="ok">All done</span>') : '<span class="muted">None</span>') + '</td>' +
            (isAdmin() ? '<td data-label="Agent">' + esc(personName(p.writing_agent) || '—') + '</td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div></div></section>';
    }).join('') || '<div class="empty"><p><b>No policies here.</b></p></div>';

    $$('tr[data-pol]', box).forEach(function (tr) {
      var p = policies.find(function (x) { return x.id === tr.getAttribute('data-pol'); });
      tr.addEventListener('click', function (e) { if (!e.target.closest('a, select')) policyModal({ policy: p, onSave: drawPolicies }); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === tr) policyModal({ policy: p, onSave: drawPolicies }); });
      $('[data-pstatus]', tr).addEventListener('change', function (e) { savePolicyStatus(p, e.target.value, drawPolicies); });
    });
  }

  // ---------- message templates ----------
  var templates = null;
  async function loadTemplates(force) {
    if (templates && !force) return templates;
    var r = await timed(sb.from('templates').select('*').order('name'));
    templates = r.error ? [] : (r.data || []);
    return templates;
  }
  function fillTemplate(text, l) {
    var mePhone = fmtPhone(me.phone) || '';
    var map = {
      first_name: l.first_name, last_name: l.last_name, full_name: fullName(l), state: l.state || '',
      coverage: money(l.coverage) || l.coverage_label || 'your', my_name: me.full_name || 'your Lifestone agent',
      my_first_name: (me.full_name || '').split(' ')[0] || 'your agent', my_phone: mePhone || 'this number', my_email: me.email
    };
    return String(text || '').replace(/\{(\w+)\}/g, function (all, k) { return k in map ? map[k] : all; });
  }
  var PLACEHOLDERS = '{first_name}, {last_name}, {coverage}, {state}, {my_name}, {my_first_name}, {my_phone}, {my_email}';

  // Pick a template, edit it, then open the phone's texting app or the email app with it filled in.
  async function messageModal(l, channel, after) {
    var list = (await loadTemplates()).filter(function (t) { return t.channel === channel; });
    var sms = channel === 'sms', tel = phone10(l.phone);
    var m = openModal('<h2>' + (sms ? 'Text ' : 'Email ') + esc(l.first_name) + '</h2>' +
      '<p class="muted modal-sub">' + esc(sms ? fmtPhone(l.phone) : l.email) + '</p>' +
      (list.length ? '<div class="tpl-pick">' + list.map(function (t) {
        return '<button type="button" class="chip-btn" data-tpl="' + esc(t.id) + '">' + esc(t.name) + '</button>';
      }).join('') + '</div>' : '') +
      '<form class="mform" novalidate>' +
      (sms ? '' : fld('Subject', '<input name="subject" autocomplete="off">')) +
      fld('Message', '<textarea name="body" rows="' + (sms ? 5 : 9) + '"></textarea>') +
      '<p class="hint">' + (sms ? 'Opens Messages on this device with the text filled in. It sends from your own phone number.' : 'Opens your email app with this message filled in.') + '</p>' +
      '<div class="modal-actions"><a class="btn btn-primary" id="msg-go" href="#">' + (sms ? 'Open in Messages' : 'Open in email') + '</a>' +
      '<button class="btn btn-ghost" type="button" id="msg-copy">Copy</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div></form>', true);
    var f = $('form', m.el), go = $('#msg-go', m.el);
    function link() {
      go.href = sms ? 'sms:+1' + tel + '?&body=' + encodeURIComponent(f.body.value)
        : 'mailto:' + encodeURIComponent(l.email).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(f.subject.value) + '&body=' + encodeURIComponent(f.body.value);
    }
    function pick(t) {
      f.body.value = fillTemplate(t.body, l);
      if (!sms) f.subject.value = fillTemplate(t.subject, l);
      $$('[data-tpl]', m.el).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tpl') === t.id); });
      link();
    }
    $$('[data-tpl]', m.el).forEach(function (b) {
      b.addEventListener('click', function () { pick(list.find(function (t) { return t.id === b.getAttribute('data-tpl'); })); });
    });
    f.addEventListener('input', link);
    if (list[0]) pick(list[0]); else link();
    go.addEventListener('click', function () {
      sb.rpc('lead_log_contact', { p_lead: l.id, p_via: sms ? 'text' : 'email' }).then(function () { setTimeout(function () { m.close(); if (after) after(sms ? 'text' : 'email'); }, 600); });
    });
    $('#msg-copy', m.el).addEventListener('click', function () {
      var text = (sms ? '' : f.subject.value + '\n\n') + f.body.value;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Copied.', 'ok'); }, function () { f.body.select(); toast('Press Ctrl+C (or Cmd+C) to copy.'); });
    });
  }

  function templateModal(t, after) {
    var isNew = !t;
    t = t || { channel: 'sms', name: '', subject: '', body: '', shared: true };
    var m = openModal('<h2>' + (isNew ? 'New template' : 'Edit template') + '</h2>' +
      '<form class="mform" novalidate>' +
      fld('Type', '<select name="channel">' + opts([['sms', 'Text message'], ['email', 'Email']], t.channel) + '</select>') +
      fld('Name', '<input name="tname" maxlength="80" autocomplete="off" placeholder="e.g. Missed call" value="' + esc(t.name) + '">') +
      fld('Email subject', '<input name="subject" maxlength="200" autocomplete="off" value="' + esc(t.subject) + '">', 'only-email') +
      fld('Message', '<textarea name="body" rows="7" maxlength="4000">' + esc(t.body) + '</textarea>') +
      '<p class="hint">Fill-ins: ' + esc(PLACEHOLDERS) + '</p>' +
      '<label class="check"><input type="checkbox" name="shared"' + (t.shared ? ' checked' : '') + '> Share with the whole team</label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-ghost" type="button" data-close>Cancel</button>' +
      (isNew ? '' : '<button class="ad-link-btn danger" type="button" data-remove>Remove template</button>') + '</div></form>', true);
    var f = $('form', m.el);
    var sync = function () { $('.only-email', f).hidden = f.channel.value !== 'email'; };
    f.channel.addEventListener('change', sync);
    sync();
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Saving…');
      var r = await sb.rpc('template_save', { p_id: isNew ? null : t.id, p_channel: f.channel.value, p_name: f.tname.value, p_subject: f.channel.value === 'email' ? f.subject.value : '', p_body: f.body.value, p_shared: f.shared.checked });
      busy(btn, false);
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      toast('Template saved.', 'ok');
      await loadTemplates(true);
      if (after) after();
    });
    var rm = $('[data-remove]', f);
    if (rm) rm.addEventListener('click', async function () {
      if (!confirm('Remove the “' + t.name + '” template?')) return;
      var r = await sb.rpc('template_remove', { p_id: t.id });
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      toast('Template removed.', 'ok');
      await loadTemplates(true);
      if (after) after();
    });
  }

  // ---------- edit a lead's details ----------
  function detailsModal(l, after) {
    var types = ['Term', 'Whole life', 'Universal life', 'Final expense', 'Not sure'];
    if (l.coverage_type && types.indexOf(l.coverage_type) === -1) types.push(l.coverage_type);
    var m = openModal('<h2>Edit ' + esc(fullName(l)) + '</h2>' +
      '<form class="mform" novalidate><div class="grid2">' +
      fld('First name', '<input name="first_name" autocomplete="off" value="' + esc(l.first_name) + '">') +
      fld('Last name', '<input name="last_name" autocomplete="off" value="' + esc(l.last_name) + '">') +
      fld('Phone', '<input name="phone" type="tel" autocomplete="off" value="' + esc(fmtPhone(l.phone)) + '">') +
      fld('Email', '<input name="email" type="email" autocomplete="off" value="' + esc(l.email) + '">') +
      fld('Date of birth', '<input name="dob" type="date" value="' + esc(l.dob || '') + '">') +
      fld('State', '<select name="state">' + opts(STATES.map(function (s) { return [s[0], s[1]]; }), l.state, '—') + '</select>') +
      fld('City', '<input name="city" autocomplete="off" value="' + esc(l.city || '') + '">') +
      fld('ZIP', '<input name="zip" inputmode="numeric" autocomplete="off" value="' + esc(l.zip || '') + '">') +
      fld('Coverage amount', '<input name="coverage" inputmode="numeric" value="' + esc(l.coverage ? money(l.coverage) : '') + '">') +
      fld('Coverage type', '<select name="coverage_type">' + opts(types, l.coverage_type, '—') + '</select>') +
      fld('Best time to call', '<input name="best_time" autocomplete="off" value="' + esc(l.best_time || '') + '">') +
      fld('Tags <span class="opt">(comma between each)</span>', '<input name="tags" autocomplete="off" placeholder="e.g. referral, spouse, Spanish" value="' + esc((l.tags || []).join(', ')) + '">') +
      '</div>' +
      '<label class="check dnc-check"><input type="checkbox" name="dnc"' + (l.do_not_contact ? ' checked' : '') + '> <span><b>Do not contact.</b> They asked us to stop calling, texting or emailing.</span></label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div></form>', true);
    var f = $('form', m.el);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      var now = {
        first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(), phone: phone10(f.phone.value), email: f.email.value.trim().toLowerCase(),
        dob: f.dob.value, state: f.state.value, city: f.city.value.trim(), zip: f.zip.value.trim(), coverage: digits(f.coverage.value),
        coverage_type: f.coverage_type.value, best_time: f.best_time.value.trim(),
        tags: f.tags.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean), do_not_contact: f.dnc.checked
      };
      var was = {
        first_name: l.first_name, last_name: l.last_name, phone: phone10(l.phone), email: l.email || '', dob: l.dob || '', state: l.state || '', city: l.city || '',
        zip: l.zip || '', coverage: l.coverage ? String(l.coverage) : '', coverage_type: l.coverage_type || '', best_time: l.best_time || '', tags: l.tags || [], do_not_contact: !!l.do_not_contact
      };
      var change = {};
      Object.keys(now).forEach(function (k) { if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) change[k] = now[k]; });
      if (!Object.keys(change).length) return m.close();
      if (change.do_not_contact && !confirm('Mark ' + l.first_name + ' as Do not contact? Call, Text and Email will be hidden on their page.')) return;
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Saving…');
      var r = await sb.rpc('lead_update_details', { p_lead: l.id, p: change });
      busy(btn, false);
      if (r.error) return formError(f, niceError(r.error));
      m.close();
      toast('Saved.', 'ok');
      loadLeads().catch(function () {});
      if (after) after();
    });
  }

  // ---------- reports ----------
  var repView = { period: 'month', agent: '' };
  var contactEvents = [];
  var PERIODS = [['month', 'This month'], ['last', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'], ['all', 'All time']];
  function periodRange(key) {
    var n = new Date(), y = n.getFullYear(), mo = n.getMonth();
    if (key === 'month') return [new Date(y, mo, 1), null];
    if (key === 'last') return [new Date(y, mo - 1, 1), new Date(y, mo, 1)];
    if (key === 'quarter') return [new Date(y, mo - mo % 3, 1), null];
    if (key === 'year') return [new Date(y, 0, 1), null];
    return [new Date(2000, 0, 1), null];
  }

  async function showReports() {
    render('<div class="ad-loading">Loading reports…</div>');
    try {
      await loadLeads();
      var r = await timed(sb.from('lead_events').select('lead_id,created_at,actor,meta').eq('kind', 'contact').order('created_at', { ascending: true }).limit(20000));
      contactEvents = r.error ? [] : (r.data || []);
    } catch (e) { return showLoadError(e); }
    stopRefresh();
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Reports</h1><p class="muted">' + (isAdmin() ? 'How the whole team is doing.' : 'How you’re doing.') + '</p></div>' +
      '<div class="head-actions">' + (isAdmin() ? '<button class="btn btn-ghost" type="button" id="r-csv">Download leads (CSV)</button>' : '') + '</div></div>' +
      '<div class="filters"><div class="seg seg-wrap" role="group" aria-label="Time period">' + PERIODS.map(function (p) {
        return '<button type="button" data-period="' + p[0] + '">' + p[1] + '</button>';
      }).join('') + '</div>' +
      (isAdmin() ? '<select id="r-agent" aria-label="Agent"><option value="">Whole team</option>' + teamOptions('') + '</select>' : '') + '</div>' +
      '<div id="rep"></div></div>');
    $$('[data-period]', main).forEach(function (b) { b.addEventListener('click', function () { repView.period = b.getAttribute('data-period'); drawReports(); }); });
    if ($('#r-agent', main)) { $('#r-agent', main).value = repView.agent; $('#r-agent', main).addEventListener('change', function (e) { repView.agent = e.target.value; drawReports(); }); }
    if ($('#r-csv', main)) $('#r-csv', main).addEventListener('click', exportLeads);
    drawReports();
  }

  var RANK = { new: 0, contacted: 1, quoted: 2, app_submitted: 3, approved: 4, issued: 5 };
  function reached(l, step, polByLead) {
    var r = RANK[l.status], pols = polByLead[l.id] || [];
    var applied = pols.length > 0 || l.status === 'declined';
    if (step === 'contacted') return (r != null && r >= 1) || !!l.last_contacted_at || l.contact_attempts > 0 || applied;
    if (step === 'quoted') return (r != null && r >= 2) || applied;
    if (step === 'applied') return (r != null && r >= 3) || applied;
    if (step === 'issued') return (r != null && r >= 5) || pols.some(function (p) { return p.status === 'issued' || p.status === 'in_force'; });
    return true;
  }

  function drawReports() {
    var box = $('#rep');
    if (!box) return;
    $$('[data-period]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-period') === repView.period ? 'true' : 'false'); });
    var range = periodRange(repView.period), from = range[0].getTime(), to = range[1] ? range[1].getTime() : Infinity;
    var inRange = function (v) { if (!v) return false; var x = (String(v).length === 10 ? localDay(v) : new Date(v)).getTime(); return x >= from && x < to; };
    var ag = repView.agent;
    var L = leads.filter(function (l) { return inRange(l.created_at) && (!ag || l.assigned_to === ag); });
    var P = policies.filter(function (p) { return !ag || p.writing_agent === ag; });
    var polByLead = {};
    policies.forEach(function (p) { (polByLead[p.lead_id] = polByLead[p.lead_id] || []).push(p); });
    var sum = function (list, fn) { return list.reduce(function (s, x) { return s + fn(x); }, 0); };
    var pct = function (a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; };

    // Funnel for leads that came in during the period.
    var steps = [['all', 'Leads'], ['contacted', 'Contacted'], ['quoted', 'Quoted'], ['applied', 'Applied'], ['issued', 'Issued']];
    var counts = steps.map(function (s) { return L.filter(function (l) { return reached(l, s[0], polByLead); }).length; });
    var funnel = '<div class="funnel">' + steps.map(function (s, i) {
      return '<div class="fn-step"><span class="fn-n">' + counts[i] + '</span><span class="fn-label">' + s[1] + '</span>' +
        (i ? '<span class="fn-pct">' + pct(counts[i], counts[0]) + ' of leads</span>' : '<span class="fn-pct">came in</span>') +
        '<span class="fn-bar"><span class="hb-fill" data-w="' + (counts[0] ? counts[i] / counts[0] * 100 : 0) + '"></span></span></div>';
    }).join('') + '</div>';

    // Speed to lead: time from when the lead came in to the first call/text/email.
    var firstTouch = {};
    contactEvents.forEach(function (e) { if (!firstTouch[e.lead_id]) firstTouch[e.lead_id] = e.created_at; });
    var waits = L.filter(function (l) { return firstTouch[l.id]; }).map(function (l) { return (new Date(firstTouch[l.id]) - new Date(l.created_at)) / 60000; }).sort(function (a, b) { return a - b; });
    var median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
    var mins = function (m) { return m == null ? '—' : m < 1 ? 'under 1 min' : m < 60 ? Math.round(m) + ' min' : m < 1440 ? (m / 60).toFixed(1) + ' hours' : (m / 1440).toFixed(1) + ' days'; };
    var never = L.filter(function (l) { return !firstTouch[l.id] && !l.last_contacted_at && S.group(l.status) !== 'closed'; }).length;

    // Production from policies.
    var submitted = P.filter(function (p) { return inRange(p.submitted_on || p.created_at); });
    var placed = P.filter(function (p) { return p.status === 'in_force' && inRange(p.placed_on); });
    var decided = submitted.filter(function (p) { return ['issued', 'in_force', 'declined', 'withdrawn'].indexOf(p.status) !== -1; });
    var issuedOf = decided.filter(function (p) { return p.status === 'issued' || p.status === 'in_force'; });

    function stat(label, value, sub) { return '<div class="tile"><span class="tile-label">' + esc(label) + '</span><span class="tile-value">' + esc(value) + '</span>' + (sub ? '<span class="tile-sub">' + esc(sub) + '</span>' : '') + '</div>'; }
    function table(cols, rows) {
      if (!rows.length) return '<p class="muted">Nothing in this period yet.</p>';
      return '<div class="table-wrap"><table class="rep-table"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td data-label="' + esc(cols[i]) + '">' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }

    var NAMES = SOURCE_NAMES;
    var bySrc = {};
    L.forEach(function (l) { var k = l.source || 'unknown'; (bySrc[k] = bySrc[k] || []).push(l); });
    var srcRows = Object.keys(bySrc).sort(function (a, b) { return bySrc[b].length - bySrc[a].length; }).map(function (k) {
      var list = bySrc[k], issued = list.filter(function (l) { return reached(l, 'issued', polByLead); }).length;
      var prem = sum(list, function (l) { return sum((polByLead[l.id] || []).filter(function (p) { return p.status === 'in_force'; }), annual); });
      return [esc(NAMES[k] || k), list.length, pct(list.filter(function (l) { return reached(l, 'contacted', polByLead); }).length, list.length),
        list.filter(function (l) { return reached(l, 'applied', polByLead); }).length, issued, pct(issued, list.length), esc(money0(prem))];
    });

    var outcomes = {}, OUT = { no_answer: 'No answer', voicemail: 'Left voicemail', spoke: 'Talked', appointment: 'Set appointment', bad_number: 'Bad number', sent: 'Sent', replied: 'Replied', '': 'Not logged' };
    var touches = contactEvents.filter(function (e) { return inRange(e.created_at) && (!ag || e.actor === ag); });
    touches.forEach(function (e) { var k = (e.meta && e.meta.via === 'call') ? (e.meta.outcome || '') : null; if (k != null) outcomes[k] = (outcomes[k] || 0) + 1; });
    var calls = touches.filter(function (e) { return e.meta && e.meta.via === 'call'; }).length;
    var outRows = Object.keys(outcomes).map(function (k) { return { label: OUT[k] || k, n: outcomes[k] }; }).sort(function (a, b) { return b.n - a.n; });

    var agentTable = '';
    if (isAdmin() && !ag) {
      agentTable = '<section class="panel span2"><h2>By agent</h2>' + table(['Agent', 'New leads', 'Calls/texts', 'Apps', 'Placed', 'Placed premium', 'Est. commission'],
        team.filter(function (p) { return p.active; }).map(function (p) {
          var pl = placed.filter(function (x) { return x.writing_agent === p.id; });
          return [esc(p.full_name || p.email), L.filter(function (l) { return l.assigned_to === p.id; }).length, touches.filter(function (e) { return e.actor === p.id; }).length,
            submitted.filter(function (x) { return x.writing_agent === p.id; }).length, pl.length, esc(money0(sum(pl, annual))), esc(money0(sum(pl, commission)))];
        })) + '</section>';
    }
    var carriers = {};
    submitted.concat(placed).forEach(function (p) { carriers[p.carrier] = 1; });
    var carrierRows = Object.keys(carriers).sort().map(function (c) {
      var sub = submitted.filter(function (p) { return p.carrier === c; }), pl = placed.filter(function (p) { return p.carrier === c; });
      return [esc(c), sub.length, sub.filter(function (p) { return p.status === 'declined'; }).length, pl.length, esc(money0(sum(pl, annual)))];
    });

    box.innerHTML = '<div class="tiles tiles-4">' +
      stat('Apps submitted', String(submitted.length), money0(sum(submitted, annual)) + ' annual premium') +
      stat('Placed', money0(sum(placed, annual)), plural(placed.length, 'policy', 'policies') + ' paid') +
      stat('Est. commission', money0(sum(placed, commission)), 'First-year, on placed policies') +
      stat('Issue rate', pct(issuedOf.length, decided.length), decided.length ? issuedOf.length + ' of ' + decided.length + ' decided apps' : 'No decisions yet') +
      '</div>' +
      '<div class="home-grid">' +
      '<section class="panel span2"><h2>Lead funnel</h2>' + (L.length ? funnel : '<p class="muted">No leads came in during this period.</p>') + '</section>' +
      '<section class="panel"><h2>Speed to lead</h2><div class="kv">' +
      '<div><span class="kv-n">' + esc(mins(median)) + '</span><span class="kv-l">typical time to first contact</span></div>' +
      '<div><span class="kv-n">' + pct(waits.filter(function (w) { return w <= 5; }).length, waits.length) + '</span><span class="kv-l">reached within 5 minutes</span></div>' +
      '<div><span class="kv-n">' + pct(waits.filter(function (w) { return w <= 60; }).length, waits.length) + '</span><span class="kv-l">within 1 hour</span></div>' +
      '<div><span class="kv-n' + (never ? ' warn' : '') + '">' + never + '</span><span class="kv-l">open leads never contacted</span></div></div>' +
      '<p class="hint">Leads reached in the first few minutes are far more likely to buy.</p></section>' +
      '<section class="panel"><h2>Calls</h2><p class="muted">' + plural(calls, 'call') + ' logged · ' + plural(touches.length - calls, 'text/email', 'texts/emails') + '</p>' +
      (outRows.length ? '<ul class="hbars">' + outRows.map(function (r) {
        var max = outRows[0].n || 1;
        return '<li><span class="hb-row"><span class="hb-label">' + esc(r.label) + '</span><span class="hb-track"><span class="hb-fill" data-w="' + (r.n / max * 100) + '"></span></span><span class="hb-n">' + r.n + '</span></span></li>';
      }).join('') + '</ul>' : '<p class="muted">No calls logged in this period.</p>') + '</section>' +
      '<section class="panel span2"><h2>By lead source</h2>' + table(['Source', 'Leads', 'Contacted', 'Applied', 'Issued', 'Conversion', 'Placed premium'], srcRows) + '</section>' +
      agentTable +
      '<section class="panel span2"><h2>By carrier</h2>' + table(['Carrier', 'Apps', 'Declined', 'Placed', 'Placed premium'], carrierRows) + '</section>' +
      '</div>';
    $$('[data-w]', box).forEach(function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
  }

  // ---------- spreadsheets (CSV) ----------
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;            // stop spreadsheet apps from running it as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(name, rows) {
    var blob = new Blob(['﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportLeads() {
    var head = ['First name', 'Last name', 'Phone', 'Email', 'State', 'City', 'ZIP', 'Date of birth', 'Age', 'Coverage', 'Coverage type', 'Stage', 'Source',
      'Assigned to', 'Temperature', 'Tags', 'Do not contact', 'Attempts', 'Came in', 'Last contact', 'Policies'];
    var rows = leads.map(function (l) {
      var pols = policies.filter(function (p) { return p.lead_id === l.id; }).map(function (p) { return p.carrier + ' (' + pStatus(p.status).label + ')'; }).join('; ');
      return [l.first_name, l.last_name, fmtPhone(l.phone), l.email, l.state, l.city, l.zip, l.dob, l.age, l.coverage, l.coverage_type, S.label(l.status),
        l.source, personName(l.assigned_to), TEMPS[l.temperature] || '', (l.tags || []).join(', '), l.do_not_contact ? 'Yes' : '', l.contact_attempts || 0,
        fmtDate(l.created_at), fmtDate(l.last_contacted_at), pols];
    });
    downloadCsv('lifestone-leads-' + isoDay(new Date()) + '.csv', [head].concat(rows));
  }
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim(); }); });
  }
  var HEADERS = {
    first_name: ['first name', 'first', 'firstname', 'given name'], last_name: ['last name', 'last', 'lastname', 'surname', 'family name'],
    name: ['name', 'full name', 'client', 'client name', 'contact', 'contact name', 'insured'],
    phone: ['phone', 'phone number', 'mobile', 'cell', 'cell phone', 'mobile phone', 'telephone', 'primary phone', 'home phone'],
    email: ['email', 'e mail', 'email address'], state: ['state', 'st'], city: ['city'], zip: ['zip', 'zip code', 'zipcode', 'postal code'],
    dob: ['dob', 'date of birth', 'birthday', 'birth date', 'birthdate'], age: ['age'], coverage: ['coverage', 'coverage amount', 'face amount', 'face', 'amount'],
    coverage_type: ['coverage type', 'type', 'product', 'policy type'], tags: ['tags', 'tag', 'labels'], note: ['note', 'notes', 'comments', 'comment']
  };
  function headerKey(h) {
    var n = String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return Object.keys(HEADERS).find(function (k) { return HEADERS[k].indexOf(n) !== -1; }) || '';
  }
  function normDob(v) {
    v = String(v || '').trim();
    var m;
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    if ((m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
      var y = m[3].length === 2 ? (+m[3] > 30 ? '19' : '20') + m[3] : m[3];
      return y + '-' + pad2(m[1]) + '-' + pad2(m[2]);
    }
    return '';
  }
  function normState(v) {
    v = String(v || '').trim();
    if (v.length === 2) return v.toUpperCase();
    var s = STATES.find(function (x) { return x[1].toLowerCase() === v.toLowerCase(); });
    return s ? s[0] : '';
  }

  async function importCsv(file, after) {
    if (file.size > 5 * 1024 * 1024) return toast('That file is over 5 MB. Split it into smaller files.', 'err');
    var rows = parseCsv(await file.text());
    if (rows.length < 2) return toast('That file has no rows to import.', 'err');
    var keys = rows[0].map(headerKey);
    if (keys.indexOf('phone') === -1 || (keys.indexOf('first_name') === -1 && keys.indexOf('name') === -1)) {
      return toast('Couldn’t find a name and phone column. Name the columns like “First name”, “Last name”, “Phone”.', 'err');
    }
    var recs = rows.slice(1).map(function (r) {
      var o = {};
      keys.forEach(function (k, i) { if (k && r[i] != null && String(r[i]).trim()) o[k] = String(r[i]).trim(); });
      if (o.name && !o.first_name) {
        var parts = o.name.indexOf(',') !== -1 ? o.name.split(',').map(function (x) { return x.trim(); }).reverse() : o.name.split(/\s+/);   // "Lee, Ann" or "Ann Lee"
        o.first_name = parts.shift();
        o.last_name = o.last_name || parts.join(' ');
      }
      delete o.name;
      if (o.dob) o.dob = normDob(o.dob);
      if (o.state) o.state = normState(o.state);
      if (o.tags) o.tags = o.tags.split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean);
      return o;
    });
    var ready = recs.filter(function (o) { var d = digits(o.phone); return o.first_name && (d.length === 10 || (d.length === 11 && d[0] === '1')); });
    var matched = keys.filter(Boolean).filter(function (k, i, a) { return a.indexOf(k) === i; });
    var m = openModal('<h2>Import leads</h2>' +
      '<p><b>' + plural(ready.length, 'lead') + ' ready</b> from ' + esc(file.name) + (recs.length - ready.length ? ' · ' + plural(recs.length - ready.length, 'row') + ' skipped (missing a name or a 10-digit phone)' : '') + '.</p>' +
      '<p class="hint">Columns found: ' + esc(matched.join(', ').replace(/_/g, ' ')) + '</p>' +
      '<div class="table-wrap imp-prev"><table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>State</th></tr></thead><tbody>' + ready.slice(0, 5).map(function (o) {
        return '<tr><td>' + esc((o.first_name || '') + ' ' + (o.last_name || '')) + '</td><td>' + esc(fmtPhone(o.phone)) + '</td><td>' + esc(o.email || '') + '</td><td>' + esc(o.state || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<form class="mform" novalidate>' +
      fld('Assign them to', '<select name="who"><option value="">Leave unassigned</option>' + teamOptions('', true) + '</select>') +
      '<label class="check"><input type="checkbox" name="skip" checked> Skip anyone whose phone number is already in the CRM</label>' +
      '<p class="hint">Only import people who agreed to be contacted. Imported leads go to the Agent path with stage New.</p>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="submit"' + (ready.length ? '' : ' disabled') + '>Import ' + plural(ready.length, 'lead') + '</button>' +
      '<button class="btn btn-ghost" type="button" data-close>Cancel</button></div></form>', true);
    var f = $('form', m.el);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', f), total = { added: 0, duplicates: 0, skipped: 0 };
      busy(btn, true, 'Importing…');
      for (var i = 0; i < ready.length; i += 500) {
        var r = await sb.rpc('lead_import', { p_rows: ready.slice(i, i + 500), p_agent: f.who.value || null, p_skip_dupes: f.skip.checked });
        if (r.error) { busy(btn, false); return formError(f, niceError(r.error) + (total.added ? ' (' + total.added + ' were already imported.)' : '')); }
        ['added', 'duplicates', 'skipped'].forEach(function (k) { total[k] += (r.data && r.data[k]) || 0; });
      }
      m.close();
      toast(plural(total.added, 'lead') + ' imported' + (total.duplicates ? ' · ' + total.duplicates + ' already in the CRM' : '') + (total.skipped ? ' · ' + total.skipped + ' skipped' : '') + '.', 'ok');
      await loadLeads().catch(function () {});
      if (after) after();
    });
  }

  // ---------- team (admins) ----------
  async function adminCall(body) {
    var token = (await sb.auth.getSession()).data.session.access_token;
    var res = await fetch('/.netlify/functions/admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body)
    });
    var out = await res.json().catch(function () { return { ok: false, error: 'Something went wrong' }; });
    if (!out.ok) throw new Error(out.error || 'Something went wrong');
    return out;
  }

  async function showTeam() {
    stopRefresh();
    await loadTeam();
    var setup = {};
    try { setup = (await adminCall({ action: 'team-status' })).status || {}; } catch (e) { /* the page still works without it */ }
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Team</h1><p class="muted">Invite agents, set roles, and turn accounts off when someone leaves.</p></div></div>' +
      '<section class="panel"><h2>Invite someone</h2>' +
      '<form id="f-invite" class="invite" novalidate>' +
      '<label class="fld">Full name<input name="fullName" autocomplete="off" required></label>' +
      '<label class="fld">Email<input name="email" type="email" autocomplete="off" required></label>' +
      '<label class="fld">Role<select name="role"><option value="agent">Agent: sees only leads assigned to them</option><option value="admin">Admin: sees everything, manages the team</option></select></label>' +
      '<button class="btn btn-primary" type="submit">Send invite</button>' +
      '<p class="form-error" role="alert" hidden></p></form>' +
      '<p class="hint">They’ll get an email to set a password and turn on two-step verification.</p></section>' +
      '<section class="panel"><h2>Members</h2><div class="table-wrap"><table class="team"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Account</th><th>Open leads</th><th></th></tr></thead><tbody>' +
      team.map(function (p) {
        var open = leads.filter(function (l) { return l.assigned_to === p.id && S.group(l.status) !== 'closed' && S.group(l.status) !== 'won'; }).length;
        var self = p.id === me.id;
        return '<tr data-id="' + esc(p.id) + '">' +
          '<td data-label="Name"><b>' + esc(p.full_name || '—') + '</b>' + (self ? ' <span class="muted">(you)</span>' : '') +
          (setup[p.id] && !setup[p.id].signedIn ? ' <span class="pending">Invite pending</span>' : '') + '</td>' +
          '<td data-label="Email">' + esc(p.email) + '</td>' +
          '<td data-label="Role"><select data-f="role"' + (self ? ' disabled' : '') + '><option value="agent"' + (p.role === 'agent' ? ' selected' : '') + '>Agent</option><option value="admin"' + (p.role === 'admin' ? ' selected' : '') + '>Admin</option></select></td>' +
          '<td data-label="Account"><select data-f="active"' + (self ? ' disabled' : '') + '><option value="1"' + (p.active ? ' selected' : '') + '>On</option><option value="0"' + (!p.active ? ' selected' : '') + '>Off</option></select></td>' +
          '<td data-label="Open leads">' + open + '</td>' +
          '<td class="row-actions">' + (self ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-save>Save</button>') +
          (!self && p.active && setup[p.id] && !setup[p.id].signedIn ? '<button class="ad-link-btn" type="button" data-resend>Resend invite</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="hint">Turning an account off signs them out of the data immediately and moves their open leads back to Unassigned.</p></section></div>');

    var f = $('#f-invite', main);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      if (!f.fullName.value.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value.trim())) return formError(f, 'Enter their name and a valid email.');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Sending…');
      try {
        await adminCall({ action: 'invite', fullName: f.fullName.value.trim(), email: f.email.value.trim(), role: f.role.value });
        toast('Invite sent to ' + f.email.value.trim() + '.', 'ok');
        showTeam();
      } catch (err) {
        formError(f, niceError(err));
      } finally { busy(btn, false); }
    });

    $$('[data-resend]', main).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var tr = btn.closest('tr');
        busy(btn, true, 'Sending…');
        try {
          await adminCall({ action: 'resend-invite', userId: tr.getAttribute('data-id') });
          btn.textContent = 'Sent ✓';
          toast('New setup link sent. It works for a limited time, so ask them to open it soon.', 'ok');
        } catch (err) {
          busy(btn, false);
          toast(niceError(err), 'err');
        }
      });
    });

    $$('[data-save]', main).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var tr = btn.closest('tr');
        var role = $('[data-f=role]', tr).value, active = $('[data-f=active]', tr).value === '1';
        if (!active && !confirm('Turn off this account? They won’t be able to see any leads.')) return;
        busy(btn, true, 'Saving…');
        var r = await sb.rpc('team_update', { p_user: tr.getAttribute('data-id'), p_role: role, p_active: active });
        busy(btn, false);
        if (r.error) return toast(niceError(r.error), 'err');
        toast('Saved.', 'ok');
        await loadLeads().catch(function () {});
        showTeam();
      });
    });
  }

  // ---------- my settings ----------
  async function showSettings() {
    stopRefresh();
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Settings</h1><p class="muted">' + esc(me.email) + ' · ' + (isAdmin() ? 'Admin' : 'Agent') + '</p></div></div>' +
      '<section class="panel"><h2>Your details &amp; alerts</h2>' +
      '<form id="f-me" class="settings" novalidate>' +
      '<label class="fld">Full name<input name="full_name" autocomplete="name" value="' + esc(me.full_name) + '"></label>' +
      '<label class="fld">Mobile number for text alerts<input name="phone" type="tel" autocomplete="tel" value="' + esc(fmtPhone(me.phone)) + '" placeholder="(954) 555-1234"></label>' +
      '<label class="check"><input type="checkbox" name="alert_email"' + (me.alert_email ? ' checked' : '') + '> Email me about ' + (isAdmin() ? 'new leads and leads' : 'leads') + ' assigned to me</label>' +
      '<label class="check"><input type="checkbox" name="alert_sms"' + (me.alert_sms ? ' checked' : '') + '> Text me about ' + (isAdmin() ? 'new leads and leads' : 'leads') + ' assigned to me</label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn btn-primary" type="submit">Save</button></form></section>' +
      '<section class="panel"><h2>Password</h2>' +
      '<form id="f-pw" class="settings" novalidate>' +
      '<label class="fld">New password<input name="password" type="password" autocomplete="new-password" minlength="10"></label>' +
      '<label class="fld">Type it again<input name="password2" type="password" autocomplete="new-password"></label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn btn-ghost" type="submit">Change password</button></form></section>' +
      '<section class="panel"><h2>Two-step verification</h2><p>On. You’ll enter a code from your authenticator app each time you sign in.</p>' +
      '<p class="hint">New phone? Sign in on your old phone first, or ask an admin to reset your two-step verification in Supabase (Authentication → Users → your account → remove the authenticator).</p></section>' +
      '<section class="panel"><div class="panel-head"><h2>Message templates</h2><button class="btn btn-ghost btn-sm" type="button" id="tpl-new">New template</button></div>' +
      '<p class="muted">Ready-made texts and emails for the Text and Email buttons on every lead. Fill-ins like {first_name} and {my_name} are filled in for you.</p>' +
      '<div id="tpl-list"><p class="muted">Loading…</p></div></section>' +
      (isAdmin() ? '<section class="panel"><h2>Import &amp; export</h2><p>Bring in leads from a spreadsheet, like an export from another CRM, or download all leads.</p>' +
        '<div class="io"><label class="btn btn-ghost file-btn">Import leads from a CSV file<input type="file" id="imp-file" accept=".csv,text/csv"></label>' +
        '<button class="btn btn-ghost" type="button" id="exp-btn">Download all leads (CSV)</button></div>' +
        '<p class="hint">The file needs a header row with at least a name and a phone column. In Excel or Google Sheets, save or download it as CSV first.</p></section>' : '') +
      '</div>');

    async function drawTemplates() {
      var list = await loadTemplates(true), box = $('#tpl-list');
      if (!box) return;
      box.innerHTML = [['sms', 'Texts'], ['email', 'Emails']].map(function (c) {
        var items = list.filter(function (t) { return t.channel === c[0]; });
        return '<h3 class="tpl-h">' + c[1] + '</h3>' + (items.length ? '<ul class="tpl-list">' + items.map(function (t) {
          var mine = isAdmin() || t.created_by === me.id;
          return '<li><div><b>' + esc(t.name) + '</b>' + (t.shared ? '' : ' <span class="pending">Only you</span>') +
            '<small>' + esc(t.body.slice(0, 120)) + (t.body.length > 120 ? '…' : '') + '</small></div>' +
            (mine ? '<button class="ad-link-btn" type="button" data-tpl-edit="' + esc(t.id) + '">Edit</button>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="muted">None yet.</p>');
      }).join('');
      $$('[data-tpl-edit]', box).forEach(function (b) {
        b.addEventListener('click', function () { templateModal(list.find(function (t) { return t.id === b.getAttribute('data-tpl-edit'); }), drawTemplates); });
      });
    }
    $('#tpl-new', main).addEventListener('click', function () { templateModal(null, drawTemplates); });
    drawTemplates();
    if ($('#imp-file', main)) {
      $('#imp-file', main).addEventListener('change', function (e) { var file = e.target.files[0]; e.target.value = ''; if (file) importCsv(file); });
      $('#exp-btn', main).addEventListener('click', async function () { await loadLeads().catch(function () {}); exportLeads(); });
    }

    var f = $('#f-me', main);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(f, '');
      if (f.alert_sms.checked && phone10(f.phone.value).length !== 10) return formError(f, 'Add a 10-digit mobile number to get text alerts.');
      var btn = $('button[type=submit]', f);
      busy(btn, true, 'Saving…');
      var r = await sb.rpc('profile_update_me', {
        p_full_name: f.full_name.value, p_phone: phone10(f.phone.value), p_alert_email: f.alert_email.checked, p_alert_sms: f.alert_sms.checked
      });
      busy(btn, false);
      if (r.error) return formError(f, niceError(r.error));
      var p = await sb.from('profiles').select('*').eq('id', me.id).maybeSingle();
      if (p.data) me = p.data;
      setTop(true);
      await loadTeam();
      toast('Saved.', 'ok');
    });
    var fp = $('#f-pw', main);
    fp.addEventListener('submit', async function (e) {
      e.preventDefault();
      formError(fp, '');
      if (fp.password.value.length < 10) return formError(fp, 'Use at least 10 characters.');
      if (fp.password.value !== fp.password2.value) return formError(fp, 'The two passwords don’t match.');
      var r = await sb.auth.updateUser({ password: fp.password.value });
      if (r.error) return formError(fp, niceError(r.error));
      fp.reset();
      toast('Password changed.', 'ok');
    });
  }

  boot().catch(function (e) {
    render(card('Something went wrong', '<p>' + esc(niceError(e)) + '</p><p><a href="./">Reload</a></p>'));
  });
})();
