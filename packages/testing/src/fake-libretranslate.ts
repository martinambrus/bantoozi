import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake LibreTranslate server (spec 07 §6): `POST /translate` and `GET /languages` on a random
 * loopback port, with every request recorded. It validates requests like LibreTranslate does
 * (JSON body, `q` string or string array, explicit `source`/`target` with an installed pair) and
 * answers in one of these modes:
 *
 * - `ok`: a translation per text: the `translations` dictionary entry for the exact text, else a
 *   deterministic English pseudo-translation ({@link pseudoTranslate}) that keeps names and numbers
 * - `weak`: echoes each text untranslated
 * - `fail`: an empty string for each text
 * - `timeout`: never answers (the client's deadline must end the request)
 * - `status`: `status` (default 500) with `{error}` and an optional `Retry-After`
 * - `raw`: `body` as JSON (or `rawText` as is) with `status` (default 200), for malformed-response
 *   tests
 *
 * `sequence` scripts the next `/translate` requests (one behaviour each, consumed in order) before
 * the base behaviour applies again. `/languages` follows only the base `timeout`/`status` modes.
 */
export type FakeLibreTranslateMode = 'ok' | 'weak' | 'fail' | 'timeout' | 'status' | 'raw';

export interface FakeLibreTranslateLanguage {
  code: string;
  name: string;
  targets: string[];
}

export interface FakeLibreTranslateBehaviour {
  /** Default `ok`. */
  mode?: FakeLibreTranslateMode;
  /** `status`/`raw` modes: the HTTP status. */
  status?: number;
  /** `status` mode: the `{error}` message (default `fake LibreTranslate error`). */
  errorMessage?: string;
  /** `status` mode: a `Retry-After` header value. */
  retryAfter?: string;
  /** `raw` mode: the JSON body. */
  body?: unknown;
  /** `raw` mode: a body sent as is instead of `body` (e.g. not JSON). */
  rawText?: string;
  /** Delay before answering, in ms. */
  delayMs?: number;
}

export interface FakeLibreTranslateOptions extends FakeLibreTranslateBehaviour {
  /** `GET /languages`; also decides which pairs `/translate` accepts. Default en, sk, cs. */
  languages?: FakeLibreTranslateLanguage[];
  /** `ok` mode: exact source text → translation. */
  translations?: Record<string, string>;
  /** Behaviours of the next `/translate` requests, in order. */
  sequence?: FakeLibreTranslateBehaviour[];
  host?: string;
}

export interface FakeLibreTranslateRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The parsed JSON body; the raw text when it is not JSON; `undefined` without a body. */
  body: unknown;
  at: Date;
}

export interface FakeLibreTranslate {
  /** Origin, e.g. `http://127.0.0.1:43123`: the `LIBRETRANSLATE_URL`. */
  readonly url: string;
  readonly requests: FakeLibreTranslateRequest[];
  /** Merges into the current options; a given `sequence` replaces the pending one. */
  setOptions(options: Omit<FakeLibreTranslateOptions, 'host'>): void;
  /** Back to the start options (or `options`), with no pending sequence and no recorded requests. */
  reset(options?: Omit<FakeLibreTranslateOptions, 'host'>): void;
  close(): Promise<void>;
}

/** What `LT_LOAD_ONLY=en,sk,cs` installs (spec 07 §2). */
export const FAKE_LIBRETRANSLATE_LANGUAGES: readonly FakeLibreTranslateLanguage[] = Object.freeze([
  { code: 'en', name: 'English', targets: ['cs', 'en', 'sk'] },
  { code: 'sk', name: 'Slovak', targets: ['cs', 'en', 'sk'] },
  { code: 'cs', name: 'Czech', targets: ['cs', 'en', 'sk'] },
]);

const MAX_REQUEST_BYTES = 1024 * 1024;

const ENGLISH_WORDS = (
  'report city people market government energy company school weather traffic project budget ' +
  'season country region police service health science river station system power water house ' +
  'price battery vehicle network summer winter result plan team match story world history ' +
  'future office bridge street court bank island village forest garden museum theatre hospital ' +
  'airport harbour factory railway election parliament minister council festival concert ' +
  'library research industry'
).split(' ');
const ENGLISH_SHORT_WORDS = 'the of and in to on for with at by'.split(' ');

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const ch of text) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * A deterministic English "translation" for tests: every word becomes an English word chosen by
 * its hash (short words become function words, every other content word gets an article), except
 * capitalized words inside a sentence (names); numbers and punctuation stay. Its length is close to
 * the source's, it shares few tokens with it and reads as English to the language detector, so it
 * assesses `ok` (spec 07 §4).
 */
export function pseudoTranslate(text: string): string {
  let contentWords = 0;
  return text.replace(/\p{L}+/gu, (word: string, offset: number) => {
    const sentenceStart = /(?:^|[.!?:])$/u.test(text.slice(0, offset).trimEnd());
    if (!sentenceStart && /^\p{Lu}/u.test(word)) return word;
    const lower = word.toLowerCase();
    const hash = fnv1a(lower);
    let english: string;
    if ([...lower].length <= 3) {
      english = ENGLISH_SHORT_WORDS[hash % ENGLISH_SHORT_WORDS.length] ?? 'the';
    } else {
      const noun = ENGLISH_WORDS[hash % ENGLISH_WORDS.length] ?? 'report';
      contentWords += 1;
      english = contentWords % 2 === 1 ? `the ${noun}` : noun;
    }
    return sentenceStart ? `${english.charAt(0).toUpperCase()}${english.slice(1)}` : english;
  });
}

type Reply =
  { status: number; headers?: Record<string, string>; body: unknown; rawText?: string } | 'hang';

export async function startFakeLibreTranslate(
  options: FakeLibreTranslateOptions = {},
): Promise<FakeLibreTranslate> {
  let current: Omit<FakeLibreTranslateOptions, 'host' | 'sequence'> = {};
  let sequence: FakeLibreTranslateBehaviour[] = [];
  const apply = (next: Omit<FakeLibreTranslateOptions, 'host'>): void => {
    const { sequence: nextSequence, ...rest } = next;
    current = { ...current, ...rest };
    if (nextSequence !== undefined) sequence = [...nextSequence];
  };
  const { host: hostOption, ...initial } = options;
  apply(initial);

  const requests: FakeLibreTranslateRequest[] = [];
  const hanging = new Set<ServerResponse>();

  const languages = (): readonly FakeLibreTranslateLanguage[] =>
    current.languages ?? FAKE_LIBRETRANSLATE_LANGUAGES;

  const errorReply = (status: number, error: string): Reply => ({ status, body: { error } });

  const behaviourReply = (behaviour: FakeLibreTranslateBehaviour): Reply | undefined => {
    if (behaviour.mode === 'timeout') return 'hang';
    if (behaviour.mode === 'status') {
      return {
        status: behaviour.status ?? 500,
        ...(behaviour.retryAfter === undefined
          ? {}
          : { headers: { 'retry-after': behaviour.retryAfter } }),
        body: { error: behaviour.errorMessage ?? 'fake LibreTranslate error' },
      };
    }
    if (behaviour.mode === 'raw') {
      return {
        status: behaviour.status ?? 200,
        body: behaviour.body,
        ...(behaviour.rawText === undefined ? {} : { rawText: behaviour.rawText }),
      };
    }
    return undefined;
  };

  const translate = (body: unknown, behaviour: FakeLibreTranslateBehaviour): Reply => {
    const scripted = behaviourReply(behaviour);
    if (scripted !== undefined) return scripted;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorReply(400, 'Invalid request: the body must be a JSON object');
    }
    const { q, source, target, format } = body as Record<string, unknown>;
    if (q === undefined) return errorReply(400, 'Invalid request: missing q parameter');
    if (typeof source !== 'string')
      return errorReply(400, 'Invalid request: missing source parameter');
    if (typeof target !== 'string')
      return errorReply(400, 'Invalid request: missing target parameter');
    const texts = Array.isArray(q) ? (q as unknown[]) : [q];
    if (!texts.every((text): text is string => typeof text === 'string')) {
      return errorReply(400, 'Invalid request: q must be a string or an array of strings');
    }
    if (format !== undefined && format !== 'text' && format !== 'html') {
      return errorReply(400, `Invalid request: unsupported format ${String(format)}`);
    }
    const from = languages().find((language) => language.code === source);
    if (from === undefined) return errorReply(400, `${source} is not supported`);
    const to = languages().find((language) => language.code === target);
    if (to === undefined) return errorReply(400, `${target} is not supported`);
    if (!from.targets.includes(target)) {
      return errorReply(
        400,
        `${to.name} (${target}) is not available as a target language from ${from.name} (${source})`,
      );
    }
    const translated = texts.map((text) => {
      if (behaviour.mode === 'weak') return text;
      if (behaviour.mode === 'fail') return '';
      const known = current.translations;
      return known !== undefined && Object.hasOwn(known, text)
        ? (known[text] ?? '')
        : pseudoTranslate(text);
    });
    return { status: 200, body: { translatedText: Array.isArray(q) ? translated : translated[0] } };
  };

  const send = (res: ServerResponse, reply: Reply): void => {
    if (reply === 'hang') {
      hanging.add(res);
      res.on('close', () => hanging.delete(res));
      return;
    }
    if (res.destroyed) return;
    res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
    res.end(reply.rawText ?? JSON.stringify(reply.body));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake-libretranslate.local');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      if (raw !== '') {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          body = raw;
        }
      }
      requests.push({
        method: req.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        headers: req.headers,
        body,
        at: new Date(),
      });
      let behaviour: FakeLibreTranslateBehaviour = current;
      let reply: Reply;
      if (url.pathname === '/translate') {
        if (req.method !== 'POST') {
          reply = errorReply(405, 'Method Not Allowed');
        } else {
          behaviour = sequence.shift() ?? current;
          reply =
            size > MAX_REQUEST_BYTES
              ? errorReply(413, 'Request Entity Too Large')
              : typeof body === 'string'
                ? errorReply(400, 'Invalid request: the body is not JSON')
                : translate(body, behaviour);
        }
      } else if (url.pathname === '/languages') {
        reply =
          req.method === 'GET'
            ? (behaviourReply(current.mode === 'raw' ? {} : current) ?? {
                status: 200,
                body: languages(),
              })
            : errorReply(405, 'Method Not Allowed');
      } else {
        reply = errorReply(404, 'Not Found');
      }
      const delayMs = behaviour.delayMs ?? 0;
      if (delayMs > 0) setTimeout(() => send(res, reply), delayMs);
      else send(res, reply);
    });
  });

  const host = hostOption ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    requests,
    setOptions: apply,
    reset: (next = initial) => {
      current = {};
      sequence = [];
      requests.length = 0;
      apply(next);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const res of hanging) res.destroy();
        hanging.clear();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
