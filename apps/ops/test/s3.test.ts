import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3Client, S3Error, signRequest } from '../src/s3.js';
import { startFakeS3, type FakeS3 } from './support/fake-s3.js';

describe('SigV4 signing', () => {
  it('reproduces the AWS documentation example (GET Object with a Range header)', () => {
    const authorization = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {
        Range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: new Date('2013-05-24T00:00:00Z'),
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('reproduces the AWS documentation example for a bucket listing query', () => {
    const authorization = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: {
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: new Date('2013-05-24T00:00:00Z'),
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(authorization).toContain(
      'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });
});

describe('S3 client against an in-memory S3', () => {
  let s3: FakeS3;
  beforeAll(async () => {
    s3 = await startFakeS3('backups-bucket');
  });
  afterAll(async () => {
    await s3.close();
  });
  const client = (partSize = 8): S3Client =>
    new S3Client(
      {
        endpoint: s3.endpoint,
        bucket: 'backups-bucket',
        region: 'us-east-1',
        accessKey: 'ak',
        secretKey: 'sk',
      },
      { partSize, attempts: 3 },
    );

  async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield Buffer.from(part);
  }

  it('stores a small stream with one PUT and verifies size and checksum', async () => {
    const c = client(1024);
    const result = await c.uploadStream('a/small.bin', chunks(['hello ', 'world']));
    expect(result).toEqual({
      key: 'a/small.bin',
      size: 11,
      sha256: createHash('sha256').update('hello world').digest('hex'),
    });
    await c.verifyObject('a/small.bin', result);
    expect(s3.objects.get('a/small.bin')?.toString()).toBe('hello world');
  });

  it('splits a larger stream into parts and completes the multipart upload', async () => {
    const c = client(8);
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const result = await c.uploadStream(
      'a/big.bin',
      chunks([text.slice(0, 5), text.slice(5, 20), text.slice(20)]),
    );
    expect(result.size).toBe(text.length);
    expect(s3.objects.get('a/big.bin')?.toString()).toBe(text);
    await c.verifyObject('a/big.bin', result);
    expect(s3.log.some((line) => line.startsWith('POST /backups-bucket/a/big.bin?uploads'))).toBe(
      true,
    );
  });

  it('refuses an object whose stored bytes differ from what was sent', async () => {
    const c = client(1024);
    const result = await c.uploadStream('a/tamper.bin', chunks(['payload']));
    s3.objects.set('a/tamper.bin', Buffer.from('paylaad'));
    await expect(c.verifyObject('a/tamper.bin', result)).rejects.toThrow(/checksum differs/u);
    s3.objects.set('a/tamper.bin', Buffer.from('short'));
    await expect(c.verifyObject('a/tamper.bin', result)).rejects.toThrow(/stored size/u);
  });

  it('lists across pages in key order and honours a limit', async () => {
    const c = client();
    for (const key of ['l/3', 'l/1', 'l/2', 'l/5', 'l/4', 'other/1'])
      await c.putObject(key, Buffer.from(key));
    expect(await c.list('l/', { pageSize: 2 })).toEqual(['l/1', 'l/2', 'l/3', 'l/4', 'l/5']);
    expect(await c.list('l/', { pageSize: 2, limit: 3 })).toEqual(['l/1', 'l/2', 'l/3']);
  });

  it('retries a transient 5xx and then succeeds; a missing bucket is an error with status and code only', async () => {
    const c = client();
    s3.failNext(2, 503);
    await c.putObject('r/retry', Buffer.from('x'));
    expect(s3.objects.has('r/retry')).toBe(true);
    const bad = new S3Client({
      endpoint: s3.endpoint,
      bucket: 'other-bucket',
      region: 'us-east-1',
      accessKey: 'ak',
      secretKey: 'sk',
    });
    await expect(bad.list('x')).rejects.toMatchObject({ status: 404, code: 'NoSuchBucket' });
  });

  it('reports a missing object as undefined (head) and as NoSuchKey (get)', async () => {
    const c = client();
    expect(await c.headObject('nope')).toBeUndefined();
    await expect(c.getObject('nope')).rejects.toMatchObject({ status: 404, code: 'NoSuchKey' });
  });

  it('reports an unreachable endpoint without the URL, the key or the credentials', async () => {
    const c = new S3Client(
      {
        endpoint: 'http://bucket-unreachable.invalid:9000',
        bucket: 'b',
        region: 'us-east-1',
        accessKey: 'AKSECRET',
        secretKey: 'SKSECRET',
      },
      { attempts: 1 },
    );
    const error = await c.list('p/').catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(S3Error);
    expect((error as Error).message).not.toMatch(/unreachable|AKSECRET|SKSECRET/u);
  });
});
