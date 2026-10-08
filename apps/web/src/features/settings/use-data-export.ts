import { useCallback, useEffect, useRef, useState } from 'react';

import { parseRetryAfter } from '../../api/client.js';
import { routes } from '../../api/routes.js';
import { useMe, useSession } from '../../session/context.js';

const EXPORT_URL = `/api/v1${routes.meExport.path}`;
/** The browser reads the object URL when the download starts; this is far longer than that takes. */
const RELEASE_AFTER_MS = 40_000;

export type ExportProblem =
  | { kind: 'http'; status: number }
  | { kind: 'rate_limited'; minutes: number | null }
  | { kind: 'network' }
  | { kind: 'incomplete' };

export type ExportState =
  | { phase: 'idle' }
  | { phase: 'downloading'; bytes: number }
  | { phase: 'done'; filename: string; bytes: number }
  | { phase: 'cancelled' }
  | { phase: 'failed'; problem: ExportProblem };

function problemOf(response: Response): ExportProblem {
  if (response.status !== 429) return { kind: 'http', status: response.status };
  const waitMs = parseRetryAfter(response.headers.get('retry-after'));
  return {
    kind: 'rate_limited',
    minutes: waitMs === null ? null : Math.max(1, Math.ceil(waitMs / 60_000)),
  };
}

/** The date in the account's time zone, so a file made just after midnight there is dated that day. */
function filenameFor(timeZone: string): string {
  const now = new Date();
  let day: string;
  try {
    day = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    day = now.toISOString().slice(0, 10);
  }
  return `bantoozi-export-${day}.json`;
}

async function readBody(response: Response, onProgress: (bytes: number) => void): Promise<Blob> {
  if (response.body === null) {
    const whole = await response.blob();
    onProgress(whole.size);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received);
  }
  return new Blob(chunks, { type: 'application/json' });
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function saveFile(file: Blob, filename: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), RELEASE_AFTER_MS);
}

/**
 * Downloads `GET /me/export` the way the browser would, but through `fetch`, to show progress and to
 * be cancelled. Nothing is saved unless the whole document arrived and is complete JSON.
 */
export function useDataExport() {
  const { timezone } = useMe();
  const session = useSession();
  const [state, setState] = useState<ExportState>({ phase: 'idle' });
  const running = useRef<AbortController | null>(null);

  useEffect(() => () => running.current?.abort(), []);

  const start = useCallback(async () => {
    if (running.current !== null) return;
    const controller = new AbortController();
    running.current = controller;
    setState({ phase: 'downloading', bytes: 0 });
    try {
      const response = await fetch(EXPORT_URL, {
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) {
        // The API client would end the session on a 401; this request does not go through it.
        if (response.status === 401) session.unauthorized();
        setState({ phase: 'failed', problem: problemOf(response) });
        return;
      }
      const file = await readBody(response, (bytes) => setState({ phase: 'downloading', bytes }));
      if (!isCompleteJson(await file.text())) {
        setState({ phase: 'failed', problem: { kind: 'incomplete' } });
        return;
      }
      const filename = filenameFor(timezone);
      saveFile(file, filename);
      setState({ phase: 'done', filename, bytes: file.size });
    } catch {
      setState(
        controller.signal.aborted
          ? { phase: 'cancelled' }
          : { phase: 'failed', problem: { kind: 'network' } },
      );
    } finally {
      running.current = null;
    }
  }, [timezone, session]);

  const cancel = useCallback(() => running.current?.abort(), []);

  return { state, start, cancel };
}
