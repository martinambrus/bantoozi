import type { CredentialStatus } from '@bantoozi/shared';
import type { TFunction } from 'i18next';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { Alert, Fact, Facts, Hint } from './admin-ui.js';
import { Time } from './format.js';
import {
  KNOWN_ERROR_CODES,
  snapshotOf,
  validationExpired,
  type ValidationWatch,
} from './provider-status.js';

const STATUS_TONES: Record<NonNullable<CredentialStatus['candidateStatus']>, BadgeTone> = {
  pending: 'neutral',
  validating: 'info',
  valid: 'success',
  invalid: 'danger',
};

type Action = 'stage' | 'validate' | 'activate' | 'revoke';

/**
 * Says what went wrong without ever repeating what was typed. The server refuses an expired
 * validation with the same conflict as a changed credential, so the panel tells them apart.
 */
function problemMessage(t: TFunction, error: unknown, action: Action, expired: boolean): string {
  if (isApiError(error)) {
    if (error.status === 409 && action === 'activate' && expired) {
      return t('providers.problems.expired');
    }
    if (error.status === 409) return t('providers.problems.changed');
    if (error.status === 503 && error.details?.['reason'] === 'keyring_unavailable') {
      return t('providers.problems.keyring');
    }
    if (error.status === 400 && error.details?.['field'] === 'apiKey') {
      return t('providers.problems.keyRejected');
    }
    if (error.status === 404 && (action === 'validate' || action === 'activate')) {
      return t('providers.problems.noCandidate');
    }
  }
  return errorMessage(t, error);
}

function lastError(t: TFunction, code: string): string {
  return KNOWN_ERROR_CODES.includes(code)
    ? t(`providers.lastError.${code}`)
    : t('providers.lastError.unknown', { code });
}

export interface ProviderPanelProps {
  credential: CredentialStatus;
  /** The server answered with a newer state of this credential. */
  onCredential: (credential: CredentialStatus) => void;
  /** The state moved under the panel: the screen reads the list again. */
  onStale: () => void;
  /** A validation was requested: the screen looks for its result until it arrives. */
  onValidationRequested: (watch: ValidationWatch) => void;
}

/** An answer that comes after the sign-in that asked has ended shows nothing. */
export function ProviderPanel({
  credential,
  onCredential,
  onStale,
  onValidationRequested,
}: ProviderPanelProps) {
  const { t } = useTranslation('admin');
  const api = useApi();
  const toast = useToast();
  const session = useSession();
  const headingId = useId();
  const { provider, candidateVersion, candidateStatus } = credential;
  const name = t(`providers.names.${provider}`);

  // The typed key lives in this state only until it is sent: it is cleared before the request
  // starts, and nothing here goes through a query or mutation cache.
  const [apiKey, setApiKey] = useState('');
  const [staging, setStaging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  const validate = useApiMutation(routes.adminCredentialValidate);
  const activate = useApiMutation(routes.adminCredentialActivate);
  const revoke = useApiMutation(routes.adminCredentialRevoke);
  const busy = staging || validate.isPending || activate.isPending || revoke.isPending;

  function fail(error: unknown, action: Action) {
    setProblem(problemMessage(t, error, action, validationExpired(credential, Date.now())));
    if (isApiError(error) && (error.status === 409 || error.status === 404)) onStale();
  }

  async function stage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey;
    // Every change of the provider is made against the revision shown, so they go one at a time.
    if (key === '' || busy) return;
    setApiKey('');
    setStaging(true);
    setProblem(null);
    const signIn = session.currentSignIn();
    try {
      const result = await api.call(routes.adminCredentialStage, {
        params: { provider },
        body: { apiKey: key, expectedRevision: credential.revision },
      });
      if (session.currentSignIn() !== signIn) return;
      onCredential(result.credential);
      toast.show({ message: t('providers.staged'), tone: 'success' });
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      fail(error, 'stage');
    } finally {
      setStaging(false);
    }
  }

  async function requestValidation() {
    if (candidateVersion === null) return;
    setProblem(null);
    const signIn = session.currentSignIn();
    try {
      const result = await validate.mutateAsync({
        params: { provider },
        body: { candidateVersion, expectedRevision: credential.revision },
      });
      if (session.currentSignIn() !== signIn) return;
      onValidationRequested({ snapshot: snapshotOf(credential), startedAt: Date.now() });
      onCredential(result.credential);
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      fail(error, 'validate');
    }
  }

  async function activateCandidate() {
    if (candidateVersion === null) return;
    setProblem(null);
    const signIn = session.currentSignIn();
    try {
      const result = await activate.mutateAsync({
        params: { provider },
        body: { candidateVersion, expectedRevision: credential.revision },
      });
      if (session.currentSignIn() !== signIn) return;
      onCredential(result.credential);
      toast.show({ message: t('providers.activated'), tone: 'success' });
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      fail(error, 'activate');
    }
  }

  async function disable() {
    setProblem(null);
    const signIn = session.currentSignIn();
    try {
      const result = await revoke.mutateAsync({
        params: { provider },
        query: { expectedRevision: credential.revision },
      });
      if (session.currentSignIn() !== signIn) return;
      onCredential(result.credential);
      toast.show({ message: t('providers.disabledToast'), tone: 'success' });
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      fail(error, 'revoke');
    }
  }

  const { capabilities } = credential;
  const expired = validationExpired(credential, Date.now());
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <h3 id={headingId} className="text-lg font-semibold">
        {name}
      </h3>
      <Facts>
        <Fact label={t('providers.source.label')}>
          {t(`providers.source.${credential.source}`)}
        </Fact>
        <Fact label={t('providers.state')}>
          <Badge tone={credential.enabled ? 'success' : 'neutral'}>
            {t(credential.enabled ? 'providers.enabled' : 'providers.disabled')}
          </Badge>
        </Fact>
        <Fact label={t('providers.activeKey')}>
          {credential.activeVersion === null
            ? t('providers.none')
            : t('providers.version', { version: credential.activeVersion })}
        </Fact>
        <Fact label={t('providers.candidateKey')}>
          {candidateVersion === null ? (
            t('providers.none')
          ) : (
            <>
              <span>{t('providers.version', { version: candidateVersion })}</span>{' '}
              {candidateStatus === null ? null : expired ? (
                <Badge tone="warning">{t('providers.candidateStatus.expired')}</Badge>
              ) : (
                <Badge tone={STATUS_TONES[candidateStatus]}>
                  {t(`providers.candidateStatus.${candidateStatus}`)}
                </Badge>
              )}
            </>
          )}
        </Fact>
        {credential.validatedAt === null ? null : (
          <Fact label={t('providers.validatedAt')}>
            <Time value={credential.validatedAt} />
          </Fact>
        )}
        {capabilities === null ? null : (
          <Fact label={t('providers.capabilities.label')}>
            <ul role="list">
              {capabilities.model === null ? null : (
                <li>{t('providers.capabilities.model', { value: capabilities.model })}</li>
              )}
              {capabilities.concurrencyLimit === null ? null : (
                <li>
                  {t('providers.capabilities.concurrency', {
                    value: capabilities.concurrencyLimit,
                  })}
                </li>
              )}
              {Object.entries(capabilities.flags).map(([flag, on]) => (
                <li key={flag}>
                  {t('providers.capabilities.flag', {
                    name: flag,
                    value: t(on ? 'providers.yes' : 'providers.no'),
                  })}
                </li>
              ))}
            </ul>
          </Fact>
        )}
      </Facts>
      {credential.lastErrorCode === null ? null : (
        <Hint>{lastError(t, credential.lastErrorCode)}</Hint>
      )}
      {problem === null ? null : <Alert>{problem}</Alert>}

      <form onSubmit={(event) => void stage(event)} noValidate className="flex flex-col gap-2">
        <TextField
          type="password"
          label={t('providers.keyLabel', { provider: name })}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={4096}
        />
        <div>
          <Button
            type="submit"
            variant="secondary"
            loading={staging}
            disabled={apiKey === '' || busy}
          >
            {t('providers.stage')}
          </Button>
        </div>
      </form>

      {candidateVersion === null ? null : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-start gap-2">
            <Button
              variant="secondary"
              loading={validate.isPending}
              disabled={busy || candidateStatus === 'validating'}
              onClick={() => void requestValidation()}
            >
              {t('providers.validate')}
            </Button>
            <Hint>{t('providers.validateHint')}</Hint>
          </div>
          <div className="flex flex-col items-start gap-2">
            <Button
              loading={activate.isPending}
              disabled={busy || candidateStatus !== 'valid' || expired}
              onClick={() => void activateCandidate()}
            >
              {t('providers.activate')}
            </Button>
            <Hint>{t('providers.activateHint')}</Hint>
          </div>
        </div>
      )}

      {credential.source === 'db' && credential.enabled ? (
        <div>
          <Button variant="danger" disabled={busy} onClick={() => setDisabling(true)}>
            {t('providers.disable')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={disabling}
        onClose={() => setDisabling(false)}
        onConfirm={disable}
        title={t('providers.disableTitle', { provider: name })}
        body={t('providers.disableBody')}
        confirmLabel={t('providers.disableConfirm')}
        danger
      />
    </section>
  );
}
