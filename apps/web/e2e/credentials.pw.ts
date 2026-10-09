import {
  expectAnalysisComplete,
  requestAnalysis,
  switchClassificationOff,
} from './admin-support/analysis.js';
import { createCard } from './admin-support/cards.js';
import { ageCredentialValidation } from './admin-support/hooks.js';
import {
  activateButton,
  activateStaged,
  activateThroughApi,
  credentialOf,
  disableProvider,
  fact,
  openPanel,
  restoreWorkingKey,
  revalidateStaged,
  stageKey,
  stageThroughApi,
  validateStaged,
} from './admin-support/providers.js';
import {
  ExchangeLog,
  fixtureKeys,
  leaksIn,
  pageSources,
  routeSources,
  storeSources,
  type Source,
} from './admin-support/secrets.js';
import { newAccount, uniqueTag } from './reader-support/accounts.js';
import { subscribe, waitForExtraction } from './reader-support/api.js';
import { analysisRequests, arrive } from './reader-support/hooks.js';
import { staysTrueFor } from './reader-support/wait.js';
import { EMAILS } from './support/env.js';
import { expect, test } from './support/test.js';

/** How long the worker keeps what it read about a credential before it reads it again (spec 04 §1.2). */
const CREDENTIAL_CACHE_MS = 10_000;

const HOUR_MS = 3_600_000;

const CHANGED_IN_THE_MEANTIME =
  'This credential changed in the meantime. The latest state is shown; check it and try again.';

/**
 * Spec 09 §9, scenario 10: a wrong key fails its validation and leaves the working key active; a
 * valid candidate activates and a stale validation cannot; no key appears anywhere afterwards; a
 * disabled provider is not replaced by the environment key.
 */
test('credentials: a wrong key never replaces the working one, a stale validation cannot activate, a disabled provider has no fallback', async ({
  api,
  browse,
  control,
}) => {
  // Seven validations or analyses through the worker and a wait for its credential cache.
  test.setTimeout(300_000);

  const keys = fixtureKeys();
  const tag = uniqueTag();
  const readerEmail = newAccount('credentials-reader');

  const adminPage = await browse.as(EMAILS.admin);
  const admin = adminPage.request;
  const exchange = new ExchangeLog(adminPage);
  const reader = await api.login(readerEmail);

  // Not "tech": the environment check that runs after this one expects that feed to hold exactly
  // its own three articles, and the articles added here stay in the database.
  const culture = await control.feed('culture');
  const subscription = await subscribe(reader, culture.url);
  await waitForExtraction(control, culture.url, culture.items.length);

  /**
   * A new article, which only the model service can classify: an article that was analyzed once
   * stays analyzed for everyone who follows its feed, so reusing one would need no call at all.
   */
  const news = async (headline: string, about: string): Promise<string> =>
    (
      await arrive(control, 'culture', {
        title: `${headline} ${tag}`,
        excerpt: `${about} (${tag}).`,
      })
    ).item.title;
  const first = await news(
    'Quantum memory chips ship to labs',
    'Labs received quantum memory chips',
  );
  const second = await news(
    'Optical routers reach campus networks',
    'Campuses got optical routers',
  );
  const third = await news(
    'Battery recyclers open pilot lines',
    'Recyclers opened two pilot lines',
  );
  // Two more for the requests that are made while the provider is disabled.
  const early = await arrive(control, 'culture', {
    title: `Firmware signing keys rotated ${tag}`,
    excerpt: `Vendors rotated their firmware signing keys after the incident (${tag}).`,
  });
  const late = await arrive(control, 'culture', {
    title: `Satellite modems get open drivers ${tag}`,
    excerpt: `Volunteers published open drivers for satellite modems (${tag}).`,
  });

  /** The reader holds an interest that the fake model scores a match for the article. */
  const interestedIn = (title: string) =>
    createCard(reader, `${title.split(' ').slice(0, 2).join(' ')} developments`, 'like');

  /** The analysis of an article succeeds, and the fake model is asked to do it. */
  async function analysisSucceeds(title: string): Promise<void> {
    const before = await control.fakeCount();
    await requestAnalysis(reader, subscription.feed.id, title);
    await expectAnalysisComplete(reader, title);
    expect(await control.fakeCount(), `the model was asked about "${title}"`).toBeGreaterThan(
      before,
    );
  }

  let failure: { error: unknown } | undefined;
  try {
    let panel = await openPanel(adminPage);

    await test.step('the administrator stores and activates a key that the model service requires', async () => {
      await control.setFakeOptions({ apiKey: keys.working });
      await stageKey(adminPage, panel, keys.working);
      await expect(fact(panel, 'Staged key')).toContainText('Pending');
      await validateStaged(panel, 'Valid');
      await activateStaged(adminPage, panel);
      await expect(fact(panel, 'Configured source')).toHaveText('Stored encrypted in the database');
      await expect(fact(panel, 'State')).toHaveText('Enabled');
      await expect(fact(panel, 'Staged key')).toHaveText('None');
      expect((await credentialOf(admin)).activeVersion).not.toBeNull();

      // The environment key is "test", which the fake refuses: the stored key does the work.
      await interestedIn(first);
      await analysisSucceeds(first);
    });

    let workingVersion = '';
    await test.step('a wrong key fails its validation and the working key stays active', async () => {
      workingVersion = (await credentialOf(admin)).activeVersion!;
      await stageKey(adminPage, panel, keys.wrong);
      await validateStaged(panel, 'Invalid');
      await expect(panel).toContainText('The provider rejected the key.');
      await expect(activateButton(panel)).toBeDisabled();
      await expect(fact(panel, 'Active key')).toHaveText(`Version ${workingVersion}`);

      const rejected = await credentialOf(admin);
      expect(rejected).toMatchObject({
        enabled: true,
        activeVersion: workingVersion,
        candidateStatus: 'invalid',
        lastErrorCode: 'auth_rejected',
      });
      // Nothing activates an invalid candidate, whoever asks.
      expect((await activateThroughApi(admin, rejected)).status()).toBe(409);
      expect((await credentialOf(admin)).activeVersion).toBe(workingVersion);

      // The model service still requires the working key, and the next analysis still succeeds.
      await interestedIn(second);
      await analysisSucceeds(second);
    });

    await test.step('a valid candidate activates and replaces the working key', async () => {
      await control.setFakeOptions({ apiKey: keys.replacement });
      await stageKey(adminPage, panel, keys.replacement);
      await validateStaged(panel, 'Valid');
      await activateStaged(adminPage, panel);
      const replaced = await credentialOf(admin);
      expect(replaced.activeVersion).not.toBe(workingVersion);
      expect(replaced.candidateVersion).toBeNull();
      // The model service now requires the new key: the analysis only succeeds if it is in use.
      await interestedIn(third);
      await analysisSucceeds(third);
    });

    await test.step('a validation that a newer candidate superseded cannot activate', async () => {
      const replacedVersion = (await credentialOf(admin)).activeVersion!;
      await control.setFakeOptions({ apiKey: keys.superseded });
      await stageKey(adminPage, panel, keys.superseded);
      await validateStaged(panel, 'Valid');
      const validated = await credentialOf(admin);

      // A second administrator session stages another key while this page still shows a valid one.
      const other = await api.login(EMAILS.admin);
      expect((await stageThroughApi(other, keys.rival, validated.revision)).status()).toBe(200);

      await activateButton(panel).click();
      await expect(adminPage.getByRole('alert')).toHaveText(CHANGED_IN_THE_MEANTIME);
      // The panel shows the latest state: the rival candidate waits for its own validation.
      await expect(fact(panel, 'Staged key')).toContainText('Pending');
      await expect(activateButton(panel)).toBeDisabled();
      const current = await credentialOf(admin);
      expect(current).toMatchObject({ activeVersion: replacedVersion, candidateStatus: 'pending' });
      expect(current.candidateVersion).not.toBe(validated.candidateVersion);

      // The superseded validation does not carry over to the new candidate by any route.
      const stale = { candidateVersion: validated.candidateVersion, revision: current.revision };
      expect((await activateThroughApi(admin, stale)).status()).toBe(409);
      expect((await activateThroughApi(admin, current)).status()).toBe(409);
      expect((await credentialOf(admin)).activeVersion).toBe(replacedVersion);
    });

    await test.step('a validation older than a day cannot activate either, a fresh one can', async () => {
      const replacedVersion = (await credentialOf(admin)).activeVersion!;
      await control.setFakeOptions({ apiKey: keys.rival });
      await validateStaged(panel, 'Valid');
      await ageCredentialValidation(control, 'typesafe', 25);
      const aged = await credentialOf(admin);
      expect(aged.candidateStatus, 'the answer itself is still "valid"').toBe('valid');
      expect(Date.now() - Date.parse(aged.validatedAt ?? ''), 'its age').toBeGreaterThan(
        24 * HOUR_MS,
      );

      await activateButton(panel).click();
      await expect(adminPage.getByRole('alert')).toHaveText(CHANGED_IN_THE_MEANTIME);
      expect((await credentialOf(admin)).activeVersion).toBe(replacedVersion);

      await revalidateStaged(admin, panel);
      await activateStaged(adminPage, panel);
      expect((await credentialOf(admin)).activeVersion).not.toBe(replacedVersion);
    });

    await test.step('no key appears in the screen, the routes, the browser stores or the export', async () => {
      panel = await openPanel(adminPage);
      const sources: Source[] = [
        ...(await pageSources(adminPage, 'providers')),
        ...(await storeSources(adminPage)),
      ];
      for (const path of ['/admin', '/settings', '/admin/usage']) {
        await adminPage.goto(path);
        await expect(adminPage.getByRole('heading', { level: 1 })).toBeVisible();
        sources.push(...(await pageSources(adminPage, path)));
      }
      sources.push(
        ...(await exchange.sources()),
        ...(await routeSources(admin, [
          '/api/v1/admin/engine/credentials',
          '/api/v1/admin/overview',
          '/api/v1/admin/usage',
          '/api/v1/admin/settings',
          '/api/v1/admin/feeds',
          '/api/v1/admin/users',
          '/api/v1/admin/library',
          '/api/v1/me',
          '/api/v1/me/export',
        ])),
        ...(await routeSources(reader, ['/api/v1/me', '/api/v1/me/export'])),
      );
      expect(await exchange.answerCount(), 'the page made API calls to look at').toBeGreaterThan(5);
      expect(leaksIn(sources, keys), 'places that show a key').toEqual([]);
    });

    await test.step('a disabled provider is not replaced by the environment key', async () => {
      panel = await openPanel(adminPage);
      await disableProvider(adminPage, panel);
      const disabledAt = Date.now();
      await expect(fact(panel, 'State')).toHaveText('Disabled');
      await expect(fact(panel, 'Active key')).toHaveText('None');
      expect(await credentialOf(admin)).toMatchObject({
        enabled: false,
        activeVersion: null,
        candidateVersion: null,
      });

      const calls = await control.fakeCount();
      /** The request for analysis is parked, and no call reaches the model service. */
      async function parked(articleId: string, title: string): Promise<void> {
        await requestAnalysis(reader, subscription.feed.id, title);
        await expect
          .poll(
            async () =>
              (await analysisRequests(control, readerEmail))
                .filter((request) => request.articleId === articleId)
                .map((request) => `${request.status}:${request.errorCode}`),
            {
              message: `the request for "${title}" is parked`,
              timeout: 45_000,
              intervals: [250, 500],
            },
          )
          .toEqual(['pending:no_key']);
        await staysTrueFor(3_000, async () => {
          expect(await control.fakeCount(), 'no call reaches the model service').toBe(calls);
        });
      }
      await parked(early.articleId, early.item.title);

      // Past the worker's cache of the credential it has read the disabled state again.
      await expect
        .poll(() => Date.now() - disabledAt, {
          message: 'the worker has read the credential again',
          timeout: CREDENTIAL_CACHE_MS * 3,
          intervals: [500],
        })
        .toBeGreaterThan(CREDENTIAL_CACHE_MS + 1_000);
      await parked(late.articleId, late.item.title);
    });
  } catch (error) {
    failure = { error };
  }

  // The scenarios share one database: leave a working key and no reader waiting for one, also when
  // a step above failed. The first failure is the one that is reported.
  try {
    await control.setFakeOptions({ apiKey: null });
    await restoreWorkingKey(admin, keys.restored);
    await switchClassificationOff(reader, subscription.feed.id);
  } catch (error) {
    if (failure === undefined) failure = { error };
    else {
      // Both failed: the step is reported, and the cleanup is not lost.
      const reason = error instanceof Error ? error.message : 'unknown';
      test.info().annotations.push({ type: 'cleanup failed', description: reason });
      console.error(`The cleanup after the failed step failed too: ${reason}`);
    }
  }
  if (failure !== undefined) throw failure.error;
});
