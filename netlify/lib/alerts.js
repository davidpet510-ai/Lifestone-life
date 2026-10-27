/*
 * Email and text alerts to the team. Both are optional: if the env vars aren't set, that
 * channel is skipped. Alerts never block saving a lead, and never include health details.
 *
 *   Email (Resend):  RESEND_API_KEY, ALERT_FROM_EMAIL  e.g. "Lifestone Leads <leads@lifestonelife.com>"
 *   Text (Twilio):   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER  e.g. +19545550000
 */
const { siteUrl, digits, Statuses } = require('./common.js');

const money = (n) => (n ? '$' + Number(n).toLocaleString('en-US') : '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prettyPhone = (p) => { const d = digits(p).replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : p; };
const leadLink = (lead) => siteUrl() + '/admin/#/lead/' + lead.id;

function toE164(p) {
  const d = digits(p);
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return String(p || '').startsWith('+') && d.length >= 11 ? '+' + d : null;
}

async function sendEmail(to, subject, text, html) {
  const key = process.env.RESEND_API_KEY, from = process.env.ALERT_FROM_EMAIL;
  if (!key || !from || !to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
  if (!res.ok) throw new Error('Resend HTTP ' + res.status);
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  const number = toE164(to);
  if (!sid || !token || !from || !number) return;
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: number, From: from, Body: body }).toString()
  });
  if (!res.ok) throw new Error('Twilio HTTP ' + res.status);
}

function summaryLines(lead) {
  return [
    ['Name', lead.first_name + ' ' + lead.last_name],
    ['Phone', prettyPhone(lead.phone)],
    ['Email', lead.email],
    ['State', lead.state],
    ['Age', lead.age],
    ['Coverage', [money(lead.coverage) || lead.coverage_label, lead.coverage_type].filter(Boolean).join(' · ')],
    ['Path', Statuses.PATHS[lead.path] || lead.path],
    ['Why an agent', lead.reason],
    ['Best time', lead.best_time],
    ['Source', lead.source]
  ].filter(([, v]) => v !== '' && v != null);
}

function emailBody(intro, lead) {
  const rows = summaryLines(lead);
  const text = intro + '\n\n' + rows.map(([k, v]) => k + ': ' + v).join('\n') + '\n\nOpen the lead: ' + leadLink(lead);
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1E2A24">' +
    '<p style="margin:0 0 14px">' + esc(intro) + '</p>' +
    '<table style="border-collapse:collapse">' + rows.map(([k, v]) =>
      '<tr><td style="padding:4px 14px 4px 0;color:#55645C">' + esc(k) + '</td><td style="padding:4px 0;font-weight:bold">' + esc(v) + '</td></tr>').join('') + '</table>' +
    '<p style="margin:20px 0 0"><a href="' + esc(leadLink(lead)) + '" style="background:#1F3D2E;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open in Lifestone dashboard</a></p></div>';
  return { text, html };
}

// Sends to every recipient on the channels they turned on. Never throws.
async function notify(recipients, subject, intro, smsText, lead) {
  const { text, html } = emailBody(intro, lead);
  const jobs = [];
  for (const r of recipients) {
    if (!r || !r.active) continue;
    if (r.alert_email && r.email) jobs.push(sendEmail(r.email, subject, text, html));
    if (r.alert_sms && r.phone) jobs.push(sendSms(r.phone, smsText + ' ' + leadLink(lead)));
  }
  const results = await Promise.allSettled(jobs);
  results.filter((x) => x.status === 'rejected').forEach((x) => console.error('alert failed:', x.reason && x.reason.message));
}

function newLead(recipients, lead) {
  const who = lead.first_name + ' ' + String(lead.last_name || '').slice(0, 1) + '.';
  const kind = lead.status === 'abandoned' ? 'Abandoned application' : 'New lead';
  const path = Statuses.PATHS[lead.path] || lead.path;
  return notify(recipients, kind + ': ' + who + ' (' + path + ')', kind + ' from the website.', 'Lifestone: ' + kind.toLowerCase() + ', ' + who + ' (' + path + ').', lead);
}

function assigned(agent, lead) {
  const who = lead.first_name + ' ' + String(lead.last_name || '').slice(0, 1) + '.';
  return notify([agent], 'Lead assigned to you: ' + who, 'This lead was assigned to you.', 'Lifestone: lead assigned to you, ' + who + '.', lead);
}

function wantsAgent(recipients, lead) {
  const who = lead.first_name + ' ' + String(lead.last_name || '').slice(0, 1) + '.';
  return notify(recipients, 'Wants to talk to an agent: ' + who, 'This person left the online application and asked to talk to an agent.', 'Lifestone: ' + who + ' asked to talk to an agent.', lead);
}

function application(recipients, lead, result) {
  const who = lead.first_name + ' ' + String(lead.last_name || '').slice(0, 1) + '.';
  const label = Statuses.label(lead.status);
  return notify(recipients, 'Online application: ' + who + ' (' + label + ')', 'An online application came in. Carrier result: ' + result + '.', 'Lifestone: online application from ' + who + ' (' + label + ').', lead);
}

// Reminder that a task is due. No lead details beyond the first name and last initial.
async function taskReminder(agent, task, lead) {
  if (!agent || !agent.active) return;
  const when = new Date(task.due_at).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
  const who = lead ? ' (' + lead.first_name + ' ' + String(lead.last_name || '').slice(0, 1) + '.)' : '';
  const link = lead ? leadLink(lead) : siteUrl() + '/admin/#/tasks';
  const line = 'Reminder: ' + task.title + who + ', due ' + when + '.';
  const jobs = [];
  if (agent.alert_email && agent.email) {
    jobs.push(sendEmail(agent.email, 'Reminder: ' + task.title + who, line + '\n\nOpen: ' + link,
      '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1E2A24"><p style="margin:0 0 18px">' + esc(line) + '</p>' +
      '<p style="margin:0"><a href="' + esc(link) + '" style="background:#1F3D2E;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open in Lifestone dashboard</a></p></div>'));
  }
  if (agent.alert_sms && agent.phone) jobs.push(sendSms(agent.phone, 'Lifestone ' + line + ' ' + link));
  const results = await Promise.allSettled(jobs);
  results.filter((x) => x.status === 'rejected').forEach((x) => console.error('reminder failed:', x.reason && x.reason.message));
}

module.exports = { taskReminder, newLead, assigned, wantsAgent, application, toE164 };
