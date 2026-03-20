require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const google = require('./integrations/google');
const config = require('./config');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Settings API (stored in config.json, gitignored) ─────────────────────────

app.get('/api/settings', (req, res) => {
  res.json({
    GOOGLE_CLIENT_ID: config.get('GOOGLE_CLIENT_ID'),
  });
});

app.post('/api/settings', (req, res) => {
  const allowed = ['GOOGLE_CLIENT_ID'];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== '') {
      update[key] = req.body[key].trim();
    }
  }
  config.save(update);
  res.json({ ok: true });
});

// Returns the Google Client ID so the browser can initialize GIS
app.get('/api/google-client-id', (req, res) => {
  res.json({ clientId: google.getClientId() || null });
});

// Syncs local-only tasks up to Google, then returns the authoritative Google task list
app.post('/api/tasks/sync', async (req, res) => {
  const { googleToken, pendingTasks: rawPending = [] } = req.body;
  const pendingTasks = Array.isArray(rawPending) ? rawPending.slice(0, 100) : [];
  if (!googleToken || !google.isConfigured()) {
    return res.status(400).json({ error: 'Google not connected' });
  }
  try {
    for (const task of pendingTasks) {
      await google.createTask(googleToken, { title: task.title, notes: task.notes || '', due: task.due || '' });
    }
    const tasks = await google.getTasks(googleToken);
    res.json({ tasks });
  } catch(e) {
    const msg = e?.errors?.[0]?.message || e.message;
    res.status(500).json({ error: msg });
  }
});

app.get('/api/connections', (req, res) => {
  res.json({
    google: { configured: google.isConfigured() },
  });
});

// ── Fetch live data from connected services ───────────────────────────────────

async function fetchExternalData(googleToken) {
  const result = { calendar: [], tasks: [], emails: [], sources: [] };

  if (googleToken && google.isConfigured()) {
    try {
      const [cal, tasks, emails] = await Promise.all([
        google.getCalendarEvents(googleToken, 7),
        google.getTasks(googleToken),
        google.getRecentEmails(googleToken, 5),
      ]);
      result.calendar.push(...cal);
      result.tasks.push(...tasks);
      result.emails.push(...emails);
      result.sources.push('Google Calendar, Google Tasks, Gmail');
    } catch(e) { console.error('Google fetch error:', e.message); }
  }

  result.calendar.sort((a, b) => new Date(a.start) - new Date(b.start));
  return result;
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(localData, external) {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone });
  const todayStr = now.toISOString().split('T')[0];

  const showTasks = external.tasks.length > 0 ? external.tasks : (localData.tasks || []).filter(t => !t.done);
  const showCalendar = external.calendar.length > 0 ? external.calendar : (localData.schedule || []);
  const todayEvents = showCalendar.filter(e => (e.start || e.date || '').slice(0, 10) === todayStr);

  const connections = external.sources.length > 0
    ? `Connected: ${external.sources.join(', ')}`
    : 'No external accounts connected — using local storage only';

  const taskList = showTasks.length > 0
    ? showTasks.map((t, i) => `  ${i + 1}. [${t.id}] ${t.title}${t.due ? ' (due ' + t.due.slice(0, 10) + ')' : ''}`).join('\n')
    : '  None';

  const calList = showCalendar.length > 0
    ? showCalendar.slice(0, 10).map(e => {
        const start = e.start
          ? new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : (e.date || '');
        return `  - [${e.id}] ${start}: ${e.title || e.event}${e.location ? ' @ ' + e.location : ''}`;
      }).join('\n')
    : '  None';

  const emailList = external.emails.length > 0
    ? external.emails.slice(0, 5).map(e => `  - From: ${e.from} | ${e.subject}`).join('\n')
    : '  None';

  const todayList = todayEvents.length > 0
    ? todayEvents.map(e => {
        const t = e.start ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : (e.time || '');
        return `  ${t ? t + ': ' : ''}${e.title || e.event}`;
      }).join('\n')
    : '  Nothing scheduled today';

  return `You are Circe, a warm and patient personal voice assistant for Duchess, a special education teacher (grades 7-12) who has early onset Alzheimer's. You help Duchess manage her daily life at school and home.

Guidelines:
- Speak in short, clear sentences — your responses will be read aloud
- Address the user as Duchess
- Be warm, encouraging, and never condescending
- Always confirm actions ("Done! I've added that!")
- Never use emoji — they are read aloud as words and sound strange
- Your name is always Circe — never refer to yourself by any other name
- For complex or sensitive topics (medical, legal), say "That's worth a second opinion — let me ask my advisor about that"
- Today is ${today}
- Local time zone: ${timeZone}
- When creating calendar events, use ISO 8601 format and assume the local time zone unless told otherwise
- ${connections}

UPCOMING CALENDAR (next 7 days):
${calList}

TODAY'S SCHEDULE:
${todayList}

PENDING TASKS (${showTasks.length}):
${taskList}

RECENT UNREAD EMAILS:
${emailList}`;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: "local_task",
    description: "Add, complete, delete, or list tasks in local storage (fallback when no external service connected)",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "complete", "delete", "list"] },
        task: { type: "string" },
        task_id: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "local_schedule",
    description: "Add or view local schedule items (fallback when no calendar connected)",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "list_today"] },
        event: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "local_student_notes",
    description: "Add or retrieve notes about Kate's students",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_note", "get_notes", "list_students"] },
        student_name: { type: "string" },
        note: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create an event in Google Calendar or Outlook (use when a calendar service is connected)",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 datetime e.g. 2026-03-20T09:00:00" },
        end: { type: "string", description: "ISO 8601 datetime (optional)" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "create_external_task",
    description: "Create a task in Google Tasks (use when Google is connected)",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        due: { type: "string", description: "ISO date e.g. 2026-03-20" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_external_task",
    description: "Mark a task complete in Google Tasks",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Delete an event from Google Calendar",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        title: { type: "string", description: "Event title, for confirmation message" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "send_email",
    description: "Compose and send an email via Gmail. Use when Duchess asks to send, write, or reply to an email.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

function runLocalTool(name, input, localData) {
  const tasks = [...(localData.tasks || [])];
  const students = { ...(localData.students || {}) };
  const schedule = [...(localData.schedule || [])];

  if (name === 'local_task') {
    if (input.action === 'add') {
      const t = { id: Date.now(), title: input.task, done: false, created: new Date().toISOString(), googleId: null };
      tasks.push(t);
      return { result: `Added: "${input.task}"`, tasks };
    }
    if (input.action === 'complete') {
      const t = tasks.find(t => t.id === input.task_id);
      if (t) { t.done = true; return { result: `Done: "${t.title}"`, tasks }; }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'delete') {
      const i = tasks.findIndex(t => t.id === input.task_id);
      if (i !== -1) { const title = tasks[i].title; tasks.splice(i, 1); return { result: `Deleted: "${title}"`, tasks }; }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'list') {
      const pending = tasks.filter(t => !t.done);
      return { result: pending.length > 0 ? pending.map(t => t.title).join('; ') : 'No pending tasks', tasks };
    }
  }

  if (name === 'local_schedule') {
    if (input.action === 'add') {
      schedule.push({ id: Date.now(), event: input.event, date: input.date, time: input.time || '' });
      return { result: `Scheduled: ${input.event} on ${input.date}`, schedule };
    }
    if (input.action === 'list_today') {
      const today = new Date().toISOString().split('T')[0];
      const events = schedule.filter(e => e.date === today);
      return { result: events.length > 0 ? events.map(e => `${e.time ? e.time + ': ' : ''}${e.event}`).join('; ') : 'Nothing today', schedule };
    }
    if (input.action === 'list') {
      return { result: schedule.length > 0 ? schedule.map(e => `${e.date}: ${e.event}`).join('; ') : 'Empty', schedule };
    }
  }

  if (name === 'local_student_notes') {
    if (input.action === 'add_note') {
      if (!students[input.student_name]) students[input.student_name] = [];
      students[input.student_name].push({ note: input.note, date: new Date().toISOString() });
      return { result: `Note saved for ${input.student_name}`, students };
    }
    if (input.action === 'get_notes') {
      const notes = students[input.student_name] || [];
      return { result: notes.length > 0 ? notes.map(n => n.note).join('; ') : `No notes for ${input.student_name}`, students };
    }
    if (input.action === 'list_students') {
      const names = Object.keys(students);
      return { result: names.length > 0 ? names.join(', ') : 'No students yet', students };
    }
  }

  return { result: 'Done' };
}

async function runExternalTool(name, input, googleToken) {
  try {
    if (name === 'create_calendar_event') {
      if (googleToken && google.isConfigured()) {
        await google.createCalendarEvent(googleToken, input);
        return `Added to Google Calendar: "${input.title}"`;
      }
      return 'No calendar connected. Used local schedule instead.';
    }

    if (name === 'create_external_task') {
      if (googleToken && google.isConfigured()) {
        await google.createTask(googleToken, input);
        return `Added to Google Tasks: "${input.title}"`;
      }
      return 'No task service connected.';
    }

    if (name === 'complete_external_task') {
      if (googleToken && google.isConfigured()) {
        await google.completeTask(googleToken, input.task_id);
        return 'Task marked complete in Google Tasks.';
      }
      return 'Could not complete task.';
    }

    if (name === 'delete_calendar_event') {
      if (googleToken && google.isConfigured()) {
        await google.deleteCalendarEvent(googleToken, input.event_id);
        return `Deleted from Google Calendar: "${input.title || input.event_id}"`;
      }
      return 'No calendar connected.';
    }

    if (name === 'send_email') {
      if (googleToken && google.isConfigured()) {
        await google.sendEmail(googleToken, input);
        return `Email sent to ${input.to}: "${input.subject}"`;
      }
      return 'Google is not connected. Cannot send email.';
    }

    return 'Unknown tool';
  } catch(e) {
    const msg = e?.response?.data?.error?.message || e?.message || 'Unknown error';
    console.error(`Tool ${name} failed:`, msg);
    return `Error: ${msg}`;
  }
}

// ── Chat endpoint ─────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages, localData = {}, googleToken, useConsultant = false } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required.' });
  }

  const model = useConsultant ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

  try {
    const external = await fetchExternalData(googleToken);
    const systemPrompt = buildSystemPrompt(localData, external);

    let currentMessages = messages.slice(-50); // cap history sent to Claude
    let updatedLocalData = {
      tasks: localData.tasks || [],
      students: localData.students || {},
      schedule: localData.schedule || [],
    };

    let iterations = 0;
    while (true) {
      if (++iterations > 10) {
        return res.status(500).json({ error: 'Request took too long to process. Please try again.' });
      }
      const response = await anthropic.messages.create({
        model,
        max_tokens: 512,
        system: systemPrompt,
        tools,
        messages: currentMessages,
      });

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use');
        currentMessages.push({ role: 'assistant', content: response.content });

        const results = [];
        for (const tb of toolBlocks) {
          let resultText;
          if (['local_task', 'local_schedule', 'local_student_notes'].includes(tb.name)) {
            const outcome = runLocalTool(tb.name, tb.input, updatedLocalData);
            if (outcome.tasks) updatedLocalData.tasks = outcome.tasks;
            if (outcome.students) updatedLocalData.students = outcome.students;
            if (outcome.schedule) updatedLocalData.schedule = outcome.schedule;
            resultText = outcome.result;
          } else {
            resultText = await runExternalTool(tb.name, tb.input, googleToken);
          }
          results.push({ type: 'tool_result', tool_use_id: tb.id, content: resultText });
        }
        currentMessages.push({ role: 'user', content: results });
        continue;
      }

      const text = response.content.find(b => b.type === 'text')?.text || "I'm not sure what to say.";
      const needsConsultant = !useConsultant && text.includes('advisor');

      return res.json({ response: text, localData: updatedLocalData, needsConsultant, model });
    }
  } catch(err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n✨ Circe is running at http://localhost:${PORT}\n`);
    if (google.isConfigured()) console.log('  ✓ Google Client ID configured');
  });
}

module.exports = { app, runLocalTool, buildSystemPrompt };
