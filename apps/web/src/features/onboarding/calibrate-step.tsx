import type { Subscription } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { Select } from '../../components/select.js';
import { ClassificationControls } from '../feeds/classification-controls.js';
import { displayTitle } from '../feeds/folders.js';
import { InlineAlert } from '../feeds/inline-alert.js';
import { AnalyzePanel } from '../training/analyze-panel.js';
import { useArticleSelection } from '../training/selection.js';
import { ArticlePicker } from './article-picker.js';
import { joinBatch, type Batch } from './batch.js';
import { CalibrationRound } from './calibration-round.js';
import { ProgressReport } from './progress-report.js';
import { StepFooter } from './step-footer.js';
import type { StepProps } from './steps.js';
import { useBatchProgress, useRoundOpen } from './use-batch-progress.js';
import { useFinish } from './use-finish.js';

export interface CalibrateStepProps extends StepProps {
  /** The feeds the account follows; there is at least one. */
  subscriptions: readonly Subscription[];
}

/**
 * The last step (spec 09 §4 step 4): the person picks articles of a feed to have analyzed, rates a
 * few of them, and finishes. Nothing is analyzed or classified except by the buttons that say so.
 */
export function CalibrateStep({ go, subscriptions }: CalibrateStepProps) {
  const { t } = useTranslation('onboarding');
  const selection = useArticleSelection();
  const finishing = useFinish();
  const [feedId, setFeedId] = useState(() => subscriptions[0]?.feed.id ?? '');
  const [batch, setBatch] = useState<Batch | null>(null);
  const progress = useBatchProgress(batch);
  const roundOpen = useRoundOpen(batch, progress);
  const automaticId = useId();

  const subscription =
    subscriptions.find((candidate) => candidate.feed.id === feedId) ?? subscriptions[0];
  if (subscription === undefined) return null;
  const busy = finishing.pressed !== null;

  return (
    <>
      <p className="text-base">{t('calibrate.lead')}</p>
      <Select
        label={t('calibrate.feed')}
        value={subscription.feed.id}
        onChange={(event) => {
          setFeedId(event.target.value);
          selection.clear();
        }}
      >
        {subscriptions.map((candidate) => (
          <option key={candidate.feed.id} value={candidate.feed.id}>
            {displayTitle(candidate)}
          </option>
        ))}
      </Select>
      <ArticlePicker feedId={subscription.feed.id} selection={selection} />
      <AnalyzePanel
        subscription={subscription}
        items={selection.items}
        onDrop={selection.remove}
        onSubmitted={(requests) => {
          const now = Date.now();
          setBatch((current) => joinBatch(current, subscription.feed.id, requests, now));
          selection.clear();
        }}
      />
      {progress === null ? null : <ProgressReport progress={progress} />}
      {roundOpen ? <CalibrationRound /> : null}
      <section aria-labelledby={automaticId} className="flex flex-col gap-3">
        <h2 id={automaticId} className="text-lg font-semibold">
          {t('calibrate.automatic.title')}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('calibrate.automatic.lead')}
        </p>
        <ClassificationControls subscription={subscription} />
      </section>
      {finishing.error === null ? null : (
        <InlineAlert>{errorMessage(t, finishing.error)}</InlineAlert>
      )}
      <StepFooter step="calibrate" go={go}>
        <Button
          variant="secondary"
          loading={finishing.pressed === 'skip'}
          disabled={busy}
          onClick={() => {
            void finishing.finish('skip');
          }}
        >
          {t('calibrate.skip')}
        </Button>
        <Button
          loading={finishing.pressed === 'finish'}
          disabled={busy}
          onClick={() => {
            void finishing.finish('finish');
          }}
        >
          {t('calibrate.finish')}
        </Button>
      </StepFooter>
    </>
  );
}
