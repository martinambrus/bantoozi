import type { RatingReason } from '@bantoozi/shared';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { UndoIcon } from '../../components/icons.js';
import { useToastOutlets } from '../../components/toast/toast-provider.js';
import { focusRestoredRow, rowOf, rowTitleOf, useReasonBar } from '../reader/actions/provider.js';
import type { PendingDislike } from './reason-bar-store.js';
import { shortcutBlocked } from './shortcut-guard.js';

/** Spec 09 §3.3, in the order of the bar; the key picks the reason while the bar is open. */
const REASONS = [
  { reason: 'off_topic', key: '1' },
  { reason: 'clickbait', key: '2' },
  { reason: 'seen', key: '3' },
  { reason: 'shallow', key: '4' },
  { reason: 'promo', key: '5' },
  { reason: 'other', key: '6' },
] as const satisfies readonly { reason: RatingReason; key: string }[];

/** The toasts sit above the bar: the toaster adds this to its own distance from the bottom. */
const HEIGHT_VARIABLE = '--reason-bar-height';
/** The distance the toasts keep from each other. */
const GAP_PX = 8;

/** Where the focus went when it left the bar, and which button of the bar had it. */
interface Handoff {
  target: Element;
  button: number;
}

/** The rows beside the disliked one and their list: where the focus goes once the bar is answered. */
interface Nearby {
  next: string | null;
  previous: string | null;
  list: HTMLElement | null;
}

const buttonsOf = (bar: Element) => Array.from(bar.querySelectorAll('button'));

function nearbyRows(articleId: string): Nearby {
  const row = rowOf(articleId);
  const idOf = (sibling: Element | null | undefined) =>
    sibling instanceof HTMLElement ? (sibling.dataset['articleId'] ?? null) : null;
  return {
    next: idOf(row?.nextElementSibling),
    previous: idOf(row?.previousElementSibling),
    list: row?.parentElement ?? null,
  };
}

/**
 * The bar is about to go with a button of it in focus. The focus goes where the keyboard flow of
 * the list took it when the disliked row left: to the row that took its place, else to the row
 * before it, else to the list, else to the page. A bar in a modal leaves the focus to the modal,
 * because the page behind it is inert.
 */
function leaveBar(bar: HTMLElement | null, { next, previous, list }: Nearby): void {
  if (bar === null || !bar.contains(document.activeElement)) return;
  const modal = bar.closest('dialog');
  if (modal !== null) {
    modal.focus();
    return;
  }
  const titles = [next, previous].map((id) => (id === null ? null : rowTitleOf(id)));
  const place = titles.find((title) => title !== null) ?? (list?.isConnected ? list : null);
  (place ?? document.querySelector('main'))?.focus();
}

function Bar({
  pending,
  handoff,
}: {
  pending: PendingDislike;
  /** What a modal that opened took from the bar's focus, to give back to the bar it moved to. */
  handoff: RefObject<Handoff | null>;
}) {
  const { t } = useTranslation('article');
  const bar = useReasonBar();
  const ref = useRef<HTMLDivElement>(null);
  const inside = useRef({ pointer: false, focus: false });
  const nearby = useRef<Nearby>({ next: null, previous: null, list: null });

  function enter(change: Partial<typeof inside.current>): void {
    Object.assign(inside.current, change);
    bar.pause(inside.current.pointer || inside.current.focus);
  }

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty(HEIGHT_VARIABLE, `${element.offsetHeight + GAP_PX}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(HEIGHT_VARIABLE);
    };
  }, []);

  useEffect(
    () => () => {
      bar.pause(false);
    },
    [bar],
  );

  // The bar opens while the row is still in the list; its neighbours are looked up before it leaves.
  useLayoutEffect(() => {
    nearby.current = nearbyRows(pending.articleId);
  }, [pending.articleId]);

  // A modal that opened took the focus off a button of the bar it replaced: the same one has it.
  useLayoutEffect(() => {
    const held = handoff.current;
    handoff.current = null;
    const dialog = ref.current?.closest('dialog');
    if (held === null || ref.current === null || dialog === null || dialog === undefined) return;
    if (document.activeElement !== held.target || !dialog.contains(held.target)) return;
    buttonsOf(ref.current)[held.button]?.focus();
  }, [handoff]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const picked = REASONS.find(({ key }) => key === event.key);
      if (picked === undefined || event.repeat || shortcutBlocked(event)) return;
      event.preventDefault();
      leaveBar(ref.current, nearby.current);
      bar.pick(picked.reason);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [bar]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        ref={ref}
        role="group"
        aria-label={t('reasonBar.label')}
        onPointerEnter={() => enter({ pointer: true })}
        onPointerLeave={() => enter({ pointer: false })}
        onFocus={() => enter({ focus: true })}
        onBlur={(event) => {
          const to = event.relatedTarget;
          if (event.currentTarget.contains(to)) return;
          enter({ focus: false });
          const left: EventTarget = event.target;
          handoff.current =
            to === null
              ? null
              : { target: to, button: buttonsOf(event.currentTarget).findIndex((b) => b === left) };
        }}
        className="pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-lg border-2 border-slate-500 bg-white p-3 text-slate-900 shadow-lg motion-safe:animate-toast-in dark:border-slate-400 dark:bg-slate-800 dark:text-slate-100"
      >
        <p className="line-clamp-2 text-sm font-medium">
          {t('reasonBar.disliked', { title: pending.title })}
        </p>
        <div className="flex flex-wrap gap-2">
          {REASONS.map(({ reason, key }) => (
            <Button
              key={reason}
              size="sm"
              variant="secondary"
              aria-keyshortcuts={key}
              onClick={() => {
                leaveBar(ref.current, nearby.current);
                bar.pick(reason);
              }}
            >
              {t(`reasonBar.reasons.${reason}`)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const pressed = document.activeElement;
              bar.undo();
              focusRestoredRow(pending.articleId, pressed);
            }}
          >
            <UndoIcon className="size-4" />
            {t('common:actions.undo')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The bar that asks for the reason of a dislike (spec 09 §3.3), one per account. It is mounted
 * once, beside the screens, so it outlasts the row that opened it. It never takes the focus; a
 * polite live region says that it opened. While a modal is open the page is inert, so the bar
 * moves into the modal, like the toasts.
 */
export function ReasonBar() {
  const { t } = useTranslation('article');
  const bar = useReasonBar();
  const outlets = useToastOutlets();
  const pending = useSyncExternalStore(bar.subscribe, bar.getSnapshot, bar.getSnapshot);
  const outlet = useSyncExternalStore(outlets.subscribe, outlets.getSnapshot, outlets.getSnapshot);
  const handoff = useRef<Handoff | null>(null);
  const open = pending !== null;

  // A page that is hidden may never come back, so its dislike does not wait for the reason.
  useEffect(() => {
    if (!open) return;
    function onHidden(): void {
      if (document.visibilityState === 'hidden') bar.expire();
    }
    function onPageHide(): void {
      bar.expire();
    }
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [bar, open]);

  const content = (
    <>
      <div aria-live="polite" className="sr-only">
        {pending === null ? '' : t('reasonBar.announce', { title: pending.title })}
      </div>
      {pending === null ? null : <Bar pending={pending} handoff={handoff} />}
    </>
  );
  return outlet === null ? content : createPortal(content, outlet);
}
