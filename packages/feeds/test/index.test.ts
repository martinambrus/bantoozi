import { describe, expect, it } from 'vitest';

import * as feeds from '../src/index.js';

// Placeholder (M0-T1): replaced by real tests when the package gets its features.
describe('@bantoozi/feeds', () => {
  it('exposes its public entry point', () => {
    expect(feeds.PACKAGE_NAME).toBe('@bantoozi/feeds');
  });

  it('exports the media signals of spec 03 §6.4', () => {
    for (const name of [
      'mediaSignals',
      'isVideoHostUrl',
      'isVideoEmbedUrl',
      'isVideoMediaObject',
      'videoEmbedRegex',
    ] as const) {
      expect(typeof feeds[name]).toBe('function');
    }
    expect(feeds.VIDEO_HOSTS).toContain('youtube.com');
    expect(feeds.VIDEO_EMBED_HOSTS).toContain('youtube-nocookie.com');
  });
});
