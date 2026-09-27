import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { JEV_FAKE_MODEL } from '@bantoozi/engine';
import { describe, expect, it } from 'vitest';

import {
  CredentialUnavailableError,
  isCredentialUnavailableError,
  MAX_SECRET_INPUT_BYTES,
  providerConfigFingerprint,
  readSecret,
  SecretInputError,
  type SecretInputStream,
} from '../src/credentials/index.js';
import { engineConfigFromWorker, type WorkerEngineConfig } from '../src/engine-router.js';

/** Unit parts of the worker credentials (M2-T3, spec 04 §1.2) that need no database. */

function output() {
  const chunks: string[] = [];
  return { chunks, write: (text: string) => chunks.push(text) };
}

/** A terminal-like stdin: raw mode is recorded, keystrokes are emitted by the test. */
function terminal() {
  const emitter = new EventEmitter();
  const modes: boolean[] = [];
  const stream = Object.assign(emitter, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      modes.push(mode);
    },
    resume: () => undefined,
    pause: () => undefined,
    [Symbol.asyncIterator]: () => {
      throw new Error('a terminal is read by events');
    },
  });
  return { stream: stream as unknown as SecretInputStream, emitter, modes };
}

describe('readSecret (protected stdin)', () => {
  it('reads piped input and drops one trailing line break', async () => {
    const prompt = output();
    expect(await readSecret(Readable.from([Buffer.from('sk-piped\n')]), prompt, '> ')).toBe(
      'sk-piped',
    );
    expect(await readSecret(Readable.from(['sk-', 'crlf\r\n']), prompt, '> ')).toBe('sk-crlf');
    expect(await readSecret(Readable.from(['two\n\n']), prompt, '> ')).toBe('two\n');
    expect(await readSecret(Readable.from(['no-newline']), prompt, '> ')).toBe('no-newline');
    // No prompt is written for piped input.
    expect(prompt.chunks).toEqual([]);
  });

  it('refuses oversized input without echoing it', async () => {
    const huge = 'k'.repeat(MAX_SECRET_INPUT_BYTES + 1);
    const error = await readSecret(Readable.from([huge]), output(), '> ').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretInputError);
    expect((error as SecretInputError).code).toBe('input_too_large');
    expect(String((error as Error).message)).not.toContain('kkkk');
  });

  it('reads a terminal in raw mode without echo, with backspace', async () => {
    const tty = terminal();
    const prompt = output();
    const pending = readSecret(tty.stream, prompt, 'API key: ');
    tty.emitter.emit('data', Buffer.from('sec'));
    tty.emitter.emit('data', 'rex');
    tty.emitter.emit('data', '\u007f');
    tty.emitter.emit('data', 't\r');
    expect(await pending).toBe('secret');
    // Nothing but the prompt and the final newline is written back.
    expect(prompt.chunks).toEqual(['API key: ', '\n']);
    expect(tty.modes).toEqual([true, false]);
    expect(tty.emitter.listenerCount('data')).toBe(0);
  });

  it('cancels on Ctrl-C and restores the terminal', async () => {
    const tty = terminal();
    const pending = readSecret(tty.stream, output(), 'API key: ');
    tty.emitter.emit('data', 'partial\u0003');
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(tty.modes).toEqual([true, false]);
  });

  it('finishes at the end of the terminal input', async () => {
    const tty = terminal();
    const pending = readSecret(tty.stream, output(), 'API key: ');
    tty.emitter.emit('data', 'eof-key');
    tty.emitter.emit('end');
    expect(await pending).toBe('eof-key');
  });
});

describe('providerConfigFingerprint', () => {
  const config = {
    typesafeBaseUrl: 'https://api.typesafe.ai',
    typesafeModel: 'jev-1.13.0',
    ollamaBaseUrl: 'https://ollama.com',
    ollamaModelFast: 'glm-5.3-flash',
    ollamaModelStrong: 'glm-5.3',
  };

  it('is a stable hex digest of the endpoint and pinned models', () => {
    const jev = providerConfigFingerprint('typesafe', config);
    expect(jev).toMatch(/^[0-9a-f]{64}$/);
    expect(providerConfigFingerprint('typesafe', { ...config })).toBe(jev);
    expect(
      providerConfigFingerprint('typesafe', {
        ...config,
        typesafeBaseUrl: 'https://api.typesafe.ai/',
      }),
    ).toBe(jev);
    // Only the provider's own settings matter.
    expect(providerConfigFingerprint('typesafe', { ...config, ollamaModelFast: 'other' })).toBe(
      jev,
    );
  });

  it('changes with the endpoint or a pinned model', () => {
    const jev = providerConfigFingerprint('typesafe', config);
    const ollama = providerConfigFingerprint('ollama', config);
    expect(ollama).not.toBe(jev);
    expect(
      providerConfigFingerprint('typesafe', { ...config, typesafeModel: 'jev-1.14.0' }),
    ).not.toBe(jev);
    expect(
      providerConfigFingerprint('typesafe', { ...config, typesafeBaseUrl: 'https://evil.test' }),
    ).not.toBe(jev);
    expect(providerConfigFingerprint('ollama', { ...config, ollamaModelStrong: 'glm-6' })).not.toBe(
      ollama,
    );
  });
});

describe('CredentialUnavailableError', () => {
  it('is a typed ENGINE_UNAVAILABLE without a cause or payload', () => {
    const error = new CredentialUnavailableError('ollama', 'decrypt_failed');
    expect(error.code).toBe('ENGINE_UNAVAILABLE');
    expect(error.details).toEqual({ provider: 'ollama', reason: 'decrypt_failed' });
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe('No usable ollama credential (decrypt_failed)');
    expect(isCredentialUnavailableError(error)).toBe(true);
    expect(isCredentialUnavailableError(new Error('x'))).toBe(false);
  });
});

describe('engineConfigFromWorker', () => {
  const worker: WorkerEngineConfig = {
    nodeEnv: 'test',
    typesafeBaseUrl: 'http://127.0.0.1:4010',
    typesafeModel: 'jev-1.13.0',
    typesafePricePerMtokUsd: 0.042,
    engineConcurrency: 4,
    dailyBudgetUsd: 2,
    ollamaBaseUrl: 'http://127.0.0.1:4011',
    ollamaModelFast: 'glm-5.3-flash',
    ollamaModelStrong: 'glm-5.3',
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: true,
  };

  it('maps the worker variables onto the router configuration', () => {
    expect(engineConfigFromWorker(worker, { rateLimitShare: 0.5 })).toEqual({
      typesafe: {
        baseUrl: 'http://127.0.0.1:4010',
        model: 'jev-1.13.0',
        pricePerMTokUsd: 0.042,
        rateLimitShare: 0.5,
      },
      ollama: {
        baseUrl: 'http://127.0.0.1:4011',
        modelFast: 'glm-5.3-flash',
        modelStrong: 'glm-5.3',
        maxConcurrency: 1,
      },
      concurrency: 4,
      dailyBudgetUsd: 2,
      llmFallbackEnabled: true,
      production: false,
    });
  });

  it('allows the fake model only as an explicit non-production test configuration', () => {
    const fake = { ...worker, typesafeModel: JEV_FAKE_MODEL };
    expect(engineConfigFromWorker(fake).typesafe.allowFakeModel).toBe(true);
    expect(engineConfigFromWorker(worker).typesafe.allowFakeModel).toBeUndefined();
    const production = engineConfigFromWorker({ ...fake, nodeEnv: 'production' });
    expect(production.production).toBe(true);
    expect(production.typesafe.allowFakeModel).toBeUndefined();
  });
});
