// @ts-check
/**
 * Integration tests for Circe UI.
 * These run against the live server at http://localhost:3000.
 * They catch bugs that unit tests can't: missing globals, DOM wiring, sidebar updates.
 *
 * Run with: npm run test:integration
 */
const { test, expect } = require('@playwright/test');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for the status text to settle (not "Thinking…" or "Speaking…") */
async function waitForIdle(page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById('status-text')?.textContent || '';
      return s !== 'Thinking…' && s !== 'Speaking…';
    },
    { timeout }
  );
}

/** Type into the chat input and press Enter */
async function send(page, text) {
  await page.fill('#text-input', text);
  await page.press('#text-input', 'Enter');
}

// ── Page load ─────────────────────────────────────────────────────────────────

test('page loads and app global is defined', async ({ page }) => {
  await page.goto('/');
  const appDefined = await page.evaluate(() => typeof window.app !== 'undefined');
  expect(appDefined).toBe(true);
});

test('shows greeting bubble on load', async ({ page }) => {
  await page.goto('/');
  // Wait for startup speech to render
  await page.waitForSelector('.message.circe', { timeout: 5000 });
  const text = await page.locator('.message.circe').first().textContent();
  expect(text?.toLowerCase()).toContain('duchess');
});

test('no JS errors on load', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForTimeout(1000);
  // favicon 404 is acceptable; anything else is not
  const real = errors.filter(e => !e.includes('favicon'));
  expect(real).toHaveLength(0);
});

// ── Sidebar initial state ─────────────────────────────────────────────────────

test('sidebar shows local schedule events on load', async ({ page }) => {
  // Seed a future event in localStorage before the app boots
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('circe_schedule', JSON.stringify([
      { id: 1, event: 'IEP meeting', date: '2099-06-15', time: '14:00' }
    ]));
  });
  await page.reload();
  await page.waitForSelector('#calendar-list .cal-event', { timeout: 3000 });
  const text = await page.locator('#calendar-list').textContent();
  expect(text).toContain('IEP meeting');
});

test('sidebar normalises 12-hour time from localStorage', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('circe_schedule', JSON.stringify([
      { id: 2, event: 'Doctor appt', date: '2099-06-16', time: '2:00 PM' }
    ]));
  });
  await page.reload();
  await page.waitForSelector('#calendar-list .cal-event', { timeout: 3000 });
  // Should render as "2:00 PM", not "Invalid Date"
  const timeEl = await page.locator('.cal-time').first().textContent();
  expect(timeEl).not.toContain('Invalid Date');
  expect(timeEl).toMatch(/\d+:\d+/);
});

test('sidebar shows pending tasks on load', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('circe_tasks', JSON.stringify([
      { id: 1, title: 'Grade papers', done: false, googleId: null }
    ]));
  });
  await page.reload();
  const text = await page.locator('#task-list').textContent();
  expect(text).toContain('Grade papers');
});

test('sidebar hides completed tasks', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('circe_tasks', JSON.stringify([
      { id: 1, title: 'Already done', done: true, googleId: null }
    ]));
  });
  await page.reload();
  const text = await page.locator('#task-list').textContent();
  expect(text).not.toContain('Already done');
  expect(text).toContain('No tasks yet');
});

// ── Send button / text input ──────────────────────────────────────────────────

test('Send button does not throw ReferenceError', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.fill('#text-input', 'hello');
  await page.click('button:has-text("Send")');
  await page.waitForTimeout(500);
  const refErrors = errors.filter(e => e.includes('ReferenceError'));
  expect(refErrors).toHaveLength(0);
});

test('Enter key submits message', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.fill('#text-input', 'test message');
  await page.press('#text-input', 'Enter');
  await page.waitForTimeout(500);
  const refErrors = errors.filter(e => e.includes('ReferenceError'));
  expect(refErrors).toHaveLength(0);
  // User bubble should appear
  const bubbles = await page.locator('.message.user').count();
  expect(bubbles).toBeGreaterThan(0);
});

test('empty message does not submit', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.message.circe'); // wait for greeting
  const beforeCount = await page.locator('.message.user').count();
  await page.click('button:has-text("Send")'); // send empty
  await page.waitForTimeout(300);
  const afterCount = await page.locator('.message.user').count();
  expect(afterCount).toBe(beforeCount); // no new bubble
});

// ── Add task flow ─────────────────────────────────────────────────────────────

test('adding a task updates the sidebar', async ({ page }) => {
  await page.goto('/');
  await send(page, 'add a task: write lesson plan');
  await waitForIdle(page);
  const sidebarText = await page.locator('#task-list').textContent();
  expect(sidebarText).toContain('lesson plan');
});

// ── Settings modal ────────────────────────────────────────────────────────────

test('settings modal opens and closes', async ({ page }) => {
  await page.goto('/');
  await page.click('button[title="Settings"]');
  await expect(page.locator('#settings-modal')).toBeVisible();
  await page.click('button:has-text("Cancel")');
  await expect(page.locator('#settings-modal')).toBeHidden();
});

// ── Chat mode toggle ──────────────────────────────────────────────────────────

test('Chat Mode button toggles active class', async ({ page }) => {
  await page.goto('/');
  const btn = page.locator('#conv-btn');
  await expect(btn).not.toHaveClass(/active/);
  await btn.click();
  await expect(btn).toHaveClass(/active/);
  await btn.click();
  await expect(btn).not.toHaveClass(/active/);
});

// ── Error messages ────────────────────────────────────────────────────────────

// ── "What can you do?" ───────────────────────────────────────────────────────

test('"what can you do" responds without a server round-trip', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.message.circe', { timeout: 5000 }); // wait for greeting
  // Intercept /api/chat to detect if it gets called
  let chatHit = false;
  await page.route('/api/chat', route => { chatHit = true; route.continue(); });
  await send(page, 'what can you do');
  // Wait for a second Circe bubble (first is the greeting, second is the help response)
  await page.waitForFunction(() => document.querySelectorAll('.message.circe').length >= 2, { timeout: 5000 });
  expect(chatHit).toBe(false);
  const reply = await page.locator('.message.circe').last().textContent();
  expect(reply?.toLowerCase()).toContain('task');
});

// ── Barge-in ──────────────────────────────────────────────────────────────────

test('bargeInReady is false on speak() start, true after 600ms', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Trigger speak() and sample bargeInReady before and after grace period
    window.app.speak('Testing barge in grace period');
    const before = window.app.bargeInReady;
    await new Promise(r => setTimeout(r, 700));
    const after = window.app.bargeInReady;
    window.speechSynthesis.cancel();
    return { before, after };
  });
  expect(result.before).toBe(false);
  expect(result.after).toBe(true);
});

// ── API error messages ────────────────────────────────────────────────────────

test('API error shows friendly message, not raw JSON', async ({ page }) => {
  await page.goto('/');
  // Intercept the chat API and return a 500 with a friendly error
  await page.route('/api/chat', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: "Something went wrong on my end. Let's try that again." }),
  }));
  await send(page, 'test');
  await waitForIdle(page);
  const lastBubble = await page.locator('.message.circe').last().textContent();
  // Should NOT contain raw JSON or status codes
  expect(lastBubble).not.toMatch(/\{.*"type".*\}/);
  expect(lastBubble).not.toMatch(/^\d{3}/);
});
