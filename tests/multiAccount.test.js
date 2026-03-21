'use strict';

/**
 * Tests for multi-account Google helpers: getAccountToken and resolveAccounts.
 * Both are exported from server.js.
 */

const { getAccountToken, resolveAccounts } = require('../server');

// ── getAccountToken ──────────────────────────────────────────────────────────

const workAccount  = { label: 'Work',     email: 'kate@school.org',  token: 'tok-work',  defaults: { calendar: true,  tasks: true,  email: true,  drive: true  } };
const homeAccount  = { label: 'Personal', email: 'kate@gmail.com',   token: 'tok-home',  defaults: { calendar: false, tasks: false, email: false, drive: false } };
const noTokenAcct  = { label: 'Empty',    email: 'empty@test.com',   token: null,        defaults: { calendar: true,  tasks: true,  email: true,  drive: true  } };

describe('getAccountToken: basic routing', () => {
  test('returns null for empty accounts array', () => {
    expect(getAccountToken([], 'calendar')).toBeNull();
  });

  test('returns null for non-array accounts', () => {
    expect(getAccountToken(null, 'calendar')).toBeNull();
    expect(getAccountToken(undefined, 'calendar')).toBeNull();
  });

  test('returns default account token for service', () => {
    expect(getAccountToken([workAccount, homeAccount], 'calendar')).toBe('tok-work');
  });

  test('returns any token when no account is default for service', () => {
    const token = getAccountToken([homeAccount], 'calendar');
    expect(token).toBe('tok-home'); // falls back to first account with a token
  });

  test('skips accounts with null token even if marked as default', () => {
    const token = getAccountToken([noTokenAcct, homeAccount], 'calendar');
    expect(token).toBe('tok-home');
  });
});

describe('getAccountToken: preferredLabel routing', () => {
  test('returns token for matching label (case-insensitive)', () => {
    expect(getAccountToken([workAccount, homeAccount], 'email', 'personal')).toBe('tok-home');
    expect(getAccountToken([workAccount, homeAccount], 'email', 'PERSONAL')).toBe('tok-home');
  });

  test('falls back to default when preferred label not found', () => {
    expect(getAccountToken([workAccount, homeAccount], 'email', 'nonexistent')).toBe('tok-work');
  });

  test('ignores preferred label match if that account has no token', () => {
    expect(getAccountToken([noTokenAcct, workAccount], 'email', 'empty')).toBe('tok-work');
  });
});

// ── resolveAccounts ──────────────────────────────────────────────────────────

describe('resolveAccounts: new multi-account format', () => {
  test('returns googleAccounts array as-is when provided', () => {
    const body = { googleAccounts: [workAccount, homeAccount] };
    const result = resolveAccounts(body);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Work');
  });

  test('returns empty array when googleAccounts is empty', () => {
    expect(resolveAccounts({ googleAccounts: [] })).toEqual([]);
  });
});

describe('resolveAccounts: legacy single-token backwards compatibility', () => {
  test('wraps legacy googleToken as a single-account array', () => {
    const result = resolveAccounts({ googleToken: 'legacy-tok' });
    expect(result).toHaveLength(1);
    expect(result[0].token).toBe('legacy-tok');
    expect(result[0].defaults.calendar).toBe(true);
    expect(result[0].defaults.tasks).toBe(true);
    expect(result[0].defaults.email).toBe(true);
    expect(result[0].defaults.drive).toBe(true);
  });

  test('prefers googleAccounts over legacy googleToken', () => {
    const body = { googleAccounts: [workAccount], googleToken: 'legacy-tok' };
    const result = resolveAccounts(body);
    expect(result).toHaveLength(1);
    expect(result[0].token).toBe('tok-work');
  });
});

describe('resolveAccounts: edge cases', () => {
  test('returns empty array for null/undefined body', () => {
    expect(resolveAccounts(null)).toEqual([]);
    expect(resolveAccounts(undefined)).toEqual([]);
    expect(resolveAccounts({})).toEqual([]);
  });
});
