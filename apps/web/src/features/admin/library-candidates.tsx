import type { LibraryCandidate } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { Alert, Fact, Facts, Hint, SectionTitle } from './admin-ui.js';
import { Time } from './format.js';
import {
  canPromote,
  canRequest,
  eligibilityKey,
  type EligibilityKey,
} from './library-eligibility.js';
import { TopicList } from './library-topics.js';
import { PromoteDialog } from './promote-dialog.js';
import { PromotionRequestDialog } from './promotion-request-dialog.js';
import { useAdminKey, useRefresh } from './use-admin.js';

const TONES: Record<EligibilityKey, BadgeTone> = {
  approved: 'success',
  inactive: 'info',
  awaiting_approval: 'warning',
  declined: 'danger',
  unknown_creator: 'danger',
  no_request: 'neutral',
  insufficient_holders: 'warning',
  expired: 'warning',
  stale_payload: 'warning',
  promoted: 'success',
};

function ProposedListing({ candidate }: { candidate: LibraryCandidate }) {
  const { t } = useTranslation('admin');
  const headingId = useId();
  const { request } = candidate;
  if (request === null) return null;
  const { payload } = request;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h5 id={headingId} className="text-sm font-semibold">
        {t('library.candidates.listing')}
      </h5>
      <Facts>
        <Fact label={t('library.candidates.slug')}>
          {payload.slug === null ? '—' : <code>{payload.slug}</code>}
        </Fact>
        <Fact label={t('library.candidates.publicTitle')}>{payload.title ?? '—'}</Fact>
        <Fact label={t('library.candidates.skTitle')}>{payload.titleSk ?? '—'}</Fact>
        <Fact label={t('library.fields.topics')}>
          {payload.topicIds.length === 0 ? '—' : <TopicList topics={payload.topicIds} />}
        </Fact>
        <Fact label={t('library.candidates.requested')}>
          <Time value={request.requestedAt} />
        </Fact>
        {request.respondedAt === null ? null : (
          <Fact label={t('library.candidates.answered')}>
            <Time value={request.respondedAt} />
          </Fact>
        )}
        {request.expiresAt === null ? null : (
          <Fact label={t('library.candidates.expires')}>
            <Time value={request.expiresAt} />
          </Fact>
        )}
        {request.promotedAt === null || request.authorizationKind === null ? null : (
          <Fact label={t('library.candidates.publishedOn')}>
            <Time value={request.promotedAt} />
            <p className="mt-1">{t(`library.basis.${request.authorizationKind}`)}</p>
          </Fact>
        )}
      </Facts>
    </section>
  );
}

function CandidateEntry({
  candidate,
  onPromote,
  onRequest,
}: {
  candidate: LibraryCandidate;
  onPromote: () => void;
  onRequest: () => void;
}) {
  const { t } = useTranslation('admin');
  const headingId = useId();
  const key = eligibilityKey(candidate.promotionEligibility);
  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 id={headingId} className="text-base font-semibold">
            {candidate.title}
          </h4>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('library.holders', { count: candidate.holders })}</span>
            <Badge tone={TONES[key]}>{t(`library.eligibility.${key}.label`)}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canPromote(candidate) ? (
            <Button
              size="sm"
              aria-label={t('library.promote.label', { title: candidate.title })}
              onClick={onPromote}
            >
              {t('library.promote.button')}
            </Button>
          ) : null}
          {canRequest(candidate) ? (
            <Button
              size="sm"
              variant="secondary"
              aria-label={t('library.requests.label', { title: candidate.title })}
              onClick={onRequest}
            >
              {t('library.requests.button')}
            </Button>
          ) : null}
        </div>
      </div>
      <Hint>{t(`library.eligibility.${key}.explain`)}</Hint>
      <Facts>
        <Fact label={t('library.fields.interest')}>{candidate.interest}</Fact>
        {candidate.notFor === null ? null : (
          <Fact label={t('library.fields.notFor')}>{candidate.notFor}</Fact>
        )}
        {candidate.request !== null || candidate.topicIds.length === 0 ? null : (
          <Fact label={t('library.fields.topics')}>
            <TopicList topics={candidate.topicIds} />
          </Fact>
        )}
      </Facts>
      <ProposedListing candidate={candidate} />
    </article>
  );
}

export function LibraryCandidates() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const adminKey = useAdminKey();
  const refresh = useRefresh();
  const headingId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<LibraryCandidate | null>(null);
  const [requesting, setRequesting] = useState<LibraryCandidate | null>(null);

  const candidates = useQuery({
    queryKey: adminKey('library', 'candidates'),
    queryFn: async ({ signal }) =>
      (await api.call(routes.adminLibraryCandidates, undefined, { signal })).items,
  });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <SectionTitle id={headingId}>{t('library.candidates.title')}</SectionTitle>
      <Hint>{t('library.candidates.intro')}</Hint>
      {notice === null ? null : <Alert>{notice}</Alert>}
      <QueryState
        query={candidates}
        isEmpty={(items) => items.length === 0}
        empty={<EmptyState title={t('library.candidates.empty')} />}
      >
        {(items) => (
          <ul className="flex flex-col gap-3">
            {items.map((candidate) => (
              <li key={candidate.cardId}>
                <CandidateEntry
                  candidate={candidate}
                  onPromote={() => {
                    setNotice(null);
                    setPromoting(candidate);
                  }}
                  onRequest={() => {
                    setNotice(null);
                    setRequesting(candidate);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {promoting === null ? null : (
        <PromoteDialog
          candidate={promoting}
          onClose={() => setPromoting(null)}
          onPromoted={() => void refresh('library')}
          onConflict={() => {
            setNotice(t('library.promote.conflict'));
            void refresh('library');
          }}
        />
      )}
      {requesting === null ? null : (
        <PromotionRequestDialog
          candidate={requesting}
          onClose={() => setRequesting(null)}
          onCreated={() => void refresh('library', 'candidates')}
        />
      )}
    </section>
  );
}
