/*
 * Runs every 15 minutes (see netlify.toml). Emails and/or texts each agent when one of their
 * tasks is about to come due, using the alert settings they chose in the dashboard.
 * Each task is reminded once; changing its due time re-arms the reminder.
 */
const db = require('../lib/db.js');
const alerts = require('../lib/alerts.js');

exports.handler = async () => {
  try {
    const due = await db.tasksToRemind();
    if (!due.length) return { statusCode: 200, body: 'nothing due' };
    const people = {}, leadCache = {};
    for (const t of due) {
      if (!t.assigned_to) continue;
      if (!(t.assigned_to in people)) people[t.assigned_to] = await db.getProfile(t.assigned_to);
      if (t.lead_id && !(t.lead_id in leadCache)) leadCache[t.lead_id] = await db.getLead(t.lead_id);
      await alerts.taskReminder(people[t.assigned_to], t, t.lead_id ? leadCache[t.lead_id] : null);
    }
    await db.markReminded(due.map((t) => t.id));
    console.log('task reminders sent', due.length);
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('task reminders failed:', e.code || '', e.message);
    return { statusCode: 500, body: 'error' };
  }
};
