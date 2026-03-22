// @ts-check
/**
 * Task persistence and duplication regression tests.
 *
 * These tests simulate the restart cycle that caused task duplication:
 * tasks accumulating copies each time the page reloads and Google sync runs.
 *
 * Strategy: seed localStorage directly (no real Google auth needed), then
 * drive the mergeUtils functions via page.evaluate() to simulate the
 * syncWithGoogle → refreshSidebar cycle. Verify count stays at 1 after
 * multiple cycles and hard reloads.
 *
 * Run with: npm run test:integration
 */

const { test, expect } = require('@playwright/test');
const { localTask, googleTask } = require('../fixtures/google');

/** Wait until the app is no longer processing */
async function waitForIdle(page, timeout = 10000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById('status-text')?.textContent || '';
      return s !== 'Thinking…' && s !== 'Speaking…';
    },
    { timeout }
  );
}

/** Seed localStorage and reload; returns without waiting for idle */
async function seedAndReload(page, tasks) {
  await page.evaluate((t) => {
    localStorage.setItem('circe_tasks', JSON.stringify(t));
  }, tasks);
  await page.reload();
}

/** Read circe_tasks from localStorage */
async function readTasks(page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('circe_tasks') || '[]')
  );
}

// ── Basic persistence ─────────────────────────────────────────────────────────

test('local task survives 3 hard reloads without duplication', async ({ page }) => {
  await page.goto('/');

  const task = localTask({ id: 9001, title: 'Grade IEP papers' });
  await seedAndReload(page, [task]);

  for (let i = 0; i < 3; i++) {
    await page.reload();
    const tasks = await readTasks(page);
    const copies = tasks.filter(t => t.title === 'Grade IEP papers');
    expect(copies).toHaveLength(1);
  }
});

test('multiple local tasks all survive 3 hard reloads', async ({ page }) => {
  await page.goto('/');

  const tasks = [
    localTask({ id: 9001, title: 'Grade IEP papers' }),
    localTask({ id: 9002, title: 'Call parent re: behaviour' }),
    localTask({ id: 9003, title: 'File progress report' }),
  ];
  await seedAndReload(page, tasks);

  for (let i = 0; i < 3; i++) {
    await page.reload();
    const stored = await readTasks(page);
    expect(stored.filter(t => !t.done)).toHaveLength(3);
    expect(new Set(stored.map(t => t.title)).size).toBe(3);
  }
});

// ── Google sync simulation ────────────────────────────────────────────────────
// Directly invokes mergeTasks in the browser (the same code path as the real
// syncWithGoogle + refreshSidebar) to simulate the token-refresh cycle.

test('task does not duplicate through simulated sync+refresh cycle (3 iterations)', async ({ page }) => {
  await page.goto('/');

  // Start: one local task, not yet pushed to Google
  const initial = [localTask({ id: 9001, title: 'Grade IEP papers' })];
  await seedAndReload(page, initial);

  // After first reload, simulate what happens when Google token fires:
  // 1. syncWithGoogle pushes pending → Google assigns a string ID
  // 2. refreshSidebar fetches and merges
  // Run this cycle 3 times (token refreshes every ~55 min in production)
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate((gTask) => {
      // Simulate Google response after task was pushed (exact API shape from fixture)
      const googleResponse = [gTask];

      // syncWithGoogle: merge Google list into localStorage (Fix 3)
      const afterSync = window.mergeUtils.mergeTasks(googleResponse, window.app.data.tasks);
      window.app.saveData({ tasks: afterSync });

      // refreshSidebar: merge again (runs concurrently in production)
      const afterRefresh = window.mergeUtils.mergeTasks(googleResponse, window.app.data.tasks);
      window.app.saveData({ tasks: afterRefresh });
    }, googleTask({ id: 'g_grade_iep', title: 'Grade IEP papers' }));

    const tasks = await readTasks(page);
    const copies = tasks.filter(t => t.title === 'Grade IEP papers');
    expect(copies).toHaveLength(1);
  }

  // Hard reload — verify count survived
  await page.reload();
  const final = await readTasks(page);
  expect(final.filter(t => t.title === 'Grade IEP papers')).toHaveLength(1);
});

test('completed tasks are preserved through sync cycle', async ({ page }) => {
  await page.goto('/');

  // One done task + one pending task
  const initial = [
    localTask({ id: 9001, title: 'Grade IEP papers', done: true }),
    localTask({ id: 9002, title: 'Call parents' }),
  ];
  await seedAndReload(page, initial);

  // Sync returns only the pending task (Google hides completed)
  await page.evaluate((gTask) => {
    const googleResponse = [gTask];
    const merged = window.mergeUtils.mergeTasks(googleResponse, window.app.data.tasks);
    window.app.saveData({ tasks: merged });
  }, googleTask({ id: 'g_call', title: 'Call parents' }));

  const tasks = await readTasks(page);
  // Pending task present
  expect(tasks.filter(t => t.title === 'Call parents')).toHaveLength(1);
  // Completed task still preserved (not wiped by sync)
  expect(tasks.filter(t => t.title === 'Grade IEP papers')).toHaveLength(1);
  expect(tasks.find(t => t.title === 'Grade IEP papers').done).toBe(true);
});

// ── Sidebar display ───────────────────────────────────────────────────────────

test('task sidebar shows correct count after reload, no phantom tasks', async ({ page }) => {
  await page.goto('/');

  await seedAndReload(page, [
    localTask({ id: 9001, title: 'Unique task alpha' }),
    localTask({ id: 9002, title: 'Unique task beta' }),
  ]);

  // Sidebar should show exactly 2 tasks
  const items = await page.locator('#task-list .task-item').count();
  expect(items).toBe(2);

  // Reload and check again
  await page.reload();
  const itemsAfter = await page.locator('#task-list .task-item').count();
  expect(itemsAfter).toBe(2);
});
