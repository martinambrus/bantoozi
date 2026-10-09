import type { Explain } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { useMe } from '../../session/context.js';
import { topReasonText } from '../article/top-reason.js';
import { useCards } from '../interests/queries.js';
import { Section } from './section.js';
import type { DemotionFlag, Demotions } from './use-demotions.js';
import { useRuleRemoval } from './use-rule-removal.js';

const DEMOTION_FLAGS: readonly string[] = ['clickbait', 'promotional', 'shallow', 'stale'];
const DEMOTION_PREFIX = 'demote:';

function demotionOf(code: string): DemotionFlag | null {
  const flag = code.startsWith(DEMOTION_PREFIX) ? code.slice(DEMOTION_PREFIX.length) : '';
  return DEMOTION_FLAGS.includes(flag) ? (flag as DemotionFlag) : null;
}

interface RuleRowProps {
  sentence: string;
  /** What takes the rule back, if anything does. */
  action: { label: string; run: () => void; busy: boolean } | null;
}

function RuleRow({ sentence, action }: RuleRowProps) {
  const sentenceId = useId();
  return (
    <li
      aria-labelledby={sentenceId}
      className="flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <span id={sentenceId}>{sentence}</span>
      {action === null ? null : (
        <Button
          variant="ghost"
          size="sm"
          aria-describedby={sentenceId}
          disabled={action.busy}
          onClick={action.run}
        >
          {action.label}
        </Button>
      )}
    </li>
  );
}

/** What fired for this article, each rule in words with the way to take it back (spec 06 §3.2). */
export function RulesApplied({ explain, demotions }: { explain: Explain; demotions: Demotions }) {
  const { t } = useTranslation('why');
  const { t: tArticle, i18n } = useTranslation('article');
  const me = useMe();
  const cards = useCards();
  const removal = useRuleRemoval();
  const [takenBack, setTakenBack] = useState<ReadonlySet<string>>(new Set());

  const takeBack = (key: string) => {
    setTakenBack((current) => new Set(current).add(key));
  };
  const cardTitle = (cardId: string) =>
    cards.data?.find((card) => card.id === cardId)?.title ??
    explain.cards.find((card) => card.id === cardId)?.title;

  const rows = explain.rules.flatMap((rule) => {
    const key = rule.ruleId ?? rule.code;
    if (takenBack.has(key)) return [];
    const words = topReasonText(tArticle, i18n.language, { kind: 'rule', code: rule.code });
    const card = rule.cardId === undefined ? undefined : cardTitle(rule.cardId);
    const sentence = card === undefined ? words : t('rules.forCard', { rule: words, card });
    const flag = demotionOf(rule.code);

    let action: RuleRowProps['action'] = null;
    if (rule.ruleId !== undefined) {
      const { ruleId } = rule;
      action = {
        label: t('common:actions.undo'),
        run: () => removal.remove(ruleId, () => takeBack(key)),
        busy: removal.pending,
      };
    } else if (flag !== null && me.preferences.demote[flag] === 'on') {
      action = {
        label: t('rules.reset'),
        run: () => demotions.reset(flag, () => takeBack(key)),
        busy: demotions.pending,
      };
    } else if (flag !== null && me.preferences.demote[flag] === 'auto') {
      // The ranker applied it by itself; a demotion that is off already was ranked before that.
      action = {
        label: t('rules.turnOff'),
        run: () => demotions.turnOff(flag, () => takeBack(key)),
        busy: demotions.pending,
      };
    }
    return [{ key, sentence, action }];
  });
  if (rows.length === 0) return null;

  return (
    <Section title={t('rules.heading')}>
      <ul role="list" aria-label={t('rules.heading')} className="flex flex-col gap-2">
        {rows.map(({ key, sentence, action }) => (
          <RuleRow key={key} sentence={sentence} action={action} />
        ))}
      </ul>
    </Section>
  );
}
