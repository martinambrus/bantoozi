import type { CardDto, LibraryCardDto } from '@bantoozi/shared';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { errorMessage } from '../../components/error-message.js';
import { CheckIcon } from '../../components/icons.js';
import { LoadingState } from '../../components/states/loading-state.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';
import { InlineAlert } from '../feeds/inline-alert.js';
import { conflictReason } from '../interests/card-errors.js';
import { useCardCache } from '../interests/queries.js';
import type { TopicIndex } from '../interests/topics.js';

/** Which list a chip belongs to: the topics to read, or the topics never to show. */
export type ChipKind = 'like' | 'never';

/**
 * The library cards a chip is changing, each with the list of that chip. Every card has a chip in
 * both lists, and while one of them changes the card the other cannot, so their requests never race.
 */
export function useChipChanges() {
  const [changing, setChanging] = useState<ReadonlyMap<string, ChipKind>>(new Map());
  const started = useRef(new Map<string, ChipKind>());
  return {
    changing,
    /** Starts a change of the card from a chip of `kind`; false while one is on its way. */
    start(cardId: string, kind: ChipKind): boolean {
      if (started.current.has(cardId)) return false;
      started.current.set(cardId, kind);
      setChanging(new Map(started.current));
      return true;
    },
    finish(cardId: string): void {
      started.current.delete(cardId);
      setChanging(new Map(started.current));
    },
  };
}

export type ChipChanges = ReturnType<typeof useChipChanges>;

/** The card the person holds from this library card, if any. */
function holding(cards: readonly CardDto[], card: LibraryCardDto): CardDto | undefined {
  return cards.find(
    (held) =>
      held.id === card.id ||
      (card.slug !== null && held.origin === 'library' && held.librarySlug === card.slug),
  );
}

interface ChipProps {
  card: LibraryCardDto;
  held: CardDto | undefined;
  kind: ChipKind;
  changes: ChipChanges;
  onFailure: (message: string | null) => void;
}

function Chip({ card, held, kind, changes, onFailure }: ChipProps) {
  const { t } = useTranslation('onboarding');
  const cache = useCardCache();
  const adopt = useApiMutation(routes.libraryAdopt);
  const remove = useApiMutation(routes.cardDelete);
  const reasonId = useId();

  // A card held with the other strength belongs to the other list.
  const pressed = held !== undefined && (held.strength === 'never') === (kind === 'never');
  const blocked = held !== undefined && !pressed;
  const changedByOther = (changes.changing.get(card.id) ?? kind) !== kind;

  async function toggle() {
    if (!changes.start(card.id, kind)) return;
    onFailure(null);
    try {
      if (held === undefined) {
        cache.apply(await adopt.mutateAsync({ params: { id: card.id }, body: { strength: kind } }));
        cache.hold([card.id]);
      } else {
        await remove.mutateAsync({ params: { id: held.id } });
        cache.remove(held.id);
        cache.refreshLibrary();
      }
    } catch (error) {
      if (conflictReason(error) === 'already_held') {
        cache.hold([card.id]);
        cache.refreshCards();
        onFailure(t('interests:library.alreadyHeld'));
      } else {
        onFailure(errorMessage(t, error));
      }
    } finally {
      changes.finish(card.id);
    }
  }

  return (
    <li>
      <button
        type="button"
        aria-pressed={pressed}
        aria-describedby={blocked ? reasonId : undefined}
        disabled={blocked || changedByOther}
        onClick={() => {
          void toggle();
        }}
        className={cx(
          'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-60',
          FOCUS_RING,
          pressed
            ? kind === 'never'
              ? 'border-red-700 bg-red-100 text-red-900 dark:border-red-300 dark:bg-red-950 dark:text-red-100'
              : 'border-indigo-700 bg-indigo-100 text-indigo-900 dark:border-indigo-300 dark:bg-indigo-950 dark:text-indigo-100'
            : 'border-slate-500 bg-white text-slate-900 hover:bg-slate-100 dark:border-slate-400 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
        )}
      >
        {pressed ? <CheckIcon className="size-4" /> : null}
        {card.title}
      </button>
      {blocked ? (
        <VisuallyHidden id={reasonId}>
          {t(kind === 'like' ? 'interests.blockedByNever' : 'interests.blockedByLike')}
        </VisuallyHidden>
      ) : null}
    </li>
  );
}

interface Group {
  key: string;
  name: string | null;
  cards: LibraryCardDto[];
}

/** The cards under the level-1 topic they belong to, the topics in the order they first appear. */
function groupByTopic(
  library: readonly LibraryCardDto[],
  topics: TopicIndex | null,
  other: string,
): Group[] {
  const groups = new Map<string, Group>();
  for (const card of library) {
    const key = card.l1TopicId ?? '';
    const group = groups.get(key) ?? {
      key,
      name: topics === null ? null : (topics.name(key) ?? other),
      cards: [],
    };
    group.cards.push(card);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function TopicGroup({ group, children }: { group: Group; children: ReactNode }) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-2">
      {group.name === null ? null : (
        <h3 id={headingId} className="text-base font-semibold">
          {group.name}
        </h3>
      )}
      <ul
        role="list"
        aria-labelledby={group.name === null ? undefined : headingId}
        className="flex flex-wrap gap-2"
      >
        {children}
      </ul>
    </div>
  );
}

export interface LibraryChipsProps {
  kind: ChipKind;
  /** Shared by the two lists, whose chips change the same cards. */
  changes: ChipChanges;
  cards: readonly CardDto[];
  library: readonly LibraryCardDto[];
  /** The topic names; null while they load. */
  topics: TopicIndex | null;
  topicsLoading: boolean;
}

/** The library cards as chips under their topics: press one to hold it, press it again to drop it. */
export function LibraryChips({
  kind,
  changes,
  cards,
  library,
  topics,
  topicsLoading,
}: LibraryChipsProps) {
  const { t } = useTranslation('onboarding');
  const headingId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const groups = groupByTopic(library, topics, t('interests:library.other'));
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t(`interests.${kind}.title`)}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t(`interests.${kind}.lead`)}</p>
      {topicsLoading ? (
        <LoadingState />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <TopicGroup key={group.key} group={group}>
              {group.cards.map((card) => (
                <Chip
                  key={card.id}
                  card={card}
                  held={holding(cards, card)}
                  kind={kind}
                  changes={changes}
                  onFailure={setFailure}
                />
              ))}
            </TopicGroup>
          ))}
        </div>
      )}
      {failure === null ? null : <InlineAlert>{failure}</InlineAlert>}
    </section>
  );
}
