/*
 * Lifestone CRM dashboard (/admin).
 *
 * Talks to Supabase directly from the browser with the public anon key. What each person
 * can see is enforced by the database (supabase/schema.sql), not by this file:
 *   admins see every lead; agents see only leads assigned to them; nothing loads
 *   until two-step verification is done.
 *
 * Routes: #/leads, #/lead/<id>, #/team (admins), #/settings
 */
(function () {
  'use strict';

  var S = window.LifestoneStatuses;
  var IDLE_MINUTES = 60;          // sign out after this long without activity
  var REFRESH_SECONDS = 45;       // how often the lead list checks for new leads
  var LEAD_LIMIT = 2000;

  var sb = null;                  // Supabase client
  var me = null;                  // my profile row
  var team = [];                  // all profiles I can see
  var leads = [];                 // leads I can see
  var leadsLoadedAt = 0;
  var view = { q: '', path: '', agent: '', mode: savedPref('lq_crm_view', 'board') };
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
  function statusChip(key) { return '<span class="chip chip-' + esc(S.group(key)) + '">' + esc(S.label(key)) + '</span>'; }
  function pathBadge(p) { return '<span class="badge badge-' + esc(p) + '">' + esc(S.PATHS[p] || p) + '</span>'; }
  function niceError(err) {
    var m = (err && (err.message || err.error_description)) || String(err || 'Something went wrong');
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
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
    });
    sb.auth.onAuthStateChange(function (event) {
      if (event === 'PASSWORD_RECOVERY') linkType = 'recovery';
      if (event === 'SIGNED_OUT') { me = null; showLogin(); }
    });
    window.addEventListener('hashchange', route);
    $('#ad-signout').addEventListener('click', signOut);
    watchIdle();
    await gate();
  }

  // Decides which screen to show: login → set password → two-step → app.
  async function gate() {
    var sess = (await sb.auth.getSession()).data.session;
    if (linkError) { var m = linkError; linkError = null; return showLogin('That link didn’t work (' + m + '). Ask an admin for a new invite, or reset your password.'); }
    if (!sess) return showLogin();
    if (linkType === 'invite' || linkType === 'recovery') return showSetPassword(linkType);

    var aal = (await sb.auth.mfa.getAuthenticatorAssuranceLevel()).data;
    if (!aal || aal.currentLevel !== 'aal2') {
      var factors = (await sb.auth.mfa.listFactors()).data || {};
      var verified = (factors.totp || []).filter(function (f) { return f.status === 'verified'; });
      return verified.length ? showMfaChallenge(verified[0]) : showMfaEnroll();
    }

    var prof = await sb.from('profiles').select('*').eq('id', sess.user.id).maybeSingle();
    if (prof.error || !prof.data) return showBlocked('We couldn’t load your profile. Try signing in again.');
    if (!prof.data.active) return showBlocked('Your account is turned off. Ask an admin to turn it back on.');
    me = prof.data;
    await loadTeam();
    setTop(true);
    if (!location.hash || location.hash === '#/' || location.hash.indexOf('access_token') !== -1) history.replaceState(null, '', '#/home');
    route();
  }

  async function signOut() {
    stopRefresh();
    await sb.auth.signOut();
    me = null; leads = []; team = [];
    history.replaceState(null, '', '#/');
    showLogin();
  }

  function watchIdle() {
    var last = Date.now();
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(function (ev) {
      window.addEventListener(ev, function () { last = Date.now(); }, { passive: true });
    });
    setInterval(function () {
      if (me && Date.now() - last > IDLE_MINUTES * 60000) {
        signOut().then(function () { toast('Signed out after ' + IDLE_MINUTES + ' minutes without activity.'); });
      }
    }, 30000);
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

  function showSetPassword(kind) {
    setTop(false);
    var main = render(card(kind === 'invite' ? 'Welcome to Lifestone' : 'Choose a new password', '' +
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
      busy(btn, false);
      if (r.error) { f.code.select(); return formError(f, /invalid|expired/i.test(r.error.message) ? 'That code didn’t work. Codes change every 30 seconds, so try the newest one.' : niceError(r.error)); }
      gate();
    });
  }

  function showBlocked(msg) {
    setTop(false);
    var main = render(card('Can’t open the dashboard', '<p>' + esc(msg) + '</p><button class="btn btn-ghost btn-wide" type="button" id="b-out">Sign out</button>'));
    $('#b-out', main).addEventListener('click', signOut);
  }

  // ---------- data ----------
  async function loadTeam() {
    var r = await sb.from('profiles').select('id,email,full_name,phone,role,active,alert_email,alert_sms,created_at').order('created_at');
    team = r.data || [];
  }

  async function loadLeads() {
    var r = await sb.from('leads')
      .select('id,created_at,updated_at,first_name,last_name,email,phone,state,age,coverage,coverage_label,coverage_type,path,status,source,assigned_to,last_contacted_at')
      .order('created_at', { ascending: false }).limit(LEAD_LIMIT);
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

  // ---------- routing ----------
  function route() {
    if (!me) return;
    var h = location.hash || '#/home';
    var m;
    if ((m = h.match(/^#\/lead\/([0-9a-f-]{36})$/i))) { markNav('leads'); return showLead(m[1]); }
    if (h === '#/leads') { markNav('leads'); return showLeads(); }
    if (h === '#/archive') { markNav('archive'); return showArchive(); }
    if (h === '#/team' && isAdmin()) { markNav('team'); return showTeam(); }
    if (h === '#/settings') { markNav('settings'); return showSettings(); }
    markNav('home');
    showHome();
  }

  // Redraws whichever list page is open after the periodic refresh.
  function refreshView() {
    var h = location.hash;
    if (h === '#/leads') drawLeadRows();
    else if (h === '#/archive') drawArchive();
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
    try { await loadLeads(); } catch (e) { return render('<div class="page"><p class="form-error">' + esc(niceError(e)) + '</p></div>'); }
    startRefresh();
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Leads</h1><p class="muted" id="lead-sum"></p></div>' +
      '<div class="head-actions"><div class="seg" role="group" aria-label="View">' +
      '<button type="button" data-mode="board">Board</button><button type="button" data-mode="list">List</button></div>' +
      '<button class="btn btn-ghost" type="button" id="refresh">Refresh</button></div></div>' +
      '<div class="filters">' +
      '<input type="search" id="f-q" placeholder="Search name, phone or email" aria-label="Search leads">' +
      '<select id="f-path" aria-label="Path"><option value="">Online + agent</option><option value="digital">Online only</option><option value="agent">Agent only</option></select>' +
      (isAdmin() ? '<select id="f-agent" aria-label="Assigned to"><option value="">Everyone</option><option value="none">Unassigned</option>' +
        team.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.full_name || p.email) + '</option>'; }).join('') + '</select>' : '') +
      '<a class="archive-link" href="#/archive">Archive <span id="archive-count"></span></a>' +
      '</div>' +
      '<div id="lead-rows"></div></div>');

    $('#f-q', main).value = view.q;
    $('#f-path', main).value = view.path;
    if ($('#f-agent', main)) $('#f-agent', main).value = view.agent;
    $('#f-q', main).addEventListener('input', function (e) { view.q = e.target.value; drawLeadRows(); });
    $('#f-path', main).addEventListener('change', function (e) { view.path = e.target.value; drawLeadRows(); });
    if ($('#f-agent', main)) $('#f-agent', main).addEventListener('change', function (e) { view.agent = e.target.value; drawLeadRows(); });
    $('#refresh', main).addEventListener('click', function () { loadLeads().then(drawLeadRows); });
    $$('[data-mode]', main).forEach(function (b) {
      b.addEventListener('click', function () { view.mode = b.getAttribute('data-mode'); savePref('lq_crm_view', view.mode); drawLeadRows(); });
    });
    drawLeadRows();
  }

  function filtered() {
    var q = view.q.trim().toLowerCase(), qd = digits(q);
    return leads.filter(function (l) {
      if (view.path && l.path !== view.path) return false;
      if (view.agent === 'none' && l.assigned_to) return false;
      if (view.agent && view.agent !== 'none' && l.assigned_to !== view.agent) return false;
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
    if (board) return drawBoard(box);
    drawGroups(box);
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
      '<th class="c-phone">Phone</th><th class="c-cov">Coverage</th><th class="c-path">Path</th><th class="c-time">Received</th><th class="c-time">Last contact</th></tr></thead>';
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
            '<td data-label="Name"><a href="#/lead/' + esc(l.id) + '" class="lead-name">' + esc(l.first_name + ' ' + l.last_name) + '</a>' +
            '<small>' + esc([l.state, l.age ? 'age ' + l.age : '', l.source].filter(Boolean).join(' · ')) + '</small></td>' +
            '<td data-label="Stage">' + statusSelect(l) + '</td>' +
            (isAdmin() ? '<td data-label="Assigned">' + assignSelect(l) + '</td>' : '') +
            '<td data-label="Phone">' + esc(fmtPhone(l.phone)) + '</td>' +
            '<td data-label="Coverage"><span>' + esc(money(l.coverage) || l.coverage_label || '—') + (l.coverage_type ? '<small>' + esc(l.coverage_type) + '</small>' : '') + '</span></td>' +
            '<td data-label="Path">' + pathBadge(l.path) + '</td>' +
            '<td data-label="Received" title="' + esc(fmtDate(l.created_at)) + '">' + esc(ago(l.created_at)) + '</td>' +
            '<td data-label="Last contact">' + (l.last_contacted_at ? esc(ago(l.last_contacted_at)) : '<span class="warn">Never</span>') + '</td>' +
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
      tr.addEventListener('click', function (e) { if (!e.target.closest('a, select')) go(); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === tr) go(); });
      $('[data-act=status]', tr).addEventListener('change', function (e) { moveLead(id, e.target.value); });
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
      '<div class="card-top"><b class="card-name">' + esc(l.first_name + ' ' + l.last_name) + '</b>' + pathBadge(l.path) + '</div>' +
      '<div class="card-meta">' + esc([money(l.coverage) || l.coverage_label, l.coverage_type].filter(Boolean).join(' · ') || 'Coverage not given') + '</div>' +
      '<div class="card-meta">' + esc(fmtPhone(l.phone)) + (l.state ? ' · ' + esc(l.state) : '') + '</div>' +
      '<div class="card-foot"><span title="' + esc(fmtDate(l.created_at)) + '">In ' + esc(ago(l.created_at)) + '</span>' +
      '<span>' + (l.last_contacted_at ? 'Contacted ' + esc(ago(l.last_contacted_at)) : '<span class="warn">Not contacted</span>') + '</span>' +
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
    try { await loadLeads(); } catch (e) { return render('<div class="page"><p class="form-error">' + esc(niceError(e)) + '</p></div>'); }
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
    try { await loadLeads(); } catch (e) { return render('<div class="page"><p class="form-error">' + esc(niceError(e)) + '</p></div>'); }
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
    var NAMES = { 'homepage-hero': 'Homepage quiz', 'homepage-quote': 'Quote form', 'policy-review': 'Policy review', 'agent-callback': 'Callback request', apply: 'Online application' };
    var srcRows = Object.keys(srcCount).map(function (k) { return { label: NAMES[k] || k, n: srcCount[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 6);
    var online = leads.filter(function (l) { return l.path === 'digital'; }).length;

    var follow = stale.concat(inbox.filter(function (l) { return stale.indexOf(l) === -1; }))
      .sort(function (a, b) { return t(a.created_at) - t(b.created_at); }).slice(0, 6);

    var workload = '';
    if (isAdmin()) {
      var people = team.filter(function (p) { return p.active; });
      workload = '<section class="panel"><h2>Team workload</h2><div class="table-wrap"><table class="team-load"><thead><tr><th>Agent</th><th>Open</th><th>Needs action</th><th>Won</th><th>Archived</th></tr></thead><tbody>' +
        '<tr><td><b>Unassigned</b></td><td>' + active.filter(function (l) { return !l.assigned_to && S.group(l.status) !== 'won'; }).length + '</td><td>' + inbox.filter(function (l) { return !l.assigned_to; }).length + '</td><td>—</td><td>—</td></tr>' +
        people.map(function (p) {
          var mine = leads.filter(function (l) { return l.assigned_to === p.id; });
          return '<tr><td>' + esc(p.full_name || p.email) + '</td><td>' + mine.filter(function (l) { var g = S.group(l.status); return g === 'inbox' || g === 'working'; }).length + '</td>' +
            '<td>' + mine.filter(function (l) { return S.group(l.status) === 'inbox'; }).length + '</td><td>' + mine.filter(function (l) { return S.group(l.status) === 'won'; }).length + '</td>' +
            '<td>' + mine.filter(isArchived).length + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }

    root.innerHTML =
      '<div class="page-head"><div><h1>' + esc(hello) + '</h1><p class="muted">' + esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) +
      (isAdmin() ? ' · Everything across the team' : ' · Your leads') + '</p></div>' +
      '<a class="btn btn-primary" href="#/leads">Open leads</a></div>' +
      '<div class="tiles">' +
      tile('New this week', String(thisWeek), (diff === 0 ? 'Same as last week' : (diff > 0 ? '▲ ' + diff : '▼ ' + (-diff)) + ' vs last week'), '#/leads') +
      tile('Needs action', String(inbox.length), 'New, abandoned or referred', '#/leads', inbox.length ? 'gold' : '') +
      tile('Waiting 24h+', String(stale.length), stale.length ? 'Not contacted yet' : 'Everyone’s been contacted', '#/leads', stale.length ? 'alert' : '') +
      tile('Open pipeline', money(pipeline) || '$0', 'Coverage still in play', '#/leads') +
      tile('Won this month', String(wonMonth), won.length + ' won all-time', '#/leads', wonMonth ? 'good' : '') +
      tile('Close rate', rate == null ? '—' : rate + '%', 'Won ÷ (won + archived)', '#/archive') +
      '</div>' +
      '<div class="home-grid">' +
      '<section class="panel follow"><h2>Follow up now</h2>' + (follow.length ? '<ul class="follow-list">' + follow.map(function (l) {
        var tel = phone10(l.phone);
        return '<li><a class="fl-main" href="#/lead/' + esc(l.id) + '"><b>' + esc(l.first_name + ' ' + l.last_name) + '</b><span>' + statusChip(l.status) + ' · in ' + esc(ago(l.created_at)) +
          (l.last_contacted_at ? '' : ' · <span class="warn">not contacted</span>') + '</span></a>' +
          (tel ? '<a class="btn btn-ghost btn-sm" href="tel:+1' + esc(tel) + '" data-call="' + esc(l.id) + '">Call</a>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="muted">Nothing waiting. Nice work.</p>') + '</section>' +
      '<section class="panel"><h2>New leads, last 14 days</h2>' + chart + '</section>' +
      '<section class="panel"><h2>Pipeline by stage</h2>' + hbars(stageRows) + '</section>' +
      '<section class="panel"><h2>Where leads come from</h2>' + hbars(srcRows, leads.length) +
      '<p class="hint">' + online + ' online · ' + (leads.length - online) + ' agent path</p></section>' +
      workload +
      '<section class="panel activity"><h2>Recent activity</h2><ol class="timeline" id="activity"><li class="muted">Loading…</li></ol></section>' +
      '</div>';

    $$('[data-call]', root).forEach(function (a) {
      a.addEventListener('click', function () { sb.rpc('lead_log_contact', { p_lead: a.getAttribute('data-call'), p_via: 'call' }); });
    });
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
  async function showLead(id) {
    stopRefresh();
    render('<div class="ad-loading">Loading lead…</div>');
    var r = await sb.from('leads').select('*').eq('id', id).maybeSingle();
    if (r.error || !r.data) {
      return render('<div class="page"><a href="#/leads" class="back">← All leads</a><div class="empty"><p><b>Lead not found.</b></p><p class="muted">It may have been reassigned to someone else.</p></div></div>');
    }
    var l = r.data;
    var ev = await sb.from('lead_events').select('*').eq('lead_id', id).order('created_at', { ascending: false });
    var events = ev.data || [];
    var d = l.details || {}, u = l.utm || {}, a = l.application;

    function rows(list) {
      var out = list.filter(function (x) { return x[1] !== '' && x[1] != null; });
      return out.length ? '<dl>' + out.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + (x[2] ? x[1] : esc(x[1])) + '</dd>'; }).join('') + '</dl>' : '<p class="muted">Nothing recorded.</p>';
    }

    var tel = phone10(l.phone);
    var main = render('<div class="page">' +
      '<a href="#/leads" class="back">← All leads</a>' +
      '<div class="lead-head">' +
      '<div><h1>' + esc(l.first_name + ' ' + l.last_name) + '</h1>' +
      '<p class="muted">' + pathBadge(l.path) + ' ' + statusChip(l.status) + ' <span>Received ' + esc(fmtDate(l.created_at)) + '</span></p></div>' +
      '<div class="lead-actions">' +
      (tel ? '<a class="btn btn-primary" data-contact="call" href="tel:+1' + esc(tel) + '">Call</a>' +
        '<a class="btn btn-ghost" data-contact="text" href="sms:+1' + esc(tel) + '">Text</a>' : '') +
      (l.email ? '<a class="btn btn-ghost" data-contact="email" href="mailto:' + esc(l.email) + '">Email</a>' : '') +
      '</div></div>' +

      (isArchived(l) ? '<div class="archived-note">This lead is archived (' + esc(S.label(l.status)) + '). Pick an active stage below to restore it.</div>' : '') +
      '<div class="lead-controls">' +
      '<label class="fld fld-inline">Stage<select id="l-status">' + stageOptions(l.status) + '</select></label>' +
      (isAdmin() ? '<label class="fld fld-inline">Assigned to<select id="l-assign"><option value="">Unassigned</option>' + team.filter(function (p) { return p.active || p.id === l.assigned_to; }).map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === l.assigned_to ? ' selected' : '') + '>' + esc((p.full_name || p.email) + (p.role === 'admin' ? ' (admin)' : '')) + '</option>';
      }).join('') + '</select></label>' : '') +
      '</div>' +

      '<div class="lead-grid"><div class="lead-info">' +
      '<section class="panel"><h2>Contact</h2>' + rows([
        ['Phone', tel ? '<a href="tel:+1' + esc(tel) + '">' + esc(fmtPhone(l.phone)) + '</a>' : esc(l.phone), true],
        ['Email', l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>' : '', true],
        ['State', l.state], ['Age', l.age], ['Best time to call', l.best_time],
        ['Last contact', l.last_contacted_at ? fmtDate(l.last_contacted_at) : 'Never']
      ]) + '</section>' +
      '<section class="panel"><h2>What they’re looking for</h2>' + rows([
        ['Coverage', money(l.coverage) || l.coverage_label], ['Type', l.coverage_type], ['Interested in', l.interest],
        ['Goal', l.goal], ['Replacing a policy', l.replacing]
      ]) + '</section>' +
      '<section class="panel"><h2>Routing</h2>' + rows([
        ['Path', S.PATHS[l.path] || l.path], ['Why it went to an agent', l.reason]
      ]) + '<p class="hint">Health answers are only used to choose the path and are never stored.</p></section>' +
      (a ? '<section class="panel"><h2>Online application</h2>' + rows([
        ['Received', fmtDate(a.received_at)], ['Carrier result', a.carrier_result], ['Coverage start', a.coverage_start],
        ['Beneficiary', [a.beneficiary, a.beneficiary_relationship ? '(' + a.beneficiary_relationship + ')' : ''].join(' ').trim()],
        ['Address', [a.address, a.city, a.state, a.zip].filter(Boolean).join(', ')], ['Gender', a.gender]
      ]) + '<p class="hint">' + esc(a.note || '') + '</p></section>' : '') +
      (d.review ? '<section class="panel"><h2>Policy review answers</h2>' + rows(Object.keys(d.review).map(function (k) { return [k.replace(/_/g, ' '), d.review[k]]; })) + '</section>' : '') +
      '<section class="panel"><h2>Consent</h2>' + rows([
        ['Agreed', l.consent_at ? fmtDate(l.consent_at) : 'Not recorded'], ['Version', l.consent_version]
      ]) + (l.consent_text ? '<p class="consent-text">“' + esc(l.consent_text) + '”</p>' : '') + '</section>' +
      '<section class="panel"><h2>Where they came from</h2>' + rows([
        ['Form', l.source], ['Page', d.page], ['Ad source', u.utm_source], ['Medium', u.utm_medium], ['Campaign', u.utm_campaign],
        ['Ad term', u.utm_term], ['Ad content', u.utm_content], ['Google click ID', d.gclid ? 'Yes' : ''], ['Facebook click ID', d.fbclid ? 'Yes' : '']
      ]) + '</section>' +
      '</div>' +

      '<div class="lead-side"><section class="panel"><h2>Notes &amp; history</h2>' +
      '<form id="f-note" class="note-form"><label class="sr" for="note">Add a note</label>' +
      '<textarea id="note" name="note" rows="3" placeholder="Add a note: what you talked about, next steps…" required></textarea>' +
      '<button class="btn btn-primary" type="submit">Add note</button></form>' +
      '<ol class="timeline">' + events.map(eventItem).join('') + '</ol></section></div></div></div>');

    $('#l-status', main).addEventListener('change', async function (e) {
      var r2 = await sb.rpc('lead_set_status', { p_lead: id, p_status: e.target.value });
      if (r2.error) { toast(niceError(r2.error), 'err'); e.target.value = l.status; return; }
      toast('Status updated.', 'ok');
      showLead(id);
    });
    if ($('#l-assign', main)) $('#l-assign', main).addEventListener('change', async function (e) {
      var agent = e.target.value || null;
      var r2 = await sb.rpc('lead_assign', { p_lead: id, p_agent: agent });
      if (r2.error) { toast(niceError(r2.error), 'err'); e.target.value = l.assigned_to || ''; return; }
      if (agent) notifyAssign(id);
      toast(agent ? 'Assigned to ' + personName(agent) + '. They’ll get an alert.' : 'Lead unassigned.', 'ok');
      showLead(id);
    });
    $$('[data-contact]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        // Let the phone/text/email app open, and log the attempt in the background.
        sb.rpc('lead_log_contact', { p_lead: id, p_via: btn.getAttribute('data-contact') }).then(function () { setTimeout(function () { if (location.hash === '#/lead/' + id) showLead(id); }, 1500); });
      });
    });
    $('#f-note', main).addEventListener('submit', async function (e) {
      e.preventDefault();
      var text = $('#note', main).value.trim();
      if (!text) return;
      var btn = $('button[type=submit]', e.target);
      busy(btn, true, 'Saving…');
      var r2 = await sb.rpc('lead_add_note', { p_lead: id, p_body: text });
      busy(btn, false);
      if (r2.error) return toast(niceError(r2.error), 'err');
      showLead(id);
    });
  }

  function eventItem(e) {
    var who = e.actor ? personName(e.actor) || 'A team member' : 'Website';
    var m = e.meta || {}, text;
    switch (e.kind) {
      case 'created': text = 'Lead came in from <b>' + esc(m.source || 'the website') + '</b> (' + esc(S.PATHS[m.path] || m.path || '') + ' path).'; break;
      case 'status': text = 'Status changed from <b>' + esc(S.label(m.from)) + '</b> to <b>' + esc(S.label(m.to)) + '</b>.'; break;
      case 'assigned': text = m.to ? 'Assigned to <b>' + esc(m.name) + '</b>.' : 'Unassigned.'; break;
      case 'contact': text = { call: 'Tapped Call.', text: 'Tapped Text.', email: 'Tapped Email.' }[m.via] || 'Contact attempt.'; break;
      case 'path': text = 'Switched to the agent path: ' + esc(e.body || '') + '.'; break;
      case 'application': text = esc(e.body || 'Online application submitted.'); break;
      case 'note': text = '<span class="note-body">' + esc(e.body) + '</span>'; break;
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

  // ---------- team (admins) ----------
  async function showTeam() {
    stopRefresh();
    await loadTeam();
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
          '<td data-label="Name"><b>' + esc(p.full_name || '—') + '</b>' + (self ? ' <span class="muted">(you)</span>' : '') + '</td>' +
          '<td data-label="Email">' + esc(p.email) + '</td>' +
          '<td data-label="Role"><select data-f="role"' + (self ? ' disabled' : '') + '><option value="agent"' + (p.role === 'agent' ? ' selected' : '') + '>Agent</option><option value="admin"' + (p.role === 'admin' ? ' selected' : '') + '>Admin</option></select></td>' +
          '<td data-label="Account"><select data-f="active"' + (self ? ' disabled' : '') + '><option value="1"' + (p.active ? ' selected' : '') + '>On</option><option value="0"' + (!p.active ? ' selected' : '') + '>Off</option></select></td>' +
          '<td data-label="Open leads">' + open + '</td>' +
          '<td>' + (self ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-save>Save</button>') + '</td></tr>';
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
        var token = (await sb.auth.getSession()).data.session.access_token;
        var res = await fetch('/.netlify/functions/admin', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ action: 'invite', fullName: f.fullName.value.trim(), email: f.email.value.trim(), role: f.role.value })
        });
        var out = await res.json();
        if (!out.ok) throw new Error(out.error);
        toast('Invite sent to ' + f.email.value.trim() + '.', 'ok');
        showTeam();
      } catch (err) {
        formError(f, niceError(err));
      } finally { busy(btn, false); }
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
      '<p class="hint">New phone? Sign in on your old phone first, or ask an admin to reset your two-step verification in Supabase (Authentication → Users → your account → remove the authenticator).</p></section></div>');

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
