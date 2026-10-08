import { MAX_FOLDER_NAME_LENGTH } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { meKey } from '../../api/query-keys.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Dialog } from '../../components/dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { TextField } from '../../components/text-field.js';
import { InlineAlert } from './inline-alert.js';
import { useSubscriptionsCache } from './subscriptions.js';

export interface RenameFolderDialogProps {
  folder: string;
  /** The names of all folders, to warn when the new name is one of the others. */
  folders: readonly string[];
  onClose: () => void;
  onRenamed: (name: string) => void;
}

/** Renames a folder for all its feeds; the dialog closes once the renamed list is on screen. */
export function RenameFolderDialog({
  folder,
  folders,
  onClose,
  onRenamed,
}: RenameFolderDialogProps) {
  const { t } = useTranslation('feeds');
  const queryClient = useQueryClient();
  const cache = useSubscriptionsCache();
  const [name, setName] = useState(folder);
  const rename = useApiMutation(routes.subscriptionsRenameFolder, {
    // The API renames the folder inside `preferences.folderOrder` as well. The cache hands new data
    // to the screen one tick after it has it; the dialog closes only once the screen shows it.
    onSuccess: async () => {
      await Promise.all([cache.refresh(), queryClient.invalidateQueries({ queryKey: meKey() })]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });

  const trimmed = name.trim();
  const merges = trimmed !== folder && folders.includes(trimmed);
  const canRename = trimmed !== '' && trimmed !== folder;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRename || rename.isPending) return;
    rename.mutate(
      { body: { from: folder, to: trimmed } },
      {
        onSuccess: () => {
          onRenamed(trimmed);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open onClose={onClose} title={t('rename.title')} dismissible={!rename.isPending}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label={t('rename.label')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_FOLDER_NAME_LENGTH}
          hint={merges ? t('rename.merge') : undefined}
          autoComplete="off"
        />
        {rename.error === null ? null : <InlineAlert>{errorMessage(t, rename.error)}</InlineAlert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={rename.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={rename.isPending} disabled={!canRename}>
            {t('rename.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
