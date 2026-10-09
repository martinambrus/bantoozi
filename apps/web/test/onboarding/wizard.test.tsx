import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { BUNDLES, type StarterBundle } from '../../src/features/onboarding/bundles.js';
import {
  battery,
  counts,
  feed,
  newcomer,
  expectUsableControls,
  rust,
  space,
  wizardServer,
  type WizardOptions,
} from './support.js';

const { open } = createHarness();

async function openWizard(path: string, options: WizardOptions = {}, language?: 'en' | 'sk') {
  const { server, state } = wizardServer(options);
  const app = await open({ path, server, ...(language === undefined ? {} : { language }) });
  return { app, server, state };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ADDRESS = () => screen.getByLabelText('Website or feed address');
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

function bundle(id: string): StarterBundle {
  const found = BUNDLES.find((candidate) => candidate.id === id);
  expect(found, `bundle ${id}`).toBeDefined();
  return found!;
}

const bundleItem = async (name: string) =>
  within(await screen.findByRole('list', { name: 'Starter bundles' })).getByRole('listitem', {
    name,
  });

describe('welcome (spec 09 §4 step 1)', () => {
  it('says in three lines that interests, not training, rank the lanes, and what Why this? is', async () => {
    await openWizard('/onboarding');

    expect(await heading('Welcome to Bantoozi')).toBeVisible();
    expect(screen.getByText('Step 1 of 4')).toBeVisible();
    const lines = within(screen.getByRole('list', { name: 'How Bantoozi works' })).getAllByRole(
      'listitem',
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent(/nothing to train first/);
    expect(lines[1]).toHaveTextContent(/For you, Maybe, Everything else and New/);
    expect(lines[2]).toHaveTextContent(/“Why this\?”/);
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('has a main landmark that can take the focus, for a modal that has nowhere else to hand it', async () => {
    await openWizard('/onboarding');
    await heading('Welcome to Bantoozi');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toHaveClass('outline-none');
    main.focus();
    expect(main).toHaveFocus();
  });

  it('goes to the feeds step and focuses its heading', async () => {
    const { app } = await openWizard('/onboarding');

    await app.user.click(await screen.findByRole('button', { name: 'Get started' }));

    const title = await heading('Add your feeds');
    expect(app.router.state.location.search).toEqual({ step: 'feeds' });
    expect(screen.getByText('Step 2 of 4')).toBeVisible();
    expect(title).toHaveFocus();
  });

  it('starts at the welcome step when the address names no step or an unknown one', async () => {
    await openWizard('/onboarding?step=party');

    expect(await heading('Welcome to Bantoozi')).toBeVisible();
    expect(screen.getByText('Step 1 of 4')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeVisible();
  });

  it('is written in Slovak for a Slovak account', async () => {
    await openWizard(
      '/onboarding',
      { me: makeMe({ locale: 'sk', preferences: { onboardingCompletedAt: null } }) },
      'sk',
    );

    expect(await heading('Vitajte v Bantoozi')).toBeVisible();
    expect(screen.getByText('Krok 1 zo 4')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Začať' })).toBeVisible();
  });
});

describe('feeds (spec 09 §4 step 2)', () => {
  it('lists the first ten feeds and the rest on request', async () => {
    const subscriptions = Array.from({ length: 12 }, (_, index) =>
      feed(String(index + 1), `Feed ${index + 1}`),
    );
    const { app } = await openWizard('/onboarding?step=feeds', { subscriptions });

    const yours = await screen.findByRole('list', { name: 'Your feeds' });
    expect(within(yours).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('You follow 12 feeds.')).toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Show all 12 feeds' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await app.user.click(toggle);

    expect(within(yours).getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('shows ten feeds or fewer without a toggle', async () => {
    const subscriptions = Array.from({ length: 10 }, (_, index) =>
      feed(String(index + 1), `Feed ${index + 1}`),
    );
    await openWizard('/onboarding?step=feeds', { subscriptions });

    const yours = await screen.findByRole('list', { name: 'Your feeds' });
    expect(within(yours).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: /^Show (all|fewer)/ })).toBeNull();
  });

  it('offers an OPML import and nothing to export', async () => {
    await openWizard('/onboarding?step=feeds');

    expect(await screen.findByLabelText('OPML file')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Export OPML' })).toBeNull();
  });

  it('needs a feed: Continue is disabled with its reason until one is added', async () => {
    const { app } = await openWizard('/onboarding?step=feeds');

    const next = await screen.findByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    expect(screen.getByText('Add at least one feed to continue.')).toBeVisible();
    expect(next).toHaveAccessibleDescription('Add at least one feed to continue.');

    await app.user.type(ADDRESS(), 'https://example.com/feed.xml');
    await app.user.click(screen.getByRole('button', { name: 'Add feed' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(screen.queryByText('Add at least one feed to continue.')).not.toBeInTheDocument();
    expect(await screen.findByText('You follow 1 feed.')).toBeVisible();
  });

  it('says that reading needs no AI and that every new feed starts with classification Off', async () => {
    await openWizard('/onboarding?step=feeds', { subscriptions: [feed('1', 'Alpha')] });

    expect(await screen.findByText(/work without any AI/)).toBeVisible();
    expect(screen.getByText(/every new feed starts with classification Off/)).toBeVisible();
    const yours = await screen.findByRole('list', { name: 'Your feeds' });
    const row = within(yours).getByRole('listitem');
    expect(row).toHaveTextContent('Alpha');
    expect(row).toHaveTextContent('Classification: Off');
  });

  it('offers the OPML import beside the address field', async () => {
    await openWizard('/onboarding?step=feeds');

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Import and export' }),
    ).toBeVisible();
    expect(screen.getByLabelText('OPML file')).toBeVisible();
  });

  it('turns a step after the feeds back to the feeds step while there is no feed', async () => {
    const { app } = await openWizard('/onboarding?step=calibrate');

    expect(await heading('Add your feeds')).toBeVisible();
    expect(app.router.state.location.search).toEqual({ step: 'feeds' });
    expect(screen.getByText('Step 2 of 4')).toBeVisible();
  });

  it('turns the interests step back too', async () => {
    const { app } = await openWizard('/onboarding?step=interests');

    expect(await heading('Add your feeds')).toBeVisible();
    expect(app.router.state.location.search).toEqual({ step: 'feeds' });
  });

  it('lets an account with a feed through to the steps after the feeds', async () => {
    await openWizard('/onboarding?step=interests', { subscriptions: [feed('1', 'Alpha')] });

    expect(await heading('What do you want to read about?')).toBeVisible();
  });

  it('continues to the interests step with a feed, and Back returns', async () => {
    const { app } = await openWizard('/onboarding?step=feeds', {
      subscriptions: [feed('1', 'Alpha')],
    });

    await app.user.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await heading('What do you want to read about?')).toBeVisible();
    expect(screen.getByText('Step 3 of 4')).toBeVisible();
    expect(app.router.state.location.search).toEqual({ step: 'interests' });

    await app.user.click(screen.getByRole('button', { name: 'Back' }));

    expect(await heading('Add your feeds')).toHaveFocus();
    expect(app.router.state.location.search).toEqual({ step: 'feeds' });
  });
});

describe('starter bundles (spec 09 §4 step 2)', () => {
  it('lists every bundle with the number of its feeds, in the language of the account', async () => {
    await openWizard('/onboarding?step=feeds');

    const list = await screen.findByRole('list', { name: 'Starter bundles' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    for (const name of ['Slovak news', 'Czech news', 'Tech', 'Science']) {
      expect(within(list).getByRole('listitem', { name })).toBeVisible();
    }
    const tech = bundle('tech');
    expect(
      within(await bundleItem('Tech')).getByRole('button', {
        name: `Add these ${tech.urls.length} feeds: Tech`,
      }),
    ).toHaveTextContent(`Add these ${tech.urls.length} feeds`);
  });

  it('names the bundles in Slovak', async () => {
    await openWizard(
      '/onboarding?step=feeds',
      { me: makeMe({ locale: 'sk', preferences: { onboardingCompletedAt: null } }) },
      'sk',
    );

    const list = await screen.findByRole('list', { name: 'Štartovacie balíky' });
    for (const item of BUNDLES) {
      expect(within(list).getByRole('listitem', { name: item.names.sk })).toBeVisible();
    }
  });

  it('posts exactly the bundle’s addresses, one after the other and without a folder', async () => {
    const { app, state } = await openWizard('/onboarding?step=feeds');
    const slovak = bundle('slovak-news');

    await app.user.click(
      within(await bundleItem('Slovak news')).getByRole('button', {
        name: `Add these ${slovak.urls.length} feeds: Slovak news`,
      }),
    );

    await waitFor(() => expect(state.subscriptions).toHaveLength(slovak.urls.length));
    const posts = app.calls('POST /subscriptions');
    expect(posts.map((post) => bodyOf(post))).toStrictEqual(slovak.urls.map((url) => ({ url })));
    for (const post of posts) {
      expect(post.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    }
    expect(new Set(posts.map((post) => post.headers.get('Idempotency-Key'))).size).toBe(
      posts.length,
    );
    expect(await screen.findByText(`You follow ${slovak.urls.length} feeds.`)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(app.calls('POST /subscriptions/:feedId/inference')).toHaveLength(0);
    expect(app.calls('POST /subscriptions/:feedId/analyze')).toHaveLength(0);
  });

  it('reports each feed as added, already there or failed, and goes on after a failure', async () => {
    const science = bundle('science');
    const [first, second, third, ...rest] = science.urls;
    const known = feed('7', 'Old science feed', { feed: { url: second! } });
    const { app } = await openWizard('/onboarding?step=feeds', {
      subscriptions: [known],
      routes: {
        'POST /subscriptions': (request) => {
          const { url } = bodyOf(request) as { url: string };
          if (url === first) {
            return json(201, { subscription: feed('21', 'First science feed', { feed: { url } }) });
          }
          if (url === second) return json(200, { subscription: known });
          if (url === third) return failure(422, 'FEED_NOT_A_FEED');
          return json(201, {
            subscription: feed(String(30 + science.urls.indexOf(url)), 'Another science feed', {
              feed: { url },
            }),
          });
        },
      },
    });

    await app.user.click(
      within(await bundleItem('Science')).getByRole('button', {
        name: `Add these ${science.urls.length} feeds: Science`,
      }),
    );

    const item = await bundleItem('Science');
    await waitFor(() =>
      expect(
        within(item).getByText(`Added ${1 + rest.length}, already there 1, failed 1.`),
      ).toBeVisible(),
    );
    const rows = within(
      within(item).getByRole('list', { name: 'Feeds added from this bundle' }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(science.urls.length);
    expect(rows[0]).toHaveTextContent('First science feed');
    expect(rows[0]).toHaveTextContent('Added');
    expect(rows[1]).toHaveTextContent('Old science feed');
    expect(rows[1]).toHaveTextContent('Already there');
    expect(rows[2]).toHaveTextContent(new URL(third!).hostname);
    expect(rows[2]).toHaveTextContent("Couldn't add");
    expect(rows[2]).toHaveTextContent("That address isn't a feed.");
    expect(app.calls('POST /subscriptions')).toHaveLength(science.urls.length);
  });

  it('stops at a quota refusal and says the rest was not tried', async () => {
    const { app } = await openWizard('/onboarding?step=feeds', {
      routes: {
        'POST /subscriptions': (request) => {
          const { url } = bodyOf(request) as { url: string };
          return url === bundle('tech').urls[1]
            ? failure(409, 'QUOTA_EXCEEDED', { limit: 'maxFeeds', used: 200, max: 200 })
            : json(201, { subscription: feed('31', 'Tech feed', { feed: { url } }) });
        },
      },
    });
    const tech = bundle('tech');

    await app.user.click(
      within(await bundleItem('Tech')).getByRole('button', {
        name: `Add these ${tech.urls.length} feeds: Tech`,
      }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Tech' })).getByRole('alert'),
      ).toHaveTextContent("You've reached your plan's limit for feeds: 200 of 200."),
    );
    expect(app.calls('POST /subscriptions')).toHaveLength(2);
    const rows = within(
      within(screen.getByRole('listitem', { name: 'Tech' })).getByRole('list', {
        name: 'Feeds added from this bundle',
      }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(tech.urls.length);
    expect(rows[0]).toHaveTextContent('Added');
    expect(rows[1]).toHaveTextContent("Couldn't add");
    for (const row of rows.slice(2)) expect(row).toHaveTextContent('Not tried');
  });
});

describe('interests (spec 09 §4 step 3)', () => {
  const options: WizardOptions = {
    subscriptions: [feed('1', 'Alpha')],
    library: [rust, battery, space],
  };

  it('groups the library chips under their topic, named in the language of the account', async () => {
    await openWizard('/onboarding?step=interests', options);

    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });
    expect(
      within(likes)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Technology', 'Cars and transport', 'Science']);
    for (const title of ['Rust programming', 'EV battery tech', 'Space launches']) {
      expect(within(likes).getByRole('button', { name: title, pressed: false })).toBeVisible();
    }
  });

  it('names the topics and the lists in Slovak for a Slovak account', async () => {
    await openWizard(
      '/onboarding?step=interests',
      { ...options, me: makeMe({ locale: 'sk', preferences: { onboardingCompletedAt: null } }) },
      'sk',
    );

    const likes = await screen.findByRole('region', { name: 'Vyberte témy, ktoré sa vám páčia' });
    expect(
      within(likes)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Technológie', 'Autá a doprava', 'Veda']);
    expect(screen.getByRole('region', { name: 'Nikdy mi neukazovať…' })).toBeVisible();
    expect(screen.getByLabelText('Popíšte niečo, o čom chcete čítať')).toBeVisible();
  });

  it('shows more of the library on request, inside the wizard', async () => {
    // The library screen sends a newcomer back to the wizard, so the wizard has nowhere to link to.
    const { app } = await openWizard('/onboarding?step=interests', {
      ...options,
      routes: {
        'GET /library': (request) =>
          json(
            200,
            request.query.get('cursor') === 'next'
              ? { items: [{ ...space, held: false }], nextCursor: null }
              : {
                  items: [
                    { ...rust, held: false },
                    { ...battery, held: false },
                  ],
                  nextCursor: 'next',
                },
          ),
      },
    });
    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });
    const never = screen.getByRole('region', { name: 'Never show me…' });
    expect(within(likes).queryByRole('button', { name: 'Space launches' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    await app.user.click(screen.getByRole('button', { name: 'Show more topics' }));

    expect(
      await within(likes).findByRole('button', { name: 'Space launches', pressed: false }),
    ).toBeVisible();
    expect(within(never).getByRole('button', { name: 'Space launches' })).toBeVisible();
    expect(within(likes).getByRole('button', { name: 'Rust programming' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show more topics' })).toBeNull();
    expect(app.calls('GET /library').map((call) => call.query.get('cursor'))).toEqual([
      null,
      'next',
    ]);
  });

  it('says why more topics did not load, and keeps the ones shown', async () => {
    const { app } = await openWizard('/onboarding?step=interests', {
      ...options,
      routes: {
        'GET /library': (request) =>
          request.query.get('cursor') === 'next'
            ? failure(500, 'INTERNAL')
            : json(200, { items: [{ ...rust, held: false }], nextCursor: 'next' }),
      },
    });
    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });

    await app.user.click(screen.getByRole('button', { name: 'Show more topics' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/\S/);
    expect(within(likes).getByRole('button', { name: 'Rust programming' })).toBeVisible();
  });

  it('adopts a chip with the strength like, and removes the card when it is pressed again', async () => {
    const { app, state } = await openWizard('/onboarding?step=interests', options);
    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });

    await app.user.click(within(likes).getByRole('button', { name: 'EV battery tech' }));

    await waitFor(() =>
      expect(within(likes).getByRole('button', { name: 'EV battery tech' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    const [adopt] = app.calls('POST /library/:id/adopt');
    expect(adopt?.pathname).toBe('/api/v1/library/501/adopt');
    expect(bodyOf(adopt!)).toStrictEqual({ strength: 'like' });
    expect(adopt?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(state.cards.map((card) => card.id)).toEqual(['501']);

    await app.user.click(within(likes).getByRole('button', { name: 'EV battery tech' }));

    await waitFor(() =>
      expect(within(likes).getByRole('button', { name: 'EV battery tech' })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
    expect(app.calls('DELETE /cards/:id').map((call) => call.pathname)).toEqual([
      '/api/v1/cards/501',
    ]);
    expect(state.cards).toEqual([]);
  });

  it('shows a card the account already holds as pressed', async () => {
    await openWizard('/onboarding?step=interests', {
      ...options,
      cards: [
        {
          id: '502',
          kind: 'interest',
          title: 'Rust programming',
          titleOverride: null,
          interest: 'The Rust programming language',
          notFor: null,
          strength: 'love',
          scopeFeedId: null,
          origin: 'library',
          isPrivateFork: false,
          examplesYes: [],
          examplesNo: [],
          topicIds: ['technology.software_dev'],
          lang: 'en',
          librarySlug: 'rust-lang',
          createdAt: '2026-09-01T08:00:00.000Z',
        },
      ],
    });
    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });

    expect(within(likes).getByRole('button', { name: 'Rust programming' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const never = screen.getByRole('region', { name: 'Never show me…' });
    expect(within(never).getByRole('button', { name: 'Rust programming' })).toBeDisabled();
  });

  it('adopts a never chip with the strength never, and keeps the same topic out of the interests', async () => {
    const { app } = await openWizard('/onboarding?step=interests', options);
    const never = await screen.findByRole('region', { name: 'Never show me…' });

    await app.user.click(within(never).getByRole('button', { name: 'Space launches' }));

    await waitFor(() =>
      expect(within(never).getByRole('button', { name: 'Space launches' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    const [adopt] = app.calls('POST /library/:id/adopt');
    expect(adopt?.pathname).toBe('/api/v1/library/503/adopt');
    expect(bodyOf(adopt!)).toStrictEqual({ strength: 'never' });
    const likes = screen.getByRole('region', { name: 'Pick topics you like' });
    expect(within(likes).getByRole('button', { name: 'Space launches' })).toBeDisabled();
  });

  it('creates a card from what the person describes, with the strength like', async () => {
    const { app, state } = await openWizard('/onboarding?step=interests', options);
    const field = await screen.findByLabelText('Describe something you want to read about');
    expect(screen.getByText(/For example: “Electric cars and batteries”/)).toBeVisible();

    await app.user.type(field, '  Slovak mountain huts  ');
    await app.user.click(screen.getByRole('button', { name: 'Add interest' }));

    expect(await screen.findByText('Added “Slovak mountain huts”.')).toBeVisible();
    const [post] = app.calls('POST /cards');
    expect(bodyOf(post!)).toStrictEqual({ interest: 'Slovak mountain huts', strength: 'like' });
    expect(post?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(state.cards.map((card) => card.interest)).toEqual(['Slovak mountain huts']);
    expect(field).toHaveValue('');
  });

  it('does not send a description that is empty or too short', async () => {
    const { app } = await openWizard('/onboarding?step=interests', options);
    const field = await screen.findByLabelText('Describe something you want to read about');

    await app.user.click(screen.getByRole('button', { name: 'Add interest' }));
    expect(await screen.findByText('Describe what you want to read about.')).toBeVisible();

    await app.user.type(field, 'ab');
    await app.user.click(screen.getByRole('button', { name: 'Add interest' }));
    expect(await screen.findByText('Describe it in at least 3 characters.')).toBeVisible();
    expect(app.calls('POST /cards')).toHaveLength(0);
  });

  it('explains a refused description in words', async () => {
    const { app } = await openWizard('/onboarding?step=interests', {
      ...options,
      routes: {
        'POST /cards': () => failure(409, 'CONFLICT', { reason: 'already_held' }),
      },
    });

    await app.user.type(
      await screen.findByLabelText('Describe something you want to read about'),
      'Rust programming',
    );
    await app.user.click(screen.getByRole('button', { name: 'Add interest' }));

    expect(
      await screen.findByText(/You already have a card with this text, with a different strength/),
    ).toBeVisible();
  });

  it('warns before continuing without an interest, and then allows it', async () => {
    const { app } = await openWizard('/onboarding?step=interests', options);

    await app.user.click(await screen.findByRole('button', { name: 'Continue' }));

    const dialog = await screen.findByRole('dialog', { name: 'Continue without interests?' });
    expect(within(dialog).getByText(/“For you” stays empty/)).toBeVisible();
    expect(app.router.state.location.search).toEqual({ step: 'interests' });

    await app.user.click(within(dialog).getByRole('button', { name: 'Add interests' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.router.state.location.search).toEqual({ step: 'interests' });

    await app.user.click(screen.getByRole('button', { name: 'Continue' }));
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue anyway' }),
    );

    expect(await heading('Choose articles to teach Bantoozi')).toBeVisible();
    expect(app.router.state.location.search).toEqual({ step: 'calibrate' });
  });

  it('does not warn once there is an interest', async () => {
    const { app } = await openWizard('/onboarding?step=interests', options);
    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });
    await app.user.click(within(likes).getByRole('button', { name: 'Rust programming' }));
    await waitFor(() =>
      expect(within(likes).getByRole('button', { name: 'Rust programming' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );

    await app.user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await heading('Choose articles to teach Bantoozi')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('counts only the cards the person wants to read about: a never card alone still warns', async () => {
    const { app } = await openWizard('/onboarding?step=interests', options);
    const never = await screen.findByRole('region', { name: 'Never show me…' });
    await app.user.click(within(never).getByRole('button', { name: 'Space launches' }));
    await waitFor(() =>
      expect(within(never).getByRole('button', { name: 'Space launches' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );

    await app.user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByRole('dialog', { name: 'Continue without interests?' }),
    ).toBeVisible();
  });
});

describe('finishing (spec 09 §4 step 5)', () => {
  const options: WizardOptions = {
    subscriptions: [feed('1', 'Alpha')],
    library: [rust],
  };

  it('sets only onboardingCompletedAt, once, and opens For you when there are personalized results', async () => {
    const { app, server } = await openWizard('/onboarding?step=calibrate', {
      ...options,
      counts: counts({ forYou: 4, new: 9 }),
    });

    await app.user.click(await screen.findByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/for_you'));
    const patches = app.calls('PATCH /me');
    expect(patches).toHaveLength(1);
    const body = bodyOf(patches[0]!) as { preferences: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['preferences']);
    expect(Object.keys(body.preferences)).toEqual(['onboardingCompletedAt']);
    expect(body.preferences['onboardingCompletedAt']).toMatch(ISO);
    expect(patches[0]?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(server.me?.preferences.onboardingCompletedAt).toMatch(ISO);
    const counted = app.calls('GET /articles/counts');
    expect(counted.at(-1)?.query.toString()).toBe('');
  });

  it('opens New, where untrained articles can be read, when nothing is personalized yet', async () => {
    const { app } = await openWizard('/onboarding?step=calibrate', {
      ...options,
      counts: counts({ forYou: 0, new: 9 }),
    });

    await app.user.click(await screen.findByRole('button', { name: 'Skip for now' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    expect(app.calls('PATCH /me')).toHaveLength(1);
  });

  it('sends it once however often the button is pressed', async () => {
    const { app } = await openWizard('/onboarding?step=calibrate', options);
    const finish = await screen.findByRole('button', { name: 'Finish' });

    await app.user.dblClick(finish);

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    expect(app.calls('PATCH /me')).toHaveLength(1);
  });

  it('stays in the wizard, and sends the same request again, when saving fails', async () => {
    let attempts = 0;
    const { app } = await openWizard('/onboarding?step=calibrate', {
      ...options,
      routes: {
        'PATCH /me': () => {
          attempts += 1;
          return attempts === 1 ? failure(500, 'INTERNAL') : json(200, makeMe());
        },
      },
    });

    await app.user.click(await screen.findByRole('button', { name: 'Finish' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(app.router.state.location.pathname).toBe('/onboarding');

    await app.user.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    const [first, second] = app.calls('PATCH /me');
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(bodyOf(second!)).toStrictEqual(bodyOf(first!));
  });

  it('does not save again when the wizard is opened after it was completed', async () => {
    const { app } = await openWizard('/onboarding?step=calibrate', {
      ...options,
      me: makeMe(),
    });

    await app.user.click(await screen.findByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    expect(app.calls('PATCH /me')).toHaveLength(0);
  });

  it('never starts inference or analysis on the way through all four steps', async () => {
    const { app } = await openWizard('/onboarding', {
      library: [rust, battery],
      routes: {},
    });

    await app.user.click(await screen.findByRole('button', { name: 'Get started' }));
    await app.user.type(
      await screen.findByLabelText('Website or feed address'),
      'https://example.com/a.xml',
    );
    await app.user.click(screen.getByRole('button', { name: 'Add feed' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    await app.user.click(
      within(await bundleItem('Tech')).getByRole('button', { name: /^Add these \d+ feeds: Tech$/ }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Tech' })).getByText(/^Added \d+,/),
      ).toBeVisible(),
    );
    await app.user.click(screen.getByRole('button', { name: 'Continue' }));
    const likes = await screen.findByRole('region', { name: 'Pick topics you like' });
    await app.user.click(within(likes).getByRole('button', { name: 'Rust programming' }));
    await waitFor(() =>
      expect(within(likes).getByRole('button', { name: 'Rust programming' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await app.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await heading('Choose articles to teach Bantoozi')).toBeVisible();
    await app.user.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    const paths = app.requests.map((request) => request.pathname);
    expect(paths.filter((path) => /\/(inference|analyze)$/.test(path))).toEqual([]);
    expect(app.calls('PATCH /me')).toHaveLength(1);
  });
});

describe('the wizard and the guard of the app', () => {
  it('can be opened again and still sets nothing', async () => {
    const { app } = await openWizard('/onboarding', { me: makeMe() });

    expect(await heading('Welcome to Bantoozi')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeVisible();
    expect(app.calls('PATCH /me')).toHaveLength(0);
  });

  it('holds a newcomer who opens another page at the welcome step', async () => {
    const { app } = await openWizard('/read/for_you', { me: newcomer() });

    expect(await heading('Welcome to Bantoozi')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeVisible();
    expect(app.router.state.location.pathname).toBe('/onboarding');
  });
});

describe('controls (spec 09 §1)', () => {
  it('are named, 44 px high and show a focus ring on the welcome step', async () => {
    await openWizard('/onboarding');
    await screen.findByRole('button', { name: 'Get started' });

    expect(expectUsableControls()).toBeGreaterThanOrEqual(1);
  });

  it('are named, 44 px high and show a focus ring on the feeds step', async () => {
    const tech = bundle('tech');
    const { app } = await openWizard('/onboarding?step=feeds', {
      subscriptions: [feed('1', 'Alpha')],
    });
    await app.user.click(
      within(await bundleItem('Tech')).getByRole('button', {
        name: `Add these ${tech.urls.length} feeds: Tech`,
      }),
    );
    await screen.findByText(/^Added \d+,/);

    expect(expectUsableControls()).toBeGreaterThanOrEqual(14);
  });

  it('are named, 44 px high and show a focus ring on the interests step', async () => {
    await openWizard('/onboarding?step=interests', {
      subscriptions: [feed('1', 'Alpha')],
      routes: {
        'GET /library': () =>
          json(200, {
            items: [rust, battery, space].map((card) => ({ ...card, held: false })),
            nextCursor: 'next',
          }),
      },
    });
    await screen.findByRole('region', { name: 'Never show me…' });
    expect(screen.getByRole('button', { name: 'Show more topics' })).toBeVisible();

    expect(expectUsableControls()).toBeGreaterThanOrEqual(11);
  });

  it('are named, 44 px high and show a focus ring in the warning dialog', async () => {
    const { app } = await openWizard('/onboarding?step=interests', {
      subscriptions: [feed('1', 'Alpha')],
      library: [rust],
    });
    await app.user.click(await screen.findByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Continue without interests?' });

    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
    expect(expectUsableControls()).toBeGreaterThanOrEqual(2);
  });
});
