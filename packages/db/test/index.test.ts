import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.js';

// Placeholder (M0-T1): replaced by real tests when the package gets its features.
describe('@bantoozi/db', () => {
  it('exposes its public entry point', () => {
    expect(PACKAGE_NAME).toBe('@bantoozi/db');
  });
});
