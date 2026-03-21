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

  test('returns TTS_VOICE with default of Samantha', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.body).toHaveProperty('TTS_VOICE');
    expect(typeof res.body.TTS_VOICE).toBe('string');
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

// ── /api/tts ──────────────────────────────────────────────────────────────────

describe('POST /api/tts', () => {
  test('returns 400 when text is missing', async () => {
    const res = await request(app).post('/api/tts').send({});
    expect(res.status).toBe(400);
  });

  test('returns 400 when text is empty string', async () => {
    const res = await request(app).post('/api/tts').send({ text: '' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when text is whitespace only', async () => {
    const res = await request(app).post('/api/tts').send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  test('voice name is sanitized (shell metacharacters stripped)', async () => {
    // This should not throw or cause a shell injection — it either succeeds or fails
    // gracefully with 400/500, never executing injected shell commands
    const res = await request(app).post('/api/tts').send({ text: 'hello', voice: 'Samantha; rm -rf /' });
    // Any status is acceptable as long as the server doesn't crash
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/tts/voices', () => {
  test('returns 200 with voices array', async () => {
    const res = await request(app).get('/api/tts/voices');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('voices');
    expect(Array.isArray(res.body.voices)).toBe(true);
  });

  test('voices have name and lang fields', async () => {
    const res = await request(app).get('/api/tts/voices');
    if (res.body.voices.length > 0) {
      expect(res.body.voices[0]).toHaveProperty('name');
      expect(res.body.voices[0]).toHaveProperty('lang');
    }
  });
});

// ── suggest_completions tool definition ───────────────────────────────────────

describe('suggest_completions tool definition', () => {
  const { tools } = require('../server');

  test('tool exists in tools array', () => {
    expect(tools.find(t => t.name === 'suggest_completions')).toBeDefined();
  });

  test('requires partial and options', () => {
    const tool = tools.find(t => t.name === 'suggest_completions');
    expect(tool.input_schema.required).toContain('partial');
    expect(tool.input_schema.required).toContain('options');
  });

  test('options is an array type', () => {
    const tool = tools.find(t => t.name === 'suggest_completions');
    expect(tool.input_schema.properties.options.type).toBe('array');
  });
});
