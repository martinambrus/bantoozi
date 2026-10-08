import type { ArticleListItem } from '@bantoozi/shared';
import { useNavigate } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';

import { useMe } from '../../../session/context.js';
import { useReasonBar } from '../actions/provider.js';
import type { VisibleRows } from '../article-list.js';
import { useReaderTargets, useSettingsWriter } from '../reader-state.js';
import type { useArticleList } from '../use-article-list.js';
import { useDesktop } from '../use-desktop.js';
import { ArticleKeys, type ArticleHandle } from './article-keys.js';
import { isSimpleModeChord, keyIgnored, onControl, simpleModeChordIgnored } from './guard.js';
import { LabelPickerContext, type LabelPickerRequest } from './label-picker.js';
import { SEQUENCE_MS, goLane, muteDays, type Sequence } from './keymap.js';
import { ShortcutsOverlay } from './overlay.js';
import { PendingHint } from './pending-hint.js';

/** Keys that are only a modifier: pressing one is not an answer to a waiting sequence. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
]);

/** The id of the row of the list that `element` is in, if it is in one. */
function rowIdOf(list: HTMLElement | null, element: Element | null): string | null {
  const row = element?.closest('li[data-article-id]');
  return list !== null && row instanceof HTMLElement && list.contains(row)
    ? (row.dataset['articleId'] ?? null)
    : null;
}

function subscribeToFocus(notify: () => void): () => void {
  document.addEventListener('focusin', notify);
  document.addEventListener('focusout', notify);
  return () => {
    document.removeEventListener('focusin', notify);
    document.removeEventListener('focusout', notify);
  };
}

/** The id of the row that holds the focus; none when the focus is elsewhere. */
function useFocusedRowId(listRef: RefObject<HTMLUListElement | null>): string | null {
  const read = useCallback(() => rowIdOf(listRef.current, document.activeElement), [listRef]);
  return useSyncExternalStore(subscribeToFocus, read, () => null);
}

export interface ReaderShortcutsProps {
  rows: VisibleRows;
  list: Pick<ReturnType<typeof useArticleList>, 'canLoadMore' | 'loadMore'>;
  /** The article that is open. */
  expanded: ArticleListItem | null;
  /** Opens an article as a press on its title does; it is never asked to close the open one. */
  onExpand: (item: ArticleListItem) => void;
  /** Opens the "Why this?" drawer for the article. */
  onWhyThis: (item: ArticleListItem) => void;
  children: ReactNode;
}

/**
 * The reader's keyboard shortcuts (spec 09 §3.4), on the wide layout only. They act on the current
 * article, which is the row that holds the focus, else the open one, and they do what its buttons
 * do. Rendered around the page of the list.
 */
export function ReaderShortcuts({
  rows,
  list,
  expanded,
  onExpand,
  onWhyThis,
  children,
}: ReaderShortcutsProps) {
  const desktop = useDesktop();
  const navigate = useNavigate();
  const { preferences } = useMe();
  const settings = useSettingsWriter();
  const reasonBar = useReasonBar();
  const targets = useReaderTargets();

  const focusedId = useFocusedRowId(rows.listRef);
  const current = rows.visible.find((item) => item.id === focusedId) ?? expanded;

  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [labelRequest, setLabelRequest] = useState<LabelPickerRequest | null>(null);
  const article = useRef<ArticleHandle | null>(null);
  const waiting = useRef<Sequence | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // A request for the label picker is for the article that was open when it was made.
  useEffect(() => {
    if (labelRequest !== null && labelRequest.articleId !== expanded?.id) setLabelRequest(null);
  }, [labelRequest, expanded]);

  function endSequence() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    waiting.current = null;
    setSequence(null);
  }

  function beginSequence(next: Sequence) {
    if (timer.current !== null) clearTimeout(timer.current);
    waiting.current = next;
    setSequence(next);
    timer.current = setTimeout(endSequence, SEQUENCE_MS);
  }

  /** The article a key acts on, worked out as the key is pressed: the focus may have moved. */
  function currentNow(): ArticleListItem | null {
    const id = rowIdOf(rows.listRef.current, document.activeElement);
    return rows.visible.find((item) => item.id === id) ?? expanded;
  }

  /** Its actions, once they are bound to it. */
  function articleNow(): ArticleHandle | null {
    const item = currentNow();
    return item !== null && article.current?.id === item.id ? article.current : null;
  }

  function onArticle(run: (handle: ArticleHandle) => void): boolean {
    const handle = articleNow();
    if (handle === null) return false;
    run(handle);
    return true;
  }

  function focusRow(item: ArticleListItem) {
    const row = Array.from(rows.listRef.current?.children ?? []).find(
      (child) => child instanceof HTMLElement && child.dataset['articleId'] === item.id,
    );
    row?.querySelector<HTMLElement>('h3 button')?.focus();
    if (preferences.markReadOnExpand && expanded?.id !== item.id) onExpand(item);
  }

  function move(step: 1 | -1): boolean {
    const here = currentNow();
    const at = here === null ? -1 : rows.visible.findIndex((item) => item.id === here.id);
    let target: ArticleListItem | undefined;
    if (at < 0) {
      target = step === 1 ? rows.staying[0] : rows.staying.at(-1);
    } else {
      for (let index = at + step; target === undefined; index += step) {
        const candidate = rows.visible[index];
        if (candidate === undefined) break;
        if (!rows.leaving.has(candidate.id)) target = candidate;
      }
      if (target === undefined && step === 1 && list.canLoadMore) void list.loadMore();
    }
    if (target !== undefined) focusRow(target);
    return true;
  }

  function chooseLabels(): boolean {
    const item = currentNow();
    if (item === null) return false;
    if (expanded?.id !== item.id) onExpand(item);
    setLabelRequest({ articleId: item.id, done: () => setLabelRequest(null) });
    return true;
  }

  function explain(): boolean {
    const item = currentNow();
    if (item === null) return false;
    onWhyThis(item);
    return true;
  }

  function startMute(): boolean {
    if (reasonBar.getSnapshot() !== null || articleNow() === null) return false;
    beginSequence('m');
    return true;
  }

  function markAllRead(): boolean {
    const open = targets.markAllRead.current;
    if (open === null) return false;
    open();
    return true;
  }

  function filterFeeds(): boolean {
    const field = targets.feedFilter.current;
    if (field === null) return false;
    field.focus();
    return true;
  }

  function toggleSimpleMode() {
    settings.change({ simpleMode: !preferences.simpleMode });
  }

  /** The second key of a sequence; false when it is not one the sequence takes. */
  function finish(first: Sequence, event: KeyboardEvent): boolean {
    if (first === 'g') {
      const lane = goLane(event.key);
      if (lane === undefined) return false;
      void navigate({ to: '/read/$lane', params: { lane } });
      return true;
    }
    const days = muteDays(event.key);
    return days !== undefined && onArticle((handle) => handle.muteStory(days));
  }

  /** The first key of a shortcut; false when it is not one, or there is nothing for it to act on. */
  function start(event: KeyboardEvent): boolean {
    switch (event.key) {
      case '+':
      case '=':
        return onArticle((handle) => handle.rate(1, event.shiftKey));
      case '-':
      case '_':
        return onArticle((handle) => handle.rate(-1, event.shiftKey));
      case 'Enter': {
        const handle = onControl(event.target) ? null : articleNow();
        return handle !== null && handle.openOriginal();
      }
      case '/':
        return filterFeeds();
      case '?':
        setHelpOpen(true);
        return true;
    }
    switch (event.key.toLowerCase()) {
      case 'j':
        return move(1);
      case 'k':
        return move(-1);
      case 'o': {
        const handle = articleNow();
        return handle !== null && handle.openOriginal();
      }
      case 'b':
        return onArticle((handle) => handle.toggleBookmark());
      case 'l':
        return chooseLabels();
      case 'w':
        return explain();
      case 'm':
        return startMute();
      case 'x':
        return onArticle((handle) => handle.toggleRead());
      case 'a':
        return event.shiftKey && markAllRead();
      case 'g':
        beginSequence('g');
        return true;
      case 's':
        toggleSimpleMode();
        return true;
      default:
        return false;
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (typeof event.key !== 'string' || MODIFIER_KEYS.has(event.key)) return;
    if (isSimpleModeChord(event)) {
      endSequence();
      if (simpleModeChordIgnored(event)) return;
      event.preventDefault();
      if (!event.repeat) toggleSimpleMode();
      return;
    }
    if (keyIgnored(event)) {
      endSequence();
      return;
    }
    if (event.repeat) return;
    const first = waiting.current;
    if (first !== null) {
      endSequence();
      if (finish(first, event)) event.preventDefault();
      return;
    }
    if (start(event)) event.preventDefault();
  }

  const handler = useRef(onKeyDown);
  useLayoutEffect(() => {
    handler.current = onKeyDown;
  });

  useEffect(() => {
    if (!desktop) return;
    const listener = (event: KeyboardEvent) => handler.current(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [desktop]);

  return (
    <LabelPickerContext value={labelRequest}>
      {children}
      {desktop ? (
        <>
          {current === null ? null : (
            <ArticleKeys key={current.id} item={current} handle={article} />
          )}
          <PendingHint sequence={sequence} />
          <ShortcutsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
        </>
      ) : null}
    </LabelPickerContext>
  );
}
