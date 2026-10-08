import { randomBytes } from 'node:crypto';

import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { call } from '../support/api.js';

/**
 * Fixture secrets and the ways a scenario looks for them. A key is a made-up string that no
 * provider issues; every key shares a prefix, so a scan finds any of them, and a message names the
 * key by its role, never by its value.
 */

const KEY_PREFIX = 'zz-fixture-key';

export type KeyRole = 'working' | 'wrong' | 'replacement' | 'superseded' | 'rival' | 'restored';

export type FixtureKeys = Readonly<Record<KeyRole, string>>;

/** One fresh key per role. */
export function fixtureKeys(): FixtureKeys {
  const key = (role: KeyRole): string => `${KEY_PREFIX}-${role}-${randomBytes(12).toString('hex')}`;
  return {
    working: key('working'),
    wrong: key('wrong'),
    replacement: key('replacement'),
    superseded: key('superseded'),
    rival: key('rival'),
    restored: key('restored'),
  };
}

/**
 * Types a secret into a field without Playwright's `fill()`, whose step title ("Fill "<value>"")
 * would put the value into the HTML report, and without a locator argument that a trace keeps. The
 * field gets the value through the browser's own setter and an `input` event, which is what typing
 * leaves behind for the page's code.
 */
export async function enterSecret(field: Locator, secret: string): Promise<void> {
  await field.focus();
  await field.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('not a text field');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) throw new Error('no value setter');
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, secret);
}

/** A piece of text that was shown, sent or stored, and where it was. */
export interface Source {
  where: string;
  text: string;
}

/**
 * Which keys appear in the sources, as sentences that name the key's role. A key is found whole;
 * a source that merely shares the fixture prefix is a leak of some key too.
 */
export function leaksIn(sources: readonly Source[], keys: FixtureKeys): string[] {
  const found: string[] = [];
  for (const { where, text } of sources) {
    const roles = Object.entries(keys)
      .filter(([, key]) => text.includes(key))
      .map(([role]) => role);
    for (const role of roles) found.push(`${where} shows the ${role} key`);
    if (roles.length === 0 && text.includes(KEY_PREFIX)) found.push(`${where} shows a fixture key`);
  }
  return found;
}

/** Everything a person can read on the page, or that its fields and markup hold. */
export async function pageSources(page: Page, label: string): Promise<Source[]> {
  const url = new URL(page.url()).pathname;
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll('input, textarea, select')]
      .map((element) => (element as HTMLInputElement).value)
      .join('\n'),
  );
  return [
    { where: `the text of ${url} (${label})`, text: await page.locator('body').innerText() },
    { where: `the markup of ${url} (${label})`, text: await page.content() },
    { where: `the fields of ${url} (${label})`, text: fields },
  ];
}

/**
 * What the browser keeps for the origin: local and session storage, every IndexedDB database,
 * every cache of the Cache API, and the cookies of the context.
 */
export async function storeSources(page: Page): Promise<Source[]> {
  const stores = await page.evaluate(async () => {
    /** The text of a stored value, however it was stored. */
    const textOf = async (value: unknown, depth = 0): Promise<string> => {
      if (depth > 8 || value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value !== 'object') return String(value);
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
      if (value instanceof Blob) return value.text();
      if (value instanceof Map) return textOf([...value.entries()], depth + 1);
      if (value instanceof Set) return textOf([...value.values()], depth + 1);
      if (value instanceof Date) return value.toISOString();
      const parts: string[] = [];
      for (const [key, inner] of Object.entries(value)) {
        parts.push(key, await textOf(inner, depth + 1));
      }
      return parts.join('\n');
    };
    const request = <T>(operation: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
      });

    const dump = (storage: Storage): string =>
      Object.keys(storage)
        .map((key) => `${key}=${storage.getItem(key) ?? ''}`)
        .join('\n');

    const databases: Array<{ name: string; text: string }> = [];
    for (const info of await indexedDB.databases()) {
      if (info.name === undefined) continue;
      const open = indexedDB.open(info.name);
      const db = await request(open);
      const parts: string[] = [];
      for (const name of Array.from(db.objectStoreNames)) {
        const store = db.transaction(name, 'readonly').objectStore(name);
        parts.push(name, await textOf(await request(store.getAll())));
        parts.push(await textOf(await request(store.getAllKeys())));
      }
      db.close();
      databases.push({ name: info.name, text: parts.join('\n') });
    }

    const caches_: Array<{ name: string; text: string }> = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const parts: string[] = [];
      for (const cached of await cache.keys()) {
        parts.push(cached.url);
        const response = await cache.match(cached);
        const type = response?.headers.get('content-type') ?? '';
        if (response !== undefined && /json|text|javascript|xml|html|css/.test(type)) {
          parts.push(await response.clone().text());
        }
      }
      caches_.push({ name, text: parts.join('\n') });
    }
    return {
      local: dump(localStorage),
      session: dump(sessionStorage),
      databases,
      caches: caches_,
    };
  });
  const cookies = await page.context().cookies();
  return [
    { where: 'localStorage', text: stores.local },
    { where: 'sessionStorage', text: stores.session },
    ...stores.databases.map(({ name, text }) => ({ where: `IndexedDB "${name}"`, text })),
    ...stores.caches.map(({ name, text }) => ({ where: `CacheStorage "${name}"`, text })),
    {
      where: 'the cookies',
      text: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('\n'),
    },
  ];
}

/** The answers of GET routes, read as the signed-in person would read them. */
export async function routeSources(
  user: APIRequestContext,
  paths: readonly string[],
): Promise<Source[]> {
  const sources: Source[] = [];
  for (const path of paths) {
    const response = await call(user, 'GET', path);
    sources.push({
      where: `the answer to GET ${path} (${response.status()})`,
      text: await response.text(),
    });
  }
  return sources;
}

/**
 * What a page exchanged with the server and said about it: the bodies of the API's answers, the
 * addresses it requested and what it wrote to the console. Collected as it happens; read with
 * {@link ExchangeLog.sources}.
 */
export class ExchangeLog {
  private readonly answers: Array<Promise<Source>> = [];
  private readonly addresses: string[] = [];
  private readonly console: string[] = [];

  constructor(page: Page) {
    page.on('request', (request) => {
      this.addresses.push(`${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/')) return;
      const where = `the answer to ${response.request().method()} ${url.pathname} (${response.status()})`;
      this.answers.push(
        response.text().then(
          (text) => ({ where, text }),
          // A body the browser dropped (a navigation, a closed page) holds nothing to find.
          () => ({ where, text: '' }),
        ),
      );
    });
    page.on('console', (message) => {
      this.console.push(message.text());
    });
    page.on('pageerror', (error) => {
      this.console.push(error.message);
    });
  }

  /** How many API answers were read, so that a scan can show it looked at something. */
  async answerCount(): Promise<number> {
    return (await Promise.all(this.answers)).length;
  }

  async sources(): Promise<Source[]> {
    return [
      ...(await Promise.all(this.answers)),
      { where: 'the requested addresses', text: this.addresses.join('\n') },
      { where: 'the browser console', text: this.console.join('\n') },
    ];
  }
}
