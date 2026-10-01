import {
  addRaterCard,
  assignmentAt,
  assignmentProgress,
  createRaterSession,
  deleteRaterSession,
  DISLIKE_REASONS,
  facetLabelsOf,
  findRaterByToken,
  headDataset,
  labelledArticleIds,
  listGoldenFeeds,
  listRaterCards,
  listRaterFeedIds,
  listRaters,
  loadSampleArticle,
  lockRater,
  nextPendingPosition,
  ownerParticipantKey,
  rateAssignment,
  raterForSession,
  removeRaterCard,
  sampleArticleLangs,
  saveFacetLabels,
  setRaterFeeds,
  skipAssignment,
  SKIP_REASON_MAX,
  type AssignmentCandidate,
  type Database,
  type RaterRow,
} from '@bantoozi/db';
import { CARD_LIMITS } from '@bantoozi/shared';
import { detectLanguage } from '@bantoozi/shared/server';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  ASSIGNMENTS_PER_RATER,
  ensureAssignments,
  NoDatasetError,
  NotReadyError,
} from './assignments.js';
import { FACET_KEYS, FacetFormSchema, facetSeed, selectFacetSet, selectOverlap } from './facets.js';
import { clip, safeExternalUrl } from './html.js';
import {
  cardsPage,
  donePage,
  facetPage,
  facetsDonePage,
  feedsPage,
  messagePage,
  ratePage,
  startPage,
  type ArticleView,
  type CardFormValues,
} from './pages.js';
import { APP_CSS, APP_JS } from './static-assets.js';
import {
  cardLimitError,
  cardsReady,
  countCards,
  feedsReady,
  MIN_FEEDS,
  MIN_INTEREST_CARDS,
  readyToRate,
  setupLocked,
  type StepState,
} from './steps.js';
import {
  csrfMatches,
  csrfToken,
  hashSecret,
  isTokenShaped,
  newSecret,
  sessionExpiry,
} from './tokens.js';

/**
 * The rating and facet-labelling server (spec 10 §2.2–§2.4): Fastify bound to loopback by the
 * `serve-rating` command, reached by raters through an authenticated HTTPS tunnel.
 *
 * Security model:
 * - `GET /r?t=<token>` (or `/facets?t=`) exchanges an unexpired, unrevoked link token for a random
 *   session cookie (HttpOnly, SameSite=Lax, Secure when `EVAL_PUBLIC_URL` is https) and redirects
 *   to the token-free URL. Exchange is rate-limited per client address: the one the loopback
 *   tunnel reports in `X-Forwarded-For`, else the socket's. Only hashes are stored.
 * - Every request re-reads the session and rechecks its expiry and the token's expiry and
 *   revocation, so `eval rater revoke` / `eval rater token` end sessions at once.
 * - Every read and write is scoped to the session's rater (its assignments, cards, feeds) or, for
 *   facet labels, to its participant.
 * - POSTs need the session's CSRF token and a same-origin `Origin` (when the browser sends one).
 * - Every response carries a strict CSP (scripts and styles from `/static/` only, no inline code),
 *   `Referrer-Policy: no-referrer` and `frame-ancestors 'none'`; token-bearing URLs are redacted
 *   in logs.
 */

export const DEFAULT_RATING_PORT = 5180;
export const RATING_HOST = '127.0.0.1';
export const SESSION_COOKIE = 'bz_eval_session';
/** Excerpts are cut to this many characters (spec 10 §2.2). */
export const EXCERPT_MAX = 600;

export interface RatingLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface RatingServerOptions {
  /** Worker-role database (spec 10 §2.4: `DATABASE_URL_WORKER`). */
  db: Database;
  /** `EVAL_PUBLIC_URL`: its origin is accepted for POSTs; https turns on `Secure` cookies. */
  publicUrl: string;
  now?: () => Date;
  logger?: RatingLogger;
  /** Assignments per rater (spec 10 §2.2: 300). */
  assignmentTarget?: number;
  /** Token exchanges per client address and window (default 20 per 10 minutes). */
  exchangeLimit?: { max: number; windowMs: number };
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** The request path with any `t=` token value replaced, for logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]t=)[^&#]*/gu, '$1[redacted]');
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '' && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

type FormBody = Record<string, string | string[]>;

function parseForm(body: string): FormBody {
  const out: FormBody = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const PositionSchema = z.coerce.number().int().min(0).max(1_000_000);
const IdParamSchema = z.string().regex(/^[1-9][0-9]{0,18}$/u);

const lines = (text: string | undefined): string[] =>
  (text ?? '')
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== '');

const CardFormSchema = z.object({
  title: z
    .string()
    .max(CARD_LIMITS.titleMax * 2)
    .optional(),
  interest: z.string().max(CARD_LIMITS.interestMax * 2),
  notFor: z
    .string()
    .max(CARD_LIMITS.notForMax * 2)
    .optional(),
  strength: z.enum(['must', 'love', 'like', 'never']),
  examplesYes: z.string().max(5000).optional(),
  examplesNo: z.string().max(5000).optional(),
  lang: z
    .string()
    .regex(/^(?:auto|[a-z]{2})$/u)
    .optional(),
});

const RateFormSchema = z.object({
  rating: z.enum(['like', 'dislike']),
  reason: z.enum(DISLIKE_REASONS).optional(),
});

/** The optional skip note: trimmed, blank → none, at most 500 characters (code points). */
const SkipFormSchema = z.object({
  skipReason: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()))
    .refine((v) => v === null || [...v].length <= SKIP_REASON_MAX),
});

interface Session {
  rater: RaterRow;
  value: string;
  csrf: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    message: string,
  ) {
    super(message);
  }
}

/** Builds the app (never listens; the command and the tests decide). */
export async function buildRatingServer(options: RatingServerOptions): Promise<FastifyInstance> {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const target = options.assignmentTarget ?? ASSIGNMENTS_PER_RATER;
  const exchangeLimit = options.exchangeLimit ?? { max: 20, windowMs: 10 * 60_000 };
  const publicOrigin = new URL(options.publicUrl).origin;
  const secureCookie = publicOrigin.startsWith('https:');
  const attempts = new Map<string, { count: number; windowStart: number }>();

  // Every client arrives through the loopback tunnel, so trust only that hop: `req.ip` is the
  // address the tunnel appended to `X-Forwarded-For` (entries a client sends sit to its left).
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: 'loopback' });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, parseForm(typeof body === 'string' ? body : body.toString('utf8')));
    },
  );

  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (reply.getHeader('cache-control') === undefined) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    options.logger?.info(
      {
        method: req.method,
        url: redactUrl(req.url),
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'rating request',
    );
  });
  app.setErrorHandler(async (error, req, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.status)
        .type('text/html; charset=utf-8')
        .send(messagePage(error.title, error.message));
    }
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      options.logger?.error(
        { err: error instanceof Error ? error.message : String(error), url: redactUrl(req.url) },
        'rating server error',
      );
    }
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(
        messagePage(
          status >= 500 ? 'Something went wrong' : 'Bad request',
          status >= 500 ? 'Please try again in a moment.' : 'The request could not be processed.',
        ),
      );
  });
  app.setNotFoundHandler(async (_req, reply) =>
    reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(messagePage('Not found', 'There is no such page.')),
  );

  const sendPage = (reply: FastifyReply, body: string, status = 200) =>
    reply.code(status).type('text/html; charset=utf-8').send(body);

  // ── Sessions ────────────────────────────────────────────────────────────────────────────────────

  const cookieHeader = (value: string, maxAgeS: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, maxAgeS)}${
      secureCookie ? '; Secure' : ''
    }`;

  async function session(req: FastifyRequest, reply: FastifyReply): Promise<Session> {
    const value = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (value !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(value)) {
      const rater = await raterForSession(db, hashSecret(value), now());
      if (rater !== null) return { rater, value, csrf: csrfToken(value) };
    }
    if (value !== undefined) reply.header('set-cookie', cookieHeader('', 0));
    throw new HttpError(
      401,
      'Link expired',
      'This rating link has expired or was revoked, or you have not opened your private link ' +
        'yet. Open the link you were given, or ask for a new one.',
    );
  }

  function checkMutation(req: FastifyRequest, s: Session): FormBody {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') {
      throw new HttpError(403, 'Forbidden', 'Cross-site requests are not accepted.');
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const host = req.headers.host;
      const allowed = new Set([publicOrigin]);
      if (host !== undefined) {
        allowed.add(`http://${host}`);
        allowed.add(`https://${host}`);
      }
      if (!allowed.has(origin)) {
        throw new HttpError(403, 'Forbidden', 'Cross-origin requests are not accepted.');
      }
    }
    const body = (req.body ?? {}) as FormBody;
    if (typeof body !== 'object' || !csrfMatches(s.value, single(body['_csrf']))) {
      throw new HttpError(403, 'Forbidden', 'The form expired. Go back, reload and try again.');
    }
    return body;
  }

  function allowExchange(req: FastifyRequest): boolean {
    const key = req.ip;
    const t = now().getTime();
    const entry = attempts.get(key);
    if (entry === undefined || t - entry.windowStart >= exchangeLimit.windowMs) {
      attempts.set(key, { count: 1, windowStart: t });
      return true;
    }
    entry.count += 1;
    return entry.count <= exchangeLimit.max;
  }

  /** `?t=` exchange: a valid token becomes a session cookie; the redirect drops the token. */
  async function exchange(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    destination: string,
  ): Promise<FastifyReply> {
    if (!allowExchange(req)) {
      throw new HttpError(429, 'Too many attempts', 'Too many link attempts. Wait a few minutes.');
    }
    const at = now();
    const tokenHash = isTokenShaped(token) ? hashSecret(token) : null;
    const rater = tokenHash === null ? null : await findRaterByToken(db, tokenHash, at);
    const expired = () =>
      new HttpError(
        401,
        'Link expired',
        'This rating link is not valid: it has expired or was revoked. Ask for a new one.',
      );
    if (rater === null || tokenHash === null) throw expired();
    const previous = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (previous !== undefined) await deleteRaterSession(db, hashSecret(previous));
    const value = newSecret();
    const expiresAt = await createRaterSession(db, {
      sessionHash: hashSecret(value),
      raterId: rater.id,
      tokenHash,
      expiresAt: sessionExpiry(at),
      now: at,
    });
    // A reissue or revocation between the lookup above and the insert: no session.
    if (expiresAt === null) throw expired();
    reply.header('set-cookie', cookieHeader(value, (expiresAt.getTime() - at.getTime()) / 1000));
    return reply.redirect(destination, 303);
  }

  // ── Shared loaders ──────────────────────────────────────────────────────────────────────────────

  async function stepState(raterId: string): Promise<StepState & { cards: number }> {
    const [cards, feeds, progress] = await Promise.all([
      listRaterCards(db, raterId),
      listRaterFeedIds(db, raterId),
      assignmentProgress(db, raterId),
    ]);
    const counts = countCards(cards);
    return { ...counts, cards: cards.length, feeds: feeds.length, assignments: progress.total };
  }

  async function articleView(
    articleId: string,
    preferredFeeds: ReadonlySet<string>,
  ): Promise<ArticleView> {
    const head = await headDataset(db);
    const row = await loadSampleArticle(db, articleId, head?.version ?? null);
    if (row === undefined) {
      throw new HttpError(404, 'Not found', 'This article is not in the golden sample.');
    }
    const snapshot = row.snapshot as {
      url?: unknown;
      input?: { title?: unknown; excerpt?: unknown; feed?: { title?: unknown } };
      carrierFeeds?: Array<{ feedId?: unknown; title?: unknown }>;
      publishedAt?: unknown;
      firstSeenAt?: unknown;
    };
    const carrier = (snapshot.carrierFeeds ?? []).find(
      (c) => typeof c.feedId === 'string' && preferredFeeds.has(c.feedId),
    );
    const feedTitle =
      typeof carrier?.title === 'string'
        ? carrier.title
        : typeof snapshot.input?.feed?.title === 'string'
          ? snapshot.input.feed.title
          : null;
    const excerpt = typeof snapshot.input?.excerpt === 'string' ? snapshot.input.excerpt : null;
    const date =
      typeof snapshot.publishedAt === 'string'
        ? snapshot.publishedAt
        : typeof snapshot.firstSeenAt === 'string'
          ? snapshot.firstSeenAt
          : null;
    return {
      feedTitle,
      title: typeof snapshot.input?.title === 'string' ? snapshot.input.title : '(untitled)',
      excerpt: excerpt === null || excerpt.trim() === '' ? null : clip(excerpt, EXCERPT_MAX),
      url: safeExternalUrl(typeof snapshot.url === 'string' ? snapshot.url : null),
      date: date === null ? null : date.slice(0, 10),
    };
  }

  /** Rating routes require completed cards and feeds (spec 10 §2.2: interests first). */
  async function requireReady(raterId: string): Promise<StepState> {
    const state = await stepState(raterId);
    if (!cardsReady(state)) {
      throw new HttpError(
        409,
        'Interests first',
        `Write at least ${MIN_INTEREST_CARDS} interest cards before rating.`,
      );
    }
    if (!feedsReady(state)) {
      throw new HttpError(409, 'Feeds first', `Pick at least ${MIN_FEEDS} feeds before rating.`);
    }
    return state;
  }

  // ── Static assets ───────────────────────────────────────────────────────────────────────────────

  app.get('/static/app.css', async (_req, reply) =>
    reply.type('text/css; charset=utf-8').header('cache-control', 'no-cache').send(APP_CSS),
  );
  app.get('/static/app.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(APP_JS),
  );
  app.get('/', async (_req, reply) => reply.redirect('/r', 303));

  // ── Rating flow ─────────────────────────────────────────────────────────────────────────────────

  app.get('/r', async (req, reply) => {
    const token = single((req.query as Record<string, string | string[]>)['t']);
    if (token !== undefined) return exchange(req, reply, token, '/r');
    const s = await session(req, reply);
    const state = await stepState(s.rater.id);
    if (state.assignments === 0) {
      if (!cardsReady(state)) return reply.redirect('/r/cards', 303);
      if (!feedsReady(state)) return reply.redirect('/r/feeds', 303);
      return sendPage(reply, startPage({ state, csrf: s.csrf }));
    }
    const next = await nextPendingPosition(db, s.rater.id, -1);
    if (next !== null) return reply.redirect(`/r/a/${next}`, 303);
    const progress = await assignmentProgress(db, s.rater.id);
    return sendPage(
      reply,
      donePage({ state, progress, canLoadMore: progress.total < target, csrf: s.csrf }),
    );
  });

  app.get('/r/cards', async (req, reply) => {
    const s = await session(req, reply);
    const [cards, state] = await Promise.all([
      listRaterCards(db, s.rater.id),
      stepState(s.rater.id),
    ]);
    return sendPage(
      reply,
      cardsPage({
        raterName: s.rater.contextName ?? s.rater.name,
        langs: s.rater.langs,
        cards,
        state,
        locked: setupLocked(state),
        csrf: s.csrf,
      }),
    );
  });

  app.post('/r/cards', async (req, reply) => {
    const s = await session(req, reply);
    const body = checkMutation(req, s);
    const raw = {
      title: single(body['title']),
      interest: single(body['interest']) ?? '',
      notFor: single(body['notFor']),
      strength: single(body['strength']) ?? 'like',
      examplesYes: single(body['examplesYes']),
      examplesNo: single(body['examplesNo']),
      lang: single(body['lang']),
    };
    const rerender = async (error: string, status = 400) => {
      const [cards, state] = await Promise.all([
        listRaterCards(db, s.rater.id),
        stepState(s.rater.id),
      ]);
      const values: CardFormValues = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined) values[key as keyof CardFormValues] = value;
      }
      return sendPage(
        reply,
        cardsPage({
          raterName: s.rater.contextName ?? s.rater.name,
          langs: s.rater.langs,
          cards,
          state,
          locked: setupLocked(state),
          csrf: s.csrf,
          error,
          values,
        }),
        status,
      );
    };
    const parsed = CardFormSchema.safeParse(raw);
    if (!parsed.success) return rerender('Please check the card fields.');
    const form = parsed.data;
    const examplesYes = lines(form.examplesYes);
    const examplesNo = lines(form.examplesNo);
    if (
      examplesYes.length > CARD_LIMITS.examplesPerSide ||
      examplesNo.length > CARD_LIMITS.examplesPerSide
    ) {
      return rerender(`At most ${CARD_LIMITS.examplesPerSide} examples per side.`);
    }
    const interest = form.interest.trim();
    const notFor = form.notFor?.trim() ?? '';
    const lang =
      form.lang === undefined || form.lang === 'auto'
        ? detectLanguage(`${interest} ${notFor}`, { hint: s.rater.langs[0], minLength: 10 }).lang
        : form.lang;
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockRater(tx, s.rater.id);
        const progress = await assignmentProgress(tx, s.rater.id);
        if (setupLocked({ assignments: progress.total })) return 'locked' as const;
        const limit = cardLimitError(
          countCards(await listRaterCards(tx, s.rater.id)),
          form.strength,
        );
        if (limit !== null) return limit;
        await addRaterCard(tx, s.rater.id, {
          title: form.title ?? null,
          interest,
          notFor: notFor === '' ? null : notFor,
          strength: form.strength,
          examplesYes,
          examplesNo,
          lang,
        });
        return null;
      });
      if (outcome === 'locked') {
        return rerender('Your cards are final now that rating has started.', 409);
      }
      if (outcome !== null) return rerender(outcome, 409);
    } catch (error) {
      const details = (error as { details?: { field?: unknown; reason?: unknown } }).details;
      if (details !== undefined) {
        return rerender(
          `Please check the ${String(details.field)} field (${String(details.reason)}).`,
        );
      }
      throw error;
    }
    return reply.redirect('/r/cards', 303);
  });

  app.post('/r/cards/:cardId/delete', async (req, reply) => {
    const s = await session(req, reply);
    checkMutation(req, s);
    const cardId = IdParamSchema.safeParse((req.params as { cardId: string }).cardId);
    if (!cardId.success) throw new HttpError(404, 'Not found', 'There is no such card.');
    // Same lock as card adds, feed changes and assignment building: the "no assignments yet"
    // check and the delete cannot interleave with a start.
    const removed = await db.transaction(async (tx) => {
      await lockRater(tx, s.rater.id);
      const progress = await assignmentProgress(tx, s.rater.id);
      if (setupLocked({ assignments: progress.total })) return 'locked' as const;
      return removeRaterCard(tx, s.rater.id, cardId.data);
    });
    if (removed === 'locked') {
      throw new HttpError(
        409,
        'Cards are final',
        'Your cards are final now that rating has started.',
      );
    }
    return reply.redirect('/r/cards', 303);
  });

  app.get('/r/feeds', async (req, reply) => {
    const s = await session(req, reply);
    const [feeds, selected, state] = await Promise.all([
      listGoldenFeeds(db),
      listRaterFeedIds(db, s.rater.id),
      stepState(s.rater.id),
    ]);
    return sendPage(
      reply,
      feedsPage({
        feeds,
        selected: new Set(selected),
        state,
        locked: setupLocked(state),
        csrf: s.csrf,
      }),
    );
  });

  app.post('/r/feeds', async (req, reply) => {
    const s = await session(req, reply);
    const body = checkMutation(req, s);
    const raw = body['feed'];
    const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
      (id) => IdParamSchema.safeParse(id).success,
    );
    const outcome = await db.transaction(async (tx) => {
      await lockRater(tx, s.rater.id);
      const progress = await assignmentProgress(tx, s.rater.id);
      if (setupLocked({ assignments: progress.total })) return 'locked' as const;
      return setRaterFeeds(tx, s.rater.id, ids);
    });
    if (outcome === 'locked') {
      throw new HttpError(
        409,
        'Feeds are final',
        'Your feeds are final now that rating has started.',
      );
    }
    if (outcome.length < MIN_FEEDS) {
      const [feeds, state] = await Promise.all([listGoldenFeeds(db), stepState(s.rater.id)]);
      return sendPage(
        reply,
        feedsPage({
          feeds,
          selected: new Set(outcome),
          state,
          locked: false,
          csrf: s.csrf,
          error: `Saved ${outcome.length}; pick at least ${MIN_FEEDS} feeds to continue.`,
        }),
        400,
      );
    }
    return reply.redirect('/r', 303);
  });

  app.post('/r/start', async (req, reply) => {
    const s = await session(req, reply);
    checkMutation(req, s);
    const state = await stepState(s.rater.id);
    if (!readyToRate(state)) {
      throw new HttpError(
        409,
        'Not ready',
        `Write ${MIN_INTEREST_CARDS}–10 interest cards and pick at least ${MIN_FEEDS} feeds first.`,
      );
    }
    try {
      await ensureAssignments(db, {
        raterId: s.rater.id,
        langs: s.rater.langs,
        now: now(),
        target,
        requireReady: true,
      });
    } catch (error) {
      if (error instanceof NoDatasetError) {
        throw new HttpError(503, 'Not ready yet', 'The article sample is not ready yet.');
      }
      if (error instanceof NotReadyError) {
        throw new HttpError(
          409,
          'Not ready',
          `Write ${MIN_INTEREST_CARDS}–10 interest cards and pick at least ${MIN_FEEDS} feeds first.`,
        );
      }
      throw error;
    }
    const progress = await assignmentProgress(db, s.rater.id);
    if (progress.total === 0) {
      return sendPage(
        reply,
        startPage({
          state,
          csrf: s.csrf,
          error: 'No articles are available for your feeds and languages yet.',
        }),
        409,
      );
    }
    return reply.redirect('/r', 303);
  });

  const positionOf = (req: FastifyRequest): number => {
    const parsed = PositionSchema.safeParse((req.params as { position: string }).position);
    if (!parsed.success) throw new HttpError(404, 'Not found', 'There is no such article.');
    return parsed.data;
  };

  app.get('/r/a/:position', async (req, reply) => {
    const s = await session(req, reply);
    await requireReady(s.rater.id);
    const position = positionOf(req);
    const assignment = await assignmentAt(db, s.rater.id, position);
    if (assignment === null) throw new HttpError(404, 'Not found', 'There is no such article.');
    const [progress, feeds] = await Promise.all([
      assignmentProgress(db, s.rater.id),
      listRaterFeedIds(db, s.rater.id),
    ]);
    const article = await articleView(assignment.articleId, new Set(feeds));
    const askReason = single((req.query as Record<string, string | string[]>)['why']) === '1';
    return sendPage(
      reply,
      ratePage({
        article,
        assignment,
        progress,
        lastPosition: progress.total - 1,
        csrf: s.csrf,
        askReason: askReason && assignment.rating === -1,
      }),
    );
  });

  /** After an action: the next pending article after this one, or `/r` (more, or done). */
  async function advance(reply: FastifyReply, raterId: string, position: number) {
    const next = await nextPendingPosition(db, raterId, position);
    return reply.redirect(next === null ? '/r' : `/r/a/${next}`, 303);
  }

  app.post('/r/a/:position/rate', async (req, reply) => {
    const s = await session(req, reply);
    const body = checkMutation(req, s);
    await requireReady(s.rater.id);
    const position = positionOf(req);
    const parsed = RateFormSchema.safeParse({
      rating: single(body['rating']),
      reason: single(body['reason']),
    });
    if (!parsed.success) throw new HttpError(400, 'Bad request', 'Unknown rating.');
    const rating = parsed.data.rating === 'like' ? 1 : -1;
    const reason = parsed.data.reason ?? null;
    const saved = await db.transaction((tx) =>
      rateAssignment(tx, { raterId: s.rater.id, position, rating, reason, now: now() }),
    );
    if (saved === null) throw new HttpError(404, 'Not found', 'There is no such article.');
    // A dislike without a reason opens the reason bar on the same article (spec 09 §3.3).
    if (rating === -1 && reason === null) return reply.redirect(`/r/a/${position}?why=1`, 303);
    return advance(reply, s.rater.id, position);
  });

  app.post('/r/a/:position/skip', async (req, reply) => {
    const s = await session(req, reply);
    const body = checkMutation(req, s);
    await requireReady(s.rater.id);
    const position = positionOf(req);
    const parsed = SkipFormSchema.safeParse({ skipReason: single(body['skipReason']) });
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Bad request',
        `A skip reason has at most ${SKIP_REASON_MAX} characters.`,
      );
    }
    const reason = parsed.data.skipReason;
    const saved = await db.transaction((tx) =>
      skipAssignment(tx, { raterId: s.rater.id, position, reason }),
    );
    if (saved === null) throw new HttpError(404, 'Not found', 'There is no such article.');
    return advance(reply, s.rater.id, position);
  });

  // ── Facet labels (spec 10 §2.3) ─────────────────────────────────────────────────────────────────

  /** The labeller's list: the owner gets the full set, anybody else the overlap subset. */
  async function facetList(
    rater: RaterRow,
  ): Promise<{ items: AssignmentCandidate[]; role: 'primary' | 'second'; labeler: string }> {
    const head = await headDataset(db);
    if (head === null) return { items: [], role: 'primary', labeler: rater.participantKey };
    const owner = ownerParticipantKey(await listRaters(db));
    const seed = facetSeed(head.seed);
    const candidates = await sampleArticleLangs(db, head.version);
    const primaryKey = owner ?? rater.participantKey;
    const primary = selectFacetSet({
      seed,
      candidates,
      keep: new Set(await labelledArticleIds(db, primaryKey)),
    });
    if (rater.participantKey === primaryKey) {
      return { items: primary, role: 'primary', labeler: rater.participantKey };
    }
    const items = selectOverlap({
      seed,
      primary,
      keep: new Set(await labelledArticleIds(db, rater.participantKey)),
    });
    return { items, role: 'second', labeler: rater.participantKey };
  }

  app.get('/facets', async (req, reply) => {
    const token = single((req.query as Record<string, string | string[]>)['t']);
    if (token !== undefined) return exchange(req, reply, token, '/facets');
    const s = await session(req, reply);
    const list = await facetList(s.rater);
    const done = new Set(await labelledArticleIds(db, list.labeler));
    const next = list.items.findIndex((item) => !done.has(item.articleId));
    if (next >= 0) return reply.redirect(`/facets/${next}`, 303);
    return sendPage(
      reply,
      facetsDonePage({
        total: list.items.length,
        labelled: list.items.filter((i) => done.has(i.articleId)).length,
      }),
    );
  });

  async function renderFacet(
    reply: FastifyReply,
    s: Session,
    index: number,
    error: string | null,
    status = 200,
    submitted?: Record<string, string>,
  ) {
    const list = await facetList(s.rater);
    const item = list.items[index];
    if (item === undefined) throw new HttpError(404, 'Not found', 'There is no such article.');
    const done = new Set(await labelledArticleIds(db, list.labeler));
    const values = submitted ?? (await facetLabelsOf(db, list.labeler, item.articleId));
    return sendPage(
      reply,
      facetPage({
        article: await articleView(item.articleId, new Set()),
        articleId: item.articleId,
        index,
        total: list.items.length,
        labelled: list.items.filter((i) => done.has(i.articleId)).length,
        role: list.role,
        values,
        csrf: s.csrf,
        error,
      }),
      status,
    );
  }

  app.get('/facets/:position', async (req, reply) => {
    const s = await session(req, reply);
    return renderFacet(reply, s, positionOf(req), null);
  });

  app.post('/facets/:position', async (req, reply) => {
    const s = await session(req, reply);
    const body = checkMutation(req, s);
    const index = positionOf(req);
    const raw: Record<string, string> = {};
    for (const key of FACET_KEYS) {
      const value = single(body[key]);
      if (value !== undefined) raw[key] = value;
    }
    // The form names the article it showed. The labeller's set is recomputed from the head dataset,
    // so a top-up or a new head version can shift positions while the form is open: save only when
    // the displayed article is still the one at this position of this labeller's set.
    const shown = IdParamSchema.safeParse(single(body['articleId']));
    if (!shown.success) throw new HttpError(400, 'Bad request', 'The form names no article.');
    const list = await facetList(s.rater);
    if (list.items[index]?.articleId !== shown.data) {
      if (list.items[index] === undefined) {
        throw new HttpError(409, 'List changed', 'Your labelling list changed; nothing was saved.');
      }
      return renderFacet(
        reply,
        s,
        index,
        'Your labelling list changed while this page was open, so nothing was saved. ' +
          'Please label the article shown now.',
        409,
      );
    }
    const parsed = FacetFormSchema.safeParse(raw);
    if (!parsed.success) {
      return renderFacet(reply, s, index, 'Please answer all six questions.', 400, raw);
    }
    await db.transaction((tx) =>
      saveFacetLabels(tx, {
        labeler: list.labeler,
        articleId: shown.data,
        values: parsed.data,
        now: now(),
      }),
    );
    const done = new Set(await labelledArticleIds(db, list.labeler));
    const after = list.items.findIndex((i, n) => n > index && !done.has(i.articleId));
    const first = list.items.findIndex((i) => !done.has(i.articleId));
    const next = after >= 0 ? after : first;
    return reply.redirect(next >= 0 ? `/facets/${next}` : '/facets', 303);
  });

  return app;
}
