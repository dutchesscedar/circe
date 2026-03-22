#!/usr/bin/env node
/**
 * Data integrity checker for Circe.
 *
 * Navigates to the running app (localhost:3000), reads localStorage, and
 * reports any data problems that could cause task/event duplication or loss.
 *
 * Usage: npm run check-data
 *
 * Exit codes:
 *   0 — all clear
 *   1 — issues found (details printed to stdout)
 */

'use strict';

const { chromium } = require('@playwright/test');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:3000', { timeout: 10000 });
    await page.waitForTimeout(1500); // let the app boot
  } catch (e) {
    console.error('❌  Could not reach http://localhost:3000 — is the server running?');
    await browser.close();
    process.exit(1);
  }

  const report = await page.evaluate(() => {
    const issues = [];
    const warnings = [];

    // ── Tasks ──────────────────────────────────────────────────────────────────
    const tasks = JSON.parse(localStorage.getItem('circe_tasks') || '[]');

    // Duplicate IDs
    const ids = tasks.map(t => t.id);
    const dupeIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupeIds.length) issues.push(`Duplicate task IDs: ${JSON.stringify(dupeIds)}`);

    // Duplicate titles (among non-done tasks)
    const activeTitles = tasks.filter(t => !t.done).map(t => (t.title || '').toLowerCase().trim());
    const dupeTitles = activeTitles.filter((t, i) => activeTitles.indexOf(t) !== i);
    if (dupeTitles.length) issues.push(`Duplicate active task titles: ${JSON.stringify([...new Set(dupeTitles)])}`);

    // Google tasks missing source field (the original bug)
    const strIdNoSource = tasks.filter(t => typeof t.id === 'string' && !t.source);
    if (strIdNoSource.length) {
      issues.push(`Tasks with string IDs but no source:'google' — may be re-pushed on next sync: ${strIdNoSource.map(t => `"${t.title}"`).join(', ')}`);
    }

    // Local tasks that look like they already have a Google ID stored as numeric timestamp
    const suspectLocal = tasks.filter(t => !t.source && typeof t.id === 'number' && t.id > 1e12);
    if (suspectLocal.length) {
      warnings.push(`${suspectLocal.length} local task(s) pending Google sync: ${suspectLocal.map(t => `"${t.title}"`).join(', ')}`);
    }

    // Tasks with no title
    const noTitle = tasks.filter(t => !t.title || t.title.trim() === '');
    if (noTitle.length) issues.push(`${noTitle.length} task(s) with empty title`);

    // ── Schedule ───────────────────────────────────────────────────────────────
    const schedule = JSON.parse(localStorage.getItem('circe_schedule') || '[]');

    const schedIds = schedule.map(e => e.id);
    const dupeSchedIds = schedIds.filter((id, i) => schedIds.indexOf(id) !== i);
    if (dupeSchedIds.length) issues.push(`Duplicate schedule event IDs: ${JSON.stringify(dupeSchedIds)}`);

    // ── Google accounts ────────────────────────────────────────────────────────
    const accounts = JSON.parse(localStorage.getItem('circe_google_accounts') || '[]');
    const emails = accounts.map(a => a.email).filter(Boolean);
    const dupeEmails = emails.filter((e, i) => emails.indexOf(e) !== i);
    if (dupeEmails.length) issues.push(`Duplicate Google accounts: ${JSON.stringify(dupeEmails)}`);

    return {
      summary: {
        tasks: tasks.length,
        activeTasks: tasks.filter(t => !t.done).length,
        completedTasks: tasks.filter(t => t.done).length,
        googleTasks: tasks.filter(t => t.source === 'google').length,
        localTasks: tasks.filter(t => !t.source).length,
        scheduleEvents: schedule.length,
        googleAccounts: accounts.length,
      },
      issues,
      warnings,
    };
  });

  await browser.close();

  console.log('\n── Circe Data Integrity Report ──────────────────────────────');
  console.log(`Tasks total: ${report.summary.tasks} (${report.summary.activeTasks} active, ${report.summary.completedTasks} done)`);
  console.log(`  Google-sourced: ${report.summary.googleTasks}  |  Local-only: ${report.summary.localTasks}`);
  console.log(`Schedule events: ${report.summary.scheduleEvents}`);
  console.log(`Google accounts: ${report.summary.googleAccounts}`);
  console.log('─────────────────────────────────────────────────────────────');

  if (report.warnings.length) {
    console.log('\n⚠  Warnings (non-critical):');
    report.warnings.forEach(w => console.log(`   • ${w}`));
  }

  if (report.issues.length === 0) {
    console.log('\n✓  No data integrity issues found.\n');
    process.exit(0);
  } else {
    console.log('\n✗  Issues found:');
    report.issues.forEach(i => console.log(`   • ${i}`));
    console.log('');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('check-data failed:', err);
  process.exit(1);
});
