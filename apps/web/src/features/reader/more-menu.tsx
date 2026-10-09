import type { ArticleListItem } from '@bantoozi/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/icon-button.js';
import { MoreIcon } from '../../components/icons.js';
import { Menu, MenuItem } from '../../components/menu.js';
import {
  RateVisibleDialog,
  RateVisibleItem,
  useVisibleUnread,
  type Asked,
} from './rate-visible.js';
import { RecentActionsSheet } from './recent-actions.js';
import type { ReaderView } from './view.js';

export interface MoreMenuProps {
  view: ReaderView;
  /** What the question to rate the visible articles calls the view. */
  name: string;
  /** The articles of the view that are loaded. */
  items: readonly ArticleListItem[];
  /** The rows the list shows and keeps. */
  visible: readonly ArticleListItem[];
}

/** The More menu of the header: rating a feed's visible articles, recent actions, Show hidden. */
export function MoreMenu({ view, name, items, visible }: MoreMenuProps) {
  const { t } = useTranslation('reader');
  const navigate = useNavigate();
  const unread = useVisibleUnread(visible);
  const [recentOpen, setRecentOpen] = useState(false);
  // The articles of the question are the ones the list showed when it was opened.
  const [asked, setAsked] = useState<Asked | null>(null);

  return (
    <>
      <Menu
        align="end"
        trigger={(props) => (
          <IconButton {...props} label={t('common:actions.more')}>
            <MoreIcon />
          </IconButton>
        )}
      >
        {view.kind === 'feed' ? (
          <RateVisibleItem asked={unread} onSelect={() => setAsked(unread)} />
        ) : null}
        <MenuItem onSelect={() => setRecentOpen(true)}>{t('header.recentActions')}</MenuItem>
        <MenuItem onSelect={() => void navigate({ to: '/read/$lane', params: { lane: 'hidden' } })}>
          {t('header.showHidden')}
        </MenuItem>
      </Menu>
      <RecentActionsSheet open={recentOpen} onClose={() => setRecentOpen(false)} items={items} />
      {asked === null ? null : (
        <RateVisibleDialog asked={asked} name={name} onClose={() => setAsked(null)} />
      )}
    </>
  );
}
