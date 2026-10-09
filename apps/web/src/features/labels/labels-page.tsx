import type { LabelDto } from '@bantoozi/shared';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { PlusIcon, TrashIcon } from '../../components/icons.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { ExampleLists, exampleKey, type ExampleSide } from '../interests/examples.js';
import { DEFAULT_COLOR, normalizeColor } from './colors.js';
import { labelSaveMessage } from './label-errors.js';
import { LabelEditor } from './label-editor.js';
import { useLabelCache, useLabels } from './queries.js';

interface LabelRowProps {
  label: LabelDto;
  onEdit: (label: LabelDto) => void;
  onDelete: (label: LabelDto) => void;
}

function LabelRow({ label, onEdit, onDelete }: LabelRowProps) {
  const { t } = useTranslation('labels');
  const toast = useToast();
  const cache = useLabelCache();
  const removeExample = useApiMutation(routes.labelExampleRemove);
  const [removing, setRemoving] = useState<string | null>(null);
  const titleId = useId();
  // The server only stores #rrggbb; anything else is never put into a style.
  const color = normalizeColor(label.color) ?? DEFAULT_COLOR;

  async function remove(side: ExampleSide, text: string) {
    setRemoving(exampleKey(side, text));
    try {
      cache.apply(
        await removeExample.mutateAsync({ params: { id: label.id }, body: { side, text } }),
      );
    } catch (error) {
      toast.show({ message: labelSaveMessage(t, error), tone: 'error' });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-600"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            role="img"
            aria-label={t('colorSwatch', { color })}
            style={{ backgroundColor: color }}
            className="size-4 shrink-0 rounded-full border border-slate-400"
          />
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold">
            {label.name}
          </h2>
        </div>
        <Badge>{t('count', { count: label.count })}</Badge>
      </div>
      <p className="break-words text-sm">{label.definition}</p>
      {label.notFor === null ? null : (
        <p className="break-words text-sm text-slate-600 dark:text-slate-300">
          {t('notFor', { text: label.notFor })}
        </p>
      )}
      <ExampleLists
        yes={label.examplesYes}
        no={label.examplesNo}
        moreLabel={t('examplesMore')}
        lessLabel={t('examplesLess')}
        removal={{
          label: (text) => t('removeExample', { text }),
          onRemove: (side, text) => void remove(side, text),
          removing,
        }}
      />
      {/* A removal gives the label a new id: an edit or a deletion sent for the old one would fail. */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-describedby={titleId}
          disabled={removing !== null}
          onClick={() => onEdit(label)}
        >
          {t('common:actions.edit')}
        </Button>
        <Button
          variant="ghost"
          aria-describedby={titleId}
          disabled={removing !== null}
          onClick={() => onDelete(label)}
        >
          <TrashIcon className="size-4" />
          {t('common:actions.delete')}
        </Button>
      </div>
    </li>
  );
}

/** The person's labels: groups of their own for organizing articles, never a sign of preference. */
export function LabelsPage() {
  const { t } = useTranslation('labels');
  const cache = useLabelCache();
  const labels = useLabels();
  const deleteLabel = useApiMutation(routes.labelDelete);
  const [editing, setEditing] = useState<LabelDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LabelDto | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  async function remove(label: LabelDto) {
    await deleteLabel.mutateAsync({ params: { id: label.id } });
    cache.remove(label.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <Button onClick={() => setEditing('new')}>
            <PlusIcon className="size-4" />
            {t('new')}
          </Button>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('lead')}</p>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('leadExamples')}</p>
      </header>
      <QueryState
        query={labels}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title={t('emptyTitle')} body={t('emptyBody')} />}
      >
        {(list) => (
          <ul
            ref={listRef}
            tabIndex={-1}
            aria-label={t('listLabel')}
            className="flex flex-col gap-3 outline-none"
          >
            {list.map((label) => (
              <LabelRow key={label.id} label={label} onEdit={setEditing} onDelete={setDeleting} />
            ))}
          </ul>
        )}
      </QueryState>
      {editing === null ? null : (
        <LabelEditor
          label={editing === 'new' ? undefined : editing}
          returnFocus={() => listRef.current}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          open
          danger
          title={t('deleteTitle')}
          body={t('deleteBody', { name: deleting.name, count: deleting.count })}
          confirmLabel={t('common:actions.delete')}
          returnFocus={() => listRef.current}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove(deleting)}
        />
      )}
    </div>
  );
}
