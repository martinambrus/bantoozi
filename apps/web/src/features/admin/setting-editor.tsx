import type {
  AdminSettingKey,
  AdminSettingsPatch,
  AdminSettingsPatchResult,
} from '@bantoozi/shared';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { TextArea } from '../../components/text-area.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { Alert, Hint } from './admin-ui.js';
import { Time } from './format.js';
import { checkSetting } from './settings-validation.js';
import { conflictReason } from './use-admin.js';

function saveError(t: TFunction, error: unknown): string {
  if (isApiError(error)) {
    const reason = error.details?.['reason'];
    if (error.status === 503 && error.details?.['engine'] === 'libretranslate') {
      if (reason === 'not_configured') return t('settings.errors.libreNotConfigured');
      if (reason === 'missing_languages') {
        const missing = error.details['missing'];
        const pairs = Array.isArray(missing) ? missing.map(String).join(', ') : '';
        return t('settings.errors.libreMissing', { pairs });
      }
      return t('settings.errors.libreUnavailable', {
        reason: typeof reason === 'string' ? reason : 'unknown',
      });
    }
    if (error.status === 400) {
      const key = error.details?.['key'];
      if (key === 'ranker.thresholds') return t('settings.errors.rankerRejected');
      if (key === 'question_sets.active') {
        return t('settings.errors.unknownQuestionSet', { kind: String(error.details?.['kind']) });
      }
    }
    if (reason === 'settings_changed') return t('settings.errors.settingsChanged');
    if (reason === 'laya_worker_missing') return t('settings.errors.layaWorkerMissing');
  }
  return errorMessage(t, error);
}

export interface SettingEditorProps {
  settingKey: AdminSettingKey;
  /** The effective value: the stored one, else the default. */
  value: unknown;
  /** When the value was stored; null while the key still reads its default. */
  storedAt: string | null;
  onSaved: (result: AdminSettingsPatchResult) => void;
  /** The settings changed under the editor: the screen loads them again. */
  onStale: () => void;
}

export function SettingEditor({
  settingKey,
  value,
  storedAt,
  onSaved,
  onStale,
}: SettingEditorProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const update = useApiMutation(routes.adminSettingsUpdate);
  const [failure, setFailure] = useState<unknown>(null);
  // Null until the text is touched, so an editor nobody edited follows the latest value.
  const [edit, setEdit] = useState<string | null>(null);

  const effective = JSON.stringify(value, null, 2);
  const text = edit ?? effective;
  const dirty = text !== effective;
  const checked = checkSetting(settingKey, text);
  const problem = checked.ok
    ? undefined
    : checked.problem === 'json'
      ? t('settings.notJson')
      : checked.problem === 'schema'
        ? t('settings.notAccepted', { reason: checked.reason })
        : t('settings.rankerInvalid', { reason: checked.reason });

  async function save() {
    if (!checked.ok) return;
    setFailure(null);
    try {
      const result = await update.mutateAsync({
        body: { [settingKey]: checked.value } as AdminSettingsPatch,
      });
      onSaved(result);
      setEdit(null);
      toast.show({
        message: t(result.changed.includes(settingKey) ? 'settings.saved' : 'settings.unchanged', {
          key: settingKey,
        }),
        tone: 'success',
      });
    } catch (error) {
      setFailure(error);
      if (conflictReason(error) === 'settings_changed') onStale();
    }
  }

  return (
    <div
      role="group"
      aria-label={settingKey}
      className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <TextArea
        label={settingKey}
        value={text}
        rows={Math.min(14, Math.max(2, text.split('\n').length + 1))}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        error={problem}
        onChange={(event) => {
          setEdit(event.target.value);
          setFailure(null);
        }}
        className="[&_textarea]:font-mono [&_textarea]:text-sm"
      />
      <Hint>
        {storedAt === null ? (
          t('settings.default')
        ) : (
          <>
            {t('settings.stored')} <Time value={storedAt} />
          </>
        )}
      </Hint>
      {failure === null ? null : <Alert>{saveError(t, failure)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!dirty || !checked.ok}
          loading={update.isPending}
          onClick={() => void save()}
        >
          {t('settings.save', { key: settingKey })}
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
    </div>
  );
}
