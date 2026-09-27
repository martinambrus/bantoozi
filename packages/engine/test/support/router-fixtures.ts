import { AppError, systemClock, type EngineName } from '@bantoozi/shared';
import type { CredentialResolver, ProviderAuth } from '@bantoozi/shared/server';

import { createMemoryCircuitStore, type BreakerParams } from '../../src/breaker.js';
import { llmCostUsd } from '../../src/llm-fallback-engine.js';
import { createEngineRouter } from '../../src/router.js';
import type {
  Answer,
  DecisionEngine,
  EngineAttempt,
  EngineConfig,
  EngineLogger,
  EngineRequest,
  EngineRouter,
  Question,
} from '../../src/types.js';
import { typesafeCostUsd } from '../../src/typesafe-engine.js';
import { createMemoryEngineStore, type MemoryEngineStore } from './memory-store.js';

/** Fixtures of the router tests: scripted engines, a fake resolver, a capturing logger. */

export const USER_ID = '0199a000-0000-7000-8000-000000000001';
export const TYPESAFE_MODEL = 'jev-test-1.0.0';
export const LLM_MODEL = 'glm-5.3-flash';

export const baseConfig = (patch: Partial<EngineConfig> = {}): EngineConfig => ({
  typesafe: { baseUrl: 'http://127.0.0.1:9', model: TYPESAFE_MODEL, pricePerMTokUsd: 0.042 },
  ollama: {
    baseUrl: 'http://127.0.0.1:9',
    modelFast: LLM_MODEL,
    modelStrong: 'glm-5.3',
    maxConcurrency: 1,
  },
  concurrency: 8,
  dailyBudgetUsd: 2,
  llmFallbackEnabled: false,
  production: false,
  ...patch,
});

export const QUESTIONS: Record<string, Question> = {
  q1: { type: 'noul', instructions: 'Is the article about energy?' },
  q2: { type: 'choice', instructions: 'Topic', criteria: { energy: 'Energy', sports: 'Sports' } },
  q3: { type: 'score', instructions: 'Depth', criteria: ['shallow', 'medium', 'deep'] },
};

export function request(patch: Partial<EngineRequest> = {}): EngineRequest {
  return {
    kind: 'enrich',
    state: { article: { title: 'Solar power grows', excerpt: 'Panels everywhere.' } },
    questions: QUESTIONS,
    questionSetSha: 'a'.repeat(64),
    stateSha256: 'b'.repeat(64),
    articleId: '11',
    articleRevision: '3',
    priority: 'interactive',
    authorization: {
      type: 'article',
      articleId: '11',
      articleRevision: '3',
      witnesses: [{ kind: 'automatic', userId: USER_ID, feedId: '5', inferenceVersion: '1' }],
    },
    ...patch,
  };
}

/** Valid (uniform) answers for any question set. */
export function answersFor(questions: Record<string, Question>): Record<string, Answer> {
  return Object.fromEntries(
    Object.entries(questions).map(([key, q]): [string, Answer] => {
      if (q.type === 'noul') return [key, { type: 'noul', p: 0.5 }];
      if (q.type === 'choice') {
        const options = Object.keys(q.criteria);
        return [
          key,
          {
            type: 'choice',
            choice: options[0] ?? '',
            probabilities: Object.fromEntries(options.map((o) => [o, 1 / options.length])),
            confidence: 0,
          },
        ];
      }
      const levels = q.criteria.length;
      return [
        key,
        {
          type: 'score',
          score: (levels - 1) / 2,
          probabilities: Array.from({ length: levels }, () => 1 / levels),
          confidence: 0,
          levels,
        },
      ];
    }),
  );
}

export const USAGE = { inputTokens: 100, outputTokens: 10 };

export function success(engine: EngineName, req: EngineRequest): EngineAttempt {
  return {
    ok: true,
    engine,
    model: engine === 'llm' ? LLM_MODEL : TYPESAFE_MODEL,
    answers: answersFor(req.questions),
    usage: USAGE,
    costUsd: engine === 'llm' ? llmCostUsd(USAGE, LLM_MODEL) : typesafeCostUsd(100, 0.042),
    latencyMs: 5,
  };
}

/** A failed attempt with the router-relevant fields of spec 04 §3's status table. */
export function failure(
  status: Exclude<Extract<EngineAttempt, { ok: false }>['status'], never>,
  patch: Partial<Extract<EngineAttempt, { ok: false }>> = {},
): EngineAttempt {
  const transient = ['error', 'timeout', 'rate_limited', 'invalid_response'].includes(status);
  return {
    ok: false,
    status,
    retryable: transient,
    detail: `test_${status}`,
    billing: 'known',
    ...patch,
  };
}

export type Step =
  | 'ok'
  | EngineAttempt
  | ((
      req: EngineRequest,
      auth: ProviderAuth | undefined,
      signal: AbortSignal,
    ) => Promise<EngineAttempt> | EngineAttempt);

export interface ScriptedEngine extends DecisionEngine {
  calls: Array<{ req: EngineRequest; auth: ProviderAuth | undefined; at: number }>;
  script: Step[];
  /** The step used once the script is exhausted. */
  otherwise: Step;
}

/** An engine that answers from a script (one step per wire attempt). */
export function scriptedEngine(
  name: EngineName,
  script: Step[] = [],
  otherwise: Step = 'ok',
): ScriptedEngine {
  const engine: ScriptedEngine = {
    name,
    calls: [],
    script: [...script],
    otherwise,
    async ask(req, signal, auth) {
      engine.calls.push({ req, auth, at: Date.now() });
      const step = engine.script.shift() ?? engine.otherwise;
      if (step === 'ok') return success(name, req);
      if (typeof step === 'function') return step(req, auth, signal);
      return step;
    },
  };
  return engine;
}

type CredentialMetadata = Awaited<ReturnType<CredentialResolver['metadata']>>;

export interface FakeCredentials extends CredentialResolver {
  keys: Partial<Record<'typesafe' | 'ollama', ProviderAuth>>;
  /** A stale cached view that `metadata` returns instead of the keys, except for a fresh read. */
  cached: Partial<Record<'typesafe' | 'ollama', CredentialMetadata>>;
  used: string[];
}

/** A resolver over fixed keys; a missing key is a typed unavailable credential. */
export function fakeCredentials(
  keys: Partial<Record<'typesafe' | 'ollama', ProviderAuth>> = {},
): FakeCredentials {
  const resolver: FakeCredentials = {
    keys: { ...keys },
    cached: {},
    used: [],
    async metadata(provider, options) {
      const cached = resolver.cached[provider];
      if (cached !== undefined && options?.fresh !== true) return { ...cached };
      const auth = resolver.keys[provider];
      if (auth === undefined) return { source: 'none', enabled: false };
      return {
        source: auth.source,
        enabled: true,
        ...(auth.credentialVersion === undefined
          ? {}
          : { activeVersion: auth.credentialVersion, revision: auth.credentialVersion }),
      };
    },
    async useActive(provider, _signal, send) {
      const auth = resolver.keys[provider];
      if (auth === undefined) {
        throw new AppError('ENGINE_UNAVAILABLE', 'Provider credential unavailable', {
          details: { provider, reason: 'none' },
        });
      }
      resolver.used.push(provider);
      return send({ ...auth });
    },
    async useCandidate() {
      throw new Error('not used by the router');
    },
  };
  return resolver;
}

export interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  obj: object;
  msg: string;
}

export function captureLogger(): EngineLogger & { entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  return {
    entries,
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
  };
}

export const JEV_KEY: ProviderAuth = {
  apiKey: 'jev-test-key',
  source: 'db',
  credentialVersion: '7',
};
export const OLLAMA_KEY: ProviderAuth = { apiKey: 'ollama-test-key', source: 'env' };

export interface SetupOptions {
  config?: Partial<EngineConfig>;
  typesafe?: ScriptedEngine | null;
  llm?: ScriptedEngine | null;
  laya?: ScriptedEngine;
  credentials?: FakeCredentials;
  store?: MemoryEngineStore;
  circuit?: ReturnType<typeof createMemoryCircuitStore>;
  budgetOverrideUsd?: number;
  ignoreDailyCaps?: boolean;
  requiredEngine?: EngineName;
  random?: () => number;
  breakerParams?: Partial<BreakerParams>;
}

export interface Setup {
  router: EngineRouter;
  store: MemoryEngineStore;
  circuit: ReturnType<typeof createMemoryCircuitStore>;
  logger: ReturnType<typeof captureLogger>;
  credentials: FakeCredentials;
  typesafe: ScriptedEngine | undefined;
  llm: ScriptedEngine | undefined;
}

/** A router over scripted engines (null: not injected), the memory store and a memory circuit. */
export function setup(options: SetupOptions = {}): Setup {
  const config = baseConfig(options.config);
  const store = options.store ?? createMemoryEngineStore({ dailyBudgetUsd: config.dailyBudgetUsd });
  const circuit = options.circuit ?? createMemoryCircuitStore();
  const logger = captureLogger();
  const credentials =
    options.credentials ?? fakeCredentials({ typesafe: JEV_KEY, ollama: OLLAMA_KEY });
  const typesafe =
    options.typesafe === null ? undefined : (options.typesafe ?? scriptedEngine('typesafe'));
  const llm = options.llm === null ? undefined : (options.llm ?? scriptedEngine('llm'));
  const engines: Partial<Record<EngineName, DecisionEngine>> = {
    ...(typesafe === undefined ? {} : { typesafe }),
    ...(llm === undefined ? {} : { llm }),
    ...(options.laya === undefined ? {} : { laya: options.laya }),
  };
  const router = createEngineRouter({
    config,
    store,
    logger,
    clock: systemClock,
    credentials,
    engines,
    circuit,
    random: options.random ?? (() => 0.5),
    ...(options.budgetOverrideUsd === undefined
      ? {}
      : { budgetOverrideUsd: options.budgetOverrideUsd }),
    ...(options.ignoreDailyCaps === undefined ? {} : { ignoreDailyCaps: options.ignoreDailyCaps }),
    ...(options.requiredEngine === undefined ? {} : { requiredEngine: options.requiredEngine }),
    ...(options.breakerParams === undefined ? {} : { breakerParams: options.breakerParams }),
  });
  return { router, store, circuit, logger, credentials, typesafe, llm };
}

/** Run `promise` while advancing fake timers until it settles. */
export async function drive<T>(
  promise: Promise<T>,
  advance: (ms: number) => Promise<unknown>,
  stepMs = 50,
  maxSteps = 100_000,
): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < maxSteps && !settled; i += 1) await advance(stepMs);
  return promise;
}
