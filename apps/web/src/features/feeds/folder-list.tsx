import type { Subscription } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { cx } from '../../components/cx.js';
import { errorMessage } from '../../components/error-message.js';
import { IconButton } from '../../components/icon-button.js';
import { ChevronDownIcon, ChevronUpIcon, DragIcon } from '../../components/icons.js';
import { useMe } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import { FeedRow } from './feed-row.js';
import { FeedSettingsSheet } from './feed-settings-sheet.js';
import { groupByFolder, moveFolderBy, moveFolderTo } from './folders.js';
import { InlineAlert } from './inline-alert.js';
import { RenameFolderDialog } from './rename-folder-dialog.js';

type Control = 'up' | 'down' | 'rename';

interface DragState {
  /** The folder being dragged, if any. */
  dragged: string | null;
  /** The folder it is over. */
  target: string | null;
  onStart: (name: string, event: DragEvent) => void;
  onEnd: () => void;
  onOver: (name: string, event: DragEvent) => void;
  onLeave: (name: string, event: DragEvent) => void;
  onDrop: (name: string, event: DragEvent) => void;
}

interface FolderSectionProps {
  name: string;
  feeds: readonly Subscription[];
  position: number;
  total: number;
  saving: boolean;
  drag: DragState;
  onMove: (name: string, step: -1 | 1) => void;
  onRename: (name: string) => void;
  onOpenSettings: (feedId: string) => void;
}

function Feeds({
  feeds,
  onOpenSettings,
}: {
  feeds: readonly Subscription[];
  onOpenSettings: (feedId: string) => void;
}) {
  return (
    <ul role="list" className="divide-y divide-slate-200 dark:divide-slate-700">
      {feeds.map((subscription) => (
        <FeedRow
          key={subscription.feed.id}
          subscription={subscription}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </ul>
  );
}

const SECTION =
  'rounded-xl border border-slate-300 bg-white px-4 pt-3 dark:border-slate-700 dark:bg-slate-900';

function FolderSection({
  name,
  feeds,
  position,
  total,
  saving,
  drag,
  onMove,
  onRename,
  onOpenSettings,
}: FolderSectionProps) {
  const { t } = useTranslation('feeds');
  const headingId = useId();
  const upUnavailable = saving || position === 0;
  const downUnavailable = saving || position === total - 1;

  return (
    <section
      aria-labelledby={headingId}
      onDragOver={(event) => drag.onOver(name, event)}
      onDragLeave={(event) => drag.onLeave(name, event)}
      onDrop={(event) => drag.onDrop(name, event)}
      className={cx(
        SECTION,
        drag.dragged === name && 'opacity-60',
        drag.dragged !== null &&
          drag.dragged !== name &&
          drag.target === name &&
          'outline-2 outline-offset-2 outline-indigo-600 dark:outline-indigo-300',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          draggable
          onDragStart={(event) => drag.onStart(name, event)}
          onDragEnd={drag.onEnd}
          className="flex min-w-0 cursor-grab items-center gap-2"
        >
          <DragIcon className="size-5 text-slate-500 dark:text-slate-400" />
          <h2 id={headingId} className="break-words text-lg font-semibold">
            {name}
          </h2>
          <span className="shrink-0 text-sm text-slate-600 dark:text-slate-300">
            {t('folders.feedCount', { count: feeds.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label={t('folders.moveUp', { folder: name })}
            aria-disabled={upUnavailable || undefined}
            data-folder={name}
            data-folder-control="up"
            onClick={() => {
              if (!upUnavailable) onMove(name, -1);
            }}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <ChevronUpIcon />
          </IconButton>
          <IconButton
            label={t('folders.moveDown', { folder: name })}
            aria-disabled={downUnavailable || undefined}
            data-folder={name}
            data-folder-control="down"
            onClick={() => {
              if (!downUnavailable) onMove(name, 1);
            }}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <ChevronDownIcon />
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('folders.renameFolder', { folder: name })}
            data-folder={name}
            data-folder-control="rename"
            onClick={() => onRename(name)}
          >
            {t('folders.rename')}
          </Button>
        </div>
      </div>
      <Feeds feeds={feeds} onOpenSettings={onOpenSettings} />
    </section>
  );
}

function LooseSection({
  feeds,
  named,
  onOpenSettings,
}: {
  feeds: readonly Subscription[];
  named: boolean;
  onOpenSettings: (feedId: string) => void;
}) {
  const { t } = useTranslation('feeds');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <h2 id={headingId} className="text-lg font-semibold">
        {t(named ? 'folders.none' : 'folders.all')}
      </h2>
      <Feeds feeds={feeds} onOpenSettings={onOpenSettings} />
    </section>
  );
}

/**
 * The feeds by folder. Folders are reordered by dragging or with the move buttons, and the whole
 * order is saved in `preferences.folderOrder`; it is shown at once and goes back if saving fails.
 */
export function FolderList({ subscriptions }: { subscriptions: readonly Subscription[] }) {
  const { t, i18n } = useTranslation('feeds');
  const me = useMe();
  const queryClient = useQueryClient();
  // The account learns the saved order even when the answer comes after the list is gone (the page
  // was left); only the order shown and the announcement need the list.
  const update = useApiMutation(routes.meUpdate, {
    onSuccess: (updated, variables) => {
      storeSavedMe(queryClient, variables?.body ?? {}, updated);
    },
  });
  const [unsavedOrder, setUnsavedOrder] = useState<string[] | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [settingsFeedId, setSettingsFeedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ folder: string; control: Control } | null>(null);
  const refocusFeed = useRef<{ feedId: string; folder: string | null } | null>(null);
  const saving = update.isPending;

  const groups = useMemo(
    () => groupByFolder(subscriptions, unsavedOrder ?? me.preferences.folderOrder, i18n.language),
    [subscriptions, unsavedOrder, me.preferences.folderOrder, i18n.language],
  );
  const folders = groups.flatMap((group) => (group.name === null ? [] : [group.name]));
  const loose = groups.find((group) => group.name === null);
  const settings = subscriptions.find((subscription) => subscription.feed.id === settingsFeedId);

  // Moving a folder reorders its element, which drops the focus; it goes back to the control used.
  useLayoutEffect(() => {
    const wanted = refocus.current;
    if (wanted === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      Array.from(root.current?.querySelectorAll<HTMLElement>('[data-folder-control]') ?? [])
        .find(
          (element) =>
            element.dataset['folder'] === wanted.folder &&
            element.dataset['folderControl'] === wanted.control,
        )
        ?.focus();
    }
    if (unsavedOrder === null) refocus.current = null;
  });

  // Saving settings can move a feed to another folder, where its settings button is a new element;
  // once the list shows the move, the focus goes to that one.
  useLayoutEffect(() => {
    const wanted = refocusFeed.current;
    if (wanted === null || settingsFeedId !== null) return;
    const row = subscriptions.find((subscription) => subscription.feed.id === wanted.feedId);
    if (row !== undefined && row.folder !== wanted.folder) return;
    refocusFeed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    Array.from(root.current?.querySelectorAll<HTMLElement>('[data-feed-settings]') ?? [])
      .find((element) => element.dataset['feedSettings'] === wanted.feedId)
      ?.focus();
  });

  function save(order: string[], moved: string) {
    if (saving) return;
    setAnnouncement('');
    setUnsavedOrder(order);
    const patch = { preferences: { folderOrder: order } };
    update.mutate(
      { body: patch },
      {
        onSuccess: () => {
          setUnsavedOrder(null);
          setAnnouncement(
            t('folders.moved', {
              folder: moved,
              position: order.indexOf(moved) + 1,
              total: order.length,
            }),
          );
        },
        onError: () => setUnsavedOrder(null),
      },
    );
  }

  function move(name: string, step: -1 | 1) {
    refocus.current = { folder: name, control: step < 0 ? 'up' : 'down' };
    save(moveFolderBy(folders, name, step), name);
  }

  const drag: DragState = {
    dragged,
    target,
    onStart: (name, event) => {
      if (saving) {
        event.preventDefault();
        return;
      }
      event.dataTransfer?.setData('text/plain', name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      setDragged(name);
    },
    onEnd: () => {
      setDragged(null);
      setTarget(null);
    },
    onOver: (name, event) => {
      if (dragged === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      setTarget(name);
    },
    onLeave: (name, event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setTarget((current) => (current === name ? null : current));
    },
    onDrop: (name, event) => {
      if (dragged === null) return;
      event.preventDefault();
      setDragged(null);
      setTarget(null);
      if (dragged !== name) save(moveFolderTo(folders, dragged, name), dragged);
    },
  };

  return (
    <div ref={root} className="flex flex-col gap-6">
      {update.error === null ? null : <InlineAlert>{errorMessage(t, update.error)}</InlineAlert>}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {folders.length === 0 ? null : (
        <ul role="list" aria-label={t('folders.list')} className="flex flex-col gap-6">
          {groups.map((group, position) =>
            group.name === null ? null : (
              <li key={group.name}>
                <FolderSection
                  name={group.name}
                  feeds={group.feeds}
                  position={position}
                  total={folders.length}
                  saving={saving}
                  drag={drag}
                  onMove={move}
                  onRename={setRenaming}
                  onOpenSettings={setSettingsFeedId}
                />
              </li>
            ),
          )}
        </ul>
      )}
      {loose === undefined ? null : (
        <LooseSection
          feeds={loose.feeds}
          named={folders.length > 0}
          onOpenSettings={setSettingsFeedId}
        />
      )}
      {renaming === null ? null : (
        <RenameFolderDialog
          folder={renaming}
          folders={folders}
          onClose={() => setRenaming(null)}
          onRenamed={(name) => {
            refocus.current = { folder: name, control: 'rename' };
          }}
        />
      )}
      {settings === undefined ? null : (
        <FeedSettingsSheet
          key={settings.feed.id}
          subscription={settings}
          folders={folders}
          onSaved={(saved) => {
            refocusFeed.current = { feedId: saved.feed.id, folder: saved.folder };
          }}
          onClose={() => setSettingsFeedId(null)}
        />
      )}
    </div>
  );
}
