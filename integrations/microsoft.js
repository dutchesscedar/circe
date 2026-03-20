const msal = require('@azure/msal-node');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '../tokens.json');
const REDIRECT_URI = 'http://localhost:3000/auth/microsoft/callback';
const SCOPES = ['Calendars.ReadWrite', 'Mail.Read', 'Tasks.ReadWrite', 'User.Read', 'offline_access'];

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function isConfigured() {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

function isConnected() {
  return isConfigured() && !!loadTokens().microsoft?.msalCache;
}

// Cache plugin that persists MSAL token cache to tokens.json
const cachePlugin = {
  async beforeCacheAccess(ctx) {
    const stored = loadTokens();
    if (stored.microsoft?.msalCache) ctx.tokenCache.deserialize(stored.microsoft.msalCache);
  },
  async afterCacheAccess(ctx) {
    if (ctx.cacheHasChanged) {
      const stored = loadTokens();
      if (!stored.microsoft) stored.microsoft = {};
      stored.microsoft.msalCache = ctx.tokenCache.serialize();
      saveTokens(stored);
    }
  },
};

function makePca() {
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authority: 'https://login.microsoftonline.com/common',
    },
    cache: { cachePlugin },
  });
}

async function getAuthUrl() {
  const pca = makePca();
  return pca.getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI });
}

async function handleCallback(code) {
  const pca = makePca();
  const result = await pca.acquireTokenByCode({ code, scopes: SCOPES, redirectUri: REDIRECT_URI });
  // Account info saved via cachePlugin afterCacheAccess
  const stored = loadTokens();
  if (!stored.microsoft) stored.microsoft = {};
  stored.microsoft.homeAccountId = result.account.homeAccountId;
  saveTokens(stored);
}

function disconnect() {
  const stored = loadTokens();
  delete stored.microsoft;
  saveTokens(stored);
}

async function getAccessToken() {
  if (!isConnected()) return null;
  const pca = makePca();
  const accounts = await pca.getTokenCache().getAllAccounts();
  const stored = loadTokens();
  const account = accounts.find(a => a.homeAccountId === stored.microsoft?.homeAccountId) || accounts[0];
  if (!account) return null;
  try {
    const result = await pca.acquireTokenSilent({ account, scopes: SCOPES });
    return result.accessToken;
  } catch(e) {
    console.error('Microsoft silent token refresh failed:', e.message);
    return null;
  }
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
async function getCalendarEvents(days = 7) {
  const token = await getAccessToken();
  if (!token) return [];
  const now = new Date().toISOString();
  const end = new Date(Date.now() + days * 86400000).toISOString();
  const res = await graph('GET', `/me/calendarView?startDateTime=${now}&endDateTime=${end}&$orderby=start/dateTime&$top=20&$select=id,subject,start,end,location`, token);
  return (res.value || []).map(e => ({
    id: e.id,
    title: e.subject || '(no title)',
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || '',
    source: 'microsoft',
  }));
}

async function createCalendarEvent({ title, start, end, location, description }) {
  const token = await getAccessToken();
  if (!token) throw new Error('Microsoft not connected');
  await graph('POST', '/me/events', token, {
    subject: title,
    body: { contentType: 'Text', content: description || '' },
    location: { displayName: location || '' },
    start: { dateTime: start, timeZone: 'America/New_York' },
    end: { dateTime: end || new Date(new Date(start).getTime() + 3600000).toISOString(), timeZone: 'America/New_York' },
  });
}

// Returns normalized tasks: { id, title, notes, due, source }
async function getTasks() {
  const token = await getAccessToken();
  if (!token) return [];
  const lists = await graph('GET', '/me/todo/lists?$top=1', token);
  if (!lists.value?.length) return [];
  const listId = lists.value[0].id;
  const res = await graph('GET', `/me/todo/lists/${listId}/tasks?$filter=status ne 'completed'&$top=20&$select=id,title,body,dueDateTime`, token);
  return (res.value || []).map(t => ({
    id: t.id,
    title: t.title,
    notes: t.body?.content || '',
    due: t.dueDateTime?.dateTime || '',
    source: 'microsoft',
  }));
}

async function createTask({ title, notes }) {
  const token = await getAccessToken();
  if (!token) throw new Error('Microsoft not connected');
  const lists = await graph('GET', '/me/todo/lists?$top=1', token);
  if (!lists.value?.length) return;
  const listId = lists.value[0].id;
  await graph('POST', `/me/todo/lists/${listId}/tasks`, token, {
    title,
    body: { content: notes || '', contentType: 'text' },
  });
}

async function completeTask(taskId) {
  const token = await getAccessToken();
  if (!token) throw new Error('Microsoft not connected');
  const lists = await graph('GET', '/me/todo/lists?$top=1', token);
  if (!lists.value?.length) return;
  const listId = lists.value[0].id;
  await graph('PATCH', `/me/todo/lists/${listId}/tasks/${taskId}`, token, { status: 'completed' });
}

// Returns normalized emails: { id, subject, from, date, source }
async function getRecentEmails(max = 5) {
  const token = await getAccessToken();
  if (!token) return [];
  const res = await graph('GET', `/me/messages?$filter=isRead eq false&$top=${max}&$select=id,subject,from,receivedDateTime&$orderby=receivedDateTime desc`, token);
  return (res.value || []).map(e => ({
    id: e.id,
    subject: e.subject || '(no subject)',
    from: e.from?.emailAddress?.address || 'Unknown',
    date: e.receivedDateTime || '',
    source: 'microsoft',
  }));
}

module.exports = {
  isConfigured, isConnected, getAuthUrl, handleCallback, disconnect,
  getCalendarEvents, createCalendarEvent,
  getTasks, createTask, completeTask,
  getRecentEmails,
};
