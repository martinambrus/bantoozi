import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * M8-F16: the header comment of `s19-list-catchup.int.test.ts` describes the catch-up as it is now
 * (an incremental `user.rank {reason: 'list'}` intent, S22), not the old full-rank catch-up. Rule:
 * the leading block comment mentions neither `{full}` nor "full-rank catch-up", and says
 * "incremental".
 */
describe('M8-F16 s19-list-catchup header', () => {
  it('no longer describes the full catch-up', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./s19-list-catchup.int.test.ts', import.meta.url)),
      'utf8',
    );
    const header = source.slice(source.indexOf('/**'), source.indexOf('*/') + 2);
    expect(header.length).toBeGreaterThan(0);
    expect(header).not.toContain('{full}');
    expect(header.toLowerCase()).not.toContain('full-rank catch-up');
    expect(header.toLowerCase()).toContain('incremental');
  });
});
