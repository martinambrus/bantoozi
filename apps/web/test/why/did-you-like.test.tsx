import type { ArticleListItem, Me, UserPreferences } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { FOCUS_RING } from '../../src/components/cx.js';
import {
  useReaderActions,
  useReturnTracker,
  useSettledActions,
} from '../../src/features/reader/actions/provider.js';
import { DidYouLikePrompt } from '../../src/features/why/did-you-like-prompt.js';
import type { Language } from '../../src/i18n/index.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import {
  actionResponse,
  bodyOf,
  deferred,
  findToast,
  makeItem,
  makeMe,
  renderReader,
  restoreVisibility,
  setVisibility,
} from '../article/harness.js';
import { acked } from '../reader/actions/fake-transport.js';
import type { ApiRouteHandler } from '../support/app.js';
import { checkUnhandled, track } from './support.js';

checkUnhandled();

afterEach(() => {
  restoreVisibility();
});

const FIRST = makeItem();
const SECOND = makeItem({
  id: '202',
  title: 'Wind farms break the output record',
  url: 'https://example.test/articles/202',
  stateVersion: '9',
});

const REQUEST_ID = '5b0c1c2e-6d1f-4d8c-9f43-0a5c2b7e9d10';

/** An article the person selected for analysis, so its feedback belongs to that request. */
const SELECTED = makeItem({
  id: '303',
  title: 'Heat pumps outsell gas boilers',
  url: 'https://example.test/articles/303',
  stateVersion: '2',
  analysis: { mode: 'training', status: 'complete', requestId: REQUEST_ID },
});

const question = (item: ArticleListItem) => `Did you like “${item.title}”?`;
const dwellOn = (item: ArticleListItem) => `Dwell on ${item.title}`;
const readOriginal = (item: ArticleListItem) => `Read the original of ${item.title}`;

function articleOf(params: Record<string, string>): ArticleListItem {
  const found = [FIRST, SECOND, SELECTED].find((item) => item.id === params['id']);
  if (found === undefined) throw new Error(`The test knows no article ${params['id']}`);
  return found;
}

const dwellAnswered =
  (prompt: boolean): ApiRouteHandler =>
  (_request, params) =>
    actionResponse(acked(articleOf(params)), { prompt });

const promptAnswerAccepted: ApiRouteHandler = (_request, params) =>
  actionResponse(acked(acked(articleOf(params))));

const patchMe: ApiRouteHandler = (request) => {
  const { preferences } = bodyOf(request) as { preferences: Partial<UserPreferences> };
  return json(200, makeMe({ preferences: { implicitFeedback: true, ...preferences } }));
};

const implicit = (preferences: Partial<UserPreferences> = {}) =>
  makeMe({ preferences: { implicitFeedback: true, ...preferences } });

function Host({ items, log }: { items: ArticleListItem[]; log: string[] }) {
  const store = useReaderActions();
  const tracker = useReturnTracker();
  useSettledActions((handle, result) => {
    log.push(`${handle.action.type}:${handle.articleId}:${result.status}`);
  });
  return (
    <>
      <DidYouLikePrompt />
      {items.map((item) => (
        <div key={item.id}>
          <button type="button" onClick={() => tracker.track(item)}>
            {readOriginal(item)}
          </button>
          <button type="button" onClick={() => store.dispatch(item, { type: 'dwell', ms: 90_000 })}>
            {dwellOn(item)}
          </button>
        </div>
      ))}
    </>
  );
}

interface Setup {
  items?: ArticleListItem[];
  me?: Me;
  language?: Language;
  routes?: Record<string, ApiRouteHandler>;
}

function renderPrompt({ items = [FIRST], me = implicit(), language, routes }: Setup = {}) {
  const log: string[] = [];
  const app = track(
    renderReader(<Host items={items} log={log} />, {
      me,
      ...(language === undefined ? {} : { language }),
      routes: { 'POST /articles/:id/dwell': dwellAnswered(true), ...routes },
    }),
  );
  return { ...app, log };
}

type Rendered = ReturnType<typeof renderPrompt>;

/** Reports a dwell on `item` and waits for the sheet that asks about it. */
async function ask(app: Rendered, item: ArticleListItem) {
  await app.user.click(screen.getByRole('button', { name: dwellOn(item) }));
  return screen.findByRole('dialog', { name: question(item) });
}

async function dwellsSettled(app: Rendered, count: number) {
  await waitFor(() =>
    expect(app.log.filter((line) => line.startsWith('dwell:'))).toHaveLength(count),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the prompt after a dwell', () => {
  it('asks "Did you like <title>?" in a bottom sheet when the dwell says prompt: true', async () => {
    const app = renderPrompt();

    const sheet = await ask(app, FIRST);

    expect(sheet).toHaveAttribute('data-side', 'bottom');
    expect(within(sheet).getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'No' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Ask less often' })).toBeInTheDocument();
    expect(app.calls('POST', '/articles/101/dwell')).toHaveLength(1);
  });

  it('asks in Slovak when that is the language', async () => {
    const app = renderPrompt({ language: 'sk' });

    await app.user.click(screen.getByRole('button', { name: dwellOn(FIRST) }));

    const sheet = await screen.findByRole('dialog', {
      name: `Páčil sa vám článok „${FIRST.title}“?`,
    });
    expect(within(sheet).getByRole('button', { name: 'Áno' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Nie' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Pýtať sa menej často' })).toBeInTheDocument();
  });

  describe('when the reader comes back from the original', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-05-31T10:00:00.000Z'));
    });

    function leaveAndReturn(awayMs: number) {
      const start = Date.now();
      setVisibility('hidden');
      vi.setSystemTime(start + awayMs);
      setVisibility('visible');
    }

    it('reports the time away and asks when the answer says prompt: true', async () => {
      const app = renderPrompt();

      await app.user.click(screen.getByRole('button', { name: readOriginal(FIRST) }));
      leaveAndReturn(90_000);

      expect(await screen.findByRole('dialog', { name: question(FIRST) })).toBeInTheDocument();
      expect(app.calls('POST', '/articles/101/dwell')).toHaveLength(1);
      expect(bodyOf(app.calls('POST', '/articles/101/dwell')[0]!)).toEqual({
        stateVersion: '4',
        contentRevision: '2',
        ms: 90_000,
      });
    });

    it('sends no dwell and asks nothing while implicit feedback is off, and does once it is on', async () => {
      const app = renderPrompt({ me: makeMe() });
      await app.user.click(screen.getByRole('button', { name: readOriginal(FIRST) }));
      leaveAndReturn(90_000);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(app.calls('POST', '/articles/101/dwell')).toHaveLength(0);
      expect(screen.queryByRole('dialog')).toBeNull();

      act(() => {
        app.queryClient.setQueryData(meKey(), implicit());
      });
      await app.user.click(screen.getByRole('button', { name: readOriginal(FIRST) }));
      leaveAndReturn(60_000);

      expect(await screen.findByRole('dialog', { name: question(FIRST) })).toBeInTheDocument();
      expect(app.calls('POST', '/articles/101/dwell')).toHaveLength(1);
    });
  });

  it('asks nothing for a dwell answered with prompt: false or refused, and asks for the next', async () => {
    let answer: ApiRouteHandler = dwellAnswered(false);
    const app = renderPrompt({
      routes: { 'POST /articles/:id/dwell': (...args) => answer(...args) },
    });

    await app.user.click(screen.getByRole('button', { name: dwellOn(FIRST) }));
    await dwellsSettled(app, 1);
    expect(screen.queryByRole('dialog')).toBeNull();

    answer = () => failure(409, 'CONFLICT', { reason: 'not_opened' });
    await app.user.click(screen.getByRole('button', { name: dwellOn(FIRST) }));
    await dwellsSettled(app, 2);
    expect(app.log).toEqual(['dwell:101:done', 'dwell:101:failed']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText("Couldn't save — retry")).toBeNull();

    answer = dwellAnswered(true);
    await app.user.click(screen.getByRole('button', { name: dwellOn(FIRST) }));
    expect(await screen.findByRole('dialog', { name: question(FIRST) })).toBeInTheDocument();
  });

  it('asks nothing for a dwell answered while implicit feedback is off, and asks once it is on', async () => {
    const app = renderPrompt({ items: [FIRST, SECOND], me: makeMe() });

    await app.user.click(screen.getByRole('button', { name: dwellOn(FIRST) }));
    await dwellsSettled(app, 1);
    expect(app.calls('POST', '/articles/101/dwell')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => {
      app.queryClient.setQueryData(meKey(), implicit());
    });
    await app.user.click(screen.getByRole('button', { name: dwellOn(SECOND) }));

    expect(await screen.findByRole('dialog', { name: question(SECOND) })).toBeInTheDocument();
  });

  it('shows one prompt at a time: a second replaces the first, and the answer is about it', async () => {
    const app = renderPrompt({
      items: [FIRST, SECOND],
      routes: { 'POST /articles/:id/prompt-answer': promptAnswerAccepted },
    });
    await ask(app, FIRST);

    const sheet = await ask(app, SECOND);

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: question(FIRST) })).toBeNull();
    await app.user.click(within(sheet).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(app.calls('POST', '/articles/202/prompt-answer')).toHaveLength(1));
    expect(app.calls('POST', '/articles/101/prompt-answer')).toHaveLength(0);
  });

  it('does nothing but close when it is closed, by its button or Escape, and asks again later', async () => {
    const app = renderPrompt({
      items: [FIRST, SECOND],
      me: implicit({ feedbackPrompt: 'often' }),
    });
    const first = await ask(app, FIRST);

    await app.user.click(within(first).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await ask(app, SECOND);
    await app.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(app.requests.filter((request) => !request.pathname.endsWith('/dwell'))).toEqual([]);
    expect(await ask(app, FIRST)).toBeInTheDocument();
  });
});

describe('the answer', () => {
  it.each([
    ['Yes', true],
    ['No', false],
  ])(
    '"%s" sends liked: %s with the fence of the dwell, and closes at once',
    async (name, liked) => {
      const answer = deferred<Response>();
      const app = renderPrompt({
        routes: { 'POST /articles/:id/prompt-answer': () => answer.promise },
      });
      const sheet = await ask(app, FIRST);

      await app.user.click(within(sheet).getByRole('button', { name }));

      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(app.calls('POST', '/articles/101/prompt-answer')).toHaveLength(1));
      const [request] = app.calls('POST', '/articles/101/prompt-answer');
      expect(bodyOf(request!)).toEqual({ stateVersion: '5', contentRevision: '2', liked });
      expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      answer.resolve(actionResponse(acked(acked(FIRST))));
      await waitFor(() => expect(app.log).toContain('promptAnswer:101:done'));
      expect(app.calls('PATCH', '/me')).toHaveLength(0);
    },
  );

  it('names the analysis the article was selected for, and only then', async () => {
    const app = renderPrompt({
      items: [FIRST, SELECTED],
      routes: { 'POST /articles/:id/prompt-answer': promptAnswerAccepted },
    });

    await app.user.click(within(await ask(app, SELECTED)).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(app.calls('POST', '/articles/303/prompt-answer')).toHaveLength(1));
    await app.user.click(within(await ask(app, FIRST)).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(app.calls('POST', '/articles/101/prompt-answer')).toHaveLength(1));

    expect(bodyOf(app.calls('POST', '/articles/303/prompt-answer')[0]!)).toEqual({
      stateVersion: '3',
      contentRevision: '2',
      liked: true,
      analysisRequestId: REQUEST_ID,
    });
    expect(bodyOf(app.calls('POST', '/articles/101/prompt-answer')[0]!)).not.toHaveProperty(
      'analysisRequestId',
    );
  });

  it('shows the usual retry offer when the answer could not be saved', async () => {
    const app = renderPrompt({
      routes: { 'POST /articles/:id/prompt-answer': () => failure(400, 'VALIDATION_FAILED') },
    });
    const sheet = await ask(app, FIRST);

    await app.user.click(within(sheet).getByRole('button', { name: 'Yes' }));

    const toast = await findToast("Couldn't save — retry");
    expect(within(toast).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('"Ask less often"', () => {
  it('lowers the setting one step from the one in force, and closes at once', async () => {
    const app = renderPrompt({
      items: [FIRST, SECOND],
      me: implicit({ feedbackPrompt: 'often' }),
      routes: { 'PATCH /me': patchMe },
    });
    const first = await ask(app, FIRST);

    await app.user.click(within(first).getByRole('button', { name: 'Ask less often' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(1));
    const [request] = app.calls('PATCH', '/me');
    expect(bodyOf(request!)).toEqual({ preferences: { feedbackPrompt: 'occasionally' } });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.calls('POST', '/articles/101/prompt-answer')).toHaveLength(0);

    await waitFor(() =>
      expect(app.queryClient.getQueryData<Me>(meKey())?.preferences.feedbackPrompt).toBe(
        'occasionally',
      ),
    );
    const second = await ask(app, SECOND);
    await app.user.click(within(second).getByRole('button', { name: 'Ask less often' }));

    await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(2));
    expect(bodyOf(app.calls('PATCH', '/me')[1]!)).toEqual({
      preferences: { feedbackPrompt: 'never' },
    });
  });

  it('is not offered when the prompt is already off', async () => {
    const app = renderPrompt({ me: implicit({ feedbackPrompt: 'never' }) });

    const sheet = await ask(app, FIRST);

    expect(within(sheet).getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Ask less often' })).toBeNull();
  });

  it('says so when the setting could not be saved', async () => {
    const app = renderPrompt({ routes: { 'PATCH /me': () => failure(500, 'INTERNAL') } });
    const sheet = await ask(app, FIRST);

    await app.user.click(within(sheet).getByRole('button', { name: 'Ask less often' }));

    expect(await findToast('Something went wrong on our side. Try again.')).toHaveAttribute(
      'data-tone',
      'error',
    );
    expect(app.queryClient.getQueryData<Me>(meKey())?.preferences.feedbackPrompt).toBe(
      'occasionally',
    );
  });
});

describe('the controls', () => {
  it('name every control and give it a 44 px target and a focus ring', async () => {
    const app = renderPrompt();
    const sheet = await ask(app, FIRST);

    for (const name of ['Yes', 'No', 'Ask less often']) {
      const control = within(sheet).getByRole('button', { name });
      expect(control.className).toContain('min-h-11');
      for (const token of FOCUS_RING.split(' ')) expect(control.className).toContain(token);
    }
  });
});
