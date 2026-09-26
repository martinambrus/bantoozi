import { describe, expect, it } from 'vitest';

import { parseXmlInWorker, runXmlWorker } from '../../src/parse/run-xml-worker.js';

const OPTIONS = { deadlineMs: 2_000, maxSourceItems: 10 };

function stub(name: string): URL {
  return new URL(`./workers/${name}`, import.meta.url);
}

describe('XML parser worker thread (spec 03 §6 CPU deadline)', () => {
  it('parses in a worker thread started from the TypeScript sources', async () => {
    await expect(
      parseXmlInWorker('<rss version="2.0"><channel><title>T</title></channel></rss>', OPTIONS),
    ).resolves.toMatchObject({ ok: true, kind: 'rss', feed: { title: 'T' }, items: [] });
  });

  it('relays the worker result and ignores unrelated messages', async () => {
    await expect(runXmlWorker(stub('echo.mjs'), 'hello', OPTIONS)).resolves.toEqual({
      ok: false,
      code: 'XML_MALFORMED',
      message: 'echo hello',
    });
  });

  it('turns a crash or exit after the parse started into a resource failure', async () => {
    await expect(runXmlWorker(stub('crash-after-start.mjs'), '', OPTIONS)).resolves.toEqual({
      ok: false,
      code: 'XML_RESOURCES',
      message: 'The XML parser exceeded its resource limits',
    });
    await expect(runXmlWorker(stub('exit-after-start.mjs'), '', OPTIONS)).resolves.toEqual({
      ok: false,
      code: 'XML_RESOURCES',
      message: 'The XML parser worker exited',
    });
  });

  it('rejects when the worker cannot start (a deployment error, not a feed error)', async () => {
    await expect(runXmlWorker(stub('missing.mjs'), '', OPTIONS)).rejects.toThrow();
    await expect(runXmlWorker(stub('exit-before-start.mjs'), '', OPTIONS)).rejects.toThrow(
      'The XML parser worker exited with code 2 before starting',
    );
    await expect(
      runXmlWorker(stub('never-start.mjs'), '', { ...OPTIONS, startupTimeoutMs: 100 }),
    ).rejects.toThrow('The XML parser worker did not start');
  });
});
