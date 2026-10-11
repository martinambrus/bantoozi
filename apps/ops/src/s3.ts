import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * A small S3 client for the backup tools (spec 11 §4): AWS Signature Version 4, path-style
 * addressing, multipart upload of an unbounded stream, ranged-free streaming download, listing and
 * deletion. It signs the real payload hash, so it works over plain HTTP (the local MinIO) and TLS.
 * Errors carry the HTTP status and the S3 error code only: never a URL query, header or key.
 */

export interface S3Config {
  /** `http://minio:9000` or `https://s3.example.com`; no trailing path. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;

  constructor(operation: string, status: number, code: string) {
    super(`s3 ${operation} failed: status ${status} ${code}`);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** Part size of a multipart upload (S3 minimum 5 MiB; 10 000 parts → 160 GB at 16 MiB). */
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;

const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Uint8Array, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding as AWS wants it (the unreserved set only). */
const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const amzDate = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/gu, '');

export interface SignInput {
  method: string;
  /** Absolute URL; its pathname is already percent-encoded and its search is the query. */
  url: URL;
  /** Headers to sign besides `host`; names are matched case-insensitively. */
  headers: Record<string, string>;
  payloadHash: string;
  now: Date;
  region: string;
  accessKey: string;
  secretKey: string;
}

/** The `Authorization` header value of a SigV4 request (service `s3`). */
export function signRequest(input: SignInput): string {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers = new Map<string, string>();
  headers.set('host', input.url.host);
  for (const [name, value] of Object.entries(input.headers)) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/gu, ' '));
  }
  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name) ?? ''}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonical = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${input.secretKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const xmlUnescape = (value: string): string =>
  value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'u').exec(xml);
  return match?.[1] === undefined ? undefined : xmlUnescape(match[1]);
}

export interface UploadResult {
  key: string;
  /** Bytes stored. */
  size: number;
  /** SHA-256 (hex) of those bytes. */
  sha256: string;
}

export interface S3Options {
  /** Test seam. */
  fetch?: typeof fetch;
  now?: () => Date;
  partSize?: number;
  /** Per-request timeout; large parts need minutes. */
  timeoutMs?: number;
  /** Attempts per request on a network error or a 5xx answer. */
  attempts?: number;
}

export class S3Client {
  readonly #config: S3Config;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly partSize: number;
  readonly #timeoutMs: number;
  readonly #attempts: number;

  constructor(config: S3Config, options: S3Options = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#attempts = options.attempts ?? 3;
  }

  #url(key: string, query: Record<string, string> = {}): URL {
    const path = key === '' ? '' : `/${key.split('/').map(awsEncode).join('/')}`;
    const url = new URL(
      `${this.#config.endpoint.replace(/\/+$/u, '')}/${awsEncode(this.#config.bucket)}${path}`,
    );
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async #send(
    operation: string,
    method: string,
    url: URL,
    body: Uint8Array | undefined,
    extra: Record<string, string> = {},
    retry = true,
  ): Promise<Response> {
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body);
    let last: unknown;
    const attempts = retry ? this.#attempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const now = this.#now();
      const headers: Record<string, string> = {
        ...extra,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate(now),
      };
      const authorization = signRequest({
        method,
        url,
        headers,
        payloadHash,
        now,
        region: this.#config.region,
        accessKey: this.#config.accessKey,
        secretKey: this.#config.secretKey,
      });
      try {
        const init: RequestInit = {
          method,
          headers: { ...headers, authorization },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#timeoutMs),
        };
        if (body !== undefined) init.body = body as never;
        const response = await this.#fetch(url, init);
        if (response.status >= 500 && attempt < attempts) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          continue;
        }
        return response;
      } catch (error) {
        last = error;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    const cause = last instanceof Error ? last : undefined;
    const code = (cause?.cause as { code?: string } | undefined)?.code ?? cause?.name ?? 'network';
    throw new S3Error(operation, 0, String(code));
  }

  async #fail(operation: string, response: Response): Promise<never> {
    let code = 'Unknown';
    try {
      code = xmlTag(await response.text(), 'Code') ?? code;
    } catch {
      /* the status alone is enough */
    }
    throw new S3Error(operation, response.status, code);
  }

  async putObject(key: string, body: Uint8Array): Promise<void> {
    const response = await this.#send('put', 'PUT', this.#url(key), body);
    if (!response.ok) await this.#fail('put', response);
    await response.body?.cancel();
  }

  /** The object's size, or undefined when it does not exist. */
  async headObject(key: string): Promise<number | undefined> {
    const response = await this.#send('head', 'HEAD', this.#url(key), undefined);
    if (response.status === 404) return undefined;
    if (!response.ok) await this.#fail('head', response);
    return Number(response.headers.get('content-length') ?? Number.NaN);
  }

  /** The object's bytes as a stream; throws `S3Error` (404 `NoSuchKey`) when it is missing. */
  async getObject(key: string): Promise<Readable> {
    const response = await this.#send('get', 'GET', this.#url(key), undefined);
    if (!response.ok || response.body === null) return this.#fail('get', response);
    return Readable.fromWeb(response.body as never);
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.#send('delete', 'DELETE', this.#url(key), undefined);
    if (!response.ok && response.status !== 404) await this.#fail('delete', response);
    await response.body?.cancel();
  }

  /** Keys under `prefix`, in key order (follows the continuation tokens up to `limit`). */
  async list(
    prefix: string,
    options: { pageSize?: number; limit?: number } = {},
  ): Promise<string[]> {
    const pageSize = options.pageSize ?? 1000;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const query: Record<string, string> = {
        'list-type': '2',
        'max-keys': String(pageSize),
        prefix,
      };
      if (token !== undefined) query['continuation-token'] = token;
      const response = await this.#send('list', 'GET', this.#url('', query), undefined);
      if (!response.ok) await this.#fail('list', response);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>[\s\S]*?<\/Contents>/gu)) {
        const key = xmlTag(match[0], 'Key');
        if (key !== undefined) keys.push(key);
      }
      token = xmlTag(xml, 'NextContinuationToken');
      if (xmlTag(xml, 'IsTruncated') !== 'true' || token === undefined || keys.length >= limit)
        break;
    }
    return keys.sort().slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
  }

  /**
   * Stores a stream: one PUT when it fits one part, else a multipart upload that is aborted on any
   * failure. Returns the stored size and SHA-256.
   */
  async uploadStream(key: string, source: AsyncIterable<Uint8Array>): Promise<UploadResult> {
    const hash = createHash('sha256');
    let size = 0;
    let uploadId: string | undefined;
    const etags: string[] = [];
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    const sendPart = async (data: Buffer): Promise<void> => {
      if (uploadId === undefined) {
        const response = await this.#send(
          'multipart-create',
          'POST',
          this.#url(key, { uploads: '' }),
          undefined,
        );
        if (!response.ok) await this.#fail('multipart-create', response);
        uploadId = xmlTag(await response.text(), 'UploadId');
        if (uploadId === undefined)
          throw new S3Error('multipart-create', response.status, 'NoUploadId');
      }
      const number = etags.length + 1;
      const response = await this.#send(
        'multipart-part',
        'PUT',
        this.#url(key, { partNumber: String(number), uploadId }),
        data,
      );
      if (!response.ok) await this.#fail('multipart-part', response);
      await response.body?.cancel();
      const etag = response.headers.get('etag');
      if (etag === null) throw new S3Error('multipart-part', response.status, 'NoETag');
      etags.push(etag);
    };

    try {
      for await (const chunk of source) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        hash.update(buffer);
        size += buffer.length;
        pending.push(buffer);
        pendingBytes += buffer.length;
        while (pendingBytes >= this.partSize) {
          const all = Buffer.concat(pending, pendingBytes);
          await sendPart(all.subarray(0, this.partSize));
          const rest = all.subarray(this.partSize);
          pending = rest.length > 0 ? [rest] : [];
          pendingBytes = rest.length;
        }
      }
      const tail = Buffer.concat(pending, pendingBytes);
      if (uploadId === undefined) {
        await this.putObject(key, tail);
      } else {
        if (tail.length > 0) await sendPart(tail);
        const parts = etags
          .map(
            (etag, index) =>
              `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
          )
          .join('');
        const response = await this.#send(
          'multipart-complete',
          'POST',
          this.#url(key, { uploadId }),
          Buffer.from(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`),
          {},
          false,
        );
        if (!response.ok) await this.#fail('multipart-complete', response);
        // S3 may answer 200 with an error document.
        const text = await response.text();
        if (xmlTag(text, 'Code') !== undefined) {
          throw new S3Error(
            'multipart-complete',
            response.status,
            xmlTag(text, 'Code') ?? 'Unknown',
          );
        }
      }
    } catch (error) {
      if (uploadId !== undefined) {
        try {
          await this.#send(
            'multipart-abort',
            'DELETE',
            this.#url(key, { uploadId }),
            undefined,
            {},
            false,
          );
        } catch {
          /* the failure above is the one to report */
        }
      }
      throw error;
    }
    return { key, size, sha256: hash.digest('hex') };
  }

  /** Re-reads the object and compares its size and SHA-256 with what was sent. */
  async verifyObject(key: string, expected: { size: number; sha256: string }): Promise<void> {
    const size = await this.headObject(key);
    if (size !== expected.size) {
      throw new Error(
        `upload verification failed: stored size ${size ?? 'missing'} != ${expected.size}`,
      );
    }
    const hash = createHash('sha256');
    let read = 0;
    for await (const chunk of await this.getObject(key)) {
      const data = chunk as Buffer;
      hash.update(data);
      read += data.length;
    }
    if (read !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw new Error('upload verification failed: stored checksum differs');
    }
  }
}
