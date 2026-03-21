// Google integration — uses browser-based OAuth (GIS).
// The access token comes from the browser (via Google Identity Services)
// and is passed with each /api/chat request. No client secret needed.

const { google } = require('googleapis');
const config = require('../config');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
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

async function deleteCalendarEvent(accessToken, eventId) {
  const auth = makeAuthClient(accessToken);
  const cal = google.calendar({ version: 'v3', auth });
  await cal.events.delete({ calendarId: 'primary', eventId });
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

async function sendEmail(accessToken, { to, subject, body }) {
  const auth = makeAuthClient(accessToken);
  const gmail = google.gmail({ version: 'v1', auth });
  // Build a minimal RFC 2822 message
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  // Gmail requires base64url encoding (no padding, url-safe)
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
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

// Returns the full plain-text body of a single email by message ID
async function getEmailBody(accessToken, messageId) {
  const auth = makeAuthClient(accessToken);
  const gmail = google.gmail({ version: 'v1', auth });
  const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const payload = detail.data.payload;

  function extractPart(part, mimeType) {
    if (part.mimeType === mimeType && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.parts) {
      for (const p of part.parts) {
        const text = extractPart(p, mimeType);
        if (text) return text;
      }
    }
    return null;
  }

  const h = payload.headers || [];
  const subject = h.find(x => x.name === 'Subject')?.value || '(no subject)';
  const from = h.find(x => x.name === 'From')?.value || 'Unknown';

  const body =
    extractPart(payload, 'text/plain') ||
    (extractPart(payload, 'text/html') || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
    '(no body)';

  return { subject, from, body: body.slice(0, 4000) };
}

// Returns a list of Drive files, optionally filtered by a search query
async function getDriveFiles(accessToken, query = '', maxResults = 10) {
  const auth = makeAuthClient(accessToken);
  const drive = google.drive({ version: 'v3', auth });

  const params = {
    pageSize: maxResults,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    q: query
      ? `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`
      : 'trashed = false',
  };

  const res = await drive.files.list(params);
  return (res.data.files || []).map(f => ({
    id: f.id,
    name: f.name,
    type: f.mimeType,
    modified: f.modifiedTime,
    url: f.webViewLink,
  }));
}

module.exports = {
  isConfigured,
  getClientId,
  SCOPES,
  getCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  getTasks,
  createTask,
  completeTask,
  getRecentEmails,
  sendEmail,
  getEmailBody,
  getDriveFiles,
};
