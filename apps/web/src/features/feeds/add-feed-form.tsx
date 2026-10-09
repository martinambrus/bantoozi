import type { SubscribeOk } from '@bantoozi/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage, quotaDetails } from '../../components/error-message.js';
import { QuotaLimitState } from '../../components/states/quota-limit-state.js';
import { TextField } from '../../components/text-field.js';
import { displayTitle } from './folders.js';
import { InlineAlert } from './inline-alert.js';
import { useSubscriptionsCache } from './subscriptions.js';

type Candidates = Extract<SubscribeOk, { status: 'choose' }>['candidates'];

export function AddFeedForm() {
  const { t } = useTranslation('feeds');
  const cache = useSubscriptionsCache();
  const headingId = useId();
  const chooserHeading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState('');
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [added, setAdded] = useState<{ title: string; existing: boolean } | null>(null);
  // The list learns of a new subscription even when the answer comes after the form is gone (the
  // page was left); a choice of candidates changes nothing yet.
  const subscribe = useApiMutation(routes.subscriptionsCreate, {
    onSuccess: (result) => {
      if (!('status' in result)) void cache.refresh();
    },
  });

  useEffect(() => {
    if (candidates !== null) chooserHeading.current?.focus();
  }, [candidates]);

  function send(url: string, fromChooser: boolean) {
    if (subscribe.isPending) return;
    // The API answers 201 for a new subscription and 200 for an existing one, with the same body;
    // the client only hands on the body, so the list it showed before tells them apart.
    const knownFeeds = new Set(cache.known()?.map((subscription) => subscription.feed.id));
    // The answer clears the field only if it still holds this text; one typed meanwhile stays.
    const sent = address;
    setAdded(null);
    if (!fromChooser) setCandidates(null);
    subscribe.mutate(
      { body: { url } },
      {
        onSuccess: (result) => {
          if ('status' in result) {
            setCandidates(result.candidates);
            return;
          }
          const { subscription } = result;
          setCandidates(null);
          setAddress((current) => (current === sent ? '' : current));
          if (fromChooser) input.current?.focus();
          setAdded({
            title: displayTitle(subscription),
            existing: knownFeeds.has(subscription.feed.id),
          });
        },
      },
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = address.trim();
    if (url !== '') send(url, false);
  }

  const quota = quotaDetails(subscribe.error);
  const failure =
    subscribe.error === null ? null : quota === null ? (
      <InlineAlert>{errorMessage(t, subscribe.error)}</InlineAlert>
    ) : (
      <QuotaLimitState {...quota} />
    );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('add.title')}
      </h2>
      <form onSubmit={submit} className="flex flex-col items-start gap-3">
        <TextField
          ref={input}
          label={t('add.label')}
          hint={t('add.hint')}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          required
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="w-full"
        />
        <Button type="submit" loading={subscribe.isPending && candidates === null}>
          {t('add.submit')}
        </Button>
      </form>
      <p role="status" className={added === null ? 'sr-only' : 'text-sm font-medium'}>
        {added === null
          ? null
          : t(added.existing ? 'add.existing' : 'add.added', { title: added.title })}
      </p>
      {candidates === null ? null : (
        <Chooser
          candidates={candidates}
          headingRef={chooserHeading}
          pending={subscribe.isPending}
          onChoose={(url) => send(url, true)}
          onCancel={() => {
            setCandidates(null);
            input.current?.focus();
          }}
        />
      )}
      {failure}
    </section>
  );
}

function Chooser({
  candidates,
  headingRef,
  pending,
  onChoose,
  onCancel,
}: {
  candidates: Candidates;
  headingRef: RefObject<HTMLHeadingElement | null>;
  pending: boolean;
  onChoose: (url: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('feeds');
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-700"
    >
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold outline-none"
      >
        {t('add.chooser.title')}
      </h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('add.chooser.lead')}</p>
      <ul role="list" className="divide-y divide-slate-200 dark:divide-slate-700">
        {candidates.map((candidate) => {
          const name = candidate.title ?? candidate.url;
          return (
            <li
              key={candidate.url}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="break-words font-medium">{name}</p>
                {candidate.title === null ? null : (
                  <p className="break-all text-sm text-slate-600 dark:text-slate-300">
                    {candidate.url}
                  </p>
                )}
                <Badge className="w-fit">{candidate.type}</Badge>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                aria-label={t('add.chooser.add', { title: name })}
                onClick={() => onChoose(candidate.url)}
              >
                {t('common:actions.add')}
              </Button>
            </li>
          );
        })}
      </ul>
      <div>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          {t('common:actions.cancel')}
        </Button>
      </div>
    </section>
  );
}
