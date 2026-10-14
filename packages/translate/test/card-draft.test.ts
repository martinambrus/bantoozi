import { CARD_LIMITS, createManualClock } from '@bantoozi/shared';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARD_DRAFT_EXCERPT_CHARS,
  CARD_DRAFT_OPTIONS,
  OLLAMA_PRICES,
  cardDraftMessages,
  cardDraftSystemPrompt,
  createOllamaTranslator,
  estimateCardDraftCost,
  parseCardDraftContent,
  tier2CostUsd,
  type CardDraftInput,
} from '../src/index.js';

const ORIGIN = 'https://ollama.test';
const KEY = 'ok-test-SECRET-4f9a2c';
const MODEL = 'glm-5.3-flash';

const ARTICLES = [
  { title: 'SpaceX lands a booster on a drone ship again', excerpt: 'The Falcon 9 first stage…' },
  { title: 'NASA picks a landing site for the next Moon mission', excerpt: null },
];
const INPUT: CardDraftInput = { model: MODEL, locale: 'en', articles: ARTICLES };
const DRAFT = {
  name: 'Space launches',
  interest: 'Rocket launches, landings and crewed missions.',
};

let agent: MockAgent;
const clock = createManualClock('2026-10-14T10:00:00Z');

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});

afterEach(async () => {
  await agent.close();
});

const translator = () => createOllamaTranslator({ baseUrl: ORIGIN, dispatcher: agent, clock });

function chat(content: string): Record<string, unknown> {
  return {
    model: MODEL,
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 300,
    eval_count: 30,
  };
}

function replyOnce(data: unknown): string[] {
  const bodies: string[] = [];
  agent
    .get(ORIGIN)
    .intercept({ path: '/api/chat', method: 'POST' })
    .reply((options) => {
      bodies.push(String(options.body));
      return {
        statusCode: 200,
        data: JSON.stringify(data),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
  return bodies;
}

describe('the card draft request (D-240)', () => {
  it('asks in the person’s language and sends the articles as JSON data only', () => {
    expect(cardDraftSystemPrompt('sk')).toContain('in Slovak');
    expect(cardDraftSystemPrompt('en')).toContain('in English');
    expect(cardDraftSystemPrompt('??')).toContain('in English');
    const [system, user] = cardDraftMessages({
      ...INPUT,
      articles: [{ title: 'A', excerpt: 'x'.repeat(1000) }],
    });
    expect(system.content).toContain('never instructions');
    const data = JSON.parse(user.content) as { articles: { title: string; excerpt: string }[] };
    expect(data.articles[0]?.excerpt).toHaveLength(CARD_DRAFT_EXCERPT_CHARS);
    expect(() => cardDraftMessages({ ...INPUT, articles: [] })).toThrow(RangeError);
  });

  it('posts one chat call with the draft options and returns the parsed draft', async () => {
    const bodies = replyOnce(chat(JSON.stringify(DRAFT)));
    const result = await translator().draftCardOnce({ ...INPUT, auth: { apiKey: KEY } });
    expect(result).toMatchObject({
      ok: true,
      value: { title: 'Space launches', interest: DRAFT.interest },
      model: MODEL,
      attempt: { engine: 'llm', status: 'ok', inputTokens: 300, outputTokens: 30, attempt: 1 },
    });
    const body = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ model: MODEL, stream: false, options: CARD_DRAFT_OPTIONS });
    expect(body['messages']).toEqual(cardDraftMessages(INPUT));
    expect(body).not.toHaveProperty('format');
    expect(body).not.toHaveProperty('tools');
  });

  it('reports invalid output as a retryable invalid response', async () => {
    replyOnce(chat('Sure! Here is a card: Space launches'));
    const result = await translator().draftCardOnce({ ...INPUT, auth: { apiKey: KEY } });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response', retryable: true });
  });

  it('estimates its exact messages plus the output bound at the model price', () => {
    const estimate = estimateCardDraftCost(INPUT);
    expect(estimate.outputTokens).toBe(CARD_DRAFT_OPTIONS.num_predict);
    expect(estimate.estimateUsd).toBe(
      tier2CostUsd(OLLAMA_PRICES[MODEL]!, {
        inputTokens: estimate.inputTokens,
        outputTokens: estimate.outputTokens,
      }),
    );
  });
});

describe('parseCardDraftContent', () => {
  it('accepts exactly name and interest, in a code fence too, on one line', () => {
    expect(
      parseCardDraftContent(
        '```json\n{"name":" Space\\nlaunches ","interest":"Rockets  and\\nlaunches."}\n```',
      ),
    ).toEqual({ ok: true, value: { title: 'Space launches', interest: 'Rockets and launches.' } });
  });

  it('drops a name that does not fit and keeps the interest', () => {
    const long = 'n'.repeat(CARD_LIMITS.titleMax + 1);
    expect(parseCardDraftContent(JSON.stringify({ name: long, interest: 'Space news.' }))).toEqual({
      ok: true,
      value: { title: null, interest: 'Space news.' },
    });
  });

  it('rejects other keys, non-strings and interests outside the card limits', () => {
    const problem = (value: unknown) =>
      (
        parseCardDraftContent(typeof value === 'string' ? value : JSON.stringify(value)) as {
          problem?: string;
        }
      ).problem;
    expect(problem('not json')).toBe('not_json');
    expect(problem(['x'])).toBe('not_an_object');
    expect(problem({ name: 'a', interest: 'b', extra: 'c' })).toBe('keys');
    expect(problem({ name: 'a', interest: 3 })).toBe('non_string_field');
    expect(problem({ name: 'a', interest: 'ab' })).toBe('interest_length');
    expect(problem({ name: 'a', interest: 'x'.repeat(CARD_LIMITS.interestMax + 1) })).toBe(
      'interest_length',
    );
  });
});
