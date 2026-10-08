import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { Switch } from '../../components/switch.js';
import { LIMITS } from '../../offline/names.js';
import { formatBytes } from '../settings/format.js';
import { Alert, Hint, SettingsSection } from '../settings/section.js';
import { useOfflineReading } from './use-offline-reading.js';

type Discard = { action: 'clear' | 'off'; unsent: number };

/** Settings: keep articles on this device for reading without a connection (spec 09 §1). */
export function OfflineSection() {
  const { t, i18n } = useTranslation('offline');
  const reading = useOfflineReading();
  const [discard, setDiscard] = useState<Discard | null>(null);

  const perform = (action: Discard['action']) =>
    action === 'off' ? reading.turnOff() : reading.clear();

  async function ask(action: Discard['action']) {
    const unsent = await reading.unsent();
    if (unsent > 0) setDiscard({ action, unsent });
    else await perform(action);
  }

  const { usage } = reading;
  return (
    <SettingsSection title={t('section.title')} description={t('section.description')}>
      <Switch
        label={t('switch.label')}
        hint={t('switch.hint')}
        checked={reading.enabled}
        disabled={reading.busy || (!reading.supported && !reading.enabled)}
        onCheckedChange={(on) => void (on ? reading.turnOn() : ask('off'))}
      />
      {!reading.supported ? (
        <Hint>{t('status.unavailable')}</Hint>
      ) : !reading.enabled ? (
        <Hint>{t('status.off')}</Hint>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          <p>{t('status.articles', { count: usage.articles })}</p>
          {usage.unsent > 0 ? <p>{t('status.unsent', { count: usage.unsent })}</p> : null}
          <Hint>
            {t('status.usage', {
              used: formatBytes(usage.bytes, i18n.language),
              limit: formatBytes(LIMITS.maxBytes, i18n.language),
            })}
          </Hint>
        </div>
      )}
      <div>
        <Button
          variant="secondary"
          disabled={reading.busy || !reading.enabled}
          onClick={() => void ask('clear')}
        >
          {t('clear.button')}
        </Button>
      </div>
      {reading.cleared ? (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
          {t('clear.done')}
        </p>
      ) : null}
      {reading.failed ? <Alert>{t('failed')}</Alert> : null}
      <ConfirmDialog
        open={discard !== null}
        onClose={() => setDiscard(null)}
        onConfirm={async () => {
          if (discard !== null) await perform(discard.action);
        }}
        title={t('discard.title')}
        body={discard === null ? null : t('discard.body', { count: discard.unsent })}
        confirmLabel={discard?.action === 'off' ? t('discard.off') : t('discard.clear')}
        danger
      />
    </SettingsSection>
  );
}
