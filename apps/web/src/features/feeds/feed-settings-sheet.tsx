import {
  IMAGE_POLICIES,
  MAX_FOLDER_NAME_LENGTH,
  MAX_TITLE_OVERRIDE_LENGTH,
  type ImagePolicy,
  type Subscription,
  type SubscriptionPatch,
} from '@bantoozi/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { useDraft } from '../../components/draft.js';
import { errorMessage } from '../../components/error-message.js';
import { SegmentedControl } from '../../components/segmented-control.js';
import { Select } from '../../components/select.js';
import { Sheet } from '../../components/sheet.js';
import { Switch } from '../../components/switch.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useMe } from '../../session/context.js';
import { ClassificationControls } from './classification-controls.js';
import { displayTitle, feedTitle } from './folders.js';
import { InlineAlert } from './inline-alert.js';
import { useSubscriptionsCache } from './subscriptions.js';
import { UnsubscribeDialog } from './unsubscribe-dialog.js';

const NO_FOLDER = 'none';
const NEW_FOLDER = 'new';
const folderValue = (name: string) => `folder:${name}`;

interface Draft {
  title: string;
  /** `NO_FOLDER`, `NEW_FOLDER` or `folderValue(name)`: values that cannot be mistaken for each other. */
  folder: string;
  newFolder: string;
  allowDuplicates: boolean;
  hidden: boolean;
  imagePolicy: ImagePolicy;
}

function draftOf(subscription: Subscription): Draft {
  return {
    title: subscription.titleOverride ?? '',
    folder: subscription.folder === null ? NO_FOLDER : folderValue(subscription.folder),
    newFolder: '',
    allowDuplicates: subscription.allowDuplicates,
    hidden: subscription.hidden,
    imagePolicy: subscription.imagePolicy,
  };
}

/** The folder the draft stands for: a name, `null` for none, `undefined` while a new name is missing. */
function chosenFolder(draft: Draft): string | null | undefined {
  if (draft.folder === NO_FOLDER) return null;
  if (draft.folder === NEW_FOLDER) return draft.newFolder.trim() || undefined;
  return draft.folder.slice(folderValue('').length);
}

/** What differs from the saved subscription, or null when nothing does or the draft is incomplete. */
function changesOf(subscription: Subscription, draft: Draft): SubscriptionPatch | null {
  const folder = chosenFolder(draft);
  if (folder === undefined) return null;
  const patch: SubscriptionPatch = {};
  const title = draft.title.trim();
  if (title !== (subscription.titleOverride ?? ''))
    patch.titleOverride = title === '' ? null : title;
  if (folder !== subscription.folder) patch.folder = folder;
  if (draft.allowDuplicates !== subscription.allowDuplicates) {
    patch.allowDuplicates = draft.allowDuplicates;
  }
  if (draft.hidden !== subscription.hidden) patch.hidden = draft.hidden;
  if (draft.imagePolicy !== subscription.imagePolicy) patch.imagePolicy = draft.imagePolicy;
  return Object.keys(patch).length === 0 ? null : patch;
}

const IMAGE_LABELS = {
  inherit: 'settings.imagesInherit',
  allow: 'settings.imagesAllow',
  block: 'settings.imagesBlock',
} as const satisfies Record<ImagePolicy, string>;

export interface FeedSettingsSheetProps {
  subscription: Subscription;
  /** The folders to choose from, in the order they are listed. */
  folders: readonly string[];
  /** The settings were saved; the sheet closes next. */
  onSaved: (saved: Subscription) => void;
  onClose: () => void;
}

export function FeedSettingsSheet({
  subscription,
  folders,
  onSaved,
  onClose,
}: FeedSettingsSheetProps) {
  const { t } = useTranslation('feeds');
  const me = useMe();
  const toast = useToast();
  const cache = useSubscriptionsCache();
  // A subscription saved meanwhile (another tab) fills the fields the person has not changed.
  const [draft, setDraft] = useDraft(subscription, draftOf);
  const [asking, setAsking] = useState(false);
  const save = useApiMutation(routes.subscriptionsUpdate);

  const title = displayTitle(subscription);
  const changes = changesOf(subscription, draft);
  const change = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changes === null || save.isPending) return;
    save.mutate(
      { params: { feedId: subscription.feed.id }, body: changes },
      {
        onSuccess: ({ subscription: saved }) => {
          cache.replace(saved);
          void cache.refresh();
          toast.show({
            message: t('settings.saved', { title: displayTitle(saved) }),
            tone: 'success',
          });
          onSaved(saved);
          onClose();
        },
      },
    );
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={t('settings.title')}
        description={title}
        dismissible={!save.isPending}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <TextField
            label={t('settings.titleLabel')}
            value={draft.title}
            onChange={(event) => change({ title: event.target.value })}
            maxLength={MAX_TITLE_OVERRIDE_LENGTH}
            hint={t('settings.titleHint', { title: feedTitle(subscription.feed) })}
            autoComplete="off"
          />
          <Select
            label={t('settings.folder')}
            value={draft.folder}
            onChange={(event) => change({ folder: event.target.value })}
          >
            <option value={NO_FOLDER}>{t('settings.noFolder')}</option>
            {folders.map((name) => (
              <option key={name} value={folderValue(name)}>
                {name}
              </option>
            ))}
            <option value={NEW_FOLDER}>{t('settings.newFolderOption')}</option>
          </Select>
          {draft.folder === NEW_FOLDER ? (
            <TextField
              label={t('settings.newFolder')}
              value={draft.newFolder}
              onChange={(event) => change({ newFolder: event.target.value })}
              maxLength={MAX_FOLDER_NAME_LENGTH}
              required
              autoComplete="off"
            />
          ) : null}
          <Switch
            label={t('settings.allowDuplicates')}
            hint={t('settings.allowDuplicatesHint')}
            checked={draft.allowDuplicates}
            onCheckedChange={(allowDuplicates) => change({ allowDuplicates })}
          />
          <Switch
            label={t('settings.hidden')}
            hint={t('settings.hiddenHint')}
            checked={draft.hidden}
            onCheckedChange={(hidden) => change({ hidden })}
          />
          <SegmentedControl
            label={t('settings.images')}
            hint={t(
              me.preferences.loadRemoteImages ? 'settings.imagesHintOn' : 'settings.imagesHintOff',
            )}
            options={IMAGE_POLICIES.map((policy) => ({
              value: policy,
              label: t(IMAGE_LABELS[policy]),
            }))}
            value={draft.imagePolicy}
            onValueChange={(imagePolicy) => change({ imagePolicy })}
          />
          {save.error === null ? null : <InlineAlert>{errorMessage(t, save.error)}</InlineAlert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending} disabled={changes === null}>
              {t('common:actions.save')}
            </Button>
          </div>
        </form>
        <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
          <ClassificationControls subscription={subscription} />
        </div>
        <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
          <Button variant="danger" onClick={() => setAsking(true)}>
            {t('unsubscribe.action')}
          </Button>
        </div>
      </Sheet>
      <UnsubscribeDialog
        open={asking}
        onClose={() => setAsking(false)}
        feedId={subscription.feed.id}
        title={title}
        onUnsubscribed={onClose}
      />
    </>
  );
}
