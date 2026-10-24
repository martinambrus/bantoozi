import type { AdminMetrics, AdminOverview } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { QueryState } from '../../components/states/query-state.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { Alert, Cell, DataTable, Hint, PageTitle, RowHeader, SectionTitle } from './admin-ui.js';
import { Time, useFormat } from './format.js';
import { BackgroundWork, useQueueWatch, useTick } from './queue-watch.js';
import { useAdminKey } from './use-admin.js';

type Breaker = AdminOverview['engine']['breakers']['typesafe'];
type BreakerEngine = keyof AdminOverview['engine']['breakers'];

const LANES = ['for_you', 'maybe', 'everything', 'hidden'] as const;
const ENGINES = ['typesafe', 'llm'] as const satisfies readonly BreakerEngine[];
const BREAKER_TONES: Record<Breaker['state'], BadgeTone> = {
  closed: 'success',
  open: 'danger',
  half_open: 'warning',
  auth: 'danger',
};

/** The worker applies a requested reset within one 10 s poll; we look every 2 s for 30 s. */
const POLL_MS = 2000;
const WATCH_MS = 30_000;

interface ResetWatch {
  engine: BreakerEngine;
  /** The server's time of the request, which the worker echoes once it has applied the reset. */
  requestedAt: string;
  /** This browser's clock when the request was accepted. */
  startedAt: number;
}

/**
 * Whether the watch period of the request is still running, by this browser's clock: failed reads
 * of the overview must not hold the wait (and the busy Reset) open.
 */
function isWatching(now: number, watch: ResetWatch): boolean {
  return now - watch.startedAt < WATCH_MS;
}

function isApplied(data: AdminOverview | undefined, watch: ResetWatch): boolean {
  const breaker = data?.engine.breakers[watch.engine];
  return breaker?.state === 'closed' && breaker.resetRequestedAt === watch.requestedAt;
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="flex flex-col gap-1 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <p id={id} className="text-sm font-medium text-slate-600 dark:text-slate-300">
        {label}
      </p>
      {children}
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <p className="text-2xl font-semibold">{children}</p>;
}

function Tiles({ overview }: { overview: AdminOverview }) {
  const { t } = useTranslation('admin');
  const format = useFormat();
  const { users, feeds, articlesToday, engine, translations } = overview;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Tile label={t('overview.tiles.users')}>
        <Value>{format.number(users.total)}</Value>
        <Hint>{t('overview.tiles.active7d', { value: format.number(users.active7d) })}</Hint>
      </Tile>
      <Tile label={t('overview.tiles.feeds')}>
        {(['active', 'quarantined', 'dead', 'paused'] as const).map((status) => (
          <p key={status}>
            {t(`overview.tiles.feedStatus.${status}`, { value: format.number(feeds[status]) })}
          </p>
        ))}
      </Tile>
      <Tile label={t('overview.tiles.articles')}>
        <Value>{format.number(articlesToday)}</Value>
      </Tile>
      <Tile label={t('overview.tiles.spend')}>
        <Value>
          {t('overview.tiles.ofCap', {
            used: format.usd(engine.spendTodayUsd),
            cap: format.usd(engine.dailyBudgetUsd),
          })}
        </Value>
        <Hint>{t('overview.tiles.committedSpend')}</Hint>
        {engine.exemptSpendTodayUsd > 0 && (
          <Hint>
            {t('overview.tiles.exemptSpend', { value: format.usd(engine.exemptSpendTodayUsd) })}
          </Hint>
        )}
      </Tile>
      <Tile label={t('overview.tiles.llm')}>
        <Value>
          {t('overview.tiles.ofCap', {
            used: format.number(engine.llmCallsToday),
            cap: format.number(engine.llmDailyCap),
          })}
        </Value>
      </Tile>
      <Tile label={t('overview.tiles.tier2')}>
        <Value>
          {t('overview.tiles.ofCap', {
            used: format.number(translations.tier2CallsToday),
            cap: format.number(translations.tier2DailyCap),
          })}
        </Value>
      </Tile>
    </div>
  );
}

function Queues({ queues }: { queues: AdminOverview['queues'] }) {
  const { t } = useTranslation('admin');
  const format = useFormat();
  if (queues.length === 0) return <Hint>{t('overview.queues.empty')}</Hint>;
  return (
    <DataTable
      caption={t('overview.queues.title')}
      hideCaption
      columns={[
        t('overview.queues.queue'),
        t('overview.queues.waiting'),
        t('overview.queues.retrying'),
        t('overview.queues.running'),
        t('overview.queues.failed'),
      ]}
    >
      {queues.map((queue) => (
        <tr key={queue.queue}>
          <RowHeader>{queue.queue}</RowHeader>
          <Cell>{format.number(queue.created)}</Cell>
          <Cell>{format.number(queue.retry)}</Cell>
          <Cell>{format.number(queue.active)}</Cell>
          <Cell>{format.number(queue.failed)}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}

type WatchStatus = 'waiting' | 'stalled' | null;

function EngineCard({
  engine,
  breaker,
  watchStatus,
  locked,
  onReset,
}: {
  engine: BreakerEngine;
  breaker: Breaker;
  watchStatus: WatchStatus;
  /** Another engine's reset is still waiting for the worker: one reset is followed at a time. */
  locked: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation('admin');
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <h4 id={id} className="font-semibold">
        {t(`overview.engines.${engine}`)}
      </h4>
      <p>
        <Badge tone={BREAKER_TONES[breaker.state]}>{t(`overview.breaker.${breaker.state}`)}</Badge>
      </p>
      <Hint>{t(`overview.breaker.explain.${breaker.state}`)}</Hint>
      {breaker.openUntil === null ? null : (
        <p className="text-sm">
          {t('overview.breaker.pausedUntil')} <Time value={breaker.openUntil} />
        </p>
      )}
      {breaker.resetRequestedAt === null ? null : (
        <p className="text-sm">
          {t('overview.breaker.lastReset')} <Time value={breaker.resetRequestedAt} />
        </p>
      )}
      {watchStatus === null ? null : (
        <p role="status" className="text-sm font-medium">
          {t(`overview.breaker.${watchStatus}`)}
        </p>
      )}
      <div>
        <Button
          variant="secondary"
          loading={watchStatus === 'waiting'}
          disabled={locked}
          onClick={onReset}
        >
          {t('overview.breaker.reset')}
        </Button>
      </div>
    </div>
  );
}

/** The like-rate per lane and the regret rate of the latest daily snapshot (spec 10 §7). */
function Metrics({ metrics }: { metrics: AdminMetrics | null | undefined }) {
  const { t } = useTranslation('admin');
  const format = useFormat();
  const percent = (rate: number | null): string =>
    rate === null
      ? t('overview.metrics.none')
      : t('overview.metrics.percent', { value: format.number(Math.round(rate * 100)) });
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('overview.metrics.title')}</SectionTitle>
      {metrics === null || metrics === undefined ? (
        <Hint>{t('overview.metrics.empty')}</Hint>
      ) : (
        <>
          <Hint>{t('overview.metrics.day', { day: metrics.day })}</Hint>
          <h4 className="font-semibold">{t('overview.metrics.likeRate')}</h4>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {LANES.map((lane) => {
              const stats = metrics.lanes[lane];
              return (
                <Tile key={lane} label={t(`overview.metrics.lanes.${lane}`)}>
                  <Value>{percent(stats?.likeRate ?? null)}</Value>
                  <Hint>
                    {t('overview.metrics.rated', { value: format.number(stats?.rated ?? 0) })}
                  </Hint>
                </Tile>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label={t('overview.metrics.regret')}>
              <Value>{percent(metrics.regret.rate)}</Value>
              <Hint>
                {metrics.regret.denominator === 0
                  ? t('overview.metrics.regretNone')
                  : t('overview.metrics.regretDetail', {
                      numerator: format.number(metrics.regret.numerator),
                      denominator: format.number(metrics.regret.denominator),
                    })}
              </Hint>
            </Tile>
          </div>
        </>
      )}
    </section>
  );
}

/** An answer that comes after the sign-in that asked has ended shows nothing. */
function Translations({ overview }: { overview: AdminOverview }) {
  const { t } = useTranslation('admin');
  const format = useFormat();
  const toast = useToast();
  const session = useSession();
  const [failure, setFailure] = useState<unknown>(null);
  const work = useQueueWatch();
  const reprocess = useApiMutation(routes.adminTranslationsReprocess, {
    onMutate: () => session.currentSignIn(),
    onSuccess: (_answer, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      setFailure(null);
      work.start(['house.retranslate-skipped']);
      toast.show({ message: t('overview.translations.queued'), tone: 'success' });
    },
    onError: setFailure,
  });
  const { last24h } = overview.translations;
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('overview.translations.title')}</SectionTitle>
      {last24h.length === 0 ? (
        <Hint>{t('overview.translations.empty')}</Hint>
      ) : (
        <DataTable
          caption={t('overview.translations.caption')}
          columns={[
            t('overview.translations.engine'),
            t('overview.translations.quality'),
            t('overview.translations.stored'),
          ]}
        >
          {last24h.map((row) => (
            <tr key={`${row.engine}-${row.quality}`}>
              <RowHeader>{t(`overview.translations.engines.${row.engine}`)}</RowHeader>
              <Cell>{t(`overview.translations.qualities.${row.quality}`)}</Cell>
              <Cell>{format.number(row.count)}</Cell>
            </tr>
          ))}
        </DataTable>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button
          variant="secondary"
          loading={reprocess.isPending || work.busy}
          onClick={() => reprocess.mutate()}
        >
          {t('overview.translations.reprocess')}
        </Button>
        {work.busy ? <BackgroundWork label={t('overview.translations.running')} /> : null}
        <Hint>{t('overview.translations.reprocessHint')}</Hint>
        {failure === null ? null : <Alert>{errorMessage(t, failure)}</Alert>}
      </div>
    </section>
  );
}

export function AdminOverviewPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const queryClient = useQueryClient();
  const session = useSession();
  const adminKey = useAdminKey();
  const reset = useApiMutation(routes.adminEngineResetBreaker);
  const [watch, setWatch] = useState<ResetWatch | null>(null);
  const [confirming, setConfirming] = useState<BreakerEngine | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: adminKey('overview'),
    queryFn: ({ signal }) => api.call(routes.adminOverview, undefined, { signal }),
    refetchInterval: (query) =>
      watch !== null && !isApplied(query.state.data, watch) && isWatching(Date.now(), watch)
        ? POLL_MS
        : false,
  });

  const pending = watch !== null && !isApplied(overview.data, watch);
  const now = useTick(pending);
  let watchStatus: WatchStatus = null;
  if (pending) watchStatus = isWatching(now, watch) ? 'waiting' : 'stalled';

  async function resetBreaker(engine: BreakerEngine) {
    setNotice(null);
    const signIn = session.currentSignIn();
    try {
      const result = await reset.mutateAsync({ body: { engine } });
      if (session.currentSignIn() !== signIn) return;
      const key = adminKey('overview');
      setWatch({ engine, requestedAt: result.resetRequestedAt, startedAt: Date.now() });
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      if (!(isApiError(error) && error.reason === 'circuit_invalid')) throw error;
      setNotice(t('overview.breaker.circuitInvalid'));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>{t('nav.overview')}</PageTitle>
      {notice === null ? null : <Alert>{notice}</Alert>}
      <QueryState query={overview}>
        {(data) => (
          <>
            <Tiles overview={data} />
            <section className="flex flex-col gap-3">
              <SectionTitle>{t('overview.engines.title')}</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2">
                {ENGINES.map((engine) => (
                  <EngineCard
                    key={engine}
                    engine={engine}
                    breaker={data.engine.breakers[engine]}
                    watchStatus={watch?.engine === engine ? watchStatus : null}
                    locked={watchStatus === 'waiting' && watch?.engine !== engine}
                    onReset={() => setConfirming(engine)}
                  />
                ))}
              </div>
            </section>
            <section className="flex flex-col gap-3">
              <SectionTitle>{t('overview.queues.title')}</SectionTitle>
              <Queues queues={data.queues} />
            </section>
            <Metrics metrics={data.metrics} />
            <Translations overview={data} />
          </>
        )}
      </QueryState>
      {confirming === null ? null : (
        <ConfirmDialog
          open
          onClose={() => setConfirming(null)}
          onConfirm={() => resetBreaker(confirming)}
          title={t('overview.breaker.resetTitle', { engine: t(`overview.engines.${confirming}`) })}
          body={t('overview.breaker.resetBody')}
          confirmLabel={t('overview.breaker.reset')}
        />
      )}
    </div>
  );
}
