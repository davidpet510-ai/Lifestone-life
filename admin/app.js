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
  var view = { tab: 'inbox', q: '', path: '', agent: '' };
  var refreshTimer = null;

  // Capture what kind of email link brought us here before Supabase reads (and clears) the URL.
  var hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  var linkType = hashParams.get('type');                 // invite | recovery | magiclink | signup
  var linkError = hashParams.get('error_description');

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
    if (!location.hash || location.hash.indexOf('access_token') !== -1) history.replaceState(null, '', '#/leads');
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
      .select('id,created_at,first_name,last_name,email,phone,state,age,coverage,coverage_label,coverage_type,path,status,source,assigned_to,last_contacted_at')
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
      loadLeads().then(function () { if (/^#\/leads/.test(location.hash)) drawLeadRows(); }).catch(function () {});
    }, REFRESH_SECONDS * 1000);
  }
  function stopRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

  // ---------- routing ----------
  function route() {
    if (!me) return;
    var h = location.hash || '#/leads';
    var m;
    if ((m = h.match(/^#\/lead\/([0-9a-f-]{36})$/i))) { markNav('leads'); return showLead(m[1]); }
    if (h === '#/team' && isAdmin()) { markNav('team'); return showTeam(); }
    if (h === '#/settings') { markNav('settings'); return showSettings(); }
    markNav('leads');
    showLeads();
  }

  // ---------- leads list ----------
  var TABS = [
    { key: 'inbox', label: 'Needs action', test: function (l) { return S.group(l.status) === 'inbox'; } },
    { key: 'unassigned', label: 'Unassigned', admin: true, test: function (l) { var g = S.group(l.status); return !l.assigned_to && (g === 'inbox' || g === 'working'); } },
    { key: 'working', label: 'In progress', test: function (l) { return S.group(l.status) === 'working'; } },
    { key: 'won', label: 'Won', test: function (l) { return S.group(l.status) === 'won'; } },
    { key: 'closed', label: 'Closed', test: function (l) { return S.group(l.status) === 'closed'; } },
    { key: 'all', label: 'All', test: function () { return true; } }
  ];

  async function showLeads() {
    render('<div class="ad-loading">Loading leads…</div>');
    try { await loadLeads(); } catch (e) { return render('<div class="page"><p class="form-error">' + esc(niceError(e)) + '</p></div>'); }
    startRefresh();
    var tabs = TABS.filter(function (t) { return !t.admin || isAdmin(); });
    var main = render('<div class="page">' +
      '<div class="page-head"><div><h1>Leads</h1><p class="muted" id="lead-sum"></p></div>' +
      '<button class="btn btn-ghost" type="button" id="refresh">Refresh</button></div>' +
      '<div class="tabs" role="tablist">' + tabs.map(function (t) {
        return '<button type="button" role="tab" data-tab="' + t.key + '"><span>' + esc(t.label) + '</span><i data-count="' + t.key + '"></i></button>';
      }).join('') + '</div>' +
      '<div class="filters">' +
      '<input type="search" id="f-q" placeholder="Search name, phone or email" aria-label="Search leads">' +
      '<select id="f-path" aria-label="Path"><option value="">Online + agent</option><option value="digital">Online only</option><option value="agent">Agent only</option></select>' +
      (isAdmin() ? '<select id="f-agent" aria-label="Assigned to"><option value="">Everyone</option><option value="none">Unassigned</option>' +
        team.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.full_name || p.email) + '</option>'; }).join('') + '</select>' : '') +
      '</div>' +
      '<div id="lead-rows"></div></div>');

    $('#f-q', main).value = view.q;
    $('#f-path', main).value = view.path;
    if ($('#f-agent', main)) $('#f-agent', main).value = view.agent;
    if (!tabs.some(function (t) { return t.key === view.tab; })) view.tab = 'inbox';

    $$('[data-tab]', main).forEach(function (b) {
      b.addEventListener('click', function () { view.tab = b.getAttribute('data-tab'); drawLeadRows(); });
    });
    $('#f-q', main).addEventListener('input', function (e) { view.q = e.target.value; drawLeadRows(); });
    $('#f-path', main).addEventListener('change', function (e) { view.path = e.target.value; drawLeadRows(); });
    if ($('#f-agent', main)) $('#f-agent', main).addEventListener('change', function (e) { view.agent = e.target.value; drawLeadRows(); });
    $('#refresh', main).addEventListener('click', function () { loadLeads().then(drawLeadRows); });
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

  function drawLeadRows() {
    var box = $('#lead-rows');
    if (!box) return;
    var base = filtered();
    TABS.forEach(function (t) {
      var c = $('[data-count="' + t.key + '"]');
      if (c) c.textContent = base.filter(t.test).length;
    });
    $$('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === view.tab ? 'true' : 'false'); });
    var tab = TABS.find(function (t) { return t.key === view.tab; });
    var rows = base.filter(tab.test);
    $('#lead-sum').textContent = leads.length + (leads.length === 1 ? ' lead' : ' leads') + (isAdmin() ? ' total' : ' assigned to you') + ' · updated ' + ago(new Date(leadsLoadedAt).toISOString());

    if (!rows.length) {
      box.innerHTML = '<div class="empty"><p><b>Nothing here.</b></p><p class="muted">' +
        (leads.length ? 'Try another tab or clear the search.' : isAdmin() ? 'New leads from the website will show up here.' : 'Leads assigned to you will show up here.') + '</p></div>';
      return;
    }
    box.innerHTML = '<div class="table-wrap"><table class="leads"><thead><tr>' +
      '<th>Name</th><th>Phone</th><th>Coverage</th><th>Path</th><th>Status</th>' + (isAdmin() ? '<th>Assigned</th>' : '') + '<th>Received</th><th>Last contact</th>' +
      '</tr></thead><tbody>' + rows.map(function (l) {
        return '<tr data-id="' + esc(l.id) + '" tabindex="0">' +
          '<td data-label="Name"><a href="#/lead/' + esc(l.id) + '" class="lead-name">' + esc(l.first_name + ' ' + l.last_name) + '</a>' +
          '<small>' + esc([l.state, l.age ? 'age ' + l.age : '', l.source].filter(Boolean).join(' · ')) + '</small></td>' +
          '<td data-label="Phone">' + esc(fmtPhone(l.phone)) + '</td>' +
          '<td data-label="Coverage"><span>' + esc(money(l.coverage) || l.coverage_label || '—') + (l.coverage_type ? '<small>' + esc(l.coverage_type) + '</small>' : '') + '</span></td>' +
          '<td data-label="Path">' + pathBadge(l.path) + '</td>' +
          '<td data-label="Status">' + statusChip(l.status) + '</td>' +
          (isAdmin() ? '<td data-label="Assigned">' + (l.assigned_to ? esc(personName(l.assigned_to)) : '<span class="muted">Unassigned</span>') + '</td>' : '') +
          '<td data-label="Received" title="' + esc(fmtDate(l.created_at)) + '">' + esc(ago(l.created_at)) + '</td>' +
          '<td data-label="Last contact">' + (l.last_contacted_at ? esc(ago(l.last_contacted_at)) : '<span class="muted">Never</span>') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
    $$('tr[data-id]', box).forEach(function (tr) {
      var go = function () { location.hash = '#/lead/' + tr.getAttribute('data-id'); };
      tr.addEventListener('click', function (e) { if (!e.target.closest('a')) go(); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    });
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

      '<div class="lead-controls">' +
      '<label class="fld fld-inline">Status<select id="l-status">' + S.STATUSES.map(function (s) {
        return '<option value="' + s.key + '"' + (s.key === l.status ? ' selected' : '') + '>' + esc(s.label) + '</option>';
      }).join('') + '</select></label>' +
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
