'use strict';

const { mergeTasks, mergeCalendar } = require('../public/mergeUtils');

// ── mergeTasks ────────────────────────────────────────────────────────────────

describe('mergeTasks', () => {
  const googleTask = (id, title) => ({ id, title, source: 'google', done: false });
  const localTask  = (id, title) => ({ id, title, googleId: null, done: false });

  test('returns google tasks when no local tasks', () => {
    const result = mergeTasks([googleTask('g1', 'Buy milk')], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g1');
  });

  test('keeps local-only tasks that are not in google list', () => {
    const result = mergeTasks(
      [googleTask('g1', 'Buy milk')],
      [localTask(1001, 'Walk dog')],
    );
    expect(result).toHaveLength(2);
    expect(result.map(t => t.title)).toContain('Walk dog');
  });

  test('drops local task whose id matches a google task id', () => {
    // Unlikely but defensive: if IDs collide, Google wins
    const result = mergeTasks(
      [googleTask('g1', 'Buy milk')],
      [{ id: 'g1', title: 'Buy milk', googleId: null }],
    );
    expect(result).toHaveLength(1);
  });

  test('drops local task whose title matches a google task (dedup after sync)', () => {
    // Task was created locally, then synced to Google; local copy has no googleId yet
    const result = mergeTasks(
      [googleTask('g1', 'Buy milk')],
      [localTask(1001, 'Buy milk')],
    );
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('google');
  });

  test('title dedup is case- and whitespace-insensitive', () => {
    const result = mergeTasks(
      [googleTask('g1', 'Buy Milk')],
      [localTask(1001, '  buy milk  ')],
    );
    expect(result).toHaveLength(1);
  });

  test('keeps local task with a different title even if ids differ', () => {
    const result = mergeTasks(
      [googleTask('g1', 'Buy milk')],
      [localTask(1001, 'Call doctor')],
    );
    expect(result).toHaveLength(2);
  });

  test('does not include already-synced local tasks (source set)', () => {
    // A task with source:'google' in the local array is NOT local-only — skip it
    const alreadySynced = { id: 'g2', title: 'Old task', source: 'google', googleId: null };
    const result = mergeTasks(
      [googleTask('g1', 'Buy milk')],
      [alreadySynced],
    );
    // alreadySynced is not local-only (has source) so it should not appear twice
    expect(result.filter(t => t.id === 'g2')).toHaveLength(0);
  });

  test('handles empty google list — keeps all local tasks', () => {
    const result = mergeTasks([], [localTask(1, 'Walk dog'), localTask(2, 'Call doctor')]);
    expect(result).toHaveLength(2);
  });

  test('handles null/undefined inputs gracefully', () => {
    expect(mergeTasks(null, null)).toEqual([]);
    expect(mergeTasks(undefined, undefined)).toEqual([]);
  });

  // ── Regression: the original duplication bug ──────────────────────────────
  // Google tasks returned by getTasks() have { id, title, source:'google' } but
  // NO googleId field. When stored in localStorage and passed back as localTasks,
  // they must NOT appear in localOnly (they're already in googleTasks).
  test('regression: Google tasks in localStorage are NOT treated as local-only', () => {
    // Simulate: task was fetched from Google and saved to localStorage verbatim
    const savedFromGoogle = { id: 'g1', title: 'Grade papers', source: 'google' }; // no googleId!
    const result = mergeTasks(
      [googleTask('g1', 'Grade papers')],  // same task comes back from Google
      [savedFromGoogle],                   // also sitting in localStorage
    );
    // Should dedupe — only one copy, not two
    expect(result.filter(t => t.title === 'Grade papers')).toHaveLength(1);
  });

  test('regression: tasks without source field (local) ARE kept even without googleId property', () => {
    // Older local tasks might not have an explicit googleId: null — just no field at all
    const bareLocalTask = { id: 1001, title: 'Walk dog', done: false }; // no googleId, no source
    const result = mergeTasks(
      [googleTask('g1', 'Buy milk')],
      [bareLocalTask],
    );
    expect(result).toHaveLength(2);
    expect(result.map(t => t.title)).toContain('Walk dog');
  });
});

// ── mergeCalendar ─────────────────────────────────────────────────────────────

describe('mergeCalendar', () => {
  const TODAY   = '2026-04-01';
  const FUTURE  = '2026-04-10';
  const PAST    = '2026-03-01';

  const gEvent  = (id, title, start) => ({ id, title, start });
  const local   = (id, title, date, time = '') => ({ id, event: title, date, time });

  test('returns google events when no local schedule', () => {
    const result = mergeCalendar([gEvent('g1', 'Team standup', `${TODAY}T09:00`)], [], TODAY);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g1');
  });

  test('keeps local events not in google list', () => {
    const result = mergeCalendar(
      [gEvent('g1', 'Standup', `${TODAY}T09:00`)],
      [local(1001, 'IEP meeting', FUTURE)],
      TODAY,
    );
    expect(result).toHaveLength(2);
    expect(result.map(e => e.title)).toContain('IEP meeting');
  });

  test('drops past local events', () => {
    const result = mergeCalendar(
      [],
      [local(1001, 'Old event', PAST)],
      TODAY,
    );
    expect(result).toHaveLength(0);
  });

  test('keeps local events on today', () => {
    const result = mergeCalendar([], [local(1001, 'Today event', TODAY)], TODAY);
    expect(result).toHaveLength(1);
  });

  test('drops local event whose id matches a google event id', () => {
    const result = mergeCalendar(
      [gEvent('g1', 'Standup', `${TODAY}T09:00`)],
      [{ id: 'g1', event: 'Standup', date: TODAY, time: '9:00 AM' }],
      TODAY,
    );
    expect(result).toHaveLength(1);
  });

  test('drops local event whose title+date matches a google event (dedup after sync)', () => {
    const result = mergeCalendar(
      [gEvent('g1', 'Team standup', `${TODAY}T09:00`)],
      [local(1001, 'Team standup', TODAY)],
      TODAY,
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g1');
  });

  test('title+date dedup is case-insensitive', () => {
    const result = mergeCalendar(
      [gEvent('g1', 'Team Standup', `${TODAY}T09:00`)],
      [local(1001, 'team standup', TODAY)],
      TODAY,
    );
    expect(result).toHaveLength(1);
  });

  test('keeps local event with same title on a different date', () => {
    const result = mergeCalendar(
      [gEvent('g1', 'Team standup', `${TODAY}T09:00`)],
      [local(1001, 'Team standup', FUTURE)],
      TODAY,
    );
    expect(result).toHaveLength(2);
  });

  test('handles null/undefined inputs gracefully', () => {
    const result = mergeCalendar(null, null, TODAY);
    expect(result).toEqual([]);
  });

  test('local event with time is included with combined start string', () => {
    const result = mergeCalendar([], [local(1001, 'Doctor appt', FUTURE, '14:00')], TODAY);
    expect(result[0].start).toBe(`${FUTURE}T14:00`);
  });

  test('normalises 12-hour "2:00 PM" time to 24-hour HH:MM', () => {
    const result = mergeCalendar([], [local(1001, 'IEP meeting', FUTURE, '2:00 PM')], TODAY);
    expect(result[0].start).toBe(`${FUTURE}T14:00`);
  });

  test('normalises "2pm" shorthand to 24-hour HH:MM', () => {
    const result = mergeCalendar([], [local(1001, 'IEP meeting', FUTURE, '2pm')], TODAY);
    expect(result[0].start).toBe(`${FUTURE}T14:00`);
  });

  test('normalises "9:30 AM" to 24-hour HH:MM', () => {
    const result = mergeCalendar([], [local(1001, 'Morning check-in', FUTURE, '9:30 AM')], TODAY);
    expect(result[0].start).toBe(`${FUTURE}T09:30`);
  });

  test('normalises "12:00 PM" (noon) correctly', () => {
    const result = mergeCalendar([], [local(1001, 'Lunch', FUTURE, '12:00 PM')], TODAY);
    expect(result[0].start).toBe(`${FUTURE}T12:00`);
  });

  test('normalises "12:00 AM" (midnight) to 00:00', () => {
    const result = mergeCalendar([], [local(1001, 'Midnight', FUTURE, '12:00 AM')], TODAY);
    expect(result[0].start).toBe(`${FUTURE}T00:00`);
  });
});

// ── Restart-cycle simulation ───────────────────────────────────────────────────
// Simulates the full token-refresh cycle that caused task duplication:
// syncWithGoogle (push pending → save merged Google list) followed by
// refreshSidebar (merge again). Verifies zero duplication after N restarts.

describe('restart-cycle simulation (duplication regression)', () => {
  // Simulate what the Google Tasks API actually returns — no googleId field
  const makeGoogleResponse = (tasks) =>
    tasks.map(t => ({ id: t.googleId || t.id, title: t.title, source: 'google' }));

  test('no duplication after 3 simulated token refreshes', () => {
    // Start: one local task, not yet synced
    let localStorage = [
      { id: 1001, title: 'Grade IEP papers', done: false, googleId: null },
    ];

    // Simulate Google Tasks API (starts empty, task gets pushed on first sync)
    let googleStore = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      // --- syncWithGoogle ---
      // Step 1: identify truly local (unsynced) tasks
      const pending = localStorage.filter(t => !t.source && !t.done);
      // Step 2: push pending to Google (simulate createTask → Google assigns id)
      for (const t of pending) {
        if (!googleStore.find(g => g.title.toLowerCase() === t.title.toLowerCase())) {
          googleStore.push({ id: `g_${t.title}`, title: t.title, source: 'google' });
        }
      }
      // Step 3: fetch all from Google and merge (the fixed syncWithGoogle flow)
      const googleResponse = makeGoogleResponse(googleStore);
      localStorage = mergeTasks(googleResponse, localStorage);

      // --- refreshSidebar ---
      // Step 4: another fetch + merge (runs concurrently after fix)
      const refreshResponse = makeGoogleResponse(googleStore);
      localStorage = mergeTasks(refreshResponse, localStorage);
    }

    // After 3 cycles, there should be exactly 1 task with this title
    const copies = localStorage.filter(t => t.title === 'Grade IEP papers');
    expect(copies).toHaveLength(1);
    expect(localStorage).toHaveLength(1);
  });

  test('multiple distinct tasks all survive 3 cycles without duplication', () => {
    let localStorage = [
      { id: 1001, title: 'Grade IEP papers', done: false, googleId: null },
      { id: 1002, title: 'Call parent re: behaviour', done: false, googleId: null },
    ];
    let googleStore = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const pending = localStorage.filter(t => !t.source && !t.done);
      for (const t of pending) {
        if (!googleStore.find(g => g.title.toLowerCase() === t.title.toLowerCase())) {
          googleStore.push({ id: `g_${t.id}`, title: t.title, source: 'google' });
        }
      }
      const gr = makeGoogleResponse(googleStore);
      localStorage = mergeTasks(gr, localStorage);
      localStorage = mergeTasks(makeGoogleResponse(googleStore), localStorage);
    }

    expect(localStorage).toHaveLength(2);
    expect(new Set(localStorage.map(t => t.title)).size).toBe(2);
  });
});
