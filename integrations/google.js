const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '../tokens.json');
const REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/tasks',
];

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function isConnected() {
  return isConfigured() && !!loadTokens().google;
}

function getAuthUrl() {
  const client = makeClient();
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

async function handleCallback(code) {
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  const stored = loadTokens();
  stored.google = tokens;
  saveTokens(stored);
}

function getClient() {
  const tokens = loadTokens();
  if (!tokens.google) return null;
  const client = makeClient();
  client.setCredentials(tokens.google);
  client.on('tokens', (newTokens) => {
    const stored = loadTokens();
    stored.google = { ...stored.google, ...newTokens };
    saveTokens(stored);
  });
  return client;
}

function disconnect() {
  const stored = loadTokens();
  delete stored.google;
  saveTokens(stored);
}

// Returns normalized events: { id, title, start, end, location, source }
async function getCalendarEvents(days = 7) {
  const auth = getClient();
  if (!auth) return [];
  const cal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    maxResults: 20,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items || []).map(e => ({
    id: e.id,
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || '',
    source: 'google',
  }));
}

async function createCalendarEvent({ title, start, end, location, description }) {
  const auth = getClient();
  if (!auth) throw new Error('Google not connected');
  const cal = google.calendar({ version: 'v3', auth });
  const res = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description: description || '',
      location: location || '',
      start: { dateTime: start },
      end: { dateTime: end || new Date(new Date(start).getTime() + 3600000).toISOString() },
    },
  });
  return res.data;
}

// Returns normalized tasks: { id, title, notes, due, source }
async function getTasks() {
  const auth = getClient();
  if (!auth) return [];
  const tasks = google.tasks({ version: 'v1', auth });
  const listsRes = await tasks.tasklists.list({ maxResults: 1 });
  const listId = listsRes.data.items?.[0]?.id || '@default';
  const res = await tasks.tasks.list({ tasklist: listId, showCompleted: false, maxResults: 20 });
  return (res.data.items || []).map(t => ({
    id: t.id,
    title: t.title,
    notes: t.notes || '',
    due: t.due || '',
    source: 'google',
  }));
}

async function createTask({ title, notes, due }) {
  const auth = getClient();
  if (!auth) throw new Error('Google not connected');
  const tasks = google.tasks({ version: 'v1', auth });
  const listsRes = await tasks.tasklists.list({ maxResults: 1 });
  const listId = listsRes.data.items?.[0]?.id || '@default';
  await tasks.tasks.insert({ tasklist: listId, requestBody: { title, notes, due } });
}

async function completeTask(taskId) {
  const auth = getClient();
  if (!auth) throw new Error('Google not connected');
  const tasks = google.tasks({ version: 'v1', auth });
  const listsRes = await tasks.tasklists.list({ maxResults: 1 });
  const listId = listsRes.data.items?.[0]?.id || '@default';
  await tasks.tasks.patch({ tasklist: listId, task: taskId, requestBody: { status: 'completed' } });
}

// Returns normalized emails: { id, subject, from, date, source }
async function getRecentEmails(max = 5) {
  const auth = getClient();
  if (!auth) return [];
  const gmail = google.gmail({ version: 'v1', auth });
  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: max, q: 'is:unread' });
  const messages = listRes.data.messages || [];
  const emails = [];
  for (const msg of messages.slice(0, max)) {
    const detail = await gmail.users.messages.get({
      userId: 'me', id: msg.id, format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const h = detail.data.payload.headers;
    emails.push({
      id: msg.id,
      subject: h.find(x => x.name === 'Subject')?.value || '(no subject)',
      from: h.find(x => x.name === 'From')?.value || 'Unknown',
      date: h.find(x => x.name === 'Date')?.value || '',
      source: 'google',
    });
  }
  return emails;
}

module.exports = {
  isConfigured, isConnected, getAuthUrl, handleCallback, disconnect,
  getCalendarEvents, createCalendarEvent,
  getTasks, createTask, completeTask,
  getRecentEmails,
};
