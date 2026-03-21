require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const google = require('./integrations/google');
const config = require('./config');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

// ── Multi-account helper ──────────────────────────────────────────────────────
// Returns the best token for a service, preferring an explicit account label,
// then the account with that service marked as default, then any connected account.
function getAccountToken(accounts, service, preferredLabel) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  if (!google.isConfigured()) return null;
  if (preferredLabel) {
    const match = accounts.find(a => a.label?.toLowerCase() === preferredLabel.toLowerCase());
    if (match?.token) return match.token;
  }
  const def = accounts.find(a => a.defaults?.[service]);
  return def?.token || accounts.find(a => a.token)?.token || null;
}

// Normalise request body to always have a googleAccounts array.
// Accepts both the new {googleAccounts:[…]} shape and the legacy {googleToken:'…'} shape.
function resolveAccounts(body) {
  const { googleAccounts, googleToken } = body || {};
  if (Array.isArray(googleAccounts) && googleAccounts.length) return googleAccounts;
  if (googleToken) {
    return [{ label: 'Google', email: null, token: googleToken, defaults: { calendar: true, tasks: true, email: true, drive: true } }];
  }
  return [];
}

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
  const accounts = resolveAccounts(req.body);
  const tasksToken = getAccountToken(accounts, 'tasks');
  const pendingTasks = Array.isArray(req.body.pendingTasks) ? req.body.pendingTasks.slice(0, 100) : [];
  if (!tasksToken) {
    return res.status(400).json({ error: 'Google not connected' });
  }
  try {
    for (const task of pendingTasks) {
      await google.createTask(tasksToken, { title: task.title, notes: task.notes || '', due: task.due || '' });
    }
    const tasks = await google.getTasks(tasksToken);
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

// Returns live calendar + task data for the sidebar (called on load and after chat)
app.post('/api/sidebar', async (req, res) => {
  const accounts = resolveAccounts(req.body);
  const external = await fetchExternalData(accounts);
  res.json({
    calendar: external.calendar,
    tasks: external.tasks,
    googleTokenExpired: !!external.googleAuthError,
  });
});

// ── Fetch live data from connected services ───────────────────────────────────

async function fetchExternalData(googleAccounts) {
  const result = { calendar: [], tasks: [], emails: [], sources: [], googleAuthError: false };
  if (!Array.isArray(googleAccounts) || !google.isConfigured()) return result;

  for (const account of googleAccounts) {
    const { token, label = 'Google', defaults = {} } = account;
    if (!token) continue;
    try {
      const [cal, tasks, emails] = await Promise.all([
        defaults.calendar !== false ? google.getCalendarEvents(token, 7) : Promise.resolve([]),
        defaults.tasks    !== false ? google.getTasks(token)              : Promise.resolve([]),
        defaults.email    !== false ? google.getRecentEmails(token, 5)    : Promise.resolve([]),
      ]);
      result.calendar.push(...cal.map(e  => ({ ...e,  accountLabel: label })));
      result.tasks   .push(...tasks.map(t => ({ ...t,  accountLabel: label })));
      result.emails  .push(...emails.map(e => ({ ...e, accountLabel: label })));
      result.sources.push(account.email ? `${label} (${account.email})` : label);
    } catch(e) {
      console.error(`Google fetch error (${label}):`, e.message);
      const status = e.code || e.status || (e.response?.status);
      if (status === 401 || status === 403) result.googleAuthError = true;
    }
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
    ? `Connected Google accounts: ${external.sources.join('; ')}`
    : 'No external accounts connected — using local storage only';

  const PRIORITY_ORDER_SP = { high: 0, medium: 1, low: 2 };
  const sortedTasks = [...showTasks].sort((a, b) => (PRIORITY_ORDER_SP[a.priority] ?? 3) - (PRIORITY_ORDER_SP[b.priority] ?? 3));
  const taskList = sortedTasks.length > 0
    ? sortedTasks.map((t, i) => {
        const pri = t.priority ? ` [${t.priority}]` : '';
        const owner = t.owner ? ` (owner: ${t.owner})` : '';
        return `  ${i + 1}. [${t.id}]${pri} ${t.title}${t.due ? ' (due ' + t.due.slice(0, 10) + ')' : ''}${owner}`;
      }).join('\n')
    : '  None';

  const calList = showCalendar.length > 0
    ? showCalendar.slice(0, 10).map(e => {
        const start = e.start
          ? new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : (e.date || '');
        return `  - [${e.id}] ${start}: ${e.title || e.event}${e.location ? ' @ ' + e.location : ''}`;
      }).join('\n')
    : '  None';

  const recentlyCompleted = (localData.tasks || []).filter(t => t.done && t.completedAt).slice(-5).reverse();
  const completedList = recentlyCompleted.length > 0
    ? recentlyCompleted.map(t => {
        const when = new Date(t.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `  - ${t.title} (${when}${t.summary ? ': ' + t.summary : ''})`;
      }).join('\n')
    : '  None';

  const urgentKeywords = /urgent|asap|important|critical|deadline|overdue|immediately|response needed/i;
  const emailList = external.emails.length > 0
    ? external.emails.slice(0, 5).map(e => {
        const flag = urgentKeywords.test(e.subject) ? ' ⚑ URGENT' : '';
        return `  - From: ${e.from} | ${e.subject}${flag}`;
      }).join('\n')
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
- Be warm and calm, never over-enthusiastic or gushing
- Confirm actions simply and directly ("Added." or "Done, I've scheduled that for you.")
- Never use emoji — they are read aloud as words and sound strange
- Your name is always Circe — never refer to yourself by any other name
- For complex or sensitive topics (medical, legal), say "That's worth a second opinion — let me ask my advisor about that"
- Today is ${today}
- Local time zone: ${timeZone}
- When creating calendar events, use ISO 8601 format and assume the local time zone unless told otherwise
- ${connections}
- Proactively simplify: if you notice a faster or easier way to do what Duchess is asking, mention it briefly after completing her request. Keep it to one sentence. Never lecture or overwhelm — just a gentle "by the way" when it's genuinely useful.

UPCOMING CALENDAR (next 7 days):
${calList}

TODAY'S SCHEDULE:
${todayList}

PENDING TASKS (${showTasks.length}):
${taskList}

RECENTLY COMPLETED TASKS (last 5):
${completedList}

RECENT UNREAD EMAILS:
${emailList}
- If any email is marked ⚑ URGENT, mention it proactively at the start of your response if Duchess hasn't asked about it yet.`;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: "local_task",
    description: "Add, complete, delete, list, or set priority on tasks in local storage (fallback when no external service connected)",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "complete", "delete", "list", "set_priority", "list_completed"] },
        task: { type: "string", description: "Task title (required for add)" },
        task_id: { type: "number", description: "Task ID (required for complete, delete, set_priority)" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "Priority level" },
        owner: { type: "string", description: "Person responsible for this task (optional)" },
        summary: { type: "string", description: "Brief note on what was done — recorded when completing a task (optional)" },
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
        time: { type: "string", description: "HH:MM in 24-hour format, e.g. 14:00" },
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
    description: "Create an event in Google Calendar (use when a calendar service is connected)",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 datetime e.g. 2026-03-20T09:00:00" },
        end: { type: "string", description: "ISO 8601 datetime (optional)" },
        location: { type: "string" },
        description: { type: "string" },
        account: { type: "string", description: "Account label to use (e.g. 'work' or 'personal'). Omit to use the default." },
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
        account: { type: "string", description: "Account label to use. Omit to use the default." },
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
        account: { type: "string", description: "Account label to use. Omit to use the default." },
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
        account: { type: "string", description: "Account label to use. Omit to use the default." },
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
        account: { type: "string", description: "Account label to send from (e.g. 'work' or 'personal'). Omit to use default." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "read_email",
    description: "Read the full body of an email by its ID. Use when Duchess asks to hear or read the content of a specific email.",
    input_schema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "The email message ID (from the recent emails list)" },
        account: { type: "string", description: "Account label to use. Omit to use the default." },
      },
      required: ["email_id"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch and summarize the content of a web page. Use when Duchess says 'summarize this page', 'what does this say', or provides a URL to read.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to fetch (must start with http:// or https://)" },
      },
      required: ["url"],
    },
  },
  {
    name: "google_drive",
    description: "Search or list files in Google Drive. Use when Duchess asks to find, look up, or search for a document or file.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_recent", "search"] },
        query: { type: "string", description: "Search term (required for search action)" },
        account: { type: "string", description: "Account label to use. Omit to use the default." },
      },
      required: ["action"],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

function runLocalTool(name, input, localData) {
  const tasks = [...(localData.tasks || [])];
  const students = { ...(localData.students || {}) };
  const schedule = [...(localData.schedule || [])];

  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

  if (name === 'local_task') {
    if (input.action === 'add') {
      const t = {
        id: Date.now(),
        title: input.task,
        done: false,
        created: new Date().toISOString(),
        googleId: null,
        priority: input.priority || null,
        owner: input.owner || null,
      };
      tasks.push(t);
      const priNote = t.priority ? ` [${t.priority} priority]` : '';
      const ownerNote = t.owner ? ` for ${t.owner}` : '';
      return { result: `Added: "${input.task}"${priNote}${ownerNote}`, tasks };
    }
    if (input.action === 'complete') {
      const t = tasks.find(t => t.id === input.task_id);
      if (t) {
        t.done = true;
        t.completedAt = new Date().toISOString();
        if (input.summary) t.summary = input.summary;
        return { result: `Done: "${t.title}"`, tasks };
      }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'list_completed') {
      const done = tasks.filter(t => t.done).slice(-10).reverse();
      if (done.length === 0) return { result: 'No completed tasks yet', tasks };
      const lines = done.map(t => {
        const when = t.completedAt ? new Date(t.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'unknown date';
        return `${t.title} (done ${when}${t.summary ? ': ' + t.summary : ''})`;
      });
      return { result: lines.join('; '), tasks };
    }
    if (input.action === 'delete') {
      const i = tasks.findIndex(t => t.id === input.task_id);
      if (i !== -1) { const title = tasks[i].title; tasks.splice(i, 1); return { result: `Deleted: "${title}"`, tasks }; }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'set_priority') {
      const t = tasks.find(t => t.id === input.task_id);
      if (t) {
        t.priority = input.priority;
        return { result: `Priority set to ${input.priority} for "${t.title}"`, tasks };
      }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'list') {
      const pending = tasks.filter(t => !t.done);
      pending.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
      if (pending.length === 0) return { result: 'No pending tasks', tasks };
      const lines = pending.map(t => {
        const pri = t.priority ? `[${t.priority}] ` : '';
        const owner = t.owner ? ` (owner: ${t.owner})` : '';
        return `${pri}${t.title}${owner}`;
      });
      return { result: lines.join('; '), tasks };
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

async function runExternalTool(name, input, googleAccounts) {
  // Pick the right token for each service, honouring the optional `account` override
  const calToken   = getAccountToken(googleAccounts, 'calendar', input.account);
  const taskToken  = getAccountToken(googleAccounts, 'tasks',    input.account);
  const emailToken = getAccountToken(googleAccounts, 'email',    input.account);
  const driveToken = getAccountToken(googleAccounts, 'drive',    input.account);

  try {
    if (name === 'create_calendar_event') {
      if (calToken) {
        await google.createCalendarEvent(calToken, input);
        const acct = input.account ? ` (${input.account})` : '';
        return `Added to Google Calendar${acct}: "${input.title}"`;
      }
      return 'No calendar connected. Used local schedule instead.';
    }

    if (name === 'create_external_task') {
      if (taskToken) {
        await google.createTask(taskToken, input);
        const acct = input.account ? ` (${input.account})` : '';
        return `Added to Google Tasks${acct}: "${input.title}"`;
      }
      return 'No task service connected.';
    }

    if (name === 'complete_external_task') {
      if (taskToken) {
        await google.completeTask(taskToken, input.task_id);
        return 'Task marked complete in Google Tasks.';
      }
      return 'Could not complete task.';
    }

    if (name === 'delete_calendar_event') {
      if (calToken) {
        await google.deleteCalendarEvent(calToken, input.event_id);
        return `Deleted from Google Calendar: "${input.title || input.event_id}"`;
      }
      return 'No calendar connected.';
    }

    if (name === 'send_email') {
      if (emailToken) {
        await google.sendEmail(emailToken, input);
        const acct = input.account ? ` (${input.account})` : '';
        return `Email sent from${acct} to ${input.to}: "${input.subject}"`;
      }
      return 'Google is not connected. Cannot send email.';
    }

    if (name === 'read_email') {
      if (emailToken) {
        const { subject, from, body } = await google.getEmailBody(emailToken, input.email_id);
        return `From: ${from}\nSubject: ${subject}\n\n${body}`;
      }
      return 'Google is not connected. Cannot read email.';
    }

    if (name === 'web_fetch') {
      let parsedUrl;
      try { parsedUrl = new URL(input.url); } catch(e) { return 'Invalid URL.'; }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return 'Only http and https URLs are supported.';
      }
      const host = parsedUrl.hostname.toLowerCase();
      const blocked = [
        /^localhost$/, /^127\./, /^0\.0\.0\.0$/, /^::1$/, /^0$/, /\.local$/,
        /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./,
        /^169\.254\./, /^metadata\.google\.internal$/,
      ];
      if (blocked.some(r => r.test(host))) return 'Cannot fetch that address.';

      try {
        const controller = new AbortController();
        const watchdog = setTimeout(() => controller.abort(), 10000);
        const fetchRes = await fetch(input.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Circe/1.0' },
        });
        clearTimeout(watchdog);
        if (!fetchRes.ok) return `Could not fetch that page (status ${fetchRes.status}).`;
        const ct = fetchRes.headers.get('content-type') || '';
        if (!ct.includes('text/')) return 'That URL does not return readable text content.';
        let text = await fetchRes.text();
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ').trim();
        if (text.length > 8000) text = text.slice(0, 8000) + '... [truncated]';
        return `Content from ${input.url}:\n\n${text}`;
      } catch(e) {
        if (e.name === 'AbortError') return 'That page took too long to load.';
        return `Could not fetch the page: ${e.message}`;
      }
    }

    if (name === 'google_drive') {
      if (driveToken) {
        const query = input.action === 'search' ? (input.query || '') : '';
        const files = await google.getDriveFiles(driveToken, query, 10);
        if (files.length === 0) return 'No files found.';
        return files.map(f => `${f.name} (modified ${(f.modified || '').slice(0, 10) || 'unknown'}) — ${f.url || 'no link'}`).join('\n');
      }
      return 'Google Drive is not connected.';
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
  const { messages, localData = {}, useConsultant = false } = req.body;
  const googleAccounts = resolveAccounts(req.body);

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required.' });
  }

  const model = useConsultant ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

  try {
    const external = await fetchExternalData(googleAccounts);
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
            resultText = await runExternalTool(tb.name, tb.input, googleAccounts);
          }
          results.push({ type: 'tool_result', tool_use_id: tb.id, content: resultText });
        }
        currentMessages.push({ role: 'user', content: results });
        continue;
      }

      const text = response.content.find(b => b.type === 'text')?.text || "I'm not sure what to say.";
      const needsConsultant = !useConsultant && text.includes('advisor');

      return res.json({ response: text, localData: updatedLocalData, needsConsultant, model, googleTokenExpired: !!external.googleAuthError, calendar: external.calendar, emails: external.emails });
    }
  } catch(err) {
    console.error('Chat error:', err.message);
    // Map known technical errors to friendly messages; never expose raw API responses to Kate
    const status = err.status || err.statusCode || (err.response && err.response.status);
    let friendly;
    if (status === 529 || (err.message && err.message.includes('overloaded'))) {
      friendly = "I'm a little overloaded right now. Give me a moment and try again.";
    } else if (status === 429 || (err.message && err.message.includes('rate'))) {
      friendly = "I need a quick breather. Try again in a moment.";
    } else if (status === 401 || status === 403) {
      friendly = "There's a problem with my connection. Ask someone to check the API key.";
    } else {
      friendly = "Something went wrong on my end. Let's try that again.";
    }
    res.status(500).json({ error: friendly });
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

module.exports = { app, runLocalTool, buildSystemPrompt, getAccountToken, resolveAccounts };
