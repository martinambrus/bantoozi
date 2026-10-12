import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { LOAD_API_PORT, LOAD_PROJECT } from './config.js';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  /** Keep going on a nonzero exit and return what was printed. */
  allowFailure?: boolean;
}

/** Runs a command to completion; returns stdout. Rejects with the stderr tail on failure. */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  try {
    const child = execFileAsync(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (options.input !== undefined) child.child.stdin?.end(options.input);
    const { stdout } = await child;
    return stdout;
  } catch (error) {
    if (options.allowFailure === true) {
      const failed = error as { stdout?: string };
      return failed.stdout ?? '';
    }
    const failed = error as { stderr?: string; message: string };
    const tail = (failed.stderr ?? failed.message).split('\n').slice(-25).join('\n');
    throw new Error(`${command} ${args.slice(0, 6).join(' ')} failed: ${tail}`, { cause: error });
  }
}

/** Throwaway secrets and settings of the load project; every value is generated per run. */
export function loadEnvFile(): string {
  const secret = (): string => randomBytes(18).toString('hex');
  return (
    [
      `POSTGRES_PASSWORD=${secret()}`,
      `BANTOOZI_OWNER_PASSWORD=${secret()}`,
      `BANTOOZI_APP_PASSWORD=${secret()}`,
      `BANTOOZI_WORKER_PASSWORD=${secret()}`,
      `SESSION_PEPPER=${secret()}`,
      `METRICS_TOKEN=${secret()}`,
      `PUBLIC_BASE_URL=http://127.0.0.1:${LOAD_API_PORT}`,
      'PUBLIC_HOST=localhost',
      'ACME_EMAIL=load@example.com',
      'TYPESAFE_MODEL=jev-fake',
      'LANGUAGE_MODES=\'{"en":"native","sk":"native","cs":"native"}\'',
      'LOG_LEVEL=warn',
    ].join('\n') + '\n'
  );
}

export interface ServiceContainers {
  /** service name -> container id */
  byService: Record<string, string>;
}

/** The `bantoozi-load` Compose project: bring up, query, tear down. */
export class LoadStack {
  private envDir: string | undefined;
  private envFile = '';
  /** Set once `up` ran, so a failed start is still torn down. */
  touched = false;

  constructor(private readonly repoRoot: string) {}

  private composeArgs(): string[] {
    return [
      'compose',
      '-p',
      LOAD_PROJECT,
      '-f',
      path.join(this.repoRoot, 'infra/compose.yml'),
      '-f',
      path.join(this.repoRoot, 'infra/load/compose.override.yml'),
      '--env-file',
      this.envFile,
    ];
  }

  /**
   * The command that tears a kept stack down. The compose files require variables only the env
   * file supplies, so the command names it; remove its directory afterwards (it holds the secrets).
   */
  teardownCommand(): string {
    const args = [...this.composeArgs(), 'down', '--volumes', '--remove-orphans'];
    const dir = this.envDir === undefined ? '' : `; rm -rf ${this.envDir}`;
    return `docker ${args.join(' ')}${dir}`;
  }

  compose(args: readonly string[], options: RunOptions = {}): Promise<string> {
    return run('docker', [...this.composeArgs(), ...args], { cwd: this.repoRoot, ...options });
  }

  /** Writes the env file (mode 600, outside the repository), builds, migrates, seeds, starts. */
  async up(log: (message: string) => void): Promise<void> {
    this.envDir = await mkdtemp(path.join(os.tmpdir(), 'bantoozi-load-'));
    this.envFile = path.join(this.envDir, 'load.env');
    await writeFile(this.envFile, loadEnvFile(), { mode: 0o600 });
    await chmod(this.envFile, 0o600);
    this.touched = true;
    log('building images');
    await this.compose(['build', 'migrate', 'seed', 'api', 'worker', 'load-sim'], {
      timeoutMs: 1_800_000,
    });
    log('starting postgres');
    await this.compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'postgres']);
    for (const job of ['migrate', 'seed']) {
      log(`running the ${job} job`);
      await this.compose(['up', '--no-build', '--no-deps', '--exit-code-from', job, job], {
        timeoutMs: 600_000,
      });
    }
    log('starting load-sim, api and worker');
    await this.compose(
      [
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        '--wait',
        '--wait-timeout',
        '240',
        'load-sim',
        'api',
        'worker',
      ],
      { timeoutMs: 400_000 },
    );
  }

  /** Stops and removes the containers, networks and volumes of the project, and the env file. */
  async down(): Promise<void> {
    if (this.touched) {
      await this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], {
        allowFailure: true,
        timeoutMs: 300_000,
      });
    }
    // Backstop if compose lost track of something (a failed start).
    const containers = (
      await run(
        'docker',
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${LOAD_PROJECT}`],
        {
          allowFailure: true,
        },
      )
    )
      .split('\n')
      .filter(Boolean);
    if (containers.length > 0)
      await run('docker', ['rm', '-f', '-v', ...containers], { allowFailure: true });
    for (const kind of ['volume', 'network'] as const) {
      const ids = (
        await run(
          'docker',
          [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${LOAD_PROJECT}`],
          {
            allowFailure: true,
          },
        )
      )
        .split('\n')
        .filter(Boolean);
      if (ids.length > 0) await run('docker', [kind, 'rm', '-f', ...ids], { allowFailure: true });
    }
    if (this.envDir !== undefined) await rm(this.envDir, { recursive: true, force: true });
    this.envDir = undefined;
  }

  async containers(): Promise<ServiceContainers> {
    const out = await run('docker', [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${LOAD_PROJECT}`,
      '--format',
      '{{.ID}} {{.Label "com.docker.compose.service"}}',
    ]);
    const byService: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const [id, service] = line.trim().split(' ');
      if (id !== undefined && service !== undefined && service !== '') byService[service] = id;
    }
    return { byService };
  }

  /** Runs SQL as the superuser in the project's database; returns rows split on `|`. */
  async sql(containerId: string, statement: string): Promise<string[][]> {
    const out = await run('docker', [
      'exec',
      containerId,
      'psql',
      '-U',
      'postgres',
      '-d',
      'bantoozi',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-F',
      '|',
      '-c',
      statement,
    ]);
    return out
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('|'));
  }
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** `"123.4MiB"` or `"1.5GiB / 6GiB"` (first part) to bytes; NaN when unreadable. */
export function parseBytes(text: string): number {
  const match = /^\s*([\d.]+)\s*([A-Za-z]+)/u.exec(text);
  const unit = match?.[2] === undefined ? undefined : UNITS[match[2].toLowerCase()];
  return match?.[1] === undefined || unit === undefined ? Number.NaN : Number(match[1]) * unit;
}

export interface StatsSample {
  cpuPct: number;
  memBytes: number;
}

/** Parses `docker stats --no-stream --format '{{json .}}'` lines into service samples. */
export function parseStats(
  output: string,
  serviceOf: Readonly<Record<string, string>>,
): Record<string, StatsSample> {
  const samples: Record<string, StatsSample> = {};
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    let row: { ID?: string; Container?: string; CPUPerc?: string; MemUsage?: string };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const id = row.ID ?? row.Container ?? '';
    const service = Object.entries(serviceOf).find(
      ([, cid]) => cid.startsWith(id) || id.startsWith(cid),
    )?.[0];
    const cpuPct = Number.parseFloat(row.CPUPerc ?? '');
    const memBytes = parseBytes(row.MemUsage ?? '');
    if (service !== undefined && Number.isFinite(cpuPct) && Number.isFinite(memBytes)) {
      samples[service] = { cpuPct, memBytes };
    }
  }
  return samples;
}

export async function dockerStats(
  containers: Record<string, string>,
): Promise<Record<string, StatsSample>> {
  const ids = Object.values(containers);
  if (ids.length === 0) return {};
  const out = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids]);
  return parseStats(out, containers);
}

/**
 * A node process inside the worker container that evaluates the REAL `backlog` alert rule of
 * apps/worker/src/alerts/rules.ts (the one `house.alerts` runs) against the database on demand.
 * It reads one line per evaluation from stdin and prints one JSON line.
 */
const PROBE_SOURCE = `
import readline from 'node:readline';
const { ALERT_RULES } = await import('/app/apps/worker/dist/alerts/rules.js');
const { createDatabase, createPool } = await import('/app/packages/db/dist/index.js');
const pool = createPool({ connectionString: process.env.DATABASE_URL_WORKER, max: 1, applicationName: 'bantoozi-load-probe' });
const db = createDatabase(pool);
const rule = ALERT_RULES.find((r) => r.id === 'backlog');
if (!rule) throw new Error('the backlog alert rule does not exist');
const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true }));
for await (const _line of rl) {
  try {
    const conditions = await rule.evaluate({ deps: { db }, now: new Date(), memo: {} });
    console.log(JSON.stringify({ conditions }));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error && error.message || error) }));
  }
}
await pool.end();
`;

export interface BacklogCondition {
  key: string;
  title: string;
  detail: string;
}

export class BacklogProbe {
  private child: ChildProcessWithoutNullStreams | undefined;
  private waiting: ((line: string) => void)[] = [];
  private buffer = '';

  /** Starts the evaluator in the worker container and waits until it is connected. */
  async start(workerContainerId: string): Promise<void> {
    const child = spawn(
      'docker',
      ['exec', '-i', workerContainerId, 'node', '--input-type=module', '-e', PROBE_SOURCE],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.waiting.shift()?.(line);
        newline = this.buffer.indexOf('\n');
      }
    });
    child.on('exit', () => {
      for (const resolve of this.waiting.splice(0)) {
        resolve(JSON.stringify({ error: `probe exited: ${stderr.slice(-400)}` }));
      }
    });
    const first = JSON.parse(await this.nextLine()) as { ready?: boolean; error?: string };
    if (first.ready !== true) throw new Error(first.error ?? 'the backlog probe did not start');
  }

  /** Runs the real backlog rule now; the conditions it returns are the alerts it would raise. */
  async evaluate(): Promise<BacklogCondition[]> {
    if (this.child === undefined) throw new Error('the backlog probe is not running');
    const line = this.nextLine();
    this.child.stdin.write('\n');
    const answer = JSON.parse(await line) as { conditions?: BacklogCondition[]; error?: string };
    if (answer.conditions === undefined) throw new Error(answer.error ?? 'backlog rule failed');
    return answer.conditions;
  }

  stop(): void {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
  }

  private nextLine(): Promise<string> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}
