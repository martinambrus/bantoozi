import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  activeAdminExists,
  anyActiveAdminId,
  bindTenant,
  closeOpenSetup,
  createSession,
  deleteWaitlistEntry,
  findUserByEmail,
  insertSignupUser,
  lockAuthEmail,
  lockSetup,
  lockSetupState,
  promoteActiveUserToAdmin,
  recordVerifiedLogin,
  replaceSetupState,
} from '@bantoozi/db';
import { newUserId, parseSetting, type Me } from '@bantoozi/shared';
import type { FastifyBaseLogger } from 'fastify';

import type { ApiServices } from '../context.js';
import { newSessionToken } from '../plugins/auth.js';
import { loadMe } from './me.js';

/**
 * First-run setup (M8b-T6, spec 08 §2.1): while no active admin exists, each API start generates a
 * 256-bit token, stores only `HMAC-SHA256(SESSION_PEPPER, token)` and its creation time in
 * `settings['auth.setup']` and prints the token once. `POST /setup/complete` redeems it.
 */

const SETUP_KEY = 'auth.setup';

/** Keyed digest of a setup token (hex). */
export function setupTokenDigest(pepper: string, token: string): string {
  return createHmac('sha256', pepper)
    .update(`bantoozi:setup-token:v1:${token}`, 'utf8')
    .digest('hex');
}

function digestsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** Whether setup is open: no active admin exists. */
export async function setupOpen(services: Pick<ApiServices, 'db'>): Promise<boolean> {
  return !(await activeAdminExists(services.db));
}

/**
 * Per-process token state. `ready` is false until this process has either persisted its own new
 * digest or found an active admin; while false, no token is redeemable (a digest left by the
 * previous process must not work), and the rotation is retried by `ensureSetupToken`.
 */
export interface SetupRuntime {
  ready: boolean;
  inflight: Promise<void> | null;
  generateToken: () => string;
}

export function createSetupRuntime(generateToken?: () => string): SetupRuntime {
  return {
    ready: false,
    inflight: null,
    generateToken: generateToken ?? (() => randomBytes(32).toString('base64url')),
  };
}

async function rotateSetupToken(
  services: Pick<ApiServices, 'db' | 'config' | 'clock' | 'setup'>,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const { db, config, clock, setup } = services;
    const token = await db.transaction(async (tx) => {
      await lockSetup(tx);
      const adminId = await anyActiveAdminId(tx);
      if (adminId !== null) {
        // Setup is closed for good: a token logged earlier must not revive if the admin goes away.
        await closeOpenSetup(tx, adminId);
        return null;
      }
      const fresh = setup.generateToken();
      await replaceSetupState(
        tx,
        parseSetting(SETUP_KEY, {
          digest: setupTokenDigest(config.sessionPepper, fresh),
          createdAt: clock.now().toISOString(),
        }),
      );
      return fresh;
    });
    // Committed: only now may this process redeem tokens (the one logged below, or none).
    setup.ready = true;
    if (token === null) return;
    const message = `First-run setup is open. Setup token (shown once, valid until the next start): ${token}`;
    const probe = (log as { isLevelEnabled?: (level: string) => boolean }).isLevelEnabled;
    if (typeof probe === 'function' && probe.call(log, 'warn')) log.warn(message);
    else process.stderr.write(`${message}\n`);
  } catch (error) {
    log.error({ err: error }, 'could not prepare the first-run setup token');
  }
}

/**
 * Rotates the token and prints it once (warn log, or stderr when the level hides warn) unless this
 * process is already ready. Concurrent callers share one attempt. Never throws: on failure the
 * process stays not ready (setup refuses every token) and the next call retries.
 */
export function ensureSetupToken(
  services: Pick<ApiServices, 'db' | 'config' | 'clock' | 'setup'>,
  log: FastifyBaseLogger,
): Promise<void> {
  const { setup } = services;
  if (setup.ready) return Promise.resolve();
  setup.inflight ??= rotateSetupToken(services, log).finally(() => {
    setup.inflight = null;
  });
  return setup.inflight;
}

/** Called when the server is ready (never throws, so the offline OpenAPI build is unaffected). */
export const initSetupToken = ensureSetupToken;

export interface CompleteSetupInput {
  token: string;
  /** Normalized. */
  email: string;
  locale: 'en' | 'sk';
  userAgent: string | null;
  ip: string | null;
}

export type CompleteSetupResult =
  { ok: true; me: Me; token: string; expiresAt: Date } | { ok: false };

/**
 * One transaction under the setup advisory lock: recheck that no admin exists, compare the token
 * digest in constant time, create or promote the admin, close setup and create the session. Every
 * refusal returns `{ok: false}` (the caller answers one generic error).
 */
export async function completeSetup(
  services: Pick<ApiServices, 'db' | 'config' | 'clock' | 'setup'>,
  input: CompleteSetupInput,
): Promise<CompleteSetupResult> {
  const { db, config, clock } = services;
  const fail = { ok: false } as const;
  // Fail closed until this process has persisted its own digest (the stored one may be older).
  if (!services.setup.ready) return fail;
  return db.transaction(async (tx): Promise<CompleteSetupResult> => {
    await lockSetup(tx);
    if (await activeAdminExists(tx)) return fail;
    const stored = await lockSetupState(tx);
    if (stored === undefined) return fail;
    const state = parseSetting(SETUP_KEY, stored);
    const expected = state.consumedAt === undefined ? state.digest : undefined;
    const given = setupTokenDigest(config.sessionPepper, input.token);
    const matches = digestsMatch(given, expected ?? '00');
    if (expected === undefined || !matches) return fail;

    await lockAuthEmail(tx, input.email);
    let userId: string;
    const existing = await findUserByEmail(tx, input.email);
    if (existing !== null) {
      if (existing.deletedAt !== null) return fail;
      const promoted = await promoteActiveUserToAdmin(tx, { email: input.email });
      if (promoted === null) return fail;
      userId = promoted;
    } else {
      userId = newUserId();
      const inserted = await insertSignupUser(tx, {
        id: userId,
        email: input.email,
        locale: input.locale,
        role: 'admin',
      });
      if (!inserted) throw new Error('setup user already exists');
    }
    await deleteWaitlistEntry(tx, input.email);
    await recordVerifiedLogin(tx, { userId, admin: true });
    await replaceSetupState(
      tx,
      parseSetting(SETUP_KEY, {
        createdAt: state.createdAt,
        consumedAt: clock.now().toISOString(),
        userId,
      }),
    );
    const tenant = await bindTenant(tx, userId);
    const { token, tokenHash } = newSessionToken();
    const session = await createSession(tx, {
      userId,
      tokenHash,
      userAgent: input.userAgent,
      ip: input.ip,
      ttlDays: config.sessionTtlDays,
    });
    const me = await loadMe(tenant);
    return { ok: true, me, token, expiresAt: session.expiresAt };
  });
}
