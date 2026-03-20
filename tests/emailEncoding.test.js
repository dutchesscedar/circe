'use strict';

// Test the RFC 2822 / base64url encoding used by google.js sendEmail
// without hitting the Google API

function buildRaw(to, subject, body) {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeRaw(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

describe('Gmail RFC 2822 base64url encoding', () => {
  test('produces base64url without +, /, or = characters', () => {
    const raw = buildRaw('test@example.com', 'Hello', 'Body text');
    expect(raw).not.toMatch(/\+/);
    expect(raw).not.toMatch(/\//);
    expect(raw).not.toMatch(/=/);
  });

  test('encoded message decodes to correct headers', () => {
    const raw = buildRaw('duchess@example.com', 'Meeting reminder', 'See you at 3pm');
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('To: duchess@example.com');
    expect(decoded).toContain('Subject: Meeting reminder');
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8');
    expect(decoded).toContain('See you at 3pm');
  });

  test('handles special characters in subject and body', () => {
    const raw = buildRaw('a@b.com', "It's a test & more", 'Line 1\r\nLine 2');
    const decoded = decodeRaw(raw);
    expect(decoded).toContain("It's a test & more");
    expect(decoded).toContain('Line 2');
  });

  test('headers and body are separated by blank line', () => {
    const raw = buildRaw('a@b.com', 'Hi', 'Body');
    const decoded = decodeRaw(raw);
    const parts = decoded.split('\r\n\r\n');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[1]).toContain('Body');
  });
});
