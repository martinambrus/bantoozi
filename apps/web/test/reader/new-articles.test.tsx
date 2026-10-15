import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreVisibility } from '../article/harness.js';
import { json } from '../api/fake-fetch.js';
import { createReaderHarness, item, page } from './support.js';

const { open } = createReaderHarness();

type Opened = Awaited<ReturnType<typeof open>>;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const lists = (app: Opened['app']) => app.calls('GET /articles').length;

let scrolled = 0;
let scrollTo: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scrolled = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrolled });
  scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  restoreVisibility();
  scrollTo.mockRestore();
});

async function openReader() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const opened = await open({ path: '/read/for_you', items: [item(1), item(2)] });
  await screen.findByRole('article', { name: 'Article 1' });
  return opened;
}

describe('new articles while the reader is open', () => {
  it('reloads the list by itself when the reader is at the top and nothing is open', async () => {
    const { app, state } = await openReader();
    const listed = lists(app);
    state.counts = { ...state.counts, forYou: state.counts.forYou + 2 };

    await advance(31_000);

    expect(lists(app)).toBe(listed + 1);
    expect(app.calls('GET /articles').at(-1)!.query.has('cursor')).toBe(false);
    expect(screen.queryByRole('button', { name: /new articles?/ })).toBeNull();
  });

  it('keeps offering the new articles when the reload by itself fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let broken = false;
    const { app, state } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      list: () =>
        broken
          ? json(503, { error: { code: 'UNAVAILABLE', message: 'down (test)' } })
          : json(200, page([item(1), item(2)])),
    });
    await screen.findByRole('article', { name: 'Article 1' });
    broken = true;
    state.counts = { ...state.counts, forYou: state.counts.forYou + 2 };

    await advance(31_000);

    expect(await screen.findByRole('button', { name: 'Show 2 new articles' })).toBeInTheDocument();
    expect(app.calls('GET /articles').length).toBeGreaterThan(1);
  });

  it('offers a banner instead while an article is open, and loads the articles when it is pressed', async () => {
    const { app, state } = await openReader();
    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));
    const listed = lists(app);
    state.counts = { ...state.counts, forYou: state.counts.forYou + 2 };

    await advance(31_000);

    expect(lists(app)).toBe(listed);
    const banner = await screen.findByRole('button', { name: 'Show 2 new articles' });
    expect(banner).toHaveTextContent('2 new articles · Show');

    await app.user.click(banner);

    await vi.waitFor(() => expect(lists(app)).toBe(listed + 1));
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: /Show \d+ new articles?/ })).toBeNull(),
    );
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('offers the banner when the reader has scrolled down', async () => {
    const { app, state } = await openReader();
    scrolled = 400;
    const listed = lists(app);
    state.counts = { ...state.counts, forYou: state.counts.forYou + 1 };

    await advance(31_000);

    expect(lists(app)).toBe(listed);
    expect(await screen.findByRole('button', { name: 'Show 1 new article' })).toBeInTheDocument();
  });

  it('does nothing when the counts fall because the reader read articles', async () => {
    const { app, state } = await openReader();
    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));
    const listed = lists(app);
    state.counts = { ...state.counts, forYou: state.counts.forYou - 1 };

    await advance(31_000);

    expect(lists(app)).toBe(listed);
    expect(screen.queryByRole('button', { name: /new articles?/ })).toBeNull();
  });

  it('does nothing when the counts stay as they are', async () => {
    const { app } = await openReader();
    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));
    const listed = lists(app);

    await advance(95_000);

    expect(lists(app)).toBe(listed);
    expect(screen.queryByRole('button', { name: /new articles?/ })).toBeNull();
  });

  it('says it in Slovak with the plural forms', async () => {
    const { app, state } = await openReader();
    await act(() => app.i18n.changeLanguage('sk'));
    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));
    state.counts = { ...state.counts, forYou: state.counts.forYou + 2 };

    await advance(31_000);

    expect(await screen.findByRole('button', { name: 'Zobraziť 2 nové články' })).toHaveTextContent(
      '2 nové články · Zobraziť',
    );

    state.counts = { ...state.counts, forYou: state.counts.forYou + 3 };
    await advance(31_000);

    expect(
      await screen.findByRole('button', { name: 'Zobraziť 5 nových článkov' }),
    ).toBeInTheDocument();
  });
});
