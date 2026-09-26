import { Worker } from 'node:worker_threads';

import type { XmlParseOutput, XmlWorkerData, XmlWorkerMessage } from './xml-worker.js';

/**
 * The worker's `workerData` marker. Repeated here (the type forces it to equal the worker's
 * `XML_WORKER_MARKER`) so the main thread never loads the worker module and its parsers.
 */
const XML_WORKER_MARKER: XmlWorkerData['marker'] = 'bantoozi:feed-xml-worker:1';

/**
 * The worker module next to this one: `.ts` when running from sources (Vitest; Node strips the
 * types natively), `.js` in the compiled package.
 */
const WORKER_URL = new URL(
  `./xml-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

/** A worker that has not started parsing by then indicates a broken installation, not a bad feed. */
const STARTUP_TIMEOUT_MS = 30_000;

/** Heap limits of the parser thread; exceeding them is a feed-caused parse failure. */
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

export type XmlWorkerOutcome =
  XmlParseOutput | { ok: false; code: 'XML_DEADLINE' | 'XML_RESOURCES'; message: string };

export interface XmlWorkerOptions {
  /** Parser CPU deadline in ms, measured from the moment the worker starts parsing. */
  deadlineMs: number;
  maxSourceItems: number;
  /** Time the worker may take to load and start parsing (default 30 s). */
  startupTimeoutMs?: number | undefined;
}

function isWorkerMessage(value: unknown): value is XmlWorkerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as { type?: unknown }).type === 'started' ||
      (value as { type?: unknown }).type === 'done')
  );
}

/**
 * Parses an XML feed in a fresh worker thread and terminates the thread when it overruns the
 * deadline (spec 03 §6: parser CPU deadline 2 s) or its heap limit. Resolves with the parse outcome;
 * rejects only when the worker itself cannot start (a deployment error, never a feed error).
 */
export function parseXmlInWorker(
  text: string,
  options: XmlWorkerOptions,
): Promise<XmlWorkerOutcome> {
  return runXmlWorker(WORKER_URL, text, options);
}

/** {@link parseXmlInWorker} with an explicit worker module (tests use stub workers). */
export function runXmlWorker(
  workerUrl: URL,
  text: string,
  options: XmlWorkerOptions,
): Promise<XmlWorkerOutcome> {
  return new Promise<XmlWorkerOutcome>((resolve, reject) => {
    let settled = false;
    let started = false;
    const workerData: XmlWorkerData = {
      marker: XML_WORKER_MARKER,
      text,
      maxSourceItems: options.maxSourceItems,
    };
    const worker = new Worker(workerUrl, {
      workerData,
      resourceLimits: RESOURCE_LIMITS,
      name: 'bantoozi-feed-xml-parser',
    });
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      finish();
    };
    let timer = setTimeout(() => {
      settle(() => reject(new Error('The XML parser worker did not start')));
    }, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);

    worker.on('message', (message: unknown) => {
      if (!isWorkerMessage(message)) return;
      if (message.type === 'started') {
        started = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          settle(() =>
            resolve({
              ok: false,
              code: 'XML_DEADLINE',
              message: `XML parsing exceeded the ${options.deadlineMs} ms deadline`,
            }),
          );
        }, options.deadlineMs);
        return;
      }
      settle(() => resolve(message.output));
    });
    worker.on('error', (error: unknown) => {
      settle(() => {
        if (!started) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve({
          ok: false,
          code: 'XML_RESOURCES',
          message: 'The XML parser exceeded its resource limits',
        });
      });
    });
    worker.on('exit', (exitCode: number) => {
      settle(() => {
        if (!started) {
          reject(new Error(`The XML parser worker exited with code ${exitCode} before starting`));
          return;
        }
        resolve({ ok: false, code: 'XML_RESOURCES', message: 'The XML parser worker exited' });
      });
    });
  });
}
