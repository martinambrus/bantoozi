import { readFixture } from '@bantoozi/testing';
import iconv from 'iconv-lite';

/** The fixed clock of the parse tests (fixtures date their items around it). */
export const NOW = new Date('2026-09-26T12:00:00Z');

/**
 * A feed fixture decoded from its exact bytes with iconv-lite. Charset detection is `decodeBody`'s
 * job (spec 03 §4, M1-T1); here the encoding is given, and a byte order mark is stripped unless
 * `keepBom` is set.
 */
export function fixtureText(name: string, encoding = 'utf-8', keepBom = false): string {
  return iconv.decode(Buffer.from(readFixture('feeds', name)), encoding, { stripBOM: !keepBom });
}

/** A minimal RSS 2.0 document around the given `<item>` markup. */
export function rss(items: string, channel = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test</title><link>https://feed.example/</link><description>Test feed</description>${channel}${items}</channel></rss>`;
}
