import {
  MODEL_ID_PATTERN,
  isModelAlias,
  JEV_LATEST_ALIAS,
  concreteModelOf,
  type AdminSettingsPatch,
  type ModelImpact,
} from '@bantoozi/shared';
import type { TFunction } from 'i18next';
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
import { formatDate, formatDateTime, formatTime } from '../../i18n/dates.js';
import { useMe, useSession } from '../../session/context.js';
import { Alert, Hint } from './admin-ui.js';
import { BackgroundWork, savedQueues, useQueueWatch } from './queue-watch.js';
import type { RuntimeEditorProps } from './runtime-editor.js';
import { MODEL_KEY, checkDraft } from './runtime-fields.js';
import { saveError } from './setting-editor.js';
import { conflictReason, useRefresh } from './use-admin.js';
import { useModelStatus } from './use-model-status.js';

type Mode = 'latest' | 'pinned';

interface Draft {
  mode: Mode;
  id: string;
}

type Problem =
  | { kind: 'error'; error: unknown }
  | { kind: 'refused'; model: string; answered: string | undefined; reason: string }
  | { kind: 'timeout' }
  | { kind: 'expired'; model: string };

/** What a save shows and sends once the change is known. */
interface Shown {
  /** The value to store; null resets to the environment default. */
  body: string | null;
  from: string;
  to: string;
  /** The release the change settles on. */
  concrete: string;
  activeModels: number | null;
}

interface Dialog {
  shown: Shown;
  kind: ModelImpact;
}

const KNOWN_ERRORS = new Set([
  'model_unavailable',
  'model_mismatch',
  'alias_unresolved',
  'timeout',
  'provider_unavailable',
  'rate_limited',
  'auth_rejected',
  'request_rejected',
  'invalid_response',
  'probe_budget_exceeded',
  'budget_unavailable',
  'cost_overrun',
  'internal_error',
  'unsupported_model',
  'no_key',
]);

function errorWords(t: TFunction, error: string | undefined): string {
  const code = (error ?? 'unknown').split(':')[0] ?? 'unknown';
  return KNOWN_ERRORS.has(code)
    ? t(`settings.modelEditor.errors.${code}`)
    : t('settings.modelEditor.errors.unknown', { code });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The time of day, and the day too when it is not today in the account's time zone. */
function whenText(iso: string, language: string, timeZone: string): string {
  const today = formatDate(Date.now(), language, timeZone) === formatDate(iso, language, timeZone);
  return today ? formatTime(iso, language, timeZone) : formatDateTime(iso, language, timeZone);
}

/**
 * The editor of `engine.typesafe_model`: follow `jev-latest` or use one release. A change is saved
 * only after a fresh probe of the new value has been confirmed, and the dialog says what it does.
 */
export function ModelEditor({
  settingKey,
  value,
  defaultValue,
  source,
  hasStoredRow,
  storedAt,
  problems,
  onSend,
  onSaved,
  onStale,
}: RuntimeEditorProps) {
  const { t, i18n } = useTranslation('admin');
  const { timezone } = useMe();
  const toast = useToast();
  const session = useSession();
  const refresh = useRefresh();
  const update = useApiMutation(routes.adminSettingsUpdate);
  const model = useModelStatus();
  const work = useQueueWatch();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [origin, setOrigin] = useState<'save' | 'reset'>('save');
  const [checkTimedOut, setCheckTimedOut] = useState(false);
  const ids = useId();
  const status = model.query.data;
  const ready = status !== undefined || model.query.isError;

  const effective = String(value ?? defaultValue ?? '');
  const savedAlias = isModelAlias(effective);
  const base: Draft = {
    mode: savedAlias ? 'latest' : 'pinned',
    id: savedAlias ? '' : effective,
  };
  const draft = edit ?? base;
  const target = draft.mode === 'latest' ? JEV_LATEST_ALIAS : draft.id.trim();
  const dirty = target !== effective;
  const checked = checkDraft(settingKey, { '': target });
  const accepted = checked.ok && MODEL_ID_PATTERN.test(target);
  const showProblem = dirty && !accepted && draft.mode === 'pinned';
  const serverRejected = problem?.kind === 'error' && isRejected(problem.error);
  const probing = model.run.name === 'probing';
  const checking = model.run.name === 'checking';
  const busy = model.run.name !== 'idle' || update.isPending;
  const errorId = `${ids}-error`;
  const inputId = `${ids}-value`;
  const saveId = `${ids}-save`;
  const modeId = `${ids}-mode`;

  function isRejected(error: unknown): boolean {
    return isApiError(error) && error.status === 400 && error.details?.['key'] === settingKey;
  }

  function choose(mode: Mode) {
    setProblem(null);
    if (mode === 'latest') {
      setEdit({ mode, id: draft.id });
      return;
    }
    const resolved = status ? concreteModelOf(status.setting.value, resolution, status.pin) : null;
    setEdit({ mode, id: draft.id === '' ? (resolved ?? '') : draft.id });
  }

  function dialogData(body: string | null, to: string, concrete: string): Shown {
    return {
      body,
      from: effective,
      to,
      concrete,
      activeModels: model.query.data?.impact?.activeModels ?? null,
    };
  }

  async function patch(shown: Shown, acknowledged: boolean) {
    const signIn = session.currentSignIn();
    setProblem(null);
    const sequence = onSend();
    try {
      const result = await update.mutateAsync({
        body: {
          [settingKey]: shown.body,
          ...(acknowledged ? { acknowledge: true } : {}),
        } as AdminSettingsPatch,
      });
      if (session.currentSignIn() !== signIn) return;
      onSaved(result, sequence);
      const queues = savedQueues(result);
      if (queues !== undefined) work.start(queues);
      setDialog(null);
      setEdit(null);
      void refresh('model-status');
      toast.show({
        message: t(result.changed.includes(settingKey) ? 'settings.saved' : 'settings.unchanged', {
          key: settingKey,
        }),
        tone: 'success',
      });
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      const reason = conflictReason(error);
      if (!acknowledged && reason === 'confirmation_required') {
        setDialog({
          shown: { ...shown, activeModels: model.query.data?.impact?.activeModels ?? null },
          kind: 'restart',
        });
        return;
      }
      setDialog(null);
      const details = isApiError(error) ? error.details : undefined;
      const named = text(details?.['model']) ?? target;
      if (reason === 'model_probe_required') setProblem({ kind: 'expired', model: named });
      else if (reason === 'model_probe_failed') {
        setProblem({
          kind: 'refused',
          model: named,
          answered: text(details?.['answered']),
          reason: text(details?.['error']) ?? 'unknown',
        });
      } else setProblem({ kind: 'error', error });
      if (reason === 'settings_changed') onStale();
    }
  }

  async function begin(to: string, body: string | null, from: 'save' | 'reset') {
    const signIn = session.currentSignIn();
    setOrigin(from);
    setProblem(null);
    setCheckTimedOut(false);
    if (to === effective) {
      await patch(dialogData(body, to, to), false);
      return;
    }
    try {
      const outcome = await model.ensureProbe(to);
      if (session.currentSignIn() !== signIn) return;
      switch (outcome.state) {
        case 'cancelled':
          return;
        case 'timeout':
          setProblem({ kind: 'timeout' });
          return;
        case 'failed': {
          const answered = outcome.probe.answered;
          setProblem({
            kind: 'refused',
            model: to,
            answered: answered !== undefined && answered !== to ? answered : undefined,
            reason: outcome.probe.error ?? 'unknown',
          });
          return;
        }
        case 'ok':
          setDialog({
            shown: {
              body,
              from: effective,
              to,
              concrete: outcome.plan.concrete,
              activeModels: outcome.status.impact?.activeModels ?? null,
            },
            kind: outcome.plan.impact,
          });
      }
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      setProblem({ kind: 'error', error });
    }
  }

  async function checkNow() {
    const signIn = session.currentSignIn();
    setProblem(null);
    setCheckTimedOut(false);
    try {
      const outcome = await model.checkNow();
      if (session.currentSignIn() !== signIn) return;
      if (outcome.state === 'timeout') setCheckTimedOut(true);
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      setProblem({ kind: 'error', error });
    }
  }

  const storedResolution = status?.resolution ?? null;
  // A concrete worker can leave an old alias resolution behind. After saving the alias again,
  // show it only once a check has confirmed it for this setting change.
  const resolution =
    storedResolution !== null &&
    (storedAt == null || Date.parse(storedResolution.checkedAt) >= Date.parse(storedAt))
      ? storedResolution
      : null;
  const lastCheck = status?.watch.lastCheck ?? null;
  const checkFailed =
    lastCheck !== null &&
    !lastCheck.ok &&
    resolution !== null &&
    Date.parse(lastCheck.at) > Date.parse(resolution.checkedAt);
  const when = (iso: string) => whenText(iso, i18n.language, timezone);
  const resetTarget = typeof defaultValue === 'string' ? defaultValue : null;

  function problemText(shown: Problem): string {
    switch (shown.kind) {
      case 'error':
        return saveError(t, shown.error);
      case 'timeout':
        return t('settings.modelEditor.probeTimeout');
      case 'expired':
        return t('settings.modelEditor.probeExpired', { model: shown.model });
      case 'refused':
        return shown.answered === undefined
          ? t('settings.modelEditor.probeRefused', {
              model: shown.model,
              reason: errorWords(t, shown.reason),
            })
          : t('settings.modelEditor.probeAnswered', {
              model: shown.model,
              answered: shown.answered,
            });
    }
  }

  return (
    <div
      role="group"
      aria-label={settingKey}
      className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-col gap-3">
        {ready ? (
          <div className="flex flex-col gap-1">
            <span id={modeId} className={LABEL_CLASSES}>
              {t('settings.modelEditor.modeLabel')}
            </span>
            <div role="radiogroup" aria-labelledby={modeId} className="flex flex-col gap-1">
              {(['latest', 'pinned'] as const).map((mode) => (
                <label
                  key={mode}
                  className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 text-base text-slate-900 dark:text-slate-100"
                >
                  <input
                    type="radio"
                    name={`${ids}-mode`}
                    value={mode}
                    checked={draft.mode === mode}
                    disabled={busy}
                    onChange={() => choose(mode)}
                    className="size-5 cursor-pointer accent-indigo-600 dark:accent-indigo-400"
                  />
                  <span>
                    {t(
                      mode === 'latest'
                        ? 'settings.modelEditor.latest'
                        : 'settings.modelEditor.pinned',
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
        {draft.mode === 'pinned' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className={`${LABEL_CLASSES} font-mono`}>
              {settingKey}
            </label>
            <input
              id={inputId}
              type="text"
              value={draft.id}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              disabled={busy}
              aria-invalid={showProblem || serverRejected ? true : undefined}
              aria-describedby={showProblem ? errorId : undefined}
              onChange={(event) => {
                setEdit({ mode: 'pinned', id: event.target.value });
                setProblem(null);
              }}
              className={CONTROL_CLASSES}
            />
            <Hint>{t('settings.modelEditor.pinnedHint')}</Hint>
          </div>
        ) : (
          <Hint>{t('settings.modelEditor.latestHint')}</Hint>
        )}
      </div>
      {showProblem ? (
        <p id={errorId} className="text-sm font-medium text-red-700 dark:text-red-300">
          {!checked.ok && target === ''
            ? t('settings.notAccepted', { reason: checked.reason })
            : t('settings.modelEditor.idRejected')}
        </p>
      ) : null}
      {savedAlias ? (
        <div className="flex flex-col gap-1">
          <Hint>
            {resolution === null
              ? t('settings.modelEditor.unresolved')
              : t('settings.modelEditor.resolves', {
                  model: resolution.model,
                  time: when(resolution.checkedAt),
                })}
          </Hint>
          {checkFailed ? (
            <Hint>
              {t('settings.modelEditor.checkFailed', {
                time: when(lastCheck.at),
                reason: errorWords(t, lastCheck.error),
                model: resolution.model,
              })}
            </Hint>
          ) : null}
          {checkTimedOut ? <Hint>{t('settings.modelEditor.checkTimeout')}</Hint> : null}
          <div>
            <Button
              variant="secondary"
              disabled={busy}
              loading={checking}
              onClick={() => void checkNow()}
            >
              {t('settings.modelEditor.checkNow')}
            </Button>
          </div>
        </div>
      ) : null}
      <Hint>
        <span>{t(`settings.source.${source === 'last_good' ? 'lastGood' : source}`)}</span>
      </Hint>
      <Hint>
        {t('settings.defaultValue', {
          value: String(defaultValue ?? t('settings.defaultUnknown')),
        })}
      </Hint>
      {problems.map((message) => (
        <Hint key={message} className="font-medium text-red-700 dark:text-red-300">
          {t('settings.workers.problem', { message })}
        </Hint>
      ))}
      {problem === null ? null : <Alert>{problemText(problem)}</Alert>}
      {probing ? (
        <BackgroundWork
          label={t('settings.modelEditor.probing', {
            model: model.run.name === 'probing' ? model.run.model : target,
          })}
        />
      ) : checking ? (
        <BackgroundWork label={t('settings.modelEditor.checking')} />
      ) : work.busy ? (
        <BackgroundWork label={t('settings.reprocessing')} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          id={saveId}
          disabled={!dirty || !accepted}
          loading={
            (probing && origin === 'save') ||
            (update.isPending && dialog === null && origin === 'save') ||
            checking ||
            work.busy
          }
          onClick={() => void begin(target, target, 'save')}
        >
          {t('settings.save', { key: settingKey })}
        </Button>
        <Button
          variant="ghost"
          disabled={
            (source === 'env' && !hasStoredRow) || resetTarget === null || busy || work.busy
          }
          loading={(probing || update.isPending) && origin === 'reset'}
          onClick={() => {
            if (resetTarget !== null) void begin(resetTarget, null, 'reset');
          }}
        >
          {t('settings.reset', { key: settingKey })}
        </Button>
        <Button
          variant="ghost"
          disabled={(!dirty && !checking) || update.isPending}
          onClick={() => {
            model.cancel();
            setEdit(null);
            setProblem(null);
            setCheckTimedOut(false);
          }}
        >
          {t('settings.revert', { key: settingKey })}
        </Button>
      </div>
      {dialog === null ? null : (
        <ImpactDialog
          settingKey={MODEL_KEY}
          dialog={dialog}
          busy={update.isPending}
          returnFocus={() => document.getElementById(saveId)}
          onCancel={() => {
            if (!update.isPending) setDialog(null);
          }}
          onConfirm={() => void patch(dialog.shown, dialog.kind === 'restart')}
        />
      )}
    </div>
  );
}

function ImpactDialog({
  settingKey,
  dialog,
  busy,
  returnFocus,
  onCancel,
  onConfirm,
}: {
  settingKey: string;
  dialog: Dialog;
  /** The confirmed request is in flight: the dialog stays until it is answered. */
  busy: boolean;
  /** Save is disabled while the probe runs, so the opener cannot take the focus back by itself. */
  returnFocus: () => HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('admin');
  const [ticked, setTicked] = useState(false);
  const { shown, kind } = dialog;
  const restart = kind === 'restart';
  const names = { key: settingKey, from: shown.from, to: shown.to };
  const count = shown.activeModels;
  return (
    <Modal
      open
      onClose={onCancel}
      returnFocus={returnFocus}
      title={t(restart ? 'settings.ack.title' : 'settings.modelEditor.impact.title')}
      description={t(restart ? 'settings.ack.body' : 'settings.modelEditor.impact.change', names)}
      surfaceClassName="m-auto w-full max-w-md rounded-xl"
    >
      {restart ? (
        <>
          <p className="text-base text-slate-900 dark:text-slate-100">
            {count === null
              ? t('settings.modelEditor.impact.restartUnknown')
              : count === 0
                ? t('settings.modelEditor.impact.restartNone')
                : t('settings.modelEditor.impact.restart', { count })}
          </p>
          <Checkbox
            label={t('settings.ack.checkbox')}
            checked={ticked}
            onChange={(event) => setTicked(event.target.checked)}
          />
        </>
      ) : (
        <p className="text-base text-slate-900 dark:text-slate-100">
          {kind === 'none'
            ? t('settings.modelEditor.impact.none', { to: shown.concrete })
            : t('settings.modelEditor.impact.kept')}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t('settings.ack.cancel')}
        </Button>
        <Button disabled={restart && !ticked} loading={busy} onClick={onConfirm}>
          {t('settings.ack.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
