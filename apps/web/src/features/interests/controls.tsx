import type { Subscription } from '@bantoozi/shared';
import { Link } from '@tanstack/react-router';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { BUTTON_BASE, BUTTON_VARIANTS } from '../../components/button.js';
import { cx } from '../../components/cx.js';
import { SegmentedControl } from '../../components/segmented-control.js';
import { Select } from '../../components/select.js';
import { feedName } from './queries.js';
import { STRENGTHS, type Strength } from './strengths.js';

export interface StrengthControlProps {
  value: Strength;
  onChange: (strength: Strength) => void;
  hint?: ReactNode;
}

/** Must, Love, Like or Never: how strongly a card shapes the ranking (spec 06). */
export function StrengthControl({ value, onChange, hint }: StrengthControlProps) {
  const { t } = useTranslation('interests');
  return (
    <SegmentedControl
      label={t('strength.label')}
      options={STRENGTHS.map((strength) => ({ value: strength, label: t(`strength.${strength}`) }))}
      value={value}
      onValueChange={onChange}
      hint={hint}
    />
  );
}

export interface ScopeSelectProps {
  /** The feed id, or null for all feeds. */
  value: string | null;
  subscriptions: readonly Subscription[];
  onChange: (feedId: string | null) => void;
  disabled?: boolean | undefined;
  error?: ReactNode;
  className?: string | undefined;
  ref?: Ref<HTMLSelectElement> | undefined;
}

/** All feeds, or one of the subscribed feeds by the name the person knows it by. */
export function ScopeSelect({
  value,
  subscriptions,
  onChange,
  disabled,
  error,
  className,
  ref,
}: ScopeSelectProps) {
  const { t } = useTranslation('interests');
  // A card can outlive the subscription it was limited to: keep showing that it is limited.
  const unknown =
    value !== null && !subscriptions.some((subscription) => subscription.feed.id === value);
  return (
    <Select
      ref={ref}
      label={t('scope.label')}
      value={value ?? ''}
      disabled={disabled}
      error={error}
      className={className}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">{t('scope.all')}</option>
      {subscriptions.map((subscription) => (
        <option key={subscription.feed.id} value={subscription.feed.id}>
          {feedName(subscription)}
        </option>
      ))}
      {unknown ? <option value={value}>{t('scope.other')}</option> : null}
    </Select>
  );
}

/** A link to the library tab, styled as a button. */
export function BrowseLibraryLink() {
  const { t } = useTranslation('interests');
  return (
    <Link
      to="/interests"
      search={{ tab: 'library' }}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS.secondary, 'px-4 text-sm')}
    >
      {t('mine.browseLibrary')}
    </Link>
  );
}
