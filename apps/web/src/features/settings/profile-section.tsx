import { LocaleSchema, MAX_DISPLAY_NAME_LENGTH, type Me, type MePatch } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { meKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { CheckIcon } from '../../components/icons.js';
import { SegmentedControl } from '../../components/segmented-control.js';
import { Select } from '../../components/select.js';
import { TextField } from '../../components/text-field.js';
import { useMe } from '../../session/context.js';
import { Alert, SettingsSection } from './section.js';

type Theme = Me['preferences']['theme'];

interface Draft {
  displayName: string;
  locale: Me['locale'];
  timezone: string;
  theme: Theme;
}

const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

function draftOf(me: Me): Draft {
  return {
    displayName: me.displayName ?? '',
    locale: me.locale,
    timezone: me.timezone,
    theme: me.preferences.theme,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.displayName === b.displayName &&
    a.locale === b.locale &&
    a.timezone === b.timezone &&
    a.theme === b.theme
  );
}

/** Only what differs from the saved profile; an empty name clears it. */
function patchOf(draft: Draft, me: Me): MePatch {
  const patch: MePatch = {};
  const name = draft.displayName.trim() === '' ? null : draft.displayName.trim();
  if (name !== me.displayName) patch.displayName = name;
  if (draft.locale !== me.locale) patch.locale = draft.locale;
  if (draft.timezone !== me.timezone) patch.timezone = draft.timezone;
  if (draft.theme !== me.preferences.theme) patch.preferences = { theme: draft.theme };
  return patch;
}

/**
 * Every zone the browser knows, UTC (which the browsers leave out of that list), and the account's
 * own even when the browser does not list it.
 */
function timeZones(current: string): string[] {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf('timeZone');
  } catch {
    // A browser without the list still shows the zone that is in use.
  }
  const zones = known.includes('UTC') ? known : ['UTC', ...known];
  return zones.includes(current) ? zones : [current, ...zones];
}

export function ProfileSection() {
  const { t } = useTranslation('settings');
  const me = useMe();
  const queryClient = useQueryClient();
  const update = useApiMutation(routes.meUpdate, { networkMode: 'always' });
  const [draft, setDraft] = useState(() => draftOf(me));
  const [synced, setSynced] = useState(me);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const zones = useMemo(() => timeZones(me.timezone), [me.timezone]);

  // A newer account (another tab saved) replaces the form, unless the person is in the middle of an edit.
  if (me !== synced) {
    setSynced(me);
    if (sameDraft(draft, draftOf(synced))) setDraft(draftOf(me));
  }

  const patch = patchOf(draft, me);
  const dirty = Object.keys(patch).length > 0;

  function edit(change: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...change }));
    setSaved(false);
    setFailure(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || update.isPending) return;
    setSaved(false);
    setFailure(null);
    let updated: Me;
    try {
      updated = await update.mutateAsync({ body: patch });
    } catch (error) {
      setFailure(error);
      return;
    }
    queryClient.setQueryData(meKey(), updated);
    setSynced(updated);
    setDraft(draftOf(updated));
    setSaved(true);
  }

  return (
    <SettingsSection
      title={t('profile.title')}
      description={t('profile.signedIn', { email: me.email })}
    >
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <TextField
          label={t('profile.displayName')}
          hint={t('profile.displayNameHint')}
          value={draft.displayName}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          autoComplete="name"
          onChange={(event) => edit({ displayName: event.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t('profile.language')}
            value={draft.locale}
            onChange={(event) => {
              const locale = LocaleSchema.safeParse(event.target.value);
              if (locale.success) edit({ locale: locale.data });
            }}
          >
            <option value="en" lang="en">
              English
            </option>
            <option value="sk" lang="sk">
              Slovenčina
            </option>
          </Select>
          <Select
            label={t('profile.timezone')}
            hint={t('profile.timezoneHint')}
            value={draft.timezone}
            onChange={(event) => edit({ timezone: event.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </div>
        <SegmentedControl
          label={t('profile.theme')}
          value={draft.theme}
          options={THEMES.map((theme) => ({ value: theme, label: t(`profile.themes.${theme}`) }))}
          onValueChange={(theme) => edit({ theme })}
        />
        {failure === null ? null : (
          <Alert>{t('profile.saveFailed', { reason: errorMessage(t, failure) })}</Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={update.isPending} disabled={!dirty}>
            {t('profile.save')}
          </Button>
          <p
            role="status"
            className="flex items-center gap-1.5 text-sm font-medium text-emerald-800 dark:text-emerald-300"
          >
            {saved ? (
              <>
                <CheckIcon className="size-4" />
                {t('profile.saved')}
              </>
            ) : null}
          </p>
        </div>
      </form>
    </SettingsSection>
  );
}
