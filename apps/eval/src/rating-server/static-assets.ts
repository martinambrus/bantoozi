/**
 * The rating app's only static assets (spec 10 §2.4: vanilla HTML + CSS + a small ES-module
 * script, no framework, no external resources). They are served from `/static/` under a CSP that
 * allows scripts and styles from the app's own origin only, so no page carries inline script or
 * style. Kept as strings so the compiled CLI needs no asset copying.
 *
 * Layout: fluid single column (max 40rem), no fixed widths, so every page works at 375 px.
 */

export const APP_CSS = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2933;
  --muted: #52606d;
  --line: #d9e2ec;
  --accent: #2563eb;
  --like: #15803d;
  --dislike: #b91c1c;
  --chip: #f0f4f8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827;
    --fg: #e5e7eb;
    --muted: #9ca3af;
    --line: #374151;
    --accent: #60a5fa;
    --like: #4ade80;
    --dislike: #f87171;
    --chip: #1f2937;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { width: 100%; max-width: 40rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.35rem; line-height: 1.25; margin: 0.5rem 0 0.75rem; }
h2 { font-size: 1.1rem; margin: 1.25rem 0 0.5rem; }
p, li { overflow-wrap: anywhere; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: 0.9rem; }
.progress { color: var(--muted); font-size: 0.9rem; margin: 0 0 0.5rem; }
.error { border: 1px solid var(--dislike); color: var(--dislike); padding: 0.5rem 0.75rem; border-radius: 0.5rem; }
.notice { border: 1px solid var(--line); padding: 0.5rem 0.75rem; border-radius: 0.5rem; }
.article { border: 1px solid var(--line); border-radius: 0.75rem; padding: 1rem; margin: 0.5rem 0 1rem; }
.article .feed { color: var(--muted); font-size: 0.85rem; margin: 0; }
.article .excerpt { margin: 0.5rem 0; }
.actions, .reasons, .nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0; }
.actions form, .reasons form { display: contents; }
button, .button {
  font: inherit;
  min-height: 2.75rem;
  padding: 0.5rem 0.9rem;
  border-radius: 0.5rem;
  border: 1px solid var(--line);
  background: var(--chip);
  color: var(--fg);
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
}
button.like { border-color: var(--like); }
button.dislike { border-color: var(--dislike); }
button.current, .button.current { outline: 3px solid var(--accent); }
.reasons { padding: 0.5rem; border-radius: 0.5rem; border: 1px dashed var(--line); }
.reasons.open { border-color: var(--dislike); }
kbd { font: 0.8rem ui-monospace, monospace; border: 1px solid var(--line); border-radius: 0.25rem; padding: 0 0.25rem; }
label { display: block; font-weight: 600; margin: 0.75rem 0 0.25rem; }
input[type="text"], textarea, select { width: 100%; max-width: 100%; font: inherit; padding: 0.5rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--bg); color: var(--fg); }
textarea { min-height: 4.5rem; }
fieldset { border: 1px solid var(--line); border-radius: 0.5rem; margin: 0.75rem 0; padding: 0.5rem 0.75rem; min-width: 0; }
legend { font-weight: 600; }
.choice { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 400; margin: 0.2rem 0.75rem 0.2rem 0; }
.cards, .feeds { list-style: none; padding: 0; margin: 0; }
.cards li { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.5rem 0.75rem; margin: 0.5rem 0; }
.feeds li { margin: 0.25rem 0; }
.feeds label { font-weight: 400; display: flex; gap: 0.5rem; align-items: flex-start; margin: 0; }
.hints { padding-left: 1.2rem; }
.skip { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0; }
.skip input[type="text"] { flex: 1 1 10rem; width: auto; min-width: 0; }
.keys { color: var(--muted); font-size: 0.85rem; }
@media (max-width: 30rem) {
  .wrap { padding: 0.75rem; }
  h1 { font-size: 1.2rem; }
  .keys { display: none; }
}
`;

/**
 * Keyboard handling (spec 10 §2.2, spec 09 §3.4 keys): `+`/`=` like, `-` dislike (then `1`–`6`
 * picks a reason), `1`–`6` dislike with that reason, `s` skip, `j`/→ next, `k`/← previous,
 * `o` open the original. Every key presses an element that carries `data-key`, so the page works
 * the same without JavaScript (plain forms and links). Keys are ignored inside form fields and with
 * modifier keys.
 */
export const APP_JS = `const KEY_ALIASES = { '=': '+', ArrowRight: 'j', ArrowLeft: 'k' };

function ignored(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target;
  if (target === null || typeof target.closest !== 'function') return false;
  return target.closest('input, textarea, select, [contenteditable]') !== null;
}

function elementFor(key) {
  for (const element of document.querySelectorAll('[data-key]')) {
    if (element.getAttribute('data-key') === key) return element;
  }
  return null;
}

document.addEventListener('keydown', (event) => {
  if (ignored(event)) return;
  const element = elementFor(KEY_ALIASES[event.key] ?? event.key);
  if (element === null) return;
  event.preventDefault();
  if (element.tagName === 'A') {
    const href = element.getAttribute('href');
    if (href === null) return;
    if (element.getAttribute('target') === '_blank') {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      window.location.assign(href);
    }
    return;
  }
  if (element.tagName === 'BUTTON' && !element.disabled) element.click();
});
`;
