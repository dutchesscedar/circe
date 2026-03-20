'use strict';

const request = require('supertest');
const { app } = require('../server');

// ── /api/connections ──────────────────────────────────────────────────────────

describe('GET /api/connections', () => {
  test('returns 200 with google configured status', async () => {
    const res = await request(app).get('/api/connections');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('google');
    expect(typeof res.body.google.configured).toBe('boolean');
  });

  test('does not expose microsoft key', async () => {
    const res = await request(app).get('/api/connections');
    expect(res.body).not.toHaveProperty('microsoft');
  });
});

// ── /api/settings ─────────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  test('returns 200 with GOOGLE_CLIENT_ID field', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('GOOGLE_CLIENT_ID');
  });

  test('does not expose ANTHROPIC_API_KEY', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.body).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  test('does not expose Microsoft keys', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.body).not.toHaveProperty('MICROSOFT_CLIENT_ID');
    expect(res.body).not.toHaveProperty('MICROSOFT_CLIENT_SECRET');
  });
});

// ── /api/tasks/sync ───────────────────────────────────────────────────────────

describe('POST /api/tasks/sync', () => {
  test('returns 400 without googleToken', async () => {
    const res = await request(app).post('/api/tasks/sync').send({ pendingTasks: [] });
    expect(res.status).toBe(400);
  });

  test('returns 400 with empty googleToken', async () => {
    const res = await request(app).post('/api/tasks/sync').send({ googleToken: '', pendingTasks: [] });
    expect(res.status).toBe(400);
  });

  test('returns 413 when body exceeds 100kb', async () => {
    const res = await request(app)
      .post('/api/tasks/sync')
      .send({ googleToken: 'tok', pendingTasks: [{ title: 'x'.repeat(200_000) }] });
    expect(res.status).toBe(413);
  });
});

// ── /api/chat ─────────────────────────────────────────────────────────────────

describe('POST /api/chat', () => {
  test('returns 400 when messages is missing', async () => {
    const res = await request(app).post('/api/chat').send({});
    expect(res.status).toBe(400);
  });

  test('returns 400 when messages is empty array', async () => {
    const res = await request(app).post('/api/chat').send({ messages: [] });
    expect(res.status).toBe(400);
  });

  test('returns 400 when messages is not an array', async () => {
    const res = await request(app).post('/api/chat').send({ messages: 'hello' });
    expect(res.status).toBe(400);
  });

  test('returns 413 when body exceeds 100kb', async () => {
    const bigContent = 'x'.repeat(200_000);
    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: bigContent }] });
    expect(res.status).toBe(413);
  });
});
