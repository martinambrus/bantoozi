import { CARD_LIMITS, type LabelDto } from '@bantoozi/shared';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import type { RouteInput } from '../../api/route.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { CONTROL_CLASSES, FieldHelp, LABEL_CLASSES, useFieldIds } from '../../components/field.js';
import type { ModalProps } from '../../components/modal.js';
import { Sheet } from '../../components/sheet.js';
import { TextArea } from '../../components/text-area.js';
import { TextField } from '../../components/text-field.js';
import { FormAlert } from '../auth/form-alert.js';
import { ExampleLists } from '../interests/examples.js';
import { DEFAULT_COLOR, normalizeColor } from './colors.js';
import {
  labelFieldIssue,
  labelFieldMessage,
  labelSaveMessage,
  type LabelField,
} from './label-errors.js';
import { useLabelCache } from './queries.js';

type CreateBody = RouteInput<typeof routes.labelCreate>['body'];
type UpdateBody = NonNullable<RouteInput<typeof routes.labelUpdate>['body']>;

interface Values {
  name: string;
  definition: string;
  notFor: string;
  color: string;
}

type TextKey = 'name' | 'definition' | 'notFor';

const MAX: Record<TextKey, number> = {
  name: CARD_LIMITS.titleMax,
  definition: CARD_LIMITS.interestMax,
  notFor: CARD_LIMITS.notForMax,
};

type Errors = Partial<Record<LabelField, string>>;

const FIELD_ORDER: readonly LabelField[] = ['name', 'definition', 'notFor', 'color'];

function valuesOf(label: LabelDto | undefined): Values {
  return {
    name: label?.name ?? '',
    definition: label?.definition ?? '',
    notFor: label?.notFor ?? '',
    color: label?.color ?? DEFAULT_COLOR,
  };
}

/** What the person typed that cannot be sent: past a limit, empty, too short or not a colour. */
function validate(t: TFunction, values: Values): Errors {
  const errors: Errors = {};
  for (const field of ['name', 'definition', 'notFor'] as const) {
    if (values[field].length > MAX[field]) {
      errors[field] = labelFieldMessage(t, { field, reason: 'too_long' });
    }
  }
  if (errors.name === undefined && values.name.trim() === '') {
    errors.name = labelFieldMessage(t, { field: 'name', reason: 'required' });
  }
  if (errors.definition === undefined) {
    const definition = values.definition.trim();
    if (definition === '') {
      errors.definition = labelFieldMessage(t, { field: 'definition', reason: 'required' });
    } else if (definition.length < CARD_LIMITS.interestMin) {
      errors.definition = labelFieldMessage(t, { field: 'definition', reason: 'too_short' });
    }
  }
  if (normalizeColor(values.color) === null) {
    errors.color = labelFieldMessage(t, { field: 'color', reason: 'color' });
  }
  return errors;
}

function createBody(values: Values): CreateBody {
  const notFor = values.notFor.trim();
  return {
    name: values.name.trim(),
    definition: values.definition.trim(),
    color: normalizeColor(values.color) ?? DEFAULT_COLOR,
    ...(notFor === '' ? {} : { notFor }),
  };
}

/** Only what differs from the label, so a save never rewrites what the person did not touch. */
function changesOf(label: LabelDto, values: Values): UpdateBody {
  const body: UpdateBody = {};
  const name = values.name.trim();
  if (name !== label.name) body.name = name;
  const definition = values.definition.trim();
  if (definition !== label.definition) body.definition = definition;
  const notFor = values.notFor.trim();
  if (notFor !== (label.notFor ?? '')) body.notFor = notFor === '' ? null : notFor;
  const color = normalizeColor(values.color);
  if (color !== null && color !== label.color.toLowerCase()) body.color = color;
  return body;
}

function ColorField({
  value,
  error,
  onChange,
  inputRef,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  inputRef: (node: HTMLInputElement | null) => void;
}) {
  const { t } = useTranslation('labels');
  const field = useFieldIds(undefined, { hint: t('editor.colorHint'), error });
  const color = normalizeColor(value);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={field.id} className={LABEL_CLASSES}>
        {t('editor.color')}
      </label>
      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          id={field.id}
          value={value}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={field.describedBy}
          aria-invalid={field.invalid}
          onChange={(event) => onChange(event.target.value)}
          className={CONTROL_CLASSES}
        />
        {color === null ? null : (
          <span
            role="img"
            aria-label={t('colorSwatch', { color })}
            style={{ backgroundColor: color }}
            className="size-8 shrink-0 rounded-full border border-slate-400"
          />
        )}
      </div>
      <FieldHelp
        hint={t('editor.colorHint')}
        hintId={field.hintId}
        error={error}
        errorId={field.errorId}
      />
    </div>
  );
}

export interface LabelEditorProps {
  /** The label to change; without one the editor creates a label. */
  label?: LabelDto | undefined;
  /** Where the focus goes on closing when the row that opened the editor is gone. */
  returnFocus?: ModalProps['returnFocus'];
  onClose: () => void;
}

/** The sheet that creates a label or changes one. The parent shows it only while it is wanted. */
export function LabelEditor({ label, returnFocus, onClose }: LabelEditorProps) {
  const { t } = useTranslation('labels');
  const cache = useLabelCache();
  const create = useApiMutation(routes.labelCreate);
  const update = useApiMutation(routes.labelUpdate);
  const [values, setValues] = useState(() => valuesOf(label));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: LabelField } | null>(null);
  const fields = useRef<Partial<Record<LabelField, HTMLElement | null>>>({});
  const saving = create.isPending || update.isPending;

  useEffect(() => {
    if (focusRequest !== null) fields.current[focusRequest.field]?.focus();
  }, [focusRequest]);

  function edit(field: LabelField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors(({ [field]: _removed, ...rest }) => rest);
  }

  function reject(found: Errors, field: LabelField) {
    setErrors(found);
    setFailure(null);
    setFocusRequest({ field });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const found = validate(t, values);
    const first = FIELD_ORDER.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      reject(found, first);
      return;
    }
    setErrors({});
    setFailure(null);
    try {
      if (label === undefined) {
        cache.apply(await create.mutateAsync({ body: createBody(values) }));
      } else {
        const body = changesOf(label, values);
        if (Object.keys(body).length > 0) {
          cache.apply(await update.mutateAsync({ params: { id: label.id }, body }));
        }
      }
      onClose();
    } catch (error) {
      const issue = labelFieldIssue(error);
      if (issue !== null) {
        reject({ [issue.field]: labelFieldMessage(t, issue) }, issue.field);
      } else {
        setFailure(labelSaveMessage(t, error));
      }
    }
  }

  const counter = (field: TextKey) =>
    t('editor.counter', { used: values[field].length, max: MAX[field] });

  return (
    <Sheet
      open
      onClose={onClose}
      title={label === undefined ? t('editor.createTitle') : t('editor.editTitle')}
      dismissible={!saving}
      returnFocus={returnFocus}
    >
      <form noValidate onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
        <TextField
          ref={(node) => {
            fields.current.name = node;
          }}
          label={t('editor.name')}
          value={values.name}
          maxLength={CARD_LIMITS.titleMax}
          hint={counter('name')}
          error={errors.name}
          onChange={(event) => edit('name', event.target.value)}
        />
        <TextArea
          ref={(node) => {
            fields.current.definition = node;
          }}
          label={t('editor.definition')}
          value={values.definition}
          rows={3}
          maxLength={CARD_LIMITS.interestMax}
          hint={counter('definition')}
          error={errors.definition}
          onChange={(event) => edit('definition', event.target.value)}
        />
        <TextArea
          ref={(node) => {
            fields.current.notFor = node;
          }}
          label={t('editor.notFor')}
          value={values.notFor}
          rows={2}
          maxLength={CARD_LIMITS.notForMax}
          hint={counter('notFor')}
          error={errors.notFor}
          onChange={(event) => edit('notFor', event.target.value)}
        />
        <ColorField
          value={values.color}
          error={errors.color}
          onChange={(value) => edit('color', value)}
          inputRef={(node) => {
            fields.current.color = node;
          }}
        />
        {label === undefined || label.examplesYes.length + label.examplesNo.length === 0 ? null : (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t('editor.examples')}</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('editor.examplesHint')}</p>
            <ExampleLists
              yes={label.examplesYes}
              no={label.examplesNo}
              moreLabel={t('examplesMore')}
              lessLabel={t('examplesLess')}
            />
          </section>
        )}
        {failure === null ? null : <FormAlert>{failure}</FormAlert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={saving}>
            {t('common:actions.save')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
