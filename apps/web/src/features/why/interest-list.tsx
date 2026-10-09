import type { CardDto, Explain } from '@bantoozi/shared';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { CardEditor } from '../interests/card-editor.js';
import { useCards } from '../interests/queries.js';
import { Meter, percentOf } from './meter.js';
import { Section } from './section.js';
import { useCardTeacher, type Side } from './use-card-teacher.js';

type ScoredCard = Explain['cards'][number];

interface InterestRowProps {
  scored: ScoredCard;
  /** The card the person holds under that id now, when they hold it. */
  held: CardDto | undefined;
  busy: boolean;
  onTeach: (side: Side) => void;
  onEdit: (() => void) | undefined;
}

function InterestRow({ scored, held, busy, onTeach, onEdit }: InterestRowProps) {
  const { t } = useTranslation('why');
  const titleId = useId();
  const title = held?.title ?? scored.title;
  const strength = held?.strength ?? scored.strength;
  const percent = percentOf(scored.p);

  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span id={titleId} className="font-medium">
          {title}
        </span>
        <span className="text-sm text-slate-600 dark:text-slate-300">
          {t('interests.strength', { strength: t(`interests:strength.${strength}`) })}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Meter
          label={t('interests.match', { title })}
          value={scored.p}
          valueText={t('interests.matchValue', { percent })}
        />
        <span aria-hidden="true" className="w-14 shrink-0 text-end text-sm tabular-nums">
          {t('percent', { percent })}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-describedby={titleId}
          disabled={busy}
          onClick={() => onTeach('no')}
        >
          {t('interests.notThis')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-describedby={titleId}
          disabled={busy}
          onClick={() => onTeach('yes')}
        >
          {t('interests.exactly')}
        </Button>
        {onEdit === undefined ? null : (
          <Button variant="ghost" size="sm" aria-describedby={titleId} onClick={onEdit}>
            {t('interests.edit')}
          </Button>
        )}
      </div>
    </li>
  );
}

export interface InterestListProps {
  articleId: string;
  cards: Explain['cards'];
}

/** The cards that judged the article, best match first, each with the two ways to correct it. */
export function InterestList({ articleId, cards }: InterestListProps) {
  const { t } = useTranslation('why');
  const held = useCards();
  const teacher = useCardTeacher(articleId);
  const [editing, setEditing] = useState<CardDto | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const ranked = [...cards].sort((a, b) => b.p - a.p);

  return (
    <Section title={t('interests.heading')}>
      {ranked.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('interests.none')}</p>
      ) : (
        <ul
          ref={listRef}
          role="list"
          tabIndex={-1}
          aria-label={t('interests.heading')}
          className="flex flex-col gap-3 outline-none"
        >
          {ranked.map((scored) => {
            const card = held.data?.find(
              (candidate) => candidate.id === teacher.currentId(scored.id),
            );
            return (
              <InterestRow
                key={scored.id}
                scored={scored}
                held={card}
                busy={teacher.pending}
                onTeach={(side) => teacher.teach(scored.id, side)}
                onEdit={card === undefined ? undefined : () => setEditing(card)}
              />
            );
          })}
        </ul>
      )}
      {editing === null ? null : (
        <CardEditor
          card={editing}
          returnFocus={() => listRef.current}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}
