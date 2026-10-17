import type { Explain } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { useMe } from '../../session/context.js';
import { topReasonText } from '../article/top-reason.js';
import { useCards } from '../interests/queries.js';
import { Section } from './section.js';
import type { DemotionFlag, Demotions } from './use-demotions.js';
import { usePressed } from './use-pressed.js';
import { useCardTeacher } from './use-card-teacher.js';
import { useRuleRemoval } from './use-rule-removal.js';

const DEMOTION_FLAGS: readonly string[] = ['clickbait', 'promotional', 'shallow', 'stale'];
const DEMOTION_PREFIX = 'demote:';
const SIMILAR_PREFIX = 'demote:similar:';

function demotionOf(code: string): DemotionFlag | null {
  const flag = code.startsWith(DEMOTION_PREFIX) ? code.slice(DEMOTION_PREFIX.length) : '';
  return DEMOTION_FLAGS.includes(flag) ? (flag as DemotionFlag) : null;
}

interface RuleAction {
  label: string;
  run: () => void;
  busy: boolean;
}

interface RuleRowProps {
  sentence: string;
  /** What takes the rule back or corrects it, if anything does, in the order shown. */
  actions: readonly RuleAction[];
}

function RuleButton({ action, describedBy }: { action: RuleAction; describedBy: string }) {
  const { pressed, press } = usePressed<true>(action.busy);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-describedby={describedBy}
      disabled={action.busy}
      loading={pressed === true}
      onClick={() => {
        press(true);
        action.run();
      }}
    >
      {action.label}
    </Button>
  );
}

function RuleRow({ sentence, actions }: RuleRowProps) {
  const sentenceId = useId();
  return (
    <li
      aria-labelledby={sentenceId}
      className="flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <span id={sentenceId}>{sentence}</span>
      {actions.map((action) => (
        <RuleButton key={action.label} action={action} describedBy={sentenceId} />
      ))}
    </li>
  );
}

/** What fired for this article, each rule in words with the way to take it back (spec 06 §3.2). */
export function RulesApplied({
  articleId,
  explain,
  demotions,
}: {
  articleId: string;
  explain: Explain;
  demotions: Demotions;
}) {
  const { t } = useTranslation('why');
  const { t: tArticle, i18n } = useTranslation('article');
  const me = useMe();
  const cards = useCards();
  const removal = useRuleRemoval();
  const teacher = useCardTeacher(articleId);
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
    const similar = rule.code.startsWith(SIMILAR_PREFIX);
    const words = similar
      ? t('rules.similar', { count: Number(rule.detail) })
      : topReasonText(tArticle, i18n.language, { kind: 'rule', code: rule.code });
    const card = rule.cardId === undefined ? undefined : cardTitle(rule.cardId);
    const sentence = card === undefined ? words : t('rules.forCard', { rule: words, card });
    const flag = demotionOf(rule.code);

    const actions: RuleAction[] = [];
    let action: RuleAction | null = null;
    if (similar) {
      if (me.preferences.demote.similar !== 'off') {
        actions.push({
          label: t('rules.similarOff'),
          run: () => demotions.turnOff('similar', () => takeBack(key)),
          busy: demotions.pending,
        });
      }
      if (rule.cardId !== undefined && card !== undefined) {
        const { cardId } = rule;
        actions.push({
          label: t('rules.teachNot', { card }),
          run: () => teacher.teach(cardId, 'no'),
          busy: teacher.pending,
        });
      }
    } else if (rule.ruleId !== undefined) {
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
    if (action !== null) actions.push(action);
    return [{ key, sentence, actions }];
  });
  if (rows.length === 0) return null;

  return (
    <Section title={t('rules.heading')}>
      <ul role="list" aria-label={t('rules.heading')} className="flex flex-col gap-2">
        {rows.map(({ key, sentence, actions }) => (
          <RuleRow key={key} sentence={sentence} actions={actions} />
        ))}
      </ul>
    </Section>
  );
}
