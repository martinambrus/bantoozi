import { RULE_KINDS, type RuleDto, type RuleKind } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { useSession } from '../../session/context.js';
import { countdown, useNow, type Countdown } from './countdown.js';
import { Time } from './format.js';
import { useRefreshAfterRuleChange, useRules, useRulesKey } from './use-rules.js';

const REFRESH_MS = 60_000;

function expiresText(t: TFunction, left: Countdown): string {
  switch (left.unit) {
    case 'expired':
      return t('expires.expired');
    case 'soon':
      return t('expires.soon');
    default:
      return t(`expires.${left.unit}`, { count: left.count });
  }
}

function RuleRow({
  rule,
  now,
  onDelete,
}: {
  rule: RuleDto;
  now: number;
  onDelete: (rule: RuleDto) => void;
}) {
  const { t } = useTranslation('rules');
  const left = rule.expiresAt === null ? null : countdown(rule.expiresAt, now);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium break-words">{rule.displayValue}</p>
        <p className="flex flex-wrap gap-x-4 text-sm text-slate-600 dark:text-slate-300">
          <span>
            {t('list.added')} <Time value={rule.createdAt} />
          </span>
          {left === null ? null : <span>{expiresText(t, left)}</span>}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        aria-label={t('list.delete', { value: rule.displayValue })}
        onClick={() => onDelete(rule)}
      >
        {t('common:actions.delete')}
      </Button>
    </li>
  );
}

function RuleGroup({
  kind,
  rules,
  now,
  onDelete,
}: {
  kind: RuleKind;
  rules: readonly RuleDto[];
  now: number;
  onDelete: (rule: RuleDto) => void;
}) {
  const { t } = useTranslation('rules');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-lg font-semibold">
        {t(`groups.${kind}`)}
      </h2>
      <ul
        role="list"
        className="divide-y divide-slate-200 rounded-lg border border-slate-300 px-4 dark:divide-slate-700 dark:border-slate-600"
      >
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} now={now} onDelete={onDelete} />
        ))}
      </ul>
    </section>
  );
}

function RuleGroups({
  rules,
  refetch,
  onDelete,
}: {
  rules: readonly RuleDto[];
  refetch: () => unknown;
  onDelete: (rule: RuleDto) => void;
}) {
  const now = useNow(REFRESH_MS);
  const asked = useRef(new Set<string>());

  // The server stops listing a rule the moment it expires; ask once for each rule that just did.
  useEffect(() => {
    const ran = rules.filter(
      (rule) =>
        rule.expiresAt !== null && Date.parse(rule.expiresAt) <= now && !asked.current.has(rule.id),
    );
    if (ran.length === 0) return;
    for (const rule of ran) asked.current.add(rule.id);
    void refetch();
  }, [rules, now, refetch]);

  return (
    <div className="flex flex-col gap-6">
      {RULE_KINDS.map((kind) => {
        const group = rules.filter((rule) => rule.kind === kind);
        return group.length === 0 ? null : (
          <RuleGroup key={kind} kind={kind} rules={group} now={now} onDelete={onDelete} />
        );
      })}
    </div>
  );
}

export function RuleList({ onRemoved }: { onRemoved: () => void }) {
  const { t } = useTranslation('rules');
  const query = useRules();
  const queryClient = useQueryClient();
  const session = useSession();
  const rulesKey = useRulesKey();
  const refresh = useRefreshAfterRuleChange();
  const remove = useApiMutation(routes.ruleDelete);
  const [pending, setPending] = useState<RuleDto | null>(null);
  const removed = useRef(false);

  // The button that opened the dialog is gone with its rule, so the focus is handed on. This lives
  // here, not in the groups, because deleting the last rule replaces the groups altogether.
  useEffect(() => {
    if (pending === null && removed.current) {
      removed.current = false;
      onRemoved();
    }
  }, [pending, onRemoved]);

  async function confirmDelete() {
    if (pending === null) return;
    const signIn = session.currentSignIn();
    try {
      await remove.mutateAsync({ params: { id: pending.id } });
    } catch (error) {
      // Already gone elsewhere is what was asked for.
      if (!(isApiError(error) && error.status === 404)) throw error;
    }
    if (session.currentSignIn() !== signIn) return;
    removed.current = true;
    queryClient.setQueryData<RuleDto[]>([...rulesKey, 'list'], (items) =>
      items?.filter((item) => item.id !== pending.id),
    );
    refresh();
  }

  return (
    <>
      <QueryState
        query={query}
        isEmpty={(rules) => rules.length === 0}
        empty={<EmptyState title={t('empty.title')} body={t('empty.body')} />}
      >
        {(rules) => <RuleGroups rules={rules} refetch={query.refetch} onDelete={setPending} />}
      </QueryState>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmDelete}
        title={t('delete.title')}
        body={
          pending === null
            ? undefined
            : t('delete.body', { kind: t(`groups.${pending.kind}`), value: pending.displayValue })
        }
        confirmLabel={t('delete.confirm')}
        danger
      />
    </>
  );
}
