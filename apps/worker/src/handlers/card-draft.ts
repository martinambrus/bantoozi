import { randomUUID } from 'node:crypto';

import {
  CARD_DRAFT_CONTEXT_CARDS,
  finishCardDraft,
  heldCardTexts,
  loadCardDraftArticles,
  loadCardDraftWork,
  type CardDraftArticle,
} from '@bantoozi/db';
import { TAXONOMY } from '@bantoozi/questions';
import { CARD_LIMITS, type InferenceAuthorization } from '@bantoozi/shared';
import {
  CARD_DRAFT_MAX_ATTEMPTS,
  toExternalCall,
  type CardDraftInput,
  type CardDraftText,
  type ChatAttemptResult,
} from '@bantoozi/translate';

import type { TranslationDeps } from '../classify/translation.js';
import { isCredentialUnavailableError } from '../credentials/resolver.js';
import type { ClassificationDeps, WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'card.draft' as const;
/** One draft call: the attempt's own 60 s plus the key lookup. */
const DRAFT_ATTEMPT_DEADLINE_MS = 90_000;

/** Level-2 topic names by id, in both languages. */
const L2_NAMES = new Map(
  TAXONOMY.flatMap((l1) => l1.children.map((l2) => [l2.id, { en: l2.nameEn, sk: l2.nameSk }])),
);

/** Cut `text` to at most `max` code points at a word boundary when one is near. */
function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max).join('');
  const space = head.lastIndexOf(' ');
  return (space > max * 0.6 ? head.slice(0, space) : head).trimEnd();
}

/**
 * The draft without the LLM: the level-2 topic the articles lean to most (summed `t2.*`) as the
 * name, and the first article's title as the interest, as the editor did before drafts.
 */
export function fallbackDraft(
  articles: readonly CardDraftArticle[],
  locale: string,
): CardDraftText | null {
  const first = articles[0];
  if (first === undefined) return null;
  const interest = cut(first.title, CARD_LIMITS.interestMax);
  if ([...interest].length < CARD_LIMITS.interestMin) return null;
  const sums = new Map<string, number>();
  for (const article of articles) {
    for (const [key, value] of Object.entries(article.facets ?? {})) {
      if (!key.startsWith('t2.') || typeof value !== 'number') continue;
      const id = key.slice(3);
      if (L2_NAMES.has(id)) sums.set(id, (sums.get(id) ?? 0) + value);
    }
  }
  let best: [string, number] | undefined;
  for (const entry of [...sums].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry[1] > 0 && (best === undefined || entry[1] > best[1])) best = entry;
  }
  const names = best === undefined ? undefined : L2_NAMES.get(best[0]);
  const title = names === undefined ? null : locale === 'sk' ? names.sk : names.en;
  return { title: title === null ? null : cut(title, CARD_LIMITS.titleMax), interest };
}

type Sent =
  | { kind: 'denied' }
  | { kind: 'sent'; reservationId: string; result: ChatAttemptResult<CardDraftText> };

/**
 * The LLM's draft, or null when it could not be had: no active Ollama key, spend refused, a
 * transport or provider failure, or invalid output after the one repair attempt. Every attempt is
 * reserved before it is sent and recorded through the router as `llm`/`card_draft`.
 */
async function draftWithLlm(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  translation: TranslationDeps,
  input: CardDraftInput,
  context: { userId: string; authorization: InferenceAuthorization },
): Promise<CardDraftText | null> {
  const { router } = classification;
  const estimate = translation.ollama.estimateCardDraft(input);
  const logicalRequestId = randomUUID();
  for (let attempt = 1; attempt <= CARD_DRAFT_MAX_ATTEMPTS; attempt += 1) {
    const reserved: { id?: string } = {};
    let sent: Sent;
    try {
      sent = await translation.credentials.useActive(
        'ollama',
        AbortSignal.timeout(DRAFT_ATTEMPT_DEADLINE_MS),
        async (auth): Promise<Sent> => {
          const reservationId = await router.reserveExternalCall({
            engine: 'llm',
            kind: 'card_draft',
            estimateUsd: estimate.estimateUsd,
            priority: 'interactive',
            userId: context.userId,
            authorization: context.authorization,
          });
          if (reservationId === null) return { kind: 'denied' };
          reserved.id = reservationId;
          const result = await translation.ollama.draftCardOnce({
            ...input,
            auth: {
              apiKey: auth.apiKey,
              ...(auth.credentialVersion === undefined
                ? {}
                : { credentialVersion: auth.credentialVersion }),
            },
            attempt,
          });
          return { kind: 'sent', reservationId, result };
        },
      );
    } catch (error) {
      if (reserved.id === undefined) {
        if (isCredentialUnavailableError(error)) return null;
        throw error;
      }
      // It may have reached the provider: the reservation stays charged conservatively.
      await router.recordExternalCall(
        {
          engine: 'llm',
          kind: 'card_draft',
          model: input.model,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          status: 'error',
          error: 'send_failure',
          billing: 'uncertain',
          logicalRequestId,
          attempt,
        },
        reserved.id,
      );
      deps.logger.warn({ job: JOB, err: error }, 'card draft attempt failed');
      return null;
    }
    if (sent.kind === 'denied') return null;
    const { result } = sent;
    const { overrun } = await router.recordExternalCall(
      { ...toExternalCall(result.attempt, { logicalRequestId }), kind: 'card_draft' },
      sent.reservationId,
    );
    if (result.ok) return result.value;
    if (overrun || result.reason !== 'invalid_response') return null;
  }
  return null;
}

/**
 * `card.draft {draftId}` (D-240): writes a pending draft's name and interest. With the Ollama
 * translator and an active key, the fast GLM model proposes them from the articles in the
 * person's language; otherwise, or when that fails, the fallback names the articles' main topic
 * and takes the first title. A draft answered already, or gone, is left alone.
 */
export function createCardDraftHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  translation: TranslationDeps | undefined,
): QueueHandler<'card.draft'> {
  return async ({ draftId }) => {
    const work = await loadCardDraftWork(deps.db, draftId);
    if (work === null) return;
    const articles = await loadCardDraftArticles(deps.db, work.articleIds);
    // The held cards of the same kind, so the proposal is a topic the reader has no card for (D-265).
    const existing = await heldCardTexts(deps.db, work.userId, work.kind, CARD_DRAFT_CONTEXT_CARDS);
    const llm =
      translation === undefined || articles.length === 0
        ? null
        : await draftWithLlm(
            deps,
            classification,
            translation,
            {
              model: translation.modelFast,
              locale: work.locale,
              kind: work.kind,
              existing: existing.map((card) => ({ name: card.title, interest: card.interest })),
              articles: articles.map((article) => ({
                title: article.title,
                excerpt: article.excerpt,
              })),
            },
            {
              userId: work.userId,
              authorization: { type: 'card_draft', userId: work.userId, draftId },
            },
          );
    const draft = llm ?? fallbackDraft(articles, work.locale);
    await finishCardDraft(
      deps.db,
      draftId,
      draft === null
        ? { status: 'failed', errorCode: 'no_text' }
        : {
            status: 'complete',
            title: draft.title,
            interest: draft.interest,
            source: llm === null ? 'fallback' : 'llm',
          },
    );
    deps.logger.info(
      { job: JOB, draftId, source: llm === null ? 'fallback' : 'llm' },
      'card draft written',
    );
  };
}
