import { useQuery } from '@tanstack/react-query';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { useCards } from './queries.js';

/** The held cards with how many recently liked articles each matched, fewest first (D-242). */
function useSwapCandidates() {
  const api = useApi();
  const accountId = useAccountId();
  const cards = useCards();
  const usage = useQuery({
    queryKey: accountKey(accountId, 'card-usage'),
    queryFn: ({ signal }) => api.call(routes.cardUsage, undefined, { signal }),
    staleTime: 0,
    gcTime: 0,
  });
  const candidates = useMemo(() => {
    if (cards.data === undefined || usage.data === undefined) return undefined;
    const matches = new Map(usage.data.map((row) => [row.cardId, row.likedMatches]));
    return cards.data
      .map((card) => ({ card, likedMatches: matches.get(card.id) ?? 0 }))
      .sort((a, b) => a.likedMatches - b.likedMatches || a.card.title.localeCompare(b.card.title));
  }, [cards.data, usage.data]);
  return { candidates, failed: cards.isError || usage.isError };
}

export interface CardSwapProps {
  /** The id of the held card chosen to go, or null. */
  value: string | null;
  onChange: (cardId: string) => void;
  disabled?: boolean | undefined;
}

/** At the card limit: a choice of the held card to remove so the new one fits. */
export function CardSwap({ value, onChange, disabled }: CardSwapProps) {
  const { t } = useTranslation('interests');
  const { candidates, failed } = useSwapCandidates();
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
      <legend className="px-1 text-sm font-semibold">{t('swap.legend')}</legend>
      <p className="text-sm text-slate-700 dark:text-slate-200">{t('swap.hint')}</p>
      {candidates === undefined ? (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
          {failed ? t('swap.failed') : t('swap.loading')}
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {candidates.map(({ card, likedMatches }) => (
            <li key={card.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm">
                <input
                  type="radio"
                  name={name}
                  value={card.id}
                  checked={value === card.id}
                  disabled={disabled}
                  className="mt-1"
                  onChange={() => onChange(card.id)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{card.title}</span>
                  <span className="text-slate-600 dark:text-slate-300">
                    {t('swap.matched', { count: likedMatches })}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
