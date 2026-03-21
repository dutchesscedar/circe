/**
 * @jest-environment jsdom
 *
 * Behavior tests for CirceApp state machine.
 * These tests exist to catch regressions in the speak → standby → listen cycle,
 * which has broken twice due to speak() not resetting state on completion.
 */
'use strict';

// ── Browser API mocks ──────────────────────────────────────────────────────────

class MockRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = '';
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.started = false;
  }
  start() { this.started = true; }
  stop()  {
    this.started = false;
    if (this.onend) this.onend();
  }
}

// Controllable TTS mock: call synth.resolveAll() to fire onend on queued utterances
class MockSpeechSynthesis {
  constructor() {
    this.speaking = false;
    this.pending  = false;
    this._queue   = [];
  }
  speak(utterance) {
    this.speaking = true;
    this._queue.push(utterance);
  }
  cancel() {
    this.speaking = false;
    this._queue = [];
  }
  getVoices() { return []; }
  // Test helper: immediately fire onend for all queued utterances
  resolveAll() {
    this.speaking = false;
    const q = this._queue.splice(0);
    q.forEach(u => { if (u.onend) u.onend(); });
  }
  // Test helper: simulate browser silently dropping the utterance (never fires onend)
  dropAll() {
    this.speaking = false;
    this.pending  = false;
    this._queue = [];
  }
}

let synth;

beforeEach(() => {
  jest.useFakeTimers();

  synth = new MockSpeechSynthesis();

  // Set up window globals required by CirceApp
  global.SpeechRecognition              = MockRecognition;
  global.webkitSpeechRecognition        = MockRecognition;
  global.SpeechSynthesisUtterance       = class { constructor(t) { this.text = t; } };
  global.speechSynthesis                = synth;
  global.AudioContext                   = class {
    createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} }, type: '' }; }
    createGain()       { return { connect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }; }
    get currentTime()  { return 0; }
  };
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });

  // Required DOM elements
  document.body.innerHTML = `
    <div id="status-text"></div>
    <div id="interim-text"></div>
    <div id="conversation"></div>
    <div id="task-list"></div>
    <div id="calendar-list"></div>
    <div id="accounts"></div>
    <div id="error-banner" style="display:none"></div>
  `;

  // Provide mergeUtils globally (loaded via <script> in the real browser)
  global.mergeUtils = require('../public/mergeUtils');

  // Clear module cache so each test gets a fresh CirceApp
  jest.resetModules();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

function makeApp() {
  const { CirceApp } = require('../public/app');
  return new CirceApp();
}

// ── speak() state machine ─────────────────────────────────────────────────────

describe('speak() state transitions', () => {
  test('sets state to "speaking" while TTS is running', () => {
    const app = makeApp();
    app.speak('Hello');
    expect(app.state).toBe('speaking');
  });

  test('resets state to "standby" when utterance finishes (onend)', () => {
    const app = makeApp();
    app.speak('Hello');
    synth.resolveAll();
    expect(app.state).toBe('standby');
  });

  test('resets state to "standby" via watchdog when browser blocks TTS', () => {
    const app = makeApp();
    app.speak('Hello');
    synth.dropAll(); // simulate browser silently dropping the utterance

    // Secondary 1-second check should recover
    jest.advanceTimersByTime(1100);
    expect(app.state).toBe('standby');
  });

  test('resolve promise fulfills after utterance ends', async () => {
    const app = makeApp();
    let resolved = false;
    const p = app.speak('Hello').then(() => { resolved = true; });
    expect(resolved).toBe(false);
    synth.resolveAll();
    await p;
    expect(resolved).toBe(true);
  });

  test('only resets once even if onend fires and watchdog also runs', () => {
    const app = makeApp();
    app.speak('Hello');
    synth.resolveAll();          // onend fires → state = standby
    jest.advanceTimersByTime(5000); // watchdog also runs — should be a no-op
    expect(app.state).toBe('standby');
  });
});

// ── Barge-in ──────────────────────────────────────────────────────────────────

describe('barge-in during speak()', () => {
  function fireResult(app, transcript, isFinal = true) {
    const event = {
      resultIndex: 0,
      results: [{
        isFinal,
        0: { transcript },
        length: 1,
      }],
    };
    event.results.length = 1;
    app.onSpeechResult(event);
  }

  test('bargeInReady is false immediately after speak() starts', () => {
    const app = makeApp();
    app.speak('Hello there');
    expect(app.bargeInReady).toBe(false);
  });

  test('bargeInReady becomes true after 600ms grace period', () => {
    const app = makeApp();
    app.speak('Hello there');
    expect(app.bargeInReady).toBe(false);
    jest.advanceTimersByTime(600);
    expect(app.bargeInReady).toBe(true);
  });

  test('speech during grace period does NOT interrupt (prevents self-interruption)', () => {
    const app = makeApp();
    app.speak('Hello');
    // bargeInReady is still false — barge-in should be ignored
    fireResult(app, 'stop');
    expect(app.state).toBe('speaking');
    expect(synth.speaking).toBe(true);
  });

  test('in chat mode, final speech after grace period cancels TTS', () => {
    const app = makeApp();
    app.toggleConversationMode(true);
    app.speak('A long response');
    jest.advanceTimersByTime(600); // grace period over
    expect(app.bargeInReady).toBe(true);
    fireResult(app, 'what time is it', true);
    expect(synth.speaking).toBe(false); // TTS cancelled
  });

  test('outside chat mode, random speech does NOT cancel TTS', () => {
    const app = makeApp();
    app.speak('A long response');
    jest.advanceTimersByTime(600);
    fireResult(app, 'what time is it', true);
    // No wake word — should not interrupt
    expect(app.state).toBe('speaking');
  });

  test('outside chat mode, wake word cancels TTS and activates listening', () => {
    const app = makeApp();
    app.speak('A long response');
    jest.advanceTimersByTime(600);
    fireResult(app, 'hey circe what time is it', true);
    expect(synth.speaking).toBe(false);
    expect(app.state).toBe('listening');
  });

  test('bargeInReady resets to false when speak() finishes normally', () => {
    const app = makeApp();
    app.speak('Hello');
    jest.advanceTimersByTime(600);
    expect(app.bargeInReady).toBe(true);
    synth.resolveAll(); // TTS ends naturally
    expect(app.bargeInReady).toBe(false);
  });
});

// ── activate() after speak() ─────────────────────────────────────────────────

describe('activate() after speak()', () => {
  test('sets state to "listening" after speak() resolves — regression for stuck-speaking bug', async () => {
    const app = makeApp();
    const p = app.speak('A response');
    synth.resolveAll(); // onend fires → state = standby
    await p;

    app.activate(); // this should work now that state is standby
    expect(app.state).toBe('listening');
  });

  test('activate() does nothing if speak() has not resolved yet', () => {
    const app = makeApp();
    app.speak('A response'); // state = speaking
    app.activate();          // should be blocked — state !== standby
    expect(app.state).toBe('speaking');
  });
});

// ── Chat mode ────────────────────────────────────────────────────────────────

describe('chat mode', () => {
  test('toggleConversationMode(true) sets state to "listening"', () => {
    const app = makeApp();
    expect(app.state).toBe('standby');
    app.toggleConversationMode(true);
    expect(app.conversationMode).toBe(true);
    expect(app.state).toBe('listening');
  });

  test('toggleConversationMode(true) works even if app was stuck in "speaking"', () => {
    const app = makeApp();
    app.speak('Something'); // stuck in speaking (synth never fires onend)
    expect(app.state).toBe('speaking');

    app.toggleConversationMode(true); // should force reset + activate
    expect(app.state).toBe('listening');
  });

  test('toggleConversationMode(false) returns to standby', () => {
    const app = makeApp();
    app.toggleConversationMode(true);
    app.toggleConversationMode(false);
    expect(app.conversationMode).toBe(false);
    expect(app.state).toBe('standby');
  });

  test('after speak() in chat mode, app re-activates to "listening"', async () => {
    const app = makeApp();
    app.toggleConversationMode(true);
    expect(app.state).toBe('listening');

    // Simulate a response being spoken
    const p = app.speak('Here is my answer');
    synth.resolveAll(); // speak ends → done() → state = standby
    await p;

    // Chat mode re-activates
    app.activate();
    expect(app.state).toBe('listening');
  });
});

// ── buildStartupSpeech ────────────────────────────────────────────────────────

describe('buildStartupSpeech', () => {
  const { buildStartupSpeech } = require('../public/mergeUtils');
  const TODAY = '2026-04-01';

  test('includes greeting', () => {
    const text = buildStartupSpeech([], [], TODAY);
    expect(text.toLowerCase()).toContain('hi');
  });

  test('mentions pending tasks', () => {
    const tasks = [{ title: 'Grade papers', done: false }];
    const text = buildStartupSpeech(tasks, [], TODAY);
    expect(text).toContain('Grade papers');
    expect(text).toContain('1 pending task');
  });

  test('skips completed tasks', () => {
    const tasks = [{ title: 'Done thing', done: true }];
    const text = buildStartupSpeech(tasks, [], TODAY);
    expect(text).not.toContain('Done thing');
    expect(text).not.toContain('task');
  });

  test('mentions today calendar events', () => {
    const schedule = [{ id: 1, event: 'IEP meeting', date: TODAY, time: '10:00' }];
    const text = buildStartupSpeech([], schedule, TODAY);
    expect(text).toContain('IEP meeting');
  });

  test('does not mention future schedule events', () => {
    const schedule = [{ id: 1, event: 'Future thing', date: '2099-12-31', time: '' }];
    const text = buildStartupSpeech([], schedule, TODAY);
    expect(text).not.toContain('Future thing');
  });

  test('caps task list at 3, mentions overflow count', () => {
    const tasks = ['A', 'B', 'C', 'D', 'E'].map((t, i) => ({ id: i, title: t, done: false }));
    const text = buildStartupSpeech(tasks, [], TODAY);
    expect(text).toContain('A, B, C');
    expect(text).toContain('and 2 more');
  });

  test('ends with wake word reminder', () => {
    const text = buildStartupSpeech([], [], TODAY);
    expect(text).toContain('Hey Circe');
  });

  test('handles null inputs gracefully', () => {
    expect(() => buildStartupSpeech(null, null, TODAY)).not.toThrow();
  });
});
