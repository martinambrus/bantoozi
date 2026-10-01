import { randomUUID } from 'node:crypto';

/** A minimal OPML 2.0 document subscribing to `urls` (no folders). */
export function opmlOf(urls: readonly string[]): string {
  const outlines = urls
    .map((url) => `<outline type="rss" text="${url}" xmlUrl="${url.replaceAll('&', '&amp;')}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>t</title></head><body>${outlines}</body></opml>`;
}

/** A multipart body carrying `document` as the `file` part of `POST /subscriptions/import-opml`. */
export function opmlUpload(document: string): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----bantoozi${randomUUID().replaceAll('-', '')}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="subs.opml"\r\n` +
        'Content-Type: text/x-opml\r\n\r\n',
    ),
    Buffer.from(document, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
