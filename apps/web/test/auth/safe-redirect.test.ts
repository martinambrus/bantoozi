import { describe, expect, it } from 'vitest';

import { safeRedirect } from '../../src/features/auth/safe-redirect.js';

describe('safeRedirect', () => {
  it.each([
    '/',
    '/read/maybe',
    '/read/feed/42?x=1',
    '/read/folder/Spr%C3%A1vy%20%2F%20SK',
    '/interests#top',
    '/settings?tab=sessions&back=%2Fread',
    '/read/label/0192f7a0-0000-7000-8000-00000000000a',
    '/logins',
    '/joined',
    '/waitlisted',
    '/admin/users?q=login',
  ])('keeps the same-origin path %s', (value) => {
    expect(safeRedirect(value)).toBe(value);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a relative path', 'read/maybe'],
    ['a protocol-relative URL', '//evil.example'],
    ['a protocol-relative URL with a path', '//evil.example/read'],
    ['three slashes', '///evil.example'],
    ['a backslash after the slash', '/\\evil.example'],
    ['two backslashes', '/\\\\evil.example'],
    ['a leading backslash', '\\evil.example'],
    ['an https URL', 'https://evil.example'],
    ['an http URL', 'http://evil.example/read'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a mailto: URL', 'mailto:a@example.com'],
    ['an encoded protocol-relative URL', '%2F%2Fevil.example'],
    ['a leading space', ' //evil.example'],
    ['a leading space before a path', ' /read/maybe'],
    ['a tab inside the slashes', '/\t/evil.example'],
    ['a newline inside the slashes', '/\n/evil.example'],
    ['a carriage return inside the slashes', '/\r/evil.example'],
    ['a NUL character', '/read\u0000/maybe'],
    ['a DEL character', '/read\u007f'],
    ['dot segments that collapse to //', '/.//evil.example'],
    ['dot segments that collapse to /login', '/read/../login'],
    ['/login', '/login'],
    ['/login with a query', '/login?redirect=%2Fread'],
    ['/login with a hash', '/login#top'],
    ['/login with a trailing slash', '/login/'],
    ['/login in capitals', '/LOGIN'],
    ['/join', '/join'],
    ['/join with a code', '/join?code=ABC123'],
    ['/waitlist', '/waitlist'],
    ['/waitlist with a trailing slash', '/waitlist/'],
  ])('sends %s to /', (_name, value) => {
    expect(safeRedirect(value)).toBe('/');
  });
});
