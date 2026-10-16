import { AdminPlanCreateSchema, AdminPlanPatchSchema, type AdminPlan } from '@bantoozi/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Dialog } from '../../components/dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { TextField } from '../../components/text-field.js';
import { useSession } from '../../session/context.js';
import { Alert } from './admin-ui.js';

const LIMITS = [
  'maxFeeds',
  'maxCards',
  'maxLabels',
  'maxForks',
  'maxRules',
  'opmlMaxFeeds',
  'minFetchIntervalS',
  'releaseIntervalS',
  'backfillDays',
  'invitesOnSignup',
  'sortOrder',
] as const;
const DEFAULTS = {
  maxFeeds: 200,
  maxCards: 150,
  maxLabels: 20,
  maxForks: 20,
  maxRules: 200,
  opmlMaxFeeds: 300,
  minFetchIntervalS: 900,
  releaseIntervalS: null,
  backfillDays: 7,
  invitesOnSignup: 3,
  sortOrder: 100,
};

export function PlanDialog({
  plan,
  onClose,
  onChanged,
}: {
  plan: AdminPlan | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('admin');
  const session = useSession();
  const create = useApiMutation(routes.adminPlanCreate);
  const update = useApiMutation(routes.adminPlanUpdate);
  const initial: Record<string, string> = {
    key: plan?.key ?? '',
    label: plan?.label ?? '',
    labelSk: plan?.labelSk ?? '',
    ...Object.fromEntries(LIMITS.map((key) => [key, String((plan ?? DEFAULTS)[key] ?? '')])),
  };
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const pending = create.isPending || update.isPending;
  const dirty = plan === null || Object.keys(initial).some((key) => form[key] !== initial[key]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: Record<string, unknown> = {
      label: form['label']?.trim(),
      labelSk: form['labelSk']?.trim() || null,
    };
    for (const key of LIMITS) {
      const value = form[key]?.trim() ?? '';
      body[key] = value === '' ? (key === 'releaseIntervalS' ? null : Number.NaN) : Number(value);
    }
    if (plan === null) body['key'] = form['key'];
    else {
      for (const key of Object.keys(body))
        if (body[key] === plan[key as keyof AdminPlan]) delete body[key];
      body['expectedVersion'] = plan.version;
    }
    const parsed =
      plan === null ? AdminPlanCreateSchema.safeParse(body) : AdminPlanPatchSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path[0]), t('plans.invalid')]),
        ),
      );
      return;
    }
    setErrors({});
    setFailure(null);
    const signIn = session.currentSignIn();
    try {
      if (plan === null) await create.mutateAsync({ body: AdminPlanCreateSchema.parse(body) });
      else
        await update.mutateAsync({
          params: { key: plan.key },
          body: AdminPlanPatchSchema.parse(body),
        });
      if (session.currentSignIn() !== signIn) return;
      onChanged();
      onClose();
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      setFailure(error);
      if (isApiError(error) && error.code === 'STALE_STATE') {
        setStale(true);
        onChanged();
      }
    }
  }

  const field = (name: string) => ({
    value: form[name] ?? '',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((previous) => ({ ...previous, [name]: event.target.value })),
    error: errors[name],
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!pending}
      title={plan === null ? t('plans.add') : t('plans.edit', { key: plan.key })}
    >
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {plan === null ? (
          <TextField label={t('plans.fields.key')} maxLength={40} {...field('key')} />
        ) : null}
        <TextField label={t('plans.fields.label')} maxLength={80} {...field('label')} />
        <TextField label={t('plans.fields.labelSk')} maxLength={80} {...field('labelSk')} />
        <div className="grid gap-4 sm:grid-cols-2">
          {LIMITS.map((name) => (
            <TextField
              key={name}
              label={t(`plans.fields.${name}`)}
              type="number"
              step={1}
              min={name === 'sortOrder' ? -1000000 : name === 'minFetchIntervalS' ? 60 : 0}
              max={name === 'minFetchIntervalS' || name === 'releaseIntervalS' ? 86400 : 1000000}
              {...field(name)}
            />
          ))}
        </div>
        {failure === null ? null : (
          <Alert>{stale ? t('plans.stale') : errorMessage(t, failure)}</Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={pending} disabled={!dirty || stale}>
            {t('plans.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
