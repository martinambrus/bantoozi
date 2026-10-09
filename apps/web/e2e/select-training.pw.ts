import { stateOf } from './flow-support/articles.js';
import { adoptLibraryCard, heldCards, libraryCard } from './flow-support/cards.js';
import { engineCalls, feedbackEvents } from './flow-support/hooks.js';
import { articleRow } from './flow-support/rows.js';
import { newAccount, uniqueTag } from './reader-support/accounts.js';
import {
  articleByTitle,
  subscribe,
  subscriptionsOf,
  waitForExtraction,
} from './reader-support/api.js';
import { analysisRequests, arrive } from './reader-support/hooks.js';
import { articlePane, openArticle, refreshUntil, rowOf } from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §9, scenario 3: of the articles of an Off feed, exactly one is selected and analyzed; only
 * that request runs; the article appears in For you; "Not really about this" in Why this? turns the
 * card that judged it into a private fork; the rating of the selected article carries the id of its
 * request, and its siblings stay untrained.
 */
test('select training: one article is analyzed, reaches For you, and Why this? forks its card', async ({
  browse,
  control,
}) => {
  // The worker takes the request up within seconds, the fake model answers slowly on purpose, and
  // the article reaches For you a few seconds after it is analyzed.
  test.setTimeout(180_000);

  const email = newAccount('select-training');
  const tag = uniqueTag();
  const tech = await control.feed('tech');
  const siblingTitles = tech.items.map((item) => item.title);
  expect(siblingTitles).toHaveLength(3);
  const page = await browse.as(email);
  const user = page.request;

  // The card that will judge the article: held before the selection, since the request freezes the
  // cards it is analyzed against. Its words are in the title of the arrival, so the fake model
  // scores it a match.
  const library = await libraryCard(user, 'Quantum computing', 'quantum-computing');
  const adopted = await adoptLibraryCard(user, library);
  expect(adopted).toMatchObject({ id: library.id, origin: 'library', isPrivateFork: false });

  const subscription = await subscribe(user, tech.url);
  expect(subscription.inferenceMode).toBe('off');
  await waitForExtraction(control, tech.url, siblingTitles.length);
  // A title no other scenario uses, so that nothing about it was analyzed before this one.
  const { item: selected, articleId } = await arrive(control, 'tech', {
    title: `Quantum ${tag} annealer beats a classical benchmark`,
    excerpt: `A laboratory in the north reports that its quantum annealer solved a routing puzzle ${tag} faster than any classical code.`,
  });
  const allTitles = [selected.title, ...siblingTitles];

  await test.step('nothing is analyzed before an article is selected', async () => {
    expect(await control.fakeCount()).toBe(0);
    expect(await analysisRequests(control, email)).toEqual([]);
    expect(await engineCalls(control, email)).toEqual([]);
  });

  await test.step('the feed view offers a checkbox on each article of the Off feed', async () => {
    await page.goto('/read/new');
    await page.getByRole('link', { name: tech.title }).click();
    await expect(page).toHaveURL(new RegExp(`/read/feed/${subscription.feed.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: tech.title })).toBeVisible();
    await refreshUntil(page, async () => {
      for (const title of allTitles)
        await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
    });
    for (const title of allTitles) {
      await expect(articleRow(page, title)).toContainText('Not analyzed');
      await expect(
        articleRow(page, title).getByRole('checkbox', { name: `Select ${title}` }),
      ).not.toBeChecked();
    }
  });

  const panel = page.getByRole('region', { name: 'Articles to analyze' });
  await test.step('selecting one article names it and offers to start training for it', async () => {
    await articleRow(page, selected.title)
      .getByRole('checkbox', { name: `Select ${selected.title}` })
      .check();
    await expect(panel).toContainText('1 of 20 selected');
    const chosen = panel.getByRole('list', { name: 'Selected articles' }).getByRole('listitem');
    await expect(chosen).toHaveCount(1);
    await expect(chosen).toHaveText(selected.title);
    await expect(
      panel.getByRole('button', { name: 'Start training and analyze this article', exact: true }),
    ).toBeEnabled();
    for (const title of siblingTitles) {
      await expect(
        articleRow(page, title).getByRole('checkbox', { name: `Select ${title}` }),
      ).not.toBeChecked();
    }
    // Selecting asks for nothing.
    expect(await analysisRequests(control, email)).toEqual([]);
    expect(await control.fakeCount()).toBe(0);
  });

  await test.step('the button sends that article alone and the row shows where its analysis stands', async () => {
    // A slow model keeps the request visible as queued or running for a few seconds.
    await control.setFakeOptions({ latencyMs: 2_500 });
    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/v1/subscriptions/${subscription.feed.id}/analyze`,
    );
    await panel
      .getByRole('button', { name: 'Start training and analyze this article', exact: true })
      .click();
    const body = (await sent).postDataJSON() as {
      articles: Array<{ id: string }>;
      startTraining?: boolean;
    };
    expect(body.articles.map((article) => article.id)).toEqual([articleId]);
    expect(body.startTraining).toBe(true);

    await expect(articleRow(page, selected.title)).toContainText(/Queued for analysis|Analyzing/);
    for (const title of siblingTitles) {
      await expect(articleRow(page, title)).toContainText('Not analyzed');
    }
    expect((await subscriptionsOf(user)).map((current) => current.inferenceMode)).toEqual([
      'training',
    ]);
  });

  let requestId = '';
  await test.step('exactly one request exists, and it completes for the selected article', async () => {
    await expect
      .poll(async () => (await analysisRequests(control, email)).map((r) => r.status), {
        message: 'the request completes',
        timeout: 60_000,
        intervals: [500, 1_000],
      })
      .toEqual(['complete']);
    const requests = await analysisRequests(control, email);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ articleId, status: 'complete', errorCode: null });
    requestId = requests[0]?.id ?? '';
    await control.setFakeOptions({ latencyMs: 50 });
  });

  await test.step('the fake model was asked about that article only', async () => {
    // Each provider call the fake received is an audit row of this account, and each is about the
    // selected article; none is about a sibling.
    await expect
      .poll(async () => (await engineCalls(control, email)).length - (await control.fakeCount()), {
        message: 'every request the fake received is an audit row of this account',
        timeout: 15_000,
      })
      .toBe(0);
    const calls = await engineCalls(control, email);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((call) => call.articleId))).toEqual(new Set([articleId]));
  });

  await test.step('the analyzed article appears in For you, with its request and a card as the reason', async () => {
    await page.goto('/read/for_you');
    await expect(page.getByRole('heading', { level: 1, name: 'For you' })).toBeVisible();
    await refreshUntil(
      page,
      async () => {
        await expect(rowOf(page, selected.title)).toBeVisible({ timeout: 1_500 });
      },
      90_000,
    );
    await expect(articleRow(page, selected.title)).not.toContainText('Not analyzed');
    await expect(articleRow(page, selected.title)).toContainText('Quantum computing');
    const row = await articleByTitle(user, selected.title);
    expect(row.lane).toBe('for_you');
    expect(row.analysis).toMatchObject({ mode: 'training', status: 'complete', requestId });
    for (const title of siblingTitles) await expect(rowOf(page, title)).toHaveCount(0);
  });

  await test.step('"Not really about this" in Why this? turns the card into a private fork', async () => {
    const pane = await openArticle(page, selected.title);
    await pane.getByRole('button', { name: 'Why this?', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Why this?' });
    await expect(drawer).toBeVisible();
    const interest = drawer.getByRole('listitem', { name: 'Quantum computing' });
    await expect(interest).toHaveCount(1);
    await interest.getByRole('button', { name: 'Not really about this', exact: true }).click();
    await expect(drawer.getByText("Learned: this isn't Quantum computing")).toBeVisible();

    const cards = await heldCards(user);
    expect(cards).toHaveLength(1);
    const [fork] = cards;
    expect(fork).toMatchObject({ origin: 'fork', isPrivateFork: true, interest: adopted.interest });
    expect(fork?.id).not.toBe(adopted.id);
    expect(fork?.examplesNo).toHaveLength(1);
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).toBeHidden();
  });

  await test.step('rating the selected article sends and stores the id of its request', async () => {
    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/v1/articles/${articleId}/rating`,
    );
    // The lane was re-read after the teaching and no longer lists the article, but the article stays
    // open beside the list, with the same buttons as its row.
    await articlePane(page)
      .getByRole('group', { name: 'Article actions' })
      .getByRole('button', { name: 'Like', exact: true })
      .click();
    const body = (await sent).postDataJSON() as { rating: number; analysisRequestId?: string };
    expect(body).toMatchObject({ rating: 1, analysisRequestId: requestId });
    await expect
      .poll(() => stateOf(user, selected.title), { message: 'the API holds the like' })
      .toMatchObject({ rating: 1 });
    const events = (await feedbackEvents(control, email, articleId)).filter(
      (event) => event.kind === 'rate',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rating: 1, analysisRequestId: requestId });
  });

  await test.step('the siblings stay untrained: not analyzed, no request, no call about them', async () => {
    for (const title of siblingTitles) {
      const sibling = await stateOf(user, title);
      expect(sibling.analysis).toMatchObject({ mode: 'training', status: 'not_requested' });
      expect(sibling.analysis.requestId).toBeNull();
      expect(sibling).toMatchObject({ rating: null, bookmarkedAt: null });
    }
    // Anything the teaching or the rating had queued for them would have started by now.
    await staysTrueFor(3_000, async () => {
      const requests = await analysisRequests(control, email);
      expect(requests.map((request) => request.articleId)).toEqual([articleId]);
      const calls = await engineCalls(control, email);
      expect(new Set(calls.map((call) => call.articleId))).toEqual(new Set([articleId]));
    });
    await expect
      .poll(async () => (await engineCalls(control, email)).length - (await control.fakeCount()), {
        message: 'the fake received no request that is not an audit row of this account',
      })
      .toBe(0);

    await page.getByRole('link', { name: tech.title }).click();
    await expect(page).toHaveURL(new RegExp(`/read/feed/${subscription.feed.id}$`));
    for (const title of siblingTitles) {
      await expect(rowOf(page, title)).toBeVisible();
      await expect(articleRow(page, title)).toContainText('Not analyzed');
    }
  });
});
