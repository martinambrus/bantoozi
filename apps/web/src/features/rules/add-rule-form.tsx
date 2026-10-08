import {
  RULE_EXPIRY_DAYS,
  RULE_KEYWORD_MAX,
  RULE_KEYWORD_MIN,
  RULE_VALUE_MAX,
  type RuleKind,
} from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { CheckIcon, WarningIcon } from '../../components/icons.js';
import { Select } from '../../components/select.js';
import { TextField } from '../../components/text-field.js';
import { useRulesKey } from './use-rules.js';

/** The kinds made here; muting a story or blocking and boosting a feed start in the reader. */
const ADDABLE_KINDS = [
  'mute_keyword',
  'block_domain',
  'boost_domain',
  'block_author',
] as const satisfies readonly RuleKind[];
type AddableKind = (typeof ADDABLE_KINDS)[number];

const NEVER = 'never';
const EXPIRIES = [NEVER, ...RULE_EXPIRY_DAYS.map(String)];

interface FieldFailure {
  field: 'value' | 'expiresInDays';
  reason: string | undefined;
}

function fieldFailure(error: unknown): FieldFailure | null {
  if (!isApiError(error) || error.status !== 400) return null;
  const field = error.details?.['field'];
  return field === 'value' || field === 'expiresInDays' ? { field, reason: error.reason } : null;
}

export function AddRuleForm() {
  const { t } = useTranslation('rules');
  const queryClient = useQueryClient();
  const rulesKey = useRulesKey();
  const create = useApiMutation(routes.ruleCreate, { networkMode: 'always' });
  const headingId = useId();
  const [kind, setKind] = useState<AddableKind>('mute_keyword');
  const [value, setValue] = useState('');
  const [expiry, setExpiry] = useState(NEVER);
  const [valueError, setValueError] = useState<string | undefined>();
  const [expiryError, setExpiryError] = useState<string | undefined>();
  const [failure, setFailure] = useState<unknown>(null);
  const [added, setAdded] = useState(false);

  function edited() {
    setValueError(undefined);
    setExpiryError(undefined);
    setFailure(null);
    setAdded(false);
  }

  function valueMessage(reason: string | undefined): string {
    switch (reason) {
      case 'keyword':
        return t('add.errors.keyword', { min: RULE_KEYWORD_MIN, max: RULE_KEYWORD_MAX });
      case 'domain':
        return t('add.errors.domain');
      case 'author':
        return t('add.errors.author', { max: RULE_VALUE_MAX });
      default:
        return t('add.errors.invalid');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    edited();
    const text = value.trim();
    if (text === '') {
      setValueError(t('add.errors.empty'));
      return;
    }
    const days = RULE_EXPIRY_DAYS.find((choice) => String(choice) === expiry);
    try {
      await create.mutateAsync({
        body: { kind, value: text, ...(days === undefined ? {} : { expiresInDays: days }) },
      });
    } catch (error) {
      const found = fieldFailure(error);
      if (found?.field === 'value') setValueError(valueMessage(found.reason));
      else if (found?.field === 'expiresInDays') setExpiryError(t('add.errors.expiry'));
      else setFailure(error);
      return;
    }
    setValue('');
    setAdded(true);
    void queryClient.invalidateQueries({ queryKey: rulesKey });
  }

  return (
    <form
      aria-labelledby={headingId}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {t('add.title')}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label={t('add.kind')}
          value={kind}
          onChange={(event) => {
            setKind(ADDABLE_KINDS.find((choice) => choice === event.target.value) ?? kind);
            edited();
          }}
        >
          {ADDABLE_KINDS.map((choice) => (
            <option key={choice} value={choice}>
              {t(`add.kinds.${choice}`)}
            </option>
          ))}
        </Select>
        <Select
          label={t('add.expires')}
          value={expiry}
          error={expiryError}
          onChange={(event) => {
            setExpiry(event.target.value);
            edited();
          }}
        >
          {EXPIRIES.map((choice) => (
            <option key={choice} value={choice}>
              {choice === NEVER ? t('add.never') : t('add.after', { count: Number(choice) })}
            </option>
          ))}
        </Select>
      </div>
      <TextField
        label={t(`add.values.${kind}.label`)}
        hint={t(`add.values.${kind}.hint`, { min: RULE_KEYWORD_MIN, max: RULE_KEYWORD_MAX })}
        value={value}
        error={valueError}
        maxLength={RULE_VALUE_MAX}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => {
          setValue(event.target.value);
          edited();
        }}
      />
      {failure === null ? null : (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-300"
        >
          <WarningIcon className="mt-0.5 size-4 shrink-0" />
          <span>{errorMessage(t, failure)}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={create.isPending}>
          {t('add.submit')}
        </Button>
        <p
          role="status"
          className="flex items-center gap-1.5 text-sm font-medium text-emerald-800 dark:text-emerald-300"
        >
          {added ? (
            <>
              <CheckIcon className="size-4" />
              {t('add.added')}
            </>
          ) : null}
        </p>
      </div>
    </form>
  );
}
