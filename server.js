require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(data) {
  const tasks = (data.tasks || []).filter(t => !t.done);
  const studentNames = Object.keys(data.students || {});
  const today = new Date().toISOString().split('T')[0];
  const todayEvents = (data.schedule || []).filter(e => e.date === today);
  const upcomingEvents = (data.schedule || [])
    .filter(e => e.date >= today)
    .slice(0, 5);

  return `You are Circe, a warm and patient personal voice assistant for Kate, a special education teacher (grades 7-12) who has early onset Alzheimer's. You help Kate manage her daily life at school and home.

Guidelines:
- Speak in short, clear sentences — your responses will be read aloud
- Be warm, encouraging, and never condescending
- Always confirm actions out loud ("Done! I've added that to your list.")
- If you're unsure about something complex or medical, say "That's a good question — let me get my advisor's take on that" (this will trigger a more careful response)
- Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Kate's current data:
PENDING TASKS (${tasks.length}):
${tasks.length > 0 ? tasks.map(t => `  [ID:${t.id}] ${t.title}`).join('\n') : '  None'}

STUDENTS WITH NOTES: ${studentNames.length > 0 ? studentNames.join(', ') : 'None yet'}

TODAY'S SCHEDULE: ${todayEvents.length > 0 ? todayEvents.map(e => `${e.time ? e.time + ' - ' : ''}${e.event}`).join(', ') : 'Nothing scheduled today'}

UPCOMING (next 5): ${upcomingEvents.length > 0 ? upcomingEvents.map(e => `${e.date}: ${e.event}`).join(' | ') : 'Nothing upcoming'}`;
}

const tools = [
  {
    name: "manage_tasks",
    description: "Add, complete, delete, or list Kate's tasks",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "complete", "delete", "list"] },
        task: { type: "string", description: "Task description (for add)" },
        task_id: { type: "number", description: "Task ID (for complete or delete)" }
      },
      required: ["action"]
    }
  },
  {
    name: "manage_students",
    description: "Add notes about students or retrieve existing notes",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_note", "get_notes", "list_students"] },
        student_name: { type: "string", description: "Student's name" },
        note: { type: "string", description: "The note to add" }
      },
      required: ["action"]
    }
  },
  {
    name: "manage_schedule",
    description: "Add events to the schedule or view what's coming up",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "list_today"] },
        event: { type: "string", description: "Event description" },
        date: { type: "string", description: "Date as YYYY-MM-DD" },
        time: { type: "string", description: "Time like '9:00 AM' (optional)" }
      },
      required: ["action"]
    }
  }
];

function runTool(toolName, input, data) {
  const tasks = [...(data.tasks || [])];
  const students = { ...(data.students || {}) };
  const schedule = [...(data.schedule || [])];

  if (toolName === 'manage_tasks') {
    if (input.action === 'add') {
      const task = { id: Date.now(), title: input.task, done: false, created: new Date().toISOString() };
      tasks.push(task);
      return { result: `Added: "${input.task}"`, tasks };
    }
    if (input.action === 'complete') {
      const t = tasks.find(t => t.id === input.task_id);
      if (t) { t.done = true; return { result: `Marked done: "${t.title}"`, tasks }; }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'delete') {
      const idx = tasks.findIndex(t => t.id === input.task_id);
      if (idx !== -1) { const title = tasks[idx].title; tasks.splice(idx, 1); return { result: `Deleted: "${title}"`, tasks }; }
      return { result: 'Task not found', tasks };
    }
    if (input.action === 'list') {
      const pending = tasks.filter(t => !t.done);
      return { result: pending.length > 0 ? pending.map(t => `${t.title}`).join('; ') : 'No pending tasks', tasks };
    }
  }

  if (toolName === 'manage_students') {
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

  if (toolName === 'manage_schedule') {
    if (input.action === 'add') {
      schedule.push({ id: Date.now(), event: input.event, date: input.date, time: input.time || '' });
      return { result: `Scheduled: ${input.event} on ${input.date}`, schedule };
    }
    if (input.action === 'list_today') {
      const today = new Date().toISOString().split('T')[0];
      const events = schedule.filter(e => e.date === today);
      return { result: events.length > 0 ? events.map(e => `${e.time ? e.time + ' ' : ''}${e.event}`).join('; ') : 'Nothing today', schedule };
    }
    if (input.action === 'list') {
      return { result: schedule.length > 0 ? schedule.map(e => `${e.date}: ${e.event}`).join('; ') : 'Schedule is empty', schedule };
    }
  }

  return { result: 'Done' };
}

app.post('/api/chat', async (req, res) => {
  const { messages, data = {}, useConsultant = false } = req.body;
  const model = useConsultant ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

  try {
    let currentMessages = [...messages];
    let updatedData = { tasks: data.tasks || [], students: data.students || {}, schedule: data.schedule || [] };

    while (true) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 512,
        system: buildSystemPrompt(updatedData),
        tools,
        messages: currentMessages
      });

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use');
        currentMessages.push({ role: 'assistant', content: response.content });

        const results = [];
        for (const tb of toolBlocks) {
          const outcome = runTool(tb.name, tb.input, updatedData);
          if (outcome.tasks) updatedData.tasks = outcome.tasks;
          if (outcome.students) updatedData.students = outcome.students;
          if (outcome.schedule) updatedData.schedule = outcome.schedule;
          results.push({ type: 'tool_result', tool_use_id: tb.id, content: outcome.result });
        }
        currentMessages.push({ role: 'user', content: results });
        continue;
      }

      const text = response.content.find(b => b.type === 'text')?.text || "I'm not sure what to say.";
      const needsConsultant = !useConsultant && (text.includes("advisor's take") || text.includes("ask my advisor"));

      return res.json({ response: text, data: updatedData, needsConsultant, model });
    }
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✨ Circe is running at http://localhost:${PORT}\n`);
});
