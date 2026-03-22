'use strict';

/**
 * Factory functions that return the EXACT shape of data returned by our
 * Google integration layer (integrations/google.js), after it maps the raw
 * Google API response. Use these in tests instead of hand-crafting objects.
 *
 * Why this matters: the task duplication bug was caused by tests using
 * { googleId: null } which doesn't match what getTasks() actually returns.
 * These factories are the single source of truth for "what does the server
 * actually send to the client".
 *
 * If you change integrations/google.js mappings, update these factories —
 * test failures will immediately surface any contract breakage.
 */

/**
 * Matches what integrations/google.js getTasks() returns per item.
 * IMPORTANT: no `googleId` field, no `done` field — those are local-only.
 */
function googleTask({ id = 'gid_001', title = 'Test task', notes = '', due = '' } = {}) {
  return { id, title, notes, due, source: 'google' };
}

/**
 * Matches what integrations/google.js getCalendarEvents() returns per item.
 */
function googleCalendarEvent({
  id = 'cal_001',
  title = 'Test event',
  start = '2026-04-01T10:00:00',
  end = '2026-04-01T11:00:00',
  location = '',
} = {}) {
  return { id, title, start, end, location, source: 'google' };
}

/**
 * Matches what server.js runLocalTool('local_task', { action: 'add' }) creates.
 * IMPORTANT: no `source` field — that's how the app knows a task is local-only.
 */
function localTask({ id = Date.now(), title = 'Test task', done = false, priority = null, owner = null } = {}) {
  return { id, title, done, created: new Date().toISOString(), googleId: null, priority, owner };
}

/**
 * A realistic /api/tasks/sync response body (server returns { tasks: [...] }).
 * Uses googleTask() so the shape is always correct.
 */
function syncResponse(tasks = []) {
  return { tasks: tasks.map(t => googleTask(t)) };
}

/**
 * A realistic /api/sidebar response body.
 */
function sidebarResponse({ tasks = [], calendar = [] } = {}) {
  return {
    tasks: tasks.map(t => googleTask(t)),
    calendar: calendar.map(e => googleCalendarEvent(e)),
  };
}

module.exports = { googleTask, googleCalendarEvent, localTask, syncResponse, sidebarResponse };
