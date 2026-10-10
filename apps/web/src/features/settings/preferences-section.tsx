import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { CheckIcon } from '../../components/icons.js';
import { SegmentedControl } from '../../components/segmented-control.js';
import { Switch } from '../../components/switch.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';
import { ImageExceptions } from './image-exceptions.js';
import {
  PreferenceSaverProvider,
  usePreferenceSaver,
  type ChoiceId,
  type SettingId,
  type SettingValues,
  type ToggleId,
} from './preferences-saver.js';
import { SettingsSection } from './section.js';
import { usePreferencesLock } from './use-preferences-lock.js';

const TIERS = [1, 2, 3, 4, 5] as const;

/** Tells a screen reader, and the eye, that the setting was saved or was not. */
function SaveStatus({ id }: { id: SettingId }) {
  const { t } = useTranslation('settings');
  const saver = usePreferenceSaver();
  return (
    <span role="status">
      {saver.savedId === id ? (
        <span className="ms-2 inline-flex items-center gap-1 font-medium text-emerald-800 dark:text-emerald-300">
          <CheckIcon className="size-4" />
          {t('preferences.saved')}
        </span>
      ) : null}
      {saver.failureOf(id) === undefined ? null : (
        <VisuallyHidden>{t('preferences.notSaved')}</VisuallyHidden>
      )}
    </span>
  );
}

function useSetting<Id extends SettingId>(id: Id, explanation: string) {
  const { t } = useTranslation('settings');
  const saver = usePreferenceSaver();
  const failure = saver.failureOf(id);
  return {
    value: saver.valueOf(id),
    change: (value: SettingValues[Id]) => saver.change(id, value),
    hint: (
      <>
        {explanation} <SaveStatus id={id} />
      </>
    ),
    error:
      failure === undefined
        ? undefined
        : t('preferences.saveFailed', { reason: errorMessage(t, failure.error) }),
  };
}

function ToggleSetting({ id, text }: { id: ToggleId; text: string }) {
  const { t } = useTranslation('settings');
  const setting = useSetting(id, t(`preferences.${text}.hint`));
  return (
    <Switch
      label={t(`preferences.${text}.label`)}
      checked={setting.value}
      onCheckedChange={setting.change}
      hint={setting.hint}
      error={setting.error}
    />
  );
}

function ChoiceSetting<Id extends ChoiceId>({
  id,
  text,
  optionsText = text,
  options,
}: {
  id: Id;
  /** Where the label and the explanation are, under `preferences`. */
  text: string;
  /** Where the names of the options are, under `preferences`. */
  optionsText?: string;
  options: readonly SettingValues[Id][];
}) {
  const { t } = useTranslation('settings');
  const setting = useSetting(id, t(`preferences.${text}.hint`));
  return (
    <SegmentedControl
      label={t(`preferences.${text}.label`)}
      options={options.map((option) => ({
        value: option,
        label: t(`preferences.${optionsText}.${option}`),
      }))}
      value={setting.value}
      onValueChange={setting.change}
      hint={setting.hint}
      error={setting.error}
    />
  );
}

function TierSetting() {
  const { t } = useTranslation('settings');
  const setting = useSetting('defaultTier', t('preferences.defaultTier.hint'));
  return (
    <SegmentedControl
      label={t('preferences.defaultTier.label')}
      options={TIERS.map((tier) => ({ value: String(tier), label: String(tier) }))}
      value={String(setting.value)}
      onValueChange={(value) => {
        const tier = TIERS.find((candidate) => String(candidate) === value);
        if (tier !== undefined) setting.change(tier);
      }}
      hint={setting.hint}
      error={setting.error}
    />
  );
}

function Group({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string | undefined;
  children: ReactNode;
}) {
  const headingId = useId();
  const introId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-describedby={intro === undefined ? undefined : introId}
      className="flex flex-col gap-4"
    >
      <h3 id={headingId} className="text-base font-semibold">
        {title}
      </h3>
      {intro === undefined ? null : (
        <p id={introId} className="text-sm text-slate-600 dark:text-slate-300">
          {intro}
        </p>
      )}
      {children}
    </div>
  );
}

const SORTS = ['score', 'date'] as const;
const FEEDBACK_PROMPTS = ['often', 'occasionally', 'never'] as const;
const TRI = ['auto', 'on', 'off'] as const;
const SWIPE_LEFT = ['dislike', 'read', 'none'] as const;
const SWIPE_RIGHT = ['like', 'bookmark', 'none'] as const;

export function PreferencesSection() {
  const { t } = useTranslation('settings');
  const { state, takeOver, whileSaving } = usePreferencesLock();
  const locked = state === 'elsewhere';
  const inert = state !== 'held';
  const controls = useRef<HTMLDivElement>(null);
  const takeOverButton = useRef<HTMLButtonElement>(null);
  // An inert subtree drops the focus; the person was in the controls, so the button is next.
  useLayoutEffect(() => {
    if (locked && controls.current?.contains(document.activeElement) === true) {
      takeOverButton.current?.focus();
    }
  }, [locked]);
  return (
    <SettingsSection title={t('preferences.title')} description={t('preferences.intro')}>
      <PreferenceSaverProvider lock={state} whileSaving={whileSaving}>
        <div className="relative">
          <div ref={controls} inert={inert} className="flex flex-col gap-8">
            <Group title={t('preferences.groups.lists')}>
              <TierSetting />
              <ChoiceSetting id="sort" text="sort" options={SORTS} />
              <ToggleSetting id="hideEverything" text="hideEverything" />
              <ToggleSetting id="simpleMode" text="simpleMode" />
            </Group>
            <Group title={t('preferences.groups.reading')}>
              <ToggleSetting id="markReadOnExpand" text="markReadOnExpand" />
              <ToggleSetting id="markReadOnRate" text="markReadOnRate" />
            </Group>
            <Group title={t('preferences.groups.learning')}>
              <ToggleSetting id="implicitFeedback" text="implicitFeedback" />
              <ToggleSetting id="implicitNegative" text="implicitNegative" />
              <ChoiceSetting id="feedbackPrompt" text="feedbackPrompt" options={FEEDBACK_PROMPTS} />
              <ToggleSetting id="exampleSuggestions" text="exampleSuggestions" />
            </Group>
            <Group title={t('preferences.groups.quality')} intro={t('preferences.quality.intro')}>
              <ChoiceSetting
                id="demote.clickbait"
                text="quality.clickbait"
                optionsText="quality"
                options={TRI}
              />
              <ChoiceSetting
                id="demote.promotional"
                text="quality.promotional"
                optionsText="quality"
                options={TRI}
              />
              <ChoiceSetting
                id="demote.shallow"
                text="quality.shallow"
                optionsText="quality"
                options={TRI}
              />
              <ChoiceSetting
                id="demote.stale"
                text="quality.stale"
                optionsText="quality"
                options={TRI}
              />
            </Group>
            <Group title={t('preferences.groups.swipe')}>
              <ChoiceSetting id="swipe.left" text="swipe.left" options={SWIPE_LEFT} />
              <ChoiceSetting id="swipe.right" text="swipe.right" options={SWIPE_RIGHT} />
            </Group>
            <Group title={t('preferences.groups.images')}>
              <ToggleSetting id="loadRemoteImages" text="images" />
              <ImageExceptions />
            </Group>
          </div>
          {locked ? (
            <div className="absolute inset-0 z-10 flex items-start justify-center bg-white/80 p-4 dark:bg-slate-950/80">
              <div
                role="status"
                className="sticky top-[calc(5rem+var(--update-bar-height,0px))] flex max-w-md flex-col items-start gap-3 rounded-lg border border-slate-300 bg-white p-4 shadow-lg dark:border-slate-600 dark:bg-slate-900"
              >
                <p className="text-base font-semibold">{t('preferences.lock.title')}</p>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {t('preferences.lock.body')}
                </p>
                <Button ref={takeOverButton} variant="secondary" onClick={takeOver}>
                  {t('preferences.lock.takeOver')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </PreferenceSaverProvider>
    </SettingsSection>
  );
}
