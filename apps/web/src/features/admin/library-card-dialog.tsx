import {
  AdminLibraryCreateSchema,
  AdminLibraryPatchSchema,
  type AdminLibraryCard,
  type AdminLibraryResultSchema,
} from '@bantoozi/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Checkbox } from '../../components/checkbox.js';
import { Dialog } from '../../components/dialog.js';
import { TextArea } from '../../components/text-area.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { Alert, Hint } from './admin-ui.js';
import {
  fieldMessage,
  fieldOf,
  libraryProblem,
  lines,
  sameList,
  topicList,
  type FieldName,
} from './library-fields.js';
import { conflictReason } from './use-admin.js';

type SaveResult = z.infer<typeof AdminLibraryResultSchema>;

interface Form {
  slug: string;
  title: string;
  interest: string;
  notFor: string;
  examplesYes: string;
  examplesNo: string;
  skTitle: string;
  skInterest: string;
  topics: string;
  retired: boolean;
}

function formOf(card: AdminLibraryCard | null): Form {
  return {
    slug: '',
    title: card?.title ?? '',
    interest: card?.interest ?? '',
    notFor: card?.notFor ?? '',
    examplesYes: card?.examplesYes.join('\n') ?? '',
    examplesNo: card?.examplesNo.join('\n') ?? '',
    skTitle: card?.i18n.sk?.title ?? '',
    skInterest: card?.i18n.sk?.interest ?? '',
    topics: card?.topicIds.join(', ') ?? '',
    retired: card !== null && card.retiredAt !== null,
  };
}

function slovak(form: Form): { title?: string; interest?: string } {
  const title = form.skTitle.trim();
  const interest = form.skInterest.trim();
  return {
    ...(title === '' ? {} : { title }),
    ...(interest === '' ? {} : { interest }),
  };
}

/** A new card: only what was filled in is sent. */
function createBody(form: Form): Record<string, unknown> {
  const notFor = form.notFor.trim();
  const examplesYes = lines(form.examplesYes);
  const examplesNo = lines(form.examplesNo);
  const sk = slovak(form);
  return {
    slug: form.slug.trim(),
    title: form.title,
    interest: form.interest,
    topicIds: topicList(form.topics),
    ...(notFor === '' ? {} : { notFor }),
    ...(examplesYes.length === 0 ? {} : { examplesYes }),
    ...(examplesNo.length === 0 ? {} : { examplesNo }),
    ...(Object.keys(sk).length === 0 ? {} : { i18n: { sk } }),
  };
}

/** An edit: only the fields that differ from the card as it was loaded. */
function patchBody(card: AdminLibraryCard, form: Form): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const title = form.title.trim();
  if (title !== card.title) patch['title'] = title;
  const topicIds = topicList(form.topics);
  if (!sameList(topicIds, card.topicIds)) patch['topicIds'] = topicIds;
  const sk = slovak(form);
  if (sk.title !== card.i18n.sk?.title || sk.interest !== card.i18n.sk?.interest) {
    // The server replaces the whole object, so the Slovak texts are always sent together.
    patch['i18n'] = Object.keys(sk).length === 0 ? {} : { sk };
  }
  if (form.retired !== (card.retiredAt !== null)) patch['retired'] = form.retired;
  const interest = form.interest.trim();
  if (interest !== card.interest) patch['interest'] = interest;
  const notFor = form.notFor.trim() === '' ? null : form.notFor.trim();
  if (notFor !== card.notFor) patch['notFor'] = notFor;
  const examplesYes = lines(form.examplesYes);
  if (!sameList(examplesYes, card.examplesYes)) patch['examplesYes'] = examplesYes;
  const examplesNo = lines(form.examplesNo);
  if (!sameList(examplesNo, card.examplesNo)) patch['examplesNo'] = examplesNo;
  return patch;
}

export interface LibraryCardDialogProps {
  /** The card to edit, or null to create one. */
  card: AdminLibraryCard | null;
  onClose: () => void;
  /** The list is out of date (a card was created or saved, or a newer version exists). */
  onChanged: () => void;
}

/** An answer that comes after the sign-in that asked has ended shows nothing. */
export function LibraryCardDialog({ card, onClose, onChanged }: LibraryCardDialogProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const session = useSession();
  const create = useApiMutation(routes.adminLibraryCreate);
  const update = useApiMutation(routes.adminLibraryUpdate);
  const [form, setForm] = useState(() => formOf(card));
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const pending = create.isPending || update.isPending;

  const set = <K extends keyof Form>(name: K, value: Form[K]) =>
    setForm((previous) => ({ ...previous, [name]: value }));

  const dirty = card === null || Object.keys(patchBody(card, form)).length > 0;

  function reject(issues: readonly { path: readonly PropertyKey[] }[]) {
    const found: Partial<Record<FieldName, string>> = {};
    for (const issue of issues) {
      const field = fieldOf(issue.path);
      if (field !== null && found[field] === undefined) found[field] = fieldMessage(t, field);
    }
    setErrors(found);
  }

  async function finish(send: () => Promise<SaveResult>, saved: (result: SaveResult) => string) {
    const signIn = session.currentSignIn();
    try {
      const result = await send();
      if (session.currentSignIn() !== signIn) return;
      toast.show({ message: saved(result), tone: 'success' });
      onChanged();
      onClose();
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      setFailure(error);
      if (conflictReason(error) === 'not_latest_version') onChanged();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    if (card === null) {
      const parsed = AdminLibraryCreateSchema.safeParse(createBody(form));
      if (!parsed.success) {
        reject(parsed.error.issues);
        return;
      }
      setErrors({});
      await finish(
        () => create.mutateAsync({ body: parsed.data }),
        () => t('library.created'),
      );
      return;
    }
    const parsed = AdminLibraryPatchSchema.safeParse(patchBody(card, form));
    if (!parsed.success) {
      reject(parsed.error.issues);
      return;
    }
    setErrors({});
    await finish(
      () => update.mutateAsync({ params: { id: card.cardId }, body: parsed.data }),
      (result) =>
        result.idChange !== null && result.card.version !== null
          ? t('library.savedVersion', { version: result.card.version })
          : t('library.saved'),
    );
  }

  const title =
    card === null
      ? t('library.create')
      : card.version === null
        ? t('library.edit.titleUnversioned', { title: card.title })
        : t('library.edit.title', { title: card.title, version: card.version });

  return (
    <Dialog open onClose={onClose} dismissible={!pending} title={title}>
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        {card === null ? (
          <TextField
            label={t('library.form.slug')}
            hint={t('library.form.slugHint')}
            value={form.slug}
            onChange={(event) => set('slug', event.target.value)}
            error={errors.slug}
            autoComplete="off"
          />
        ) : (
          <Hint>{t('library.edit.versionHint')}</Hint>
        )}
        <TextField
          label={t('library.form.title')}
          value={form.title}
          onChange={(event) => set('title', event.target.value)}
          error={errors.title}
        />
        <TextArea
          label={t('library.form.interest')}
          rows={3}
          value={form.interest}
          onChange={(event) => set('interest', event.target.value)}
          error={errors.interest}
        />
        <TextField
          label={t('library.form.notFor')}
          value={form.notFor}
          onChange={(event) => set('notFor', event.target.value)}
          error={errors.notFor}
        />
        <TextArea
          label={t('library.form.examplesYes')}
          rows={3}
          value={form.examplesYes}
          onChange={(event) => set('examplesYes', event.target.value)}
          error={errors.examplesYes}
        />
        <TextArea
          label={t('library.form.examplesNo')}
          rows={3}
          value={form.examplesNo}
          onChange={(event) => set('examplesNo', event.target.value)}
          error={errors.examplesNo}
        />
        <TextField
          label={t('library.form.skTitle')}
          value={form.skTitle}
          onChange={(event) => set('skTitle', event.target.value)}
          error={errors.skTitle}
        />
        <TextArea
          label={t('library.form.skInterest')}
          rows={2}
          value={form.skInterest}
          onChange={(event) => set('skInterest', event.target.value)}
          error={errors.skInterest}
        />
        <TextField
          label={t('library.form.topics')}
          hint={t('library.form.topicsHint')}
          value={form.topics}
          onChange={(event) => set('topics', event.target.value)}
          error={errors.topicIds}
          autoComplete="off"
        />
        {card === null ? null : (
          <Checkbox
            label={t('library.form.retired')}
            hint={t('library.form.retiredHint')}
            checked={form.retired}
            onChange={(event) => set('retired', event.target.checked)}
          />
        )}
        {failure === null ? null : <Alert>{libraryProblem(t, failure)}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={pending} disabled={!dirty}>
            {card === null ? t('library.form.create') : t('library.form.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
