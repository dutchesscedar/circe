'use strict';

/**
 * Merge Google tasks with local-only tasks.
 *
 * Rules:
 * - Google is the source of truth for anything that has been synced.
 * - Local tasks (googleId === null, no source) are kept only if:
 *     (a) their numeric id is not already in the Google list, AND
 *     (b) their title (case-insensitive, trimmed) doesn't match any Google task title
 *         (catches tasks created locally then pushed to Google before the id was updated).
 *
 * @param {Array} googleTasks  - tasks returned by the Google Tasks API (have id & source:'google')
 * @param {Array} localTasks   - current this.data.tasks array (mix of local and previously-merged)
 * @returns {Array} merged task list
 */
function mergeTasks(googleTasks, localTasks) {
  const googleIds    = new Set((googleTasks  || []).map(t => t.id));
  const googleTitles = new Set((googleTasks  || []).map(t => (t.title || '').toLowerCase().trim()));

  const localOnly = (localTasks || []).filter(t =>
    !t.source &&
    t.googleId === null &&
    !googleIds.has(t.id) &&
    !googleTitles.has((t.title || '').toLowerCase().trim())
  );

  return [...(googleTasks || []), ...localOnly];
}

/**
 * Merge Google calendar events with local schedule entries.
 *
 * Rules:
 * - Google events come first and are the source of truth.
 * - Local schedule entries are kept only if their id isn't already in the Google list
 *   AND their start date is today or in the future.
 * - Deduplication by title+date as a last resort (catches locally-created events that
 *   were later pushed to Google Calendar).
 *
 * @param {Array}  googleEvents  - events from Google Calendar (have id, title, start)
 * @param {Array}  localSchedule - this.data.schedule entries ({ id, event|title, date, time })
 * @param {string} todayStr      - ISO date string 'YYYY-MM-DD' for the current day
 * @returns {Array} merged events list ({ id, title, start })
 */
function mergeCalendar(googleEvents, localSchedule, todayStr) {
  const googleIds = new Set((googleEvents || []).map(e => e.id));

  // Build a set of "title|date" keys for Google events for title+date dedup
  const googleKeys = new Set(
    (googleEvents || []).map(e => {
      const dateStr = (e.start || '').slice(0, 10);
      return `${(e.title || '').toLowerCase().trim()}|${dateStr}`;
    })
  );

  const localEvents = (localSchedule || []).map(e => ({
    id:    e.id,
    title: e.event || e.title || '',
    start: e.date ? (e.time ? `${e.date}T${e.time}` : e.date) : '',
  }));

  const localOnly = localEvents.filter(e => {
    if (googleIds.has(e.id)) return false;
    if (e.start < todayStr)  return false;  // past events
    const key = `${(e.title || '').toLowerCase().trim()}|${e.start.slice(0, 10)}`;
    if (googleKeys.has(key)) return false;   // duplicate by title+date
    return true;
  });

  return [...(googleEvents || []), ...localOnly];
}

/**
 * Build the spoken startup greeting Circe says on load.
 * Summarises pending tasks and today's calendar events.
 *
 * @param {Array}  tasks    - this.data.tasks
 * @param {Array}  schedule - this.data.schedule
 * @param {string} [todayOverride] - ISO date string, defaults to today (injectable for tests)
 * @returns {string} text to speak aloud
 */
function buildStartupSpeech(tasks, schedule, todayOverride) {
  const today = todayOverride || new Date().toISOString().slice(0, 10);
  const pending = (tasks || []).filter(t => !t.done);
  const todayEvents = (schedule || []).filter(e => e.date === today);

  const parts = ["Hi Duchess, ready when you are."];

  if (pending.length > 0) {
    const shown    = pending.slice(0, 3).map(t => t.title).join(', ');
    const overflow = pending.length > 3 ? ` and ${pending.length - 3} more` : '';
    parts.push(`You have ${pending.length} pending task${pending.length !== 1 ? 's' : ''}: ${shown}${overflow}.`);
  }

  if (todayEvents.length > 0) {
    const names = todayEvents.slice(0, 3).map(e => e.event || e.title || '').filter(Boolean).join(', ');
    parts.push(`On your calendar today: ${names}.`);
  }

  parts.push('Say "Hey Circe" when you need me.');
  return parts.join(' ');
}

// UMD: works as a Node require() for tests AND as a plain <script> in the browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeTasks, mergeCalendar, buildStartupSpeech };
} else {
  window.mergeUtils = { mergeTasks, mergeCalendar, buildStartupSpeech };
}
