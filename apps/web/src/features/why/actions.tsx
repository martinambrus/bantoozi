import type { ArticleListItem } from '@bantoozi/shared';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { MakeCard } from '../article/make-card.js';
import { MuteKeyword } from '../article/mute-keyword.js';
import { useRuleActions } from '../article/use-rule-actions.js';
import { Section } from './section.js';
import { usePressed } from './use-pressed.js';

/** What the person can do about the article from here: a card, a source, an author, a keyword. */
export function Actions({ item }: { item: ArticleListItem }) {
  const { t } = useTranslation('why');
  const { t: tArticle } = useTranslation('article');
  const rules = useRuleActions(item);
  const { pressed, press } = usePressed<string>(rules.pending);
  const actionsRef = useRef<HTMLDivElement>(null);
  const sourceActions = [
    { label: tArticle('detail.boostFeed'), run: rules.boostFeed },
    { label: tArticle('detail.blockFeed'), run: rules.blockFeed },
    { label: tArticle('detail.blockAuthor'), run: rules.blockAuthor },
  ].flatMap(({ label, run }) => (run === null ? [] : [{ label, run }]));

  return (
    <Section title={t('actions.heading')}>
      <div ref={actionsRef} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        <MakeCard item={item} returnTo={() => actionsRef.current} />
        {sourceActions.map(({ label, run }) => (
          <Button
            key={label}
            variant="secondary"
            disabled={rules.pending}
            loading={pressed === label}
            onClick={() => {
              press(label);
              run();
            }}
          >
            {label}
          </Button>
        ))}
        <MuteKeyword item={item} />
      </div>
    </Section>
  );
}
