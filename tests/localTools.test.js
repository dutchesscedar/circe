'use strict';

const { runLocalTool } = require('../server');

const empty = () => ({ tasks: [], students: {}, schedule: [] });

// ── local_task ────────────────────────────────────────────────────────────────

describe('local_task: add', () => {
  test('creates a task with correct fields', () => {
    const { tasks } = runLocalTool('local_task', { action: 'add', task: 'Buy milk' }, empty());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Buy milk');
    expect(tasks[0].done).toBe(false);
    expect(tasks[0].googleId).toBeNull();
    expect(typeof tasks[0].id).toBe('number');
  });

  test('does not mutate the original task list', () => {
    const data = empty();
    runLocalTool('local_task', { action: 'add', task: 'X' }, data);
    expect(data.tasks).toHaveLength(0);
  });
});

describe('local_task: complete', () => {
  test('marks an existing task done', () => {
    const data = { ...empty(), tasks: [{ id: 1, title: 'Buy milk', done: false }] };
    const { tasks } = runLocalTool('local_task', { action: 'complete', task_id: 1 }, data);
    expect(tasks[0].done).toBe(true);
  });

  test('returns not-found message for unknown id', () => {
    const { result } = runLocalTool('local_task', { action: 'complete', task_id: 999 }, empty());
    expect(result).toBe('Task not found');
  });
});

describe('local_task: delete', () => {
  test('removes the task', () => {
    const data = { ...empty(), tasks: [{ id: 1, title: 'Buy milk', done: false }] };
    const { tasks } = runLocalTool('local_task', { action: 'delete', task_id: 1 }, data);
    expect(tasks).toHaveLength(0);
  });

  test('returns not-found for unknown id', () => {
    const { result } = runLocalTool('local_task', { action: 'delete', task_id: 999 }, empty());
    expect(result).toBe('Task not found');
  });
});

describe('local_task: list', () => {
  test('lists only pending tasks', () => {
    const data = {
      ...empty(),
      tasks: [
        { id: 1, title: 'Buy milk', done: false },
        { id: 2, title: 'Done thing', done: true },
      ],
    };
    const { result } = runLocalTool('local_task', { action: 'list' }, data);
    expect(result).toContain('Buy milk');
    expect(result).not.toContain('Done thing');
  });

  test('returns empty message when no pending tasks', () => {
    const { result } = runLocalTool('local_task', { action: 'list' }, empty());
    expect(result).toBe('No pending tasks');
  });
});

// ── local_schedule ────────────────────────────────────────────────────────────

describe('local_schedule: add', () => {
  test('creates a schedule entry', () => {
    const { schedule } = runLocalTool(
      'local_schedule',
      { action: 'add', event: 'Team meeting', date: '2026-04-01', time: '9:00 AM' },
      empty(),
    );
    expect(schedule).toHaveLength(1);
    expect(schedule[0].event).toBe('Team meeting');
    expect(schedule[0].date).toBe('2026-04-01');
  });
});

describe('local_schedule: list_today', () => {
  test('returns only events scheduled for today', () => {
    const today = new Date().toISOString().split('T')[0];
    const data = {
      ...empty(),
      schedule: [
        { id: 1, event: 'Today event', date: today, time: '' },
        { id: 2, event: 'Future event', date: '2099-12-31', time: '' },
      ],
    };
    const { result } = runLocalTool('local_schedule', { action: 'list_today' }, data);
    expect(result).toContain('Today event');
    expect(result).not.toContain('Future event');
  });

  test('returns nothing-today message when no events', () => {
    const { result } = runLocalTool('local_schedule', { action: 'list_today' }, empty());
    expect(result).toBe('Nothing today');
  });
});

describe('local_schedule: list', () => {
  test('lists all schedule entries', () => {
    const data = {
      ...empty(),
      schedule: [{ id: 1, event: 'A', date: '2026-04-01', time: '' }],
    };
    const { result } = runLocalTool('local_schedule', { action: 'list' }, data);
    expect(result).toContain('2026-04-01');
    expect(result).toContain('A');
  });
});

// ── local_student_notes ───────────────────────────────────────────────────────

describe('local_student_notes: add_note', () => {
  test('saves a note for a new student', () => {
    const { students } = runLocalTool(
      'local_student_notes',
      { action: 'add_note', student_name: 'Alex', note: 'Needs extra time' },
      empty(),
    );
    expect(students.Alex).toHaveLength(1);
    expect(students.Alex[0].note).toBe('Needs extra time');
  });

  test('appends to an existing student', () => {
    const data = { ...empty(), students: { Alex: [{ note: 'First note', date: '' }] } };
    const { students } = runLocalTool(
      'local_student_notes',
      { action: 'add_note', student_name: 'Alex', note: 'Second note' },
      data,
    );
    expect(students.Alex).toHaveLength(2);
  });
});

describe('local_student_notes: get_notes', () => {
  test('returns notes for a known student', () => {
    const data = { ...empty(), students: { Alex: [{ note: 'Needs extra time', date: '' }] } };
    const { result } = runLocalTool(
      'local_student_notes',
      { action: 'get_notes', student_name: 'Alex' },
      data,
    );
    expect(result).toContain('Needs extra time');
  });

  test('returns no-notes message for unknown student', () => {
    const { result } = runLocalTool(
      'local_student_notes',
      { action: 'get_notes', student_name: 'Unknown' },
      empty(),
    );
    expect(result).toContain('No notes for Unknown');
  });
});

describe('local_student_notes: list_students', () => {
  test('returns student names', () => {
    const data = { ...empty(), students: { Alex: [], Jordan: [] } };
    const { result } = runLocalTool(
      'local_student_notes',
      { action: 'list_students' },
      data,
    );
    expect(result).toContain('Alex');
    expect(result).toContain('Jordan');
  });

  test('returns empty message with no students', () => {
    const { result } = runLocalTool(
      'local_student_notes',
      { action: 'list_students' },
      empty(),
    );
    expect(result).toBe('No students yet');
  });
});

// ── local_task: priority and owner ────────────────────────────────────────────

describe('local_task: add with priority and owner', () => {
  test('stores priority and owner fields', () => {
    const { tasks } = runLocalTool(
      'local_task',
      { action: 'add', task: 'Grade papers', priority: 'high', owner: 'Kate' },
      empty(),
    );
    expect(tasks[0].priority).toBe('high');
    expect(tasks[0].owner).toBe('Kate');
  });

  test('priority defaults to null when not provided', () => {
    const { tasks } = runLocalTool('local_task', { action: 'add', task: 'No priority task' }, empty());
    expect(tasks[0].priority).toBeNull();
  });

  test('includes priority note in result message', () => {
    const { result } = runLocalTool(
      'local_task',
      { action: 'add', task: 'Urgent thing', priority: 'high' },
      empty(),
    );
    expect(result).toContain('high priority');
  });
});

describe('local_task: set_priority', () => {
  test('updates an existing task priority', () => {
    const data = { ...empty(), tasks: [{ id: 1, title: 'Buy milk', done: false, priority: null }] };
    const { tasks, result } = runLocalTool(
      'local_task',
      { action: 'set_priority', task_id: 1, priority: 'medium' },
      data,
    );
    expect(tasks[0].priority).toBe('medium');
    expect(result).toContain('medium');
    expect(result).toContain('Buy milk');
  });

  test('returns not-found for unknown id', () => {
    const { result } = runLocalTool(
      'local_task',
      { action: 'set_priority', task_id: 999, priority: 'high' },
      empty(),
    );
    expect(result).toBe('Task not found');
  });
});

describe('local_task: list sorts by priority', () => {
  test('high priority tasks appear before low', () => {
    const data = {
      ...empty(),
      tasks: [
        { id: 1, title: 'Low task', done: false, priority: 'low' },
        { id: 2, title: 'High task', done: false, priority: 'high' },
        { id: 3, title: 'No priority', done: false, priority: null },
      ],
    };
    const { result } = runLocalTool('local_task', { action: 'list' }, data);
    const highIdx = result.indexOf('High task');
    const lowIdx = result.indexOf('Low task');
    const noneIdx = result.indexOf('No priority');
    expect(highIdx).toBeLessThan(lowIdx);
    expect(lowIdx).toBeLessThan(noneIdx);
  });

  test('includes priority label and owner in list output', () => {
    const data = {
      ...empty(),
      tasks: [{ id: 1, title: 'Buy milk', done: false, priority: 'high', owner: 'Kate' }],
    };
    const { result } = runLocalTool('local_task', { action: 'list' }, data);
    expect(result).toContain('[high]');
    expect(result).toContain('owner: Kate');
  });
});
