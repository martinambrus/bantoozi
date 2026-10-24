import { describe, expect, it } from 'vitest';

import { isOlderSameMajorRelease } from '../src/model-watch.js';

describe('isOlderSameMajorRelease', () => {
  it.each([
    ['jev-1.14.0-rc10', 'jev-1.14.0-rc9', true],
    ['jev-1.14.0-rc9', 'jev-1.14.0-rc10', false],
    ['jev-1.14.0-rc.2', 'jev-1.14.0-rc.10', true],
    ['jev-1.14.0-1', 'jev-1.14.0-alpha', true],
    ['jev-1.14.0-rc', 'jev-1.14.0-rc.1', true],
    ['jev-1.14.0-rc1', 'jev-1.14.0', true],
    ['jev-1.14.0', 'jev-1.14.0-rc1', false],
    ['jev-1.14.0.1', 'jev-1.14.0', false],
    ['jev-1.14.0', 'jev-1.14.0.1', true],
    ['jev-1.14.0.2', 'jev-1.14.0.10', true],
    ['jev-1.14.0.9007199254740993', 'jev-1.14.0.9007199254740992', false],
    ['jev-1.14.0.1', 'jev-1.14.0-rc1', false],
    ['jev-1.14.0-rc1', 'jev-1.14.0.1', true],
    ['jev-1.14.0+build1', 'jev-1.14.0+build2', false],
    ['jev-1.14.0', 'jev-2.0.0', false],
    ['jev-2.0.0', 'jev-1.14.0', false],
    ['jev-1.14.0', 'jev-1.14.0', false],
    ['jev-1.9007199254740992.0', 'jev-1.9007199254740993.0', true],
    ['jev-1.14.9', 'jev-1.14.10', true],
  ])('%s older than %s: %s', (answered, current, expected) => {
    expect(isOlderSameMajorRelease(answered, current)).toBe(expected);
  });
});
