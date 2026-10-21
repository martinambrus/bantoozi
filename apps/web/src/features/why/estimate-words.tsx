import type { Explain } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Section } from './section.js';

type Word = NonNullable<Explain['estimate']>['top'][number];

/** The distinct, non-empty labels of the words with this sign, strongest first. */
function wordsWithSign(top: readonly Word[], sign: 1 | -1): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  const ordered = top
    .filter((word) => Math.sign(word.contribution) === sign)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  for (const word of ordered) {
    const key = word.label.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    labels.push(word.label.trim());
  }
  return labels;
}

function WordList({
  label,
  words,
  lang,
}: {
  label: string;
  words: string[];
  lang?: string | undefined;
}) {
  if (words.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</p>
      <ul
        role="list"
        aria-label={label}
        lang={lang}
        className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
      >
        {words.map((word) => (
          <li key={word}>{word}</li>
        ))}
      </ul>
    </div>
  );
}

/** The words of the article that moved the word estimate, up and down, in the article's own words. */
export function EstimateWords({
  estimate,
  lang,
}: {
  estimate: NonNullable<Explain['estimate']>;
  lang?: string | undefined;
}) {
  const { t } = useTranslation('why');
  const raised = wordsWithSign(estimate.top, 1);
  const lowered = wordsWithSign(estimate.top, -1);
  if (raised.length === 0 && lowered.length === 0) return null;

  return (
    <Section title={t('estimate.heading')}>
      <WordList label={t('estimate.raised')} words={raised} lang={lang} />
      <WordList label={t('estimate.lowered')} words={lowered} lang={lang} />
      <p className="text-xs text-slate-600 dark:text-slate-400">{t('estimate.note')}</p>
    </Section>
  );
}
