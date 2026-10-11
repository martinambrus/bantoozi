import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LoadStack } from '../src/load/docker.js';
import { runLoad } from '../src/load/run.js';

/**
 * S19: `load:run` writes a mode-600 env file with throwaway secrets into a temp directory. The
 * directory must be gone after teardown on every path: a clean run, a failed start (build, migrate,
 * start) and an unreachable Docker CLI. Docker is a fake `docker` executable on PATH that records
 * its calls and fails when its arguments contain FAKE_DOCKER_FAIL; TMPDIR points at a scratch
 * directory so nothing outside the test is looked at or touched.
 */

let scratch: string;
let tmp: string;
let repo: string;
let log: string;
const saved = {
  TMPDIR: process.env['TMPDIR'],
  PATH: process.env['PATH'],
  FAIL: process.env['FAKE_DOCKER_FAIL'],
  LOG: process.env['FAKE_DOCKER_LOG'],
};

const leftovers = (): string[] =>
  readdirSync(tmp).filter((name) => name.startsWith('bantoozi-load-'));
const calls = (): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 's19-tempdir-'));
  tmp = path.join(scratch, 'tmp');
  const bin = path.join(scratch, 'bin');
  repo = path.join(scratch, 'repo');
  mkdirSync(tmp);
  mkdirSync(repo);
  mkdirSync(bin);
  log = path.join(scratch, 'docker.log');
  const docker = path.join(bin, 'docker');
  writeFileSync(
    docker,
    [
      '#!/bin/sh',
      'echo "$@" >> "$FAKE_DOCKER_LOG"',
      'if [ -n "$FAKE_DOCKER_FAIL" ]; then case "$*" in *"$FAKE_DOCKER_FAIL"*) echo "fake docker: refused" >&2; exit 1;; esac; fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);
  process.env['TMPDIR'] = tmp;
  process.env['PATH'] = `${bin}:${saved.PATH ?? ''}`;
  process.env['FAKE_DOCKER_LOG'] = log;
  delete process.env['FAKE_DOCKER_FAIL'];
});

afterEach(() => {
  for (const [key, value] of [
    ['TMPDIR', saved.TMPDIR],
    ['PATH', saved.PATH],
    ['FAKE_DOCKER_FAIL', saved.FAIL],
    ['FAKE_DOCKER_LOG', saved.LOG],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const noLog = (): void => {};

describe('the load stack env directory', () => {
  it('exists, with a mode-600 env file, while the stack is up, and is removed by down()', async () => {
    const stack = new LoadStack(repo);
    await stack.up(noLog);
    const [dir] = leftovers();
    expect(dir).toBeDefined();
    const file = path.join(tmp, dir!, 'load.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('POSTGRES_PASSWORD=');
    await stack.down();
    expect(leftovers()).toEqual([]);
    expect(calls().some((call) => call.includes('down --volumes'))).toBe(true);
  });

  it.each(['build', 'postgres', 'migrate', 'load-sim'])(
    'is removed by down() after a start that failed at %s',
    async (step) => {
      process.env['FAKE_DOCKER_FAIL'] = step;
      const stack = new LoadStack(repo);
      await expect(stack.up(noLog)).rejects.toThrow();
      process.env['FAKE_DOCKER_FAIL'] = '';
      await stack.down();
      expect(leftovers()).toEqual([]);
    },
  );

  it('is removed even when every docker command of the teardown fails', async () => {
    const stack = new LoadStack(repo);
    await stack.up(noLog);
    process.env['FAKE_DOCKER_FAIL'] = ' ';
    await stack.down();
    expect(leftovers()).toEqual([]);
  });

  it('is removed when the docker CLI cannot be started at all', async () => {
    const stack = new LoadStack(repo);
    await stack.up(noLog);
    process.env['PATH'] = '/nonexistent';
    await stack.down();
    expect(leftovers()).toEqual([]);
  });

  it('down() twice is safe and leaves nothing', async () => {
    const stack = new LoadStack(repo);
    await stack.up(noLog);
    await stack.down();
    await stack.down();
    expect(leftovers()).toEqual([]);
  });
});

describe('runLoad teardown (the stack never reaches its containers: fake docker lists none)', () => {
  const run = (keep: boolean, messages: string[]) =>
    runLoad({
      durationMin: 2,
      outDir: path.join(scratch, 'out'),
      keep,
      repoRoot: repo,
      log: (message: string) => messages.push(message),
    });

  it('removes the env directory when the run fails', async () => {
    const messages: string[] = [];
    await expect(run(false, messages)).rejects.toThrow(/container is not running/);
    expect(leftovers()).toEqual([]);
  });

  it('with --keep, never strands the secrets: no env directory, or a teardown command that names it', async () => {
    // `docker compose -p bantoozi-load down --volumes` alone cannot work: infra/compose.yml has
    // required variables (${POSTGRES_PASSWORD:?}) that only the env file supplies. A kept stack
    // must therefore either not keep a secret-bearing directory nobody is told about, or tell the
    // operator the command that works, naming the env file, which must exist.
    const messages: string[] = [];
    await expect(run(true, messages)).rejects.toThrow(/container is not running/);
    const dirs = leftovers();
    const named = /--env-file[ =](\S*bantoozi-load-\S*load\.env)/u.exec(messages.join('\n'))?.[1];
    const stranded = dirs.length > 0 && (named === undefined || !existsSync(named));
    expect({ dirs, named, stranded }).toMatchObject({ stranded: false });
  });
});
