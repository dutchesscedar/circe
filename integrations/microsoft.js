// Microsoft Graph integration — uses browser-based MSAL.js OAuth.
// The access token comes from the browser and is passed with each /api/chat request.
// No client secret needed — only a Client ID.

const axios = require('axios');
const config = require('../config');

function getClientId() {
  return config.get('MICROSOFT_CLIENT_ID');
}

function isConfigured() {
  return !!getClientId();
}

async function graph(method, endpoint, token, body) {
  const res = await axios({
    method,
    url: `https://graph.microsoft.com/v1.0${endpoint}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  });
  return res.data;
}

// Returns normalized events: { id, title, start, end, location, source }
async function getCalendarEvents(accessToken, days = 7) {
  const now = new Date().toISOString();
  const end = new Date(Date.now() + days * 86400000).toISOString();
  const res = await graph('GET',
    `/me/calendarView?startDateTime=${now}&endDateTime=${end}&$orderby=start/dateTime&$top=20&$select=id,subject,start,end,location`,
    accessToken);
  return (res.value || []).map(e => ({
    id: e.id,
    title: e.subject || '(no title)',
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || '',
    source: 'microsoft',
  }));
}

async function createCalendarEvent(accessToken, { title, start, end, location, description }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await graph('POST', '/me/events', accessToken, {
    subject: title,
    body: { contentType: 'Text', content: description || '' },
    location: { displayName: location || '' },
    start: { dateTime: start, timeZone },
    end: { dateTime: end || new Date(new Date(start).getTime() + 3600000).toISOString(), timeZone },
  });
}

async function deleteCalendarEvent(accessToken, eventId) {
  await axios.delete(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// Returns normalized tasks: { id, title, notes, due, source }
async function getTasks(accessToken) {
  const lists = await graph('GET', '/me/todo/lists?$top=1', accessToken);
  if (!lists.value?.length) return [];
  const listId = lists.value[0].id;
  const res = await graph('GET',
    `/me/todo/lists/${listId}/tasks?$filter=status ne 'completed'&$top=20&$select=id,title,body,dueDateTime`,
    accessToken);
  return (res.value || []).map(t => ({
    id: t.id,
    title: t.title,
    notes: t.body?.content || '',
    due: t.dueDateTime?.dateTime || '',
    source: 'microsoft',
  }));
}

async function createTask(accessToken, { title, notes, due }) {
  const lists = await graph('GET', '/me/todo/lists?$top=1', accessToken);
  if (!lists.value?.length) return;
  const listId = lists.value[0].id;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await graph('POST', `/me/todo/lists/${listId}/tasks`, accessToken, {
    title,
    body: { content: notes || '', contentType: 'text' },
    ...(due ? { dueDateTime: { dateTime: due, timeZone } } : {}),
  });
}

async function completeTask(accessToken, taskId) {
  const lists = await graph('GET', '/me/todo/lists?$top=1', accessToken);
  if (!lists.value?.length) return;
  const listId = lists.value[0].id;
  await graph('PATCH', `/me/todo/lists/${listId}/tasks/${taskId}`, accessToken, { status: 'completed' });
}

// Returns normalized emails: { id, subject, from, date, source }
async function getRecentEmails(accessToken, max = 5) {
  const res = await graph('GET',
    `/me/messages?$filter=isRead eq false&$top=${max}&$select=id,subject,from,receivedDateTime&$orderby=receivedDateTime desc`,
    accessToken);
  return (res.value || []).map(e => ({
    id: e.id,
    subject: e.subject || '(no subject)',
    from: e.from?.emailAddress?.address || 'Unknown',
    date: e.receivedDateTime || '',
    source: 'microsoft',
  }));
}

module.exports = {
  isConfigured,
  getClientId,
  getCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  getTasks,
  createTask,
  completeTask,
  getRecentEmails,
};
