import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/** An in-memory S3 (path-style) for the backup tools' tests: objects, multipart, listing. */
export interface FakeS3 {
  endpoint: string;
  objects: Map<string, Buffer>;
  /** Requests seen: `METHOD path?query`. */
  log: string[];
  /** Fail the next N requests with this status (for retry tests). */
  failNext(count: number, status: number): void;
  close(): Promise<void>;
}

const md5 = (data: Buffer): string => `"${createHash('md5').update(data).digest('hex')}"`;

export async function startFakeS3(bucket = 'bucket'): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const log: string[] = [];
  let failures = 0;
  let failStatus = 500;
  let nextUpload = 1;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://localhost');
      log.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (
        status: number,
        text: string | Buffer = '',
        headers: Record<string, string> = {},
      ): void => {
        res.writeHead(status, headers);
        res.end(text);
      };
      if (
        typeof req.headers.authorization !== 'string' ||
        !req.headers.authorization.startsWith('AWS4-HMAC-SHA256 ')
      ) {
        return send(403, '<Error><Code>AccessDenied</Code></Error>');
      }
      if (req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) {
        return send(400, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
      }
      if (failures > 0) {
        failures -= 1;
        return send(failStatus, '<Error><Code>InternalError</Code></Error>');
      }
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith(`/${bucket}`))
        return send(404, '<Error><Code>NoSuchBucket</Code></Error>');
      const key = path.slice(bucket.length + 2);
      const q = url.searchParams;
      if (key === '' && req.method === 'GET') {
        const prefix = q.get('prefix') ?? '';
        const size = Number(q.get('max-keys') ?? '1000');
        const after = q.get('continuation-token') ?? '';
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = all.slice(0, size);
        const more = all.length > page.length;
        const items = page
          .map(
            (k) =>
              `<Contents><Key>${k.replace(/&/gu, '&amp;')}</Key><Size>${objects.get(k)?.length}</Size></Contents>`,
          )
          .join('');
        return send(
          200,
          `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>` : ''}${items}</ListBucketResult>`,
        );
      }
      if (req.method === 'POST' && q.has('uploads')) {
        const id = `u${nextUpload++}`;
        uploads.set(id, { key, parts: new Map() });
        return send(
          200,
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      const upload = uploads.get(q.get('uploadId') ?? '');
      if (req.method === 'PUT' && upload !== undefined && q.has('partNumber')) {
        upload.parts.set(Number(q.get('partNumber')), body);
        return send(200, '', { etag: md5(body) });
      }
      if (req.method === 'POST' && upload !== undefined) {
        const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/gu)].map(
          (m) => Number(m[1]),
        );
        objects.set(upload.key, Buffer.concat(numbers.map((n) => upload.parts.get(n) as Buffer)));
        uploads.delete(q.get('uploadId') as string);
        return send(
          200,
          '<CompleteMultipartUploadResult><Key>x</Key></CompleteMultipartUploadResult>',
        );
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId') as string);
        return send(204);
      }
      if (req.method === 'PUT') {
        objects.set(key, body);
        return send(200, '', { etag: md5(body) });
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return send(204);
      }
      const object = objects.get(key);
      if (object === undefined) return send(404, '<Error><Code>NoSuchKey</Code></Error>');
      if (req.method === 'HEAD') return send(200, '', { 'content-length': String(object.length) });
      if (req.method === 'GET')
        return send(200, object, { 'content-length': String(object.length) });
      return send(405);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    log,
    failNext(count, status) {
      failures = count;
      failStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
