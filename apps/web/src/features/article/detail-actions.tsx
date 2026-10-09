import { RULE_EXPIRY_DAYS, type ArticleListItem } from '@bantoozi/shared';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { cx } from '../../components/cx.js';
import {
  CheckIcon,
  ChevronDownIcon,
  EyeOffIcon,
  InfoIcon,
  MoreIcon,
  TagIcon,
} from '../../components/icons.js';
import { Menu, MenuItem, type MenuTriggerProps } from '../../components/menu.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';
import {
  useLabelPickerRequest,
  type LabelPickerRequest,
} from '../reader/shortcuts/label-picker.js';
import { BookmarkButton, RateButtons } from './article-buttons.js';
import { LabelDot } from './label-dot.js';
import type { ArticleActions } from './use-article-actions.js';
import { useLabels } from './use-labels.js';
import { useRuleActions } from './use-rule-actions.js';

const noop = () => {};

/** The button of the label picker; the "l" key presses it once for its article. */
function LabelTrigger({ articleId, ...trigger }: MenuTriggerProps & { articleId: string }) {
  const { t } = useTranslation('article');
  const request = useLabelPickerRequest();
  const answered = useRef<LabelPickerRequest | null>(null);
  const { ref } = trigger;

  useEffect(() => {
    if (request === null || request.articleId !== articleId || answered.current === request) return;
    answered.current = request;
    const button = ref.current;
    if (button !== null && button.getAttribute('aria-expanded') !== 'true') button.click();
    request.done();
  }, [request, articleId, ref]);

  return (
    <Button {...trigger} variant="secondary">
      <TagIcon className="size-4" />
      {t('detail.labels')}
    </Button>
  );
}

function LabelMenu({ item, actions }: { item: ArticleListItem; actions: ArticleActions }) {
  const { t, i18n } = useTranslation('article');
  const labels = useLabels(true);

  return (
    <Menu trigger={(props) => <LabelTrigger {...props} articleId={item.id} />}>
      {labels.data === undefined ? (
        <MenuItem disabled onSelect={noop}>
          {labels.isError ? errorMessage(i18n.t, labels.error) : t('common:states.loading')}
        </MenuItem>
      ) : labels.data.length === 0 ? (
        <MenuItem disabled onSelect={noop}>
          {t('detail.noLabels')}
        </MenuItem>
      ) : (
        labels.data.map((label) => {
          const assigned = item.labelIds.includes(label.id);
          return (
            <MenuItem
              key={label.id}
              onSelect={() =>
                assigned ? actions.removeLabel(label.id) : actions.addLabel(label.id)
              }
            >
              <span aria-hidden="true" className="flex items-center gap-2">
                <CheckIcon className={cx('size-4', !assigned && 'invisible')} />
                <LabelDot color={label.color} />
                {label.name}
              </span>
              <VisuallyHidden>
                {t(assigned ? 'detail.labelRemove' : 'detail.labelAdd', { name: label.name })}
              </VisuallyHidden>
            </MenuItem>
          );
        })
      )}
    </Menu>
  );
}

export interface DetailActionsProps {
  /** The article as displayed. */
  item: ArticleListItem;
  actions: ArticleActions;
  onWhyThis?: (() => void) | undefined;
}

/** The action bar of an expanded article (spec 09 §3.2). */
export function DetailActions({ item, actions, onWhyThis }: DetailActionsProps) {
  const { t } = useTranslation('article');
  const rules = useRuleActions(item);
  const more = [
    { label: 'detail.blockFeed', run: rules.blockFeed },
    { label: 'detail.blockDomain', run: rules.blockDomain },
    { label: 'detail.blockAuthor', run: rules.blockAuthor },
    { label: 'detail.boostFeed', run: rules.boostFeed },
  ].flatMap(({ label, run }) => (run === null ? [] : [{ label, run }]));

  return (
    <div
      role="group"
      aria-label={t('detail.actions')}
      className="flex flex-wrap items-center gap-2"
    >
      <RateButtons rating={item.rating} onRate={actions.rate} />
      <BookmarkButton bookmarked={item.bookmarkedAt !== null} onToggle={actions.toggleBookmark} />
      <LabelMenu item={item} actions={actions} />
      {onWhyThis === undefined ? null : (
        <Button variant="secondary" onClick={onWhyThis}>
          <InfoIcon className="size-4" />
          {t('detail.whyThis')}
        </Button>
      )}
      <Menu
        trigger={(props) => (
          <Button {...props} variant="secondary">
            <EyeOffIcon className="size-4" />
            {t('detail.muteStory')}
            <ChevronDownIcon className="size-4" />
          </Button>
        )}
      >
        {RULE_EXPIRY_DAYS.map((days) => (
          <MenuItem key={days} onSelect={() => rules.muteStory(days)}>
            {t('detail.muteFor', { count: days })}
          </MenuItem>
        ))}
      </Menu>
      {more.length === 0 ? null : (
        <Menu
          align="end"
          trigger={(props) => (
            <Button {...props} variant="secondary">
              <MoreIcon className="size-4" />
              {t('common:actions.more')}
            </Button>
          )}
        >
          {more.map(({ label, run }) => (
            <MenuItem key={label} onSelect={run}>
              {t(label)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}
