import type { Page } from '@playwright/test';

import { expect } from '../support/test.js';

/**
 * The web app manifest the page links to, read the way the browser reads it: the `<link
 * rel="manifest">` of the document, its JSON, and the icons it names.
 */

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

export interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  icons: ManifestIcon[];
}

export interface LinkedManifest {
  /** The address the manifest was read from. */
  url: string;
  contentType: string;
  manifest: Manifest;
}

/** Follows the manifest link of the open document and reads the manifest it leads to. */
export async function linkedManifest(page: Page): Promise<LinkedManifest> {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href, 'the document links its manifest').not.toBeNull();
  const url = new URL(href ?? '', page.url()).href;
  const response = await page.request.get(url);
  expect(response.status(), `${url} answers`).toBe(200);
  return {
    url,
    contentType: response.headers()['content-type'] ?? '',
    manifest: (await response.json()) as Manifest,
  };
}

/** The pixels of an icon as the page decodes it. */
export async function decodedIconSize(
  page: Page,
  src: string,
  manifestUrl: string,
): Promise<{ width: number; height: number }> {
  return page.evaluate(
    async ({ icon, base }) => {
      const image = new Image();
      image.src = new URL(icon, base).href;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    },
    { icon: src, base: manifestUrl },
  );
}
