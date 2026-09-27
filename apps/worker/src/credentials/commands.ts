import {
  activateProviderCredential,
  listCredentialMetadata,
  readCredentialMetadata,
  readStoredEnvelopes,
  requestProviderValidation,
  resolveAdminUserId,
  rewrapProviderCredential,
  setProviderCredentialEnabled,
  sqlState,
  stageProviderCredential,
  validationRequestable,
  type CredentialMetadataRecord,
  type Database,
} from '@bantoozi/db';
import { AppError, isAppError, PROVIDERS, ProviderSchema } from '@bantoozi/shared';
import type { Config } from '@bantoozi/shared/server';
import {
  CredentialCryptoError,
  encryptProviderSecret,
  ProviderKeyring,
  rewrapProviderSecret,
  validateProviderSecret,
} from '@bantoozi/shared/server/credential-crypto';
import type { Command } from 'commander';

import { providerConfigFingerprint } from './fingerprint.js';
import type { CredentialProvider } from './resolver.js';
import { readSecret, SecretInputError, type SecretInputStream } from './secret-input.js';

/**
 * The credentials CLI (spec 04 §1.2 "until the UI exists, a server CLI stages the same rows using
 * the same validation and authorization rules"), run as `pnpm worker-cli credentials:<command>` on
 * the worker host:
 *
 * - `credentials:status` — redacted metadata of both providers and the keyring ids;
 * - `credentials:stage <provider> --admin <email>` — read the key from stdin (echo disabled on a
 *   terminal; never argv), validate and encrypt it locally, stage it as the pending candidate;
 * - `credentials:validate <provider> --admin <email> [--wait <s> | --inline]` — queue
 *   `provider.validate` (or run it in this process) for the current candidate;
 * - `credentials:activate <provider> --admin <email>` — activate the validated candidate;
 * - `credentials:revoke <provider> --admin <email>` — local revocation (tombstone);
 * - `credentials:rewrap [provider]` — master-key rotation: rewrap every stored envelope whose
 *   wrapping key is not `PROVIDER_MASTER_KEY_ID`.
 *
 * **Admin choice.** The M0 admin SQL functions are executable by the API role only and require an
 * administrator session (`app.user_id`); the CLI connects as `bantoozi_worker`, a host operator
 * with the master keys. It therefore uses the worker-role repository that mirrors those functions
 * (same row lock, revision CAS and state rules), and the state-changing commands require
 * `--admin <email>` naming an active administrator, recorded as `updated_by`. Every command's
 * optimistic `--expected-revision` defaults to the revision it has just read.
 *
 * Output is metadata only: versions, statuses, timestamps, sanitized codes and key ids — never a
 * key, part of a key, a hash of a key or an envelope.
 */

export type CredentialCliConfig = Pick<
  Config,
  | 'nodeEnv'
  | 'providerMasterKeyId'
  | 'providerMasterKeys'
  | 'typesafeApiKey'
  | 'ollamaApiKey'
  | 'typesafeBaseUrl'
  | 'typesafeModel'
  | 'typesafePricePerMtokUsd'
  | 'ollamaBaseUrl'
  | 'ollamaModelFast'
  | 'ollamaModelStrong'
>;

export interface CliOutput {
  write(text: string): unknown;
}

export interface CliIo {
  stdin: SecretInputStream;
  stdout: CliOutput;
  stderr: CliOutput;
}

/** One command's database session. */
export interface CredentialCliSession {
  db: Database;
  config: CredentialCliConfig;
  /** Run `provider.validate` in this process instead of queueing it (`--inline`). */
  validateInline?: (payload: {
    provider: CredentialProvider;
    candidateVersion: string;
  }) => Promise<void>;
  close(): Promise<void>;
}

export interface CredentialCliDeps {
  io: CliIo;
  /** Opens the session lazily, so `--help` needs no configuration. */
  open(): Promise<CredentialCliSession>;
  /** Default: `process.exitCode = code`. */
  setExitCode?: (code: number) => void;
  /** Poll interval of `validate --wait` (tests). Default 1 s. */
  pollMs?: number;
}

class CliUsageError extends Error {}

function parseProvider(value: string): CredentialProvider {
  const parsed = ProviderSchema.safeParse(value);
  if (!parsed.success) throw new CliUsageError(`unknown provider (use ${PROVIDERS.join(' or ')})`);
  return parsed.data;
}

function parseRevision(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,18})$/.test(value)) throw new CliUsageError(`${name} must be a revision`);
  return value;
}

function keyringOf(config: CredentialCliConfig): ProviderKeyring {
  const parsed = ProviderKeyring.parse(config.providerMasterKeyId, config.providerMasterKeys);
  if (!parsed.ok) {
    throw new CliUsageError(
      `PROVIDER_MASTER_KEY_ID/PROVIDER_MASTER_KEYS are unusable (${parsed.reason}); nothing was changed`,
    );
  }
  return parsed.keyring;
}

const envKeyOf = (config: CredentialCliConfig, provider: CredentialProvider) =>
  provider === 'typesafe' ? config.typesafeApiKey : config.ollamaApiKey;

const at = (date: Date | null): string => (date === null ? '-' : date.toISOString());

/** One provider's redacted status lines. */
export function describeCredential(
  provider: CredentialProvider,
  row: CredentialMetadataRecord | null,
  config: CredentialCliConfig,
): string[] {
  if (row === null) {
    return envKeyOf(config, provider) === undefined
      ? [`${provider}: source=none (no stored credential, no bootstrap key)`]
      : [`${provider}: source=env (bootstrap key; used only while no row exists)`];
  }
  const lines = [
    `${provider}: source=db revision=${row.revision} enabled=${row.enabled ? 'yes' : 'no'} ` +
      `active=${row.activeVersion ?? '-'} activated=${at(row.activatedAt)} updated=${at(row.updatedAt)}`,
  ];
  if (row.activeVersion === null && row.candidateVersion === null && !row.enabled) {
    lines.push('  revoked: no key is stored and the environment fallback is blocked');
  }
  if (row.candidateVersion !== null) {
    const v = row.candidateValidation;
    const fingerprint =
      v.configFingerprint === undefined
        ? '-'
        : v.configFingerprint === providerConfigFingerprint(provider, config)
          ? 'current'
          : 'changed';
    const capabilities = Object.entries(v.capabilities ?? {})
      .filter(([, on]) => on)
      .map(([name]) => name)
      .sort()
      .join(',');
    // A validator that stopped without a result: Validate may be requested again (D-87).
    const lease = row.validationLeaseExpired ? ' lease=expired' : '';
    lines.push(
      `  candidate=${row.candidateVersion} status=${row.candidateStatus ?? '-'}${lease} ` +
        `validated=${at(row.validatedAt)} model=${v.model ?? '-'} config=${fingerprint} ` +
        `capabilities=${capabilities === '' ? '-' : capabilities} attempts=${v.attempts ?? '-'} ` +
        `error=${row.lastErrorCode ?? '-'}`,
    );
  } else if (row.lastErrorCode !== null) {
    lines.push(`  last error=${row.lastErrorCode}`);
  }
  return lines;
}

function describeKeyring(config: CredentialCliConfig): string {
  const parsed = ProviderKeyring.parse(config.providerMasterKeyId, config.providerMasterKeys);
  return parsed.ok
    ? `keyring: active=${parsed.keyring.activeKeyId} keys=${parsed.keyring.keyIds.join(',')}`
    : `keyring: unavailable (${parsed.reason})`;
}

/** A message that is safe to print: codes and fixed texts, never input or database payloads. */
function safeMessage(error: unknown): string {
  if (error instanceof CliUsageError || error instanceof SecretInputError) return error.message;
  if (error instanceof CredentialCryptoError) return `${error.code}: ${error.message}`;
  if (isAppError(error)) return `${error.code}: ${error.message}`;
  const state = sqlState(error);
  return `unexpected ${error instanceof Error ? error.name : 'error'}${state === undefined ? '' : ` (SQLSTATE ${state})`}`;
}

async function currentRow(
  db: Database,
  provider: CredentialProvider,
): Promise<CredentialMetadataRecord | null> {
  return readCredentialMetadata(db, provider);
}

function candidateOf(
  row: CredentialMetadataRecord | null,
  provider: CredentialProvider,
  requested: string | undefined,
): string {
  const candidate = requested ?? row?.candidateVersion ?? undefined;
  if (candidate === undefined) {
    throw new AppError('NOT_FOUND', `No ${provider} candidate is staged`);
  }
  return candidate;
}

export function registerCredentialCommands(program: Command, deps: CredentialCliDeps): void {
  const { io } = deps;
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const pollMs = deps.pollMs ?? 1_000;
  const print = (lines: string | string[]) => {
    io.stdout.write(`${([] as string[]).concat(lines).join('\n')}\n`);
  };

  /** Run one command in its own session; failures print a safe message and exit non-zero. */
  const command =
    <A extends unknown[]>(fn: (session: CredentialCliSession, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      let session: CredentialCliSession | undefined;
      try {
        session = await deps.open();
        await fn(session, ...args);
      } catch (error) {
        io.stderr.write(`error: ${safeMessage(error)}\n`);
        setExitCode(error instanceof CliUsageError ? 2 : 1);
      } finally {
        await session?.close();
      }
    };

  program
    .command('credentials:status')
    .description('print redacted provider credential metadata and keyring ids')
    .action(
      command(async ({ db, config }) => {
        const rows = await listCredentialMetadata(db);
        const lines = PROVIDERS.flatMap((provider) =>
          describeCredential(provider, rows.find((r) => r.provider === provider) ?? null, config),
        );
        print([...lines, describeKeyring(config)]);
      }),
    );

  program
    .command('credentials:stage')
    .description('stage a new API key read from stdin (echo disabled) as the pending candidate')
    .argument('<provider>', PROVIDERS.join(' | '))
    .requiredOption('--admin <email>', 'active administrator recorded as the author')
    .option('--expected-revision <revision>', 'optimistic check (default: the current revision)')
    .action(
      command(
        async (
          { db, config },
          providerArg: string,
          options: { admin: string; expectedRevision?: string },
        ) => {
          const provider = parseProvider(providerArg);
          const requested = parseRevision('--expected-revision', options.expectedRevision);
          // Check everything that can fail before the key is typed.
          const keyring = keyringOf(config);
          const adminUserId = await resolveAdminUserId(db, options.admin);
          const expectedRevision = requested ?? (await currentRow(db, provider))?.revision ?? '0';
          const secretVersion = String(BigInt(expectedRevision) + 1n);
          const secret = await readSecret(
            io.stdin,
            io.stderr,
            `${provider} API key (input hidden, Enter to finish): `,
          );
          validateProviderSecret(secret);
          const envelope = encryptProviderSecret({ keyring, provider, secretVersion, secret });
          const staged = await stageProviderCredential(db, {
            provider,
            expectedRevision,
            envelope,
            adminUserId,
          });
          print([
            `staged ${provider} candidate version ${staged.candidateVersion} (revision ${staged.revision}, pending); ` +
              'no provider call was made and the active key is unchanged',
            `next: credentials:validate ${provider} --admin ${options.admin}`,
          ]);
        },
      ),
    );

  program
    .command('credentials:validate')
    .description('validate the staged candidate with a synthetic probe (provider.validate)')
    .argument('<provider>', PROVIDERS.join(' | '))
    .requiredOption('--admin <email>', 'active administrator requesting the validation')
    .option('--candidate-version <version>', 'the candidate to validate (default: the staged one)')
    .option('--expected-revision <revision>', 'optimistic check (default: the current revision)')
    .option('--wait <seconds>', 'wait up to this long for a worker to record the result')
    .option('--inline', 'run the probe in this process instead of queueing it')
    .action(
      command(
        async (
          session,
          providerArg: string,
          options: {
            admin: string;
            candidateVersion?: string;
            expectedRevision?: string;
            wait?: string;
            inline?: boolean;
          },
        ) => {
          const { db, config } = session;
          const provider = parseProvider(providerArg);
          const requestedRevision = parseRevision('--expected-revision', options.expectedRevision);
          const requestedCandidate = parseRevision('--candidate-version', options.candidateVersion);
          const waitSeconds = options.wait === undefined ? 0 : Number(options.wait);
          if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3_600) {
            throw new CliUsageError('--wait must be a whole number of seconds up to 3600');
          }
          await resolveAdminUserId(db, options.admin);
          const row = await currentRow(db, provider);
          const candidateVersion = candidateOf(row, provider, requestedCandidate);
          const expectedRevision = requestedRevision ?? row?.revision ?? '0';
          const before = row?.candidateValidation.checkedAt;

          if (options.inline === true) {
            if (session.validateInline === undefined) {
              throw new CliUsageError('--inline is not available in this session');
            }
            if (
              row === null ||
              row.revision !== expectedRevision ||
              row.candidateVersion !== candidateVersion ||
              !validationRequestable(row)
            ) {
              throw new AppError('CONFLICT', 'Stale or busy credential candidate');
            }
            await session.validateInline({ provider, candidateVersion });
            print(describeCredential(provider, await currentRow(db, provider), config));
            return;
          }

          await requestProviderValidation(db, { provider, candidateVersion, expectedRevision });
          print(`queued provider.validate for ${provider} candidate ${candidateVersion}`);
          if (waitSeconds === 0) return;
          const deadline = Date.now() + waitSeconds * 1_000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            const now = await currentRow(db, provider);
            const finished =
              now === null ||
              now.candidateVersion !== candidateVersion ||
              (now.candidateStatus !== 'validating' &&
                now.candidateValidation.checkedAt !== before);
            if (finished) {
              print(describeCredential(provider, now, config));
              return;
            }
          }
          print(
            'no result yet; a worker consuming provider.validate records it (credentials:status)',
          );
        },
      ),
    );

  program
    .command('credentials:activate')
    .description('activate the validated candidate (valid within 24 h, same configuration)')
    .argument('<provider>', PROVIDERS.join(' | '))
    .requiredOption('--admin <email>', 'active administrator recorded as the author')
    .option('--candidate-version <version>', 'the candidate to activate (default: the staged one)')
    .option('--expected-revision <revision>', 'optimistic check (default: the current revision)')
    .action(
      command(
        async (
          { db, config },
          providerArg: string,
          options: { admin: string; candidateVersion?: string; expectedRevision?: string },
        ) => {
          const provider = parseProvider(providerArg);
          const requestedRevision = parseRevision('--expected-revision', options.expectedRevision);
          const requestedCandidate = parseRevision('--candidate-version', options.candidateVersion);
          const adminUserId = await resolveAdminUserId(db, options.admin);
          const row = await currentRow(db, provider);
          const candidateVersion = candidateOf(row, provider, requestedCandidate);
          const activated = await activateProviderCredential(db, {
            provider,
            expectedRevision: requestedRevision ?? row?.revision ?? '0',
            candidateVersion,
            configFingerprint: providerConfigFingerprint(provider, config),
            adminUserId,
          });
          print(
            `activated ${provider} version ${activated.activeVersion} (revision ${activated.revision}); ` +
              'the superseded key was cleared and an auth-mode breaker of this provider was closed',
          );
        },
      ),
    );

  program
    .command('credentials:revoke')
    .description('revoke locally: clear both keys and block the environment fallback')
    .argument('<provider>', PROVIDERS.join(' | '))
    .requiredOption('--admin <email>', 'active administrator recorded as the author')
    .option('--expected-revision <revision>', 'optimistic check (default: the current revision)')
    .action(
      command(
        async (
          { db },
          providerArg: string,
          options: { admin: string; expectedRevision?: string },
        ) => {
          const provider = parseProvider(providerArg);
          const requested = parseRevision('--expected-revision', options.expectedRevision);
          const adminUserId = await resolveAdminUserId(db, options.admin);
          const expectedRevision = requested ?? (await currentRow(db, provider))?.revision ?? '0';
          const revoked = await setProviderCredentialEnabled(db, {
            provider,
            expectedRevision,
            enabled: false,
            adminUserId,
          });
          print([
            `revoked ${provider} locally (revision ${revoked.revision}): both stored keys are cleared, ` +
              'no new calls are admitted and the environment fallback is blocked',
            "the provider-side key is NOT revoked: revoke it in the provider's dashboard as well",
          ]);
        },
      ),
    );

  program
    .command('credentials:rewrap')
    .description('master-key rotation: rewrap stored keys under PROVIDER_MASTER_KEY_ID')
    .argument('[provider]', PROVIDERS.join(' | '))
    .action(
      command(async ({ db, config }, providerArg: string | undefined) => {
        const providers = providerArg === undefined ? [...PROVIDERS] : [parseProvider(providerArg)];
        const keyring = keyringOf(config);
        const lines: string[] = [];
        for (const provider of providers) {
          let rewrapped = 0;
          let current = 0;
          let raced = 0;
          for (const stored of await readStoredEnvelopes(db, provider)) {
            const keyId = (stored.envelope as { key_id?: unknown } | null)?.key_id;
            if (keyId === keyring.activeKeyId) {
              current += 1;
              continue;
            }
            const envelope = rewrapProviderSecret({
              keyring,
              provider,
              secretVersion: stored.version,
              envelope: stored.envelope,
            });
            const written = await rewrapProviderCredential(db, {
              provider,
              slot: stored.slot,
              version: stored.version,
              currentEnvelope: stored.envelope,
              envelope,
            });
            if (written) rewrapped += 1;
            else raced += 1;
          }
          lines.push(
            `${provider}: rewrapped ${rewrapped} key(s) to ${keyring.activeKeyId}, ${current} already current` +
              (raced > 0 ? `, ${raced} changed concurrently (run again)` : ''),
          );
        }
        print(lines);
      }),
    );
}
