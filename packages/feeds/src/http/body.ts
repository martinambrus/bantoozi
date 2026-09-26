import { brotliDecompress, gunzip, inflate, inflateRaw } from 'node:zlib';

import { SafeFetchError } from './errors.js';

/** The content codings the client accepts and decodes itself (spec 03 §4.4). */
export type ContentCoding = 'gzip' | 'deflate' | 'br';

/** Sent with every request: exactly the codings {@link decodeContent} can decode. */
export const ACCEPT_ENCODING = 'gzip, deflate, br';

/** More stacked codings than this are treated as hostile. */
const MAX_CODINGS = 3;

/**
 * Parses `Content-Encoding` into the codings applied, in order (spec 03 §4.4). `identity` is a
 * no-op; `x-gzip` is gzip; anything else is `FEED_DECODE_ERROR`, before the body is read.
 */
export function parseContentCodings(value: string | undefined): ContentCoding[] {
  if (value === undefined) return [];
  const codings: ContentCoding[] = [];
  for (const raw of value.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token === '' || token === 'identity') continue;
    if (token === 'gzip' || token === 'x-gzip') codings.push('gzip');
    else if (token === 'deflate') codings.push('deflate');
    else if (token === 'br') codings.push('br');
    else {
      const shown = /^[a-z0-9._-]{1,32}$/.test(token) ? ` "${token}"` : '';
      throw new SafeFetchError('FEED_DECODE_ERROR', `unsupported content encoding${shown}`);
    }
  }
  if (codings.length > MAX_CODINGS) {
    throw new SafeFetchError('FEED_DECODE_ERROR', 'too many stacked content encodings');
  }
  return codings;
}

/** RFC 1950 zlib header check; servers also send raw RFC 1951 deflate under `deflate`. */
function isZlibWrapped(input: Buffer): boolean {
  const [cmf = 0, flg = 0] = input;
  return input.length >= 2 && (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/**
 * Decodes one content coding with the decompressed output capped at `maxBytes` (Node stops
 * inflating as soon as the cap is passed, so a small bomb costs little). An oversized result is
 * `FEED_TOO_LARGE`; corrupt or truncated data is `FEED_DECODE_ERROR`; an abort of `signal` (the
 * fetch deadline) rejects with its reason.
 */
function decompress(
  input: Buffer,
  coding: ContentCoding,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (input.length === 0) return Promise.resolve(input);
  return new Promise<Buffer>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as unknown);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (error: Error | null, output: Buffer): void => {
      signal.removeEventListener('abort', onAbort);
      if (error === null) {
        resolve(output);
      } else if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        reject(
          new SafeFetchError('FEED_TOO_LARGE', `the decompressed body exceeds ${maxBytes} bytes`),
        );
      } else {
        reject(
          new SafeFetchError('FEED_DECODE_ERROR', `corrupt ${coding} content`, { cause: error }),
        );
      }
    };
    const options = { maxOutputLength: maxBytes };
    if (coding === 'gzip') gunzip(input, options, done);
    else if (coding === 'br') brotliDecompress(input, options, done);
    else if (isZlibWrapped(input)) inflate(input, options, done);
    else inflateRaw(input, options, done);
  });
}

/**
 * Undoes `codings` (applied in order, so decoded in reverse), each stage capped at `maxBytes`
 * (spec 03 §4.4: the cap applies to decompressed bytes too). The undici `request` API never
 * decompresses, so this is the single decoding of the stream.
 */
export async function decodeContent(
  input: Buffer,
  codings: readonly ContentCoding[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  let content = input;
  for (const coding of [...codings].reverse()) {
    content = await decompress(content, coding, maxBytes, signal);
  }
  return content;
}

/** A response body stream as undici returns it. */
export interface BodyStream extends AsyncIterable<unknown> {
  destroy(error?: Error): unknown;
}

/**
 * Reads a response body with the compressed (wire) size capped at `maxBytes` (spec 03 §4.4): a
 * `Content-Length` above the cap fails before reading, and a streamed body fails as soon as it
 * passes the cap; leaving the loop destroys the stream, which aborts the request.
 */
export async function readWireBody(
  body: BodyStream,
  contentLength: string | undefined,
  maxBytes: number,
): Promise<Buffer> {
  if (contentLength !== undefined && /^\s*\d+\s*$/.test(contentLength)) {
    if (Number(contentLength) > maxBytes) {
      throw new SafeFetchError('FEED_TOO_LARGE', `Content-Length exceeds ${maxBytes} bytes`);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxBytes) {
      throw new SafeFetchError('FEED_TOO_LARGE', `the body exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
