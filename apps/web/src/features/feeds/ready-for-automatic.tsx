import type { LearningFeedAgreement, Subscription } from '@bantoozi/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { EnableAutomaticDialog } from './enable-automatic-dialog.js';
import { displayTitle } from './folders.js';

/** Says a training feed's interests agree with the reader, and offers the confirmed switch to automatic. */
export function ReadyForAutomatic({
  subscription,
  agreement,
  label,
}: {
  subscription: Subscription;
  agreement: LearningFeedAgreement;
  /** Replaces the short agreement text. */
  label?: string | undefined;
}) {
  const { t } = useTranslation('feeds');
  const [asking, setAsking] = useState(false);
  const name = displayTitle(subscription);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {label ?? t('agreement.short.ready')}
      </span>
      <Button
        size="sm"
        variant="secondary"
        aria-label={t('agreement.enableLabel', { title: name })}
        onClick={() => setAsking(true)}
      >
        {t('agreement.enable')}
      </Button>
      <EnableAutomaticDialog
        open={asking}
        onClose={() => setAsking(false)}
        subscription={subscription}
        agreement={agreement}
      />
    </div>
  );
}
