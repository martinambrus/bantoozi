import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { LoadingState } from '../../components/states/loading-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { FormAlert } from '../auth/form-alert.js';
import { ExampleLists } from './examples.js';
import { useCardCache, useRequests, type PublicationRequest } from './queries.js';
import { useTopicIndex, type TopicIndex } from './topics.js';

const STATUS_TONES: Record<PublicationRequest['status'], BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'neutral',
  expired: 'neutral',
  promoted: 'info',
};

/** The name of a language in the interface language; the code itself when it has none. */
function languageName(code: string, interfaceLanguage: string): string {
  try {
    return new Intl.DisplayNames([interfaceLanguage], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function RequestItem({
  request,
  topics,
}: {
  request: PublicationRequest;
  topics: TopicIndex | null;
}) {
  const { t, i18n } = useTranslation('interests');
  const cache = useCardCache();
  const respond = useApiMutation(routes.cardPublicationRespond);
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const titleId = useId();
  const { card, proposed } = request;
  const isLabel = request.kind === 'label';

  async function answer(decision: 'approve' | 'decline') {
    if (busy !== null) return;
    setBusy(decision);
    setMessage(null);
    try {
      const answered = await respond.mutateAsync({
        params: { id: request.id },
        body: { decision, expectedVersion: request.version },
      });
      cache.replaceRequest(answered.request);
    } catch (error) {
      if (isApiError(error) && (error.status === 409 || error.status === 404)) {
        // Someone, or something, answered or withdrew it first: show where it stands now.
        cache.refreshRequests();
        setMessage(t('requests.changed'));
      } else {
        setMessage(errorMessage(t, error));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className="min-w-0 break-words text-base font-semibold">
          {card.title}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {isLabel ? <Badge>{t('requests.item.label')}</Badge> : null}
          <Badge tone={STATUS_TONES[request.status]}>
            {t(`requests.status.${request.status}`)}
          </Badge>
        </div>
      </div>
      <dl className="flex flex-col gap-3">
        {proposed.title === null ? null : (
          <Field label={t('requests.item.publicTitle')}>{proposed.title}</Field>
        )}
        {Object.entries(proposed.i18n).map(([code, texts]) => {
          const language = languageName(code, i18n.language);
          return (
            <div key={code} className="flex flex-col gap-3">
              {texts['title'] === undefined ? null : (
                <Field label={t('requests.item.titleIn', { language })}>{texts['title']}</Field>
              )}
              {texts['interest'] === undefined ? null : (
                <Field label={t('requests.item.interestIn', { language })}>
                  {texts['interest']}
                </Field>
              )}
              {texts['notFor'] === undefined ? null : (
                <Field label={t('requests.item.notForIn', { language })}>{texts['notFor']}</Field>
              )}
            </div>
          );
        })}
        <Field label={isLabel ? t('requests.item.definition') : t('requests.item.interest')}>
          {card.interest}
        </Field>
        {card.notFor === null ? null : (
          <Field label={t('requests.item.notFor')}>{card.notFor}</Field>
        )}
        {proposed.topicIds.length === 0 ? null : (
          <Field label={t('requests.item.topics')}>
            <span className="flex flex-wrap gap-1.5">
              {proposed.topicIds.map((id) => (
                <Badge key={id}>{topics?.name(id) ?? id}</Badge>
              ))}
            </span>
          </Field>
        )}
      </dl>
      <ExampleLists
        yes={card.examplesYes}
        no={card.examplesNo}
        moreLabel={t('requests.item.examplesYes')}
        lessLabel={t('requests.item.examplesNo')}
      />
      {message === null ? null : <FormAlert>{message}</FormAlert>}
      {request.status === 'pending' || request.status === 'approved' ? (
        <div className="flex flex-wrap gap-2">
          {request.status === 'pending' ? (
            <Button
              loading={busy === 'approve'}
              disabled={busy !== null}
              aria-describedby={titleId}
              onClick={() => void answer('approve')}
            >
              {t('requests.approve')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            loading={busy === 'decline'}
            disabled={busy !== null}
            aria-describedby={titleId}
            onClick={() => void answer('decline')}
          >
            {t('requests.decline')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function About() {
  const { t } = useTranslation('interests');
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-xl bg-slate-100 p-4 text-sm dark:bg-slate-800"
    >
      <h3 id={headingId} className="font-semibold">
        {t('requests.about.heading')}
      </h3>
      <p>{t('requests.about.reuse')}</p>
      <p>{t('requests.about.listing')}</p>
      <p>{t('requests.about.version')}</p>
      <p>{t('requests.about.silence')}</p>
      <p>{t('requests.about.inactivity')}</p>
    </section>
  );
}

/** Asks for the creator's answer to the exact card a public listing would show. */
export function PublicationRequests() {
  const { t } = useTranslation('interests');
  const requests = useRequests();
  const { topics, index } = useTopicIndex();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-xl font-semibold">
          {t('requests.heading')}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('requests.lead')}</p>
      </div>
      <About />
      <QueryState
        query={requests}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title={t('requests.emptyTitle')} body={t('requests.emptyBody')} />}
      >
        {(list) =>
          // The topic names come first, so the topics of a card are never shown as codes.
          topics.isLoading ? (
            <LoadingState />
          ) : (
            <ul aria-labelledby={headingId} className="flex flex-col gap-3">
              {list.map((request) => (
                <RequestItem key={request.id} request={request} topics={index} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}
