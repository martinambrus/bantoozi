import type {
  AdminSettingsPatch,
  AdminSettingsPatchResult,
  RuntimeSettingKey,
} from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Checkbox } from '../../components/checkbox.js';
import { CONTROL_CLASSES, LABEL_CLASSES } from '../../components/field.js';
import { Modal } from '../../components/modal.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { Alert, Hint } from './admin-ui.js';
import {
  ACKNOWLEDGED_KEYS,
  FIELDS,
  checkDraft,
  draftOf,
  formatValue,
  sameDraft,
  type Draft,
} from './runtime-fields.js';
import { saveError } from './setting-editor.js';
import { conflictReason } from './use-admin.js';

export interface RuntimeEditorProps {
  settingKey: RuntimeSettingKey;
  /** The stored value; null while the key reads its environment default. */
  value: unknown;
  /** The environment default; null when no process can tell. */
  defaultValue: unknown;
  source: 'env' | 'stored' | 'last_good';
  /** Whether a row is stored for the key, valid or not (an invalid one reads as `env`). */
  hasStoredRow: boolean;
  /** What the live workers refused of this key. */
  problems: readonly string[];
  onSaved: (result: AdminSettingsPatchResult) => void;
  onStale: () => void;
}

interface Pending {
  /** The value to store; null resets to the environment default. */
  value: unknown;
  from: string;
  to: string;
}

/** A typed editor of one live runtime key: validated by the shared schema before any request. */
export function RuntimeEditor({
  settingKey,
  value,
  defaultValue,
  source,
  hasStoredRow,
  problems,
  onSaved,
  onStale,
}: RuntimeEditorProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const session = useSession();
  const update = useApiMutation(routes.adminSettingsUpdate);
  const [failure, setFailure] = useState<unknown>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const errorId = useId();

  const fields = FIELDS[settingKey];
  const effective = value ?? defaultValue;
  const base = draftOf(settingKey, effective);
  const draft = edit ?? base;
  const dirty = !sameDraft(draft, base);
  const checked = checkDraft(settingKey, draft);
  const showProblem = dirty && !checked.ok;
  const serverRejected =
    isApiError(failure) && failure.status === 400 && failure.details?.['key'] === settingKey;
  const invalid = showProblem || serverRejected;

  async function submit(body: unknown, acknowledged: boolean, shown: Pending) {
    const sent = draft;
    const signIn = session.currentSignIn();
    setFailure(null);
    try {
      const result = await update.mutateAsync({
        body: {
          [settingKey]: body,
          ...(acknowledged ? { acknowledge: true } : {}),
        } as AdminSettingsPatch,
      });
      if (session.currentSignIn() !== signIn) return;
      onSaved(result);
      // Text edited while the save was on its way stays, still to be saved.
      setEdit((current) =>
        body === null || (current !== null && sameDraft(current, sent)) ? null : current,
      );
      toast.show({
        message: t(result.changed.includes(settingKey) ? 'settings.saved' : 'settings.unchanged', {
          key: settingKey,
        }),
        tone: 'success',
      });
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      if (!acknowledged && conflictReason(error) === 'confirmation_required') {
        setPending(shown);
        return;
      }
      setFailure(error);
      if (conflictReason(error) === 'settings_changed') onStale();
    }
  }

  function request(body: unknown) {
    const shown: Pending = {
      value: body,
      from: formatValue(t, settingKey, effective),
      to: formatValue(t, settingKey, body === null ? defaultValue : body),
    };
    // An explicit "off" from an unknown fallback state needs no confirmation (the API decides).
    const offFromUnknown =
      settingKey === 'engine.llm_fallback_enabled' &&
      body === false &&
      (effective === null || effective === undefined);
    if (ACKNOWLEDGED_KEYS.includes(settingKey) && !offFromUnknown) setPending(shown);
    else void submit(body, false, shown);
  }

  return (
    <div
      role="group"
      aria-label={settingKey}
      className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-col gap-3">
        {fields.map((field) => {
          const label = field.part === null ? settingKey : `${settingKey}.${field.part}`;
          const id = `${errorId}-${field.part ?? 'value'}`;
          const text = draft[field.part ?? ''] ?? '';
          const change = (next: string) => {
            setEdit({ ...draft, [field.part ?? '']: next });
            setFailure(null);
          };
          if (field.kind === 'switch' && (base[field.part ?? ''] ?? '') === '') {
            // The current value is unknown, so a single checkbox would pass an unset switch off as
            // "off": the admin chooses on or off explicitly.
            return (
              <div key={id} className="flex flex-col gap-1">
                <span id={`${id}-label`} className={`${LABEL_CLASSES} font-mono`}>
                  {label}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={`${id}-label`}
                  className="flex flex-wrap gap-4"
                >
                  {(['true', 'false'] as const).map((choice) => (
                    <label
                      key={choice}
                      className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 text-base text-slate-900 dark:text-slate-100"
                    >
                      <input
                        type="radio"
                        name={id}
                        value={choice}
                        checked={text === choice}
                        onChange={() => change(choice)}
                        className="size-5 cursor-pointer accent-indigo-600 dark:accent-indigo-400"
                      />
                      <span>{t(choice === 'true' ? 'settings.on' : 'settings.off')}</span>
                    </label>
                  ))}
                </div>
                <Hint>{t('settings.stateUnknown')}</Hint>
              </div>
            );
          }
          if (field.kind === 'switch') {
            return (
              <Checkbox
                key={id}
                id={id}
                label={<span className="font-mono text-sm">{label}</span>}
                checked={text === 'true'}
                onChange={(event) => change(event.target.checked ? 'true' : 'false')}
              />
            );
          }
          const numeric = field.kind !== 'text';
          return (
            <div key={id} className="flex flex-col gap-1.5">
              <label htmlFor={id} className={`${LABEL_CLASSES} font-mono`}>
                {label}
              </label>
              <input
                id={id}
                type={numeric ? 'number' : 'text'}
                {...(numeric ? { step: 'any', inputMode: 'decimal' as const } : {})}
                value={text}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-invalid={invalid ? true : undefined}
                aria-describedby={showProblem ? errorId : undefined}
                onChange={(event) => change(event.target.value)}
                className={CONTROL_CLASSES}
              />
            </div>
          );
        })}
      </div>
      {showProblem && !checked.ok ? (
        <p id={errorId} className="text-sm font-medium text-red-700 dark:text-red-300">
          {t('settings.notAccepted', { reason: checked.reason })}
        </p>
      ) : null}
      <Hint>
        <span>{t(`settings.source.${source === 'last_good' ? 'lastGood' : source}`)}</span>
      </Hint>
      <Hint>{t('settings.defaultValue', { value: formatValue(t, settingKey, defaultValue) })}</Hint>
      {problems.map((message) => (
        <Hint key={message} className="font-medium text-red-700 dark:text-red-300">
          {t('settings.workers.problem', { message })}
        </Hint>
      ))}
      {failure === null ? null : <Alert>{saveError(t, failure)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!dirty || !checked.ok}
          loading={update.isPending}
          onClick={() => {
            if (checked.ok) request(checked.value);
          }}
        >
          {t('settings.save', { key: settingKey })}
        </Button>
        <Button
          variant="ghost"
          disabled={(source === 'env' && !hasStoredRow) || update.isPending}
          onClick={() => request(null)}
        >
          {t('settings.reset', { key: settingKey })}
        </Button>
        <Button
          variant="ghost"
          disabled={!dirty || update.isPending}
          onClick={() => {
            setEdit(null);
            setFailure(null);
          }}
        >
          {t('settings.revert', { key: settingKey })}
        </Button>
      </div>
      {pending === null ? null : (
        <AcknowledgeDialog
          settingKey={settingKey}
          pending={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const confirmed = pending;
            setPending(null);
            void submit(confirmed.value, true, confirmed);
          }}
        />
      )}
    </div>
  );
}

function AcknowledgeDialog({
  settingKey,
  pending,
  onCancel,
  onConfirm,
}: {
  settingKey: string;
  pending: Pending;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('admin');
  const [ticked, setTicked] = useState(false);
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('settings.ack.title')}
      description={t('settings.ack.body', {
        key: settingKey,
        from: pending.from,
        to: pending.to,
      })}
      surfaceClassName="m-auto w-full max-w-md rounded-xl"
    >
      <Checkbox
        label={t('settings.ack.checkbox')}
        checked={ticked}
        onChange={(event) => setTicked(event.target.checked)}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('settings.ack.cancel')}
        </Button>
        <Button disabled={!ticked} onClick={onConfirm}>
          {t('settings.ack.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
