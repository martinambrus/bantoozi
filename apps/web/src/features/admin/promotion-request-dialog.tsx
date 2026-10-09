import { PromotionRequestBodySchema, type LibraryCandidate } from '@bantoozi/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Dialog } from '../../components/dialog.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { Alert, Hint } from './admin-ui.js';
import {
  fieldMessage,
  fieldOf,
  libraryProblem,
  topicList,
  type FieldName,
} from './library-fields.js';

export interface PromotionRequestDialogProps {
  candidate: LibraryCandidate;
  onClose: () => void;
  onCreated: () => void;
}

/** An answer that comes after the sign-in that asked has ended shows nothing. */
export function PromotionRequestDialog({
  candidate,
  onClose,
  onCreated,
}: PromotionRequestDialogProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const session = useSession();
  const create = useApiMutation(routes.adminLibraryPromotionRequest);
  const [title, setTitle] = useState(candidate.title);
  const [titleSk, setTitleSk] = useState('');
  const [topics, setTopics] = useState(candidate.topicIds.join(', '));
  const [slug, setSlug] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const sk = titleSk.trim();
    const typedSlug = slug.trim();
    const parsed = PromotionRequestBodySchema.safeParse({
      cardId: candidate.cardId,
      title,
      topicIds: topicList(topics),
      ...(sk === '' ? {} : { titleSk: sk }),
      ...(typedSlug === '' ? {} : { slug: typedSlug }),
    });
    if (!parsed.success) {
      const found: Partial<Record<FieldName, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = fieldOf(issue.path);
        if (field !== null && found[field] === undefined) found[field] = fieldMessage(t, field);
      }
      setErrors(found);
      return;
    }
    setErrors({});
    const signIn = session.currentSignIn();
    try {
      await create.mutateAsync({ body: parsed.data });
      if (session.currentSignIn() !== signIn) return;
      toast.show({ message: t('library.requests.created'), tone: 'success' });
      onCreated();
      onClose();
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!create.isPending}
      title={t('library.requests.title')}
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <Hint>{t('library.requests.intro')}</Hint>
        <TextField
          label={t('library.requests.publicTitle')}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={errors.title}
        />
        <TextField
          label={t('library.form.skTitle')}
          value={titleSk}
          onChange={(event) => setTitleSk(event.target.value)}
          error={errors.skTitle}
        />
        <TextField
          label={t('library.form.topics')}
          hint={t('library.form.topicsHint')}
          value={topics}
          onChange={(event) => setTopics(event.target.value)}
          error={errors.topicIds}
          autoComplete="off"
        />
        <TextField
          label={t('library.requests.slug')}
          hint={t('library.requests.slugHint')}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          error={errors.slug}
          autoComplete="off"
        />
        {failure === null ? null : <Alert>{libraryProblem(t, failure)}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('library.requests.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
