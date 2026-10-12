import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HostHealthDetailSchema } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * S17 (spec 11 §6.1 "Service health": repeated OOM/restarts): `infra/scripts/host-health.sh` must put
 * the per-container restart count and OOM state into the `host_health` event it posts, as
 * `containers.<compose service>.{restarts, oomKilled}`. The script runs with a stubbed `docker` on
 * PATH. The stub answers what a script can reasonably ask (all through `docker`, never a daemon):
 *
 *  - `docker compose ... exec -T postgres df -Pk|-Pi <dir>`: a fixed filesystem report;
 *  - `docker compose ... exec -T api node -e ...`: stores its stdin (the posted detail) and succeeds;
 *  - `docker compose ... ps` and `docker ps` with `-q` or `--format json|<template>`: the compose
 *    containers `api`, `worker` and `postgres` (ids `id-api`, ...);
 *  - `docker inspect [--format <template>] <ids...>`: the full JSON array, or the template filled for
 *    `.Name`, `.Id`, `.RestartCount`, `.State.OOMKilled`, `.State.Running` and
 *    `index .Config.Labels "com.docker.compose.service"`;
 *  - anything else exits 3 with a message, so an unexpected question fails loudly.
 */

const script = fileURLToPath(new URL('../../../infra/scripts/host-health.sh', import.meta.url));

const STUB = `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
const containers = [
  { svc: 'api', restarts: 4, oom: false },
  { svc: 'worker', restarts: 0, oom: true },
  { svc: 'postgres', restarts: 1, oom: false },
];
const info = (c) => ({
  Id: 'id-' + c.svc,
  Name: '/bantoozi-s17-' + c.svc + '-1',
  RestartCount: c.restarts,
  State: { Status: 'running', Running: true, OOMKilled: c.oom },
  Config: { Labels: { 'com.docker.compose.service': c.svc, 'com.docker.compose.project': 'bantoozi-s17' } },
});
const fail = (message) => { process.stderr.write('docker stub: ' + message + '\\n'); process.exit(3); };
const formatOf = () => {
  const i = args.findIndex((a) => a === '--format' || a === '-f');
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith('--format='));
  return eq ? eq.slice('--format='.length) : undefined;
};
const fill = (template, c) => {
  const value = {
    '.Id': 'id-' + c.svc, '.ID': 'id-' + c.svc, '.Name': '/bantoozi-s17-' + c.svc + '-1',
    '.Names': 'bantoozi-s17-' + c.svc + '-1', '.Service': c.svc, '.RestartCount': String(c.restarts),
    '.State.OOMKilled': String(c.oom), '.State.Running': 'true', '.State.Status': 'running',
  };
  return template.replace(/{{\\s*([^}]*?)\\s*}}/g, (_all, action) => {
    if (action in value) return value[action];
    const label = /^(?:index \\.Config\\.Labels|\\.Label) "([^"]+)"$/.exec(action);
    if (label) return info(c).Config.Labels[label[1]] ?? '';
    return fail('unsupported template action ' + action);
  });
};
const listing = () => {
  const format = formatOf();
  if (args.includes('-q') || args.includes('--quiet')) return containers.map((c) => 'id-' + c.svc).join('\\n') + '\\n';
  if (format === 'json') return containers.map((c) => JSON.stringify({ ID: 'id-' + c.svc, Name: 'bantoozi-s17-' + c.svc + '-1', Service: c.svc, State: 'running' })).join('\\n') + '\\n';
  if (format) return containers.map((c) => fill(format, c)).join('\\n') + '\\n';
  return fail('ps without -q or --format');
};
let rest = args;
if (rest[0] === 'compose') {
  const exec = rest.indexOf('exec');
  const ps = rest.indexOf('ps');
  if (exec >= 0) {
    const tail = rest.slice(exec + 1).filter((a) => a !== '-T');
    if (tail[0] === 'postgres' && tail[1] === 'df') {
      const inode = tail.includes('-Pi');
      process.stdout.write(inode
        ? 'Filesystem Inodes IUsed IFree IUse% Mounted on\\n/dev/sda1 100000 1000 99000 1% /var/lib/postgresql/data\\n'
        : 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 1000000 400000 600000 40% /var/lib/postgresql/data\\n');
      process.exit(0);
    }
    if (tail[0] === 'api' && tail[1] === 'node') {
      let body = '';
      process.stdin.on('data', (chunk) => { body += chunk; }).on('end', () => {
        fs.writeFileSync(dir + '/posted.json', body);
        process.exit(0);
      });
      return;
    }
    fail('unexpected compose exec ' + tail.join(' '));
  }
  if (ps >= 0) {
    if (process.env.STUB_NO_CONTAINERS) fail('container listing unavailable');
    process.stdout.write(listing());
    process.exit(0);
  }
  fail('unexpected compose command ' + rest.join(' '));
} else if (rest[0] === 'ps') {
  if (process.env.STUB_NO_CONTAINERS) fail('container listing unavailable');
  process.stdout.write(listing());
} else if (rest[0] === 'inspect') {
  if (process.env.STUB_NO_CONTAINERS) fail('inspect unavailable');
  const ids = rest.slice(1).filter((a) => a.startsWith('id-'));
  const chosen = containers.filter((c) => ids.length === 0 || ids.includes('id-' + c.svc));
  const format = formatOf();
  process.stdout.write(format ? chosen.map((c) => fill(format, c)).join('\\n') + '\\n' : JSON.stringify(chosen.map(info)));
} else {
  fail('unexpected command ' + rest.join(' '));
}
`;

let dir: string;
let envFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-health-s17-'));
  writeFileSync(join(dir, 'docker'), STUB);
  chmodSync(join(dir, 'docker'), 0o755);
  envFile = join(dir, 'prod.env');
  writeFileSync(envFile, 'COMPOSE_PROJECT_NAME=bantoozi-s17\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(extraEnv: Record<string, string> = {}) {
  rmSync(join(dir, 'posted.json'), { force: true });
  const result = spawnSync('bash', [script, '--env-file', envFile], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      HOME: dir,
      TMPDIR: dir,
      STUB_DIR: dir,
      ...extraEnv,
    },
    timeout: 60_000,
  });
  let posted: Record<string, unknown> | undefined;
  try {
    posted = JSON.parse(readFileSync(join(dir, 'posted.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    posted = undefined;
  }
  return { ...result, posted };
}

describe('S17 host-health.sh reports container restarts and OOM kills', () => {
  it('posts containers.<service>.{restarts, oomKilled} next to the filesystems', () => {
    const result = run();

    expect(result.stderr).not.toContain('docker stub:');
    expect(result.status, result.stderr).toBe(0);
    expect(result.posted, 'the host_health detail reached the api container').toBeDefined();
    const detail = result.posted as {
      filesystems?: Array<{ mount: string }>;
      containers?: Record<string, { restarts: number; oomKilled: boolean }>;
    };
    expect(detail.filesystems?.map((fs) => fs.mount)).toContain('/var/lib/postgresql/data');
    expect(detail.containers).toEqual({
      api: { restarts: 4, oomKilled: false },
      worker: { restarts: 0, oomKilled: true },
      postgres: { restarts: 1, oomKilled: false },
    });
  });

  it('prints the same detail and posts one the bounded ops-event schema accepts', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"containers"');
    expect(result.stdout).toContain('"oomKilled":true');
    expect(HostHealthDetailSchema.safeParse(result.posted).success).toBe(true);
  });

  it('still reports the disks when the containers cannot be inspected', () => {
    const normal = run();
    expect(
      Object.keys((normal.posted as { containers?: object } | undefined)?.containers ?? {}),
    ).toHaveLength(3);

    const result = run({ STUB_NO_CONTAINERS: '1' });

    expect(result.status, result.stderr).toBe(0);
    const detail = result.posted as {
      filesystems?: unknown[];
      containers?: Record<string, unknown>;
    };
    expect(detail.filesystems?.length).toBeGreaterThan(0);
    expect(Object.keys(detail.containers ?? {})).toHaveLength(0);
  });
});
