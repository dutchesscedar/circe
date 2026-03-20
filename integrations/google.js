// Google integration — uses browser-based OAuth (GIS).
// The access token comes from the browser (via Google Identity Services)
// and is passed with each /api/chat request. No client secret needed.

const { google } = require('googleapis');
const config = require('../config');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

function getClientId() {
  return config.get('GOOGLE_CLIENT_ID');
}

function isConfigured() {
  return !!getClientId();
}

// Make an authenticated Google API client from a browser-issued access token
function makeAuthClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

// Returns normalized events: { id, title, start, end, location, source }
async function getCalendarEvents(accessToken, days = 7) {
  const auth = makeAuthClient(accessToken);
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

async function createCalendarEvent(accessToken, { title, start, end, location, description }) {
  const auth = makeAuthClient(accessToken);
  const cal = google.calendar({ version: 'v3', auth });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description: description || '',
      location: location || '',
      start: { dateTime: start, timeZone },
      end: { dateTime: end || new Date(new Date(start).getTime() + 3600000).toISOString(), timeZone },
    },
  });
  return res.data;
}

// Returns normalized tasks: { id, title, notes, due, source }
async function getTasks(accessToken) {
  const auth = makeAuthClient(accessToken);
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

async function createTask(accessToken, { title, notes, due }) {
  const auth = makeAuthClient(accessToken);
  const tasks = google.tasks({ version: 'v1', auth });
  const listsRes = await tasks.tasklists.list({ maxResults: 1 });
  const listId = listsRes.data.items?.[0]?.id || '@default';
  await tasks.tasks.insert({ tasklist: listId, requestBody: { title, notes, due } });
}

async function completeTask(accessToken, taskId) {
  const auth = makeAuthClient(accessToken);
  const tasks = google.tasks({ version: 'v1', auth });
  const listsRes = await tasks.tasklists.list({ maxResults: 1 });
  const listId = listsRes.data.items?.[0]?.id || '@default';
  await tasks.tasks.patch({ tasklist: listId, task: taskId, requestBody: { status: 'completed' } });
}

// Returns normalized emails: { id, subject, from, date, source }
async function getRecentEmails(accessToken, max = 5) {
  const auth = makeAuthClient(accessToken);
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
  isConfigured,
  getClientId,
  SCOPES,
  getCalendarEvents,
  createCalendarEvent,
  getTasks,
  createTask,
  completeTask,
  getRecentEmails,
};
