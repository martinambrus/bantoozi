const AUTH_SCREENS = new Set(['/login', '/join', '/waitlist']);

// Only used to resolve the value the way a browser would; nothing is ever fetched from it.
const BASE = 'http://same-origin.invalid';

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Where to go after signing in: the `redirect` the guard put in the login URL, if it is a path of
 * this app, else `/`. The value comes from the address bar, so anything a browser could read as
 * another origin (`//host`, `/\host`, a scheme, a tab or newline it would strip) is refused, and
 * so are the sign-in screens themselves, which would only bounce the visitor back.
 */
export function safeRedirect(value?: string): string {
  if (value === undefined || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\') || hasControlCharacter(value)) return '/';

  const url = new URL(value, BASE);
  // Dot segments can collapse a harmless-looking path into `//host` or `/login`.
  if (url.origin !== BASE || url.pathname.startsWith('//')) return '/';
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  return AUTH_SCREENS.has(path) ? '/' : value;
}
