/**
 * Minimal HTML helpers for the rating pages: every interpolated value goes through {@link esc}, and
 * a fragment built with {@link html} is a {@link SafeHtml} that is inserted as is.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: string): string {
  return value.replace(/[&<>"']/gu, (ch) => ESCAPES[ch] ?? ch);
}

type Part = SafeHtml | string | number | null | undefined | false | readonly Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return '';
  if (part instanceof SafeHtml) return part.value;
  if (Array.isArray(part)) return part.map((p: Part) => render(p)).join('');
  return esc(String(part));
}

/** Tagged template: literal parts are trusted markup, interpolations are escaped. */
export function html(strings: TemplateStringsArray, ...values: Part[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** A complete page: viewport meta for phones, the one stylesheet and the one module script. */
export function page(title: string, body: SafeHtml): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${title} · Bantoozi rating</title>
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        <main class="wrap">${body}</main>
        <script type="module" src="/static/app.js"></script>
      </body>
    </html> `.value;
}

/** Only http(s) links leave the app ("open original"); anything else is dropped. */
export function safeExternalUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Cut to `max` code points at a word boundary when possible, with an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join('');
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
