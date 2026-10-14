import { CARD_LIMITS, type CardDto } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import type { RouteInput } from '../../api/route.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { cx } from '../../components/cx.js';
import { useDraft } from '../../components/draft.js';
import { quotaDetails } from '../../components/error-message.js';
import type { ModalProps } from '../../components/modal.js';
import { Sheet } from '../../components/sheet.js';
import { TextArea } from '../../components/text-area.js';
import { TextField } from '../../components/text-field.js';
import { useAccountId } from '../../session/context.js';
import { FormAlert } from '../auth/form-alert.js';
import { learningKey } from '../learning/use-learning.js';
import { checkAuthoring } from './authoring-hints.js';
import { CardSwap } from './card-swap.js';
import { cardFieldIssue, cardFieldMessage, saveMessage, type CardField } from './card-errors.js';
import { ScopeSelect, StrengthControl } from './controls.js';
import { ExampleLists } from './examples.js';
import { useCardCache, useSubscriptions, type UpdateOffer } from './queries.js';
import { DEFAULT_STRENGTH, type Strength } from './strengths.js';
import { UpdateDiff } from './update-diff.js';
import { useCardDraft } from './use-card-draft.js';

type CreateBody = RouteInput<typeof routes.cardCreate>['body'];
type UpdateBody = NonNullable<RouteInput<typeof routes.cardUpdate>['body']>;

interface Values {
  title: string;
  interest: string;
  notFor: string;
  strength: Strength;
  /** A feed id; empty for all feeds. */
  scope: string;
}

type TextKey = 'title' | 'interest' | 'notFor';

const TEXT_FIELDS: readonly TextKey[] = ['title', 'interest', 'notFor'];

const MAX: Record<TextKey, number> = {
  title: CARD_LIMITS.titleMax,
  interest: CARD_LIMITS.interestMax,
  notFor: CARD_LIMITS.notForMax,
};

type Errors = Partial<Record<CardField, string>>;

function valuesOf(card: CardDto | undefined): Values {
  return {
    title: card?.title ?? '',
    interest: card?.interest ?? '',
    notFor: card?.notFor ?? '',
    strength: card?.strength ?? DEFAULT_STRENGTH,
    scope: card?.scopeFeedId ?? '',
  };
}

/** What the person typed that cannot be sent: past a limit, or too little to describe an interest. */
function validate(t: TFunction, values: Values): Errors {
  const errors: Errors = {};
  for (const field of TEXT_FIELDS) {
    if (values[field].length > MAX[field]) {
      errors[field] = cardFieldMessage(t, { field, reason: 'too_long' });
    }
  }
  if (errors.interest === undefined) {
    const interest = values.interest.trim();
    if (interest === '') {
      errors.interest = cardFieldMessage(t, { field: 'interest', reason: 'required' });
    } else if (interest.length < CARD_LIMITS.interestMin) {
      errors.interest = cardFieldMessage(t, { field: 'interest', reason: 'too_short' });
    }
  }
  return errors;
}

function createBody(values: Values): CreateBody {
  const title = values.title.trim();
  const notFor = values.notFor.trim();
  return {
    interest: values.interest.trim(),
    strength: values.strength,
    ...(title === '' ? {} : { title }),
    ...(notFor === '' ? {} : { notFor }),
    ...(values.scope === '' ? {} : { scopeFeedId: values.scope }),
  };
}

/** Only what differs from the card, so a save never rewrites what the person did not touch. */
function changesOf(card: CardDto, values: Values): UpdateBody {
  const body: UpdateBody = {};
  const title = values.title.trim();
  if (title !== card.title) {
    if (title !== '') body.title = title;
    // Emptying the name drops the person's own name; a card without one has nothing to drop.
    else if (card.titleOverride !== null) body.title = null;
  }
  const interest = values.interest.trim();
  if (interest !== card.interest) body.interest = interest;
  const notFor = values.notFor.trim();
  if (notFor !== (card.notFor ?? '')) body.notFor = notFor === '' ? null : notFor;
  if (values.strength !== card.strength) body.strength = values.strength;
  if (values.scope !== (card.scopeFeedId ?? '')) {
    body.scopeFeedId = values.scope === '' ? null : values.scope;
  }
  return body;
}

export interface CardEditorProps {
  /** The card to change; without one the editor creates a card. */
  card?: CardDto | undefined;
  /** An update the library offers for this card, shown above the form to review. */
  review?: UpdateOffer | undefined;
  /** Without a card: the article the new card is made from, whose title starts the interest text. */
  fromArticle?: { id: string; title: string } | undefined;
  /**
   * Without a card: up to five articles the new card is made from (instead of `fromArticle`). Their
   * titles become its examples; a drafted name and interest fill the fields (D-240).
   */
  fromArticles?: readonly { id: string; title: string }[] | undefined;
  /** Where the focus goes on closing when the row that opened the editor is gone. */
  returnFocus?: ModalProps['returnFocus'];
  onClose: () => void;
}

/** The sheet that creates a card or changes one. The parent shows it only while it is wanted. */
export function CardEditor({
  card,
  review,
  fromArticle,
  fromArticles,
  returnFocus,
  onClose,
}: CardEditorProps) {
  const { t } = useTranslation('interests');
  const cache = useCardCache();
  const subscriptions = useSubscriptions();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const create = useApiMutation(routes.cardCreate);
  const createFromArticle = useApiMutation(routes.cardFromArticle);
  const update = useApiMutation(routes.cardUpdate);
  const sources = useMemo(
    () =>
      card !== undefined
        ? undefined
        : (fromArticles ?? (fromArticle === undefined ? undefined : [fromArticle])),
    [card, fromArticle, fromArticles],
  );
  const source = sources?.[0];
  const many = (sources?.length ?? 0) > 1;
  // A card saved meanwhile (another tab) fills the fields the person has not changed.
  const [values, setValues] = useDraft(card, valuesOf);
  // The fields the person typed in: a draft that arrives later never overwrites them.
  const typed = useRef(new Set<TextKey>());
  const sourceIds = useMemo(() => sources?.map((article) => article.id), [sources]);
  const drafting = useCardDraft(sourceIds);
  const draft = drafting.status === 'ready' ? drafting.draft : undefined;
  const waiting = source !== undefined && drafting.status === 'drafting';
  // Without a usable draft the interest starts from the first article's title.
  const fallbackTitle =
    source !== undefined && (drafting.status === 'unavailable' || draft?.interest === null)
      ? source.title
      : undefined;
  useEffect(() => {
    if (draft === undefined || draft.interest === null) return;
    const { title, interest } = draft;
    setValues((current) => ({
      ...current,
      ...(typed.current.has('title') || title === null ? {} : { title }),
      ...(typed.current.has('interest') ? {} : { interest }),
    }));
  }, [draft, setValues]);
  useEffect(() => {
    if (fallbackTitle === undefined || typed.current.has('interest')) return;
    setValues((current) =>
      current.interest === '' ? { ...current, interest: fallbackTitle } : current,
    );
  }, [fallbackTitle, setValues]);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: CardField } | null>(null);
  const fields = useRef<Partial<Record<CardField, HTMLElement | null>>>({});
  const saving = create.isPending || createFromArticle.isPending || update.isPending;
  const hints = checkAuthoring(values.interest);
  const hintsId = useId();

  useEffect(() => {
    if (focusRequest !== null) fields.current[focusRequest.field]?.focus();
  }, [focusRequest]);

  function edit(field: TextKey, value: string) {
    typed.current.add(field);
    setValues((current) => ({ ...current, [field]: value }));
    setErrors(({ [field]: _removed, ...rest }) => rest);
  }

  function reject(found: Errors, field: CardField) {
    setErrors(found);
    setFailure(null);
    setFocusRequest({ field });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (swapping && replaceId === null) return;
    const found = validate(t, values);
    const first = TEXT_FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      reject(found, first);
      return;
    }
    setErrors({});
    setFailure(null);
    try {
      if (card === undefined) {
        const body = {
          ...createBody(values),
          ...(replaceId === null ? {} : { replaceCardId: replaceId }),
        };
        const result =
          source === undefined
            ? await create.mutateAsync({ body })
            : await createFromArticle.mutateAsync({
                body: {
                  ...body,
                  articleId: source.id,
                  ...(many
                    ? { moreArticleIds: (sources ?? []).slice(1).map((article) => article.id) }
                    : {}),
                },
              });
        if (replaceId !== null) cache.remove(replaceId);
        cache.apply(result);
      } else {
        const body = changesOf(card, values);
        if (Object.keys(body).length > 0) {
          cache.apply(await update.mutateAsync({ params: { id: card.id }, body }));
        }
      }
      void queryClient.invalidateQueries({ queryKey: learningKey(accountId) });
      onClose();
    } catch (error) {
      if (card === undefined && quotaDetails(error)?.limit === 'maxCards') setSwapping(true);
      const issue = cardFieldIssue(error);
      if (issue !== null) {
        reject({ [issue.field]: cardFieldMessage(t, issue) }, issue.field);
      } else {
        setFailure(saveMessage(t, error));
      }
    }
  }

  const counter = (field: TextKey) =>
    t('editor.counter', { used: values[field].length, max: MAX[field] });
  const flagged = [hints.severalTopics, hints.negation, hints.number];
  const hintTexts = [t('hints.oneTopic'), t('hints.noNot'), t('hints.noNumbers')];
  const hasExamples = card !== undefined && card.examplesYes.length + card.examplesNo.length > 0;
  const createTitle =
    source === undefined
      ? t('editor.createTitle')
      : t(many ? 'editor.fromArticlesTitle' : 'editor.fromArticleTitle');
  const draftNote =
    drafting.status === 'drafting'
      ? t(many ? 'editor.draftingMany' : 'editor.drafting')
      : draft?.source === 'llm'
        ? t(many ? 'editor.draftedMany' : 'editor.drafted')
        : null;

  return (
    <Sheet
      open
      onClose={onClose}
      title={card === undefined ? createTitle : t('editor.editTitle')}
      description={
        source === undefined
          ? undefined
          : t(many ? 'editor.fromArticlesHint' : 'editor.fromArticleHint')
      }
      dismissible={!saving}
      returnFocus={returnFocus}
    >
      <form noValidate onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
        {review === undefined ? null : (
          <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-indigo-300 bg-indigo-50 p-3 dark:border-indigo-700 dark:bg-indigo-950">
            <legend className="px-1 text-sm font-semibold">{t('editor.review')}</legend>
            <UpdateDiff offer={review} stacked />
          </fieldset>
        )}
        {source === undefined ? null : (
          <p role="status" className="text-sm text-slate-600 empty:hidden dark:text-slate-300">
            {draftNote}
          </p>
        )}
        <TextField
          ref={(node) => {
            fields.current.title = node;
          }}
          label={t('editor.name')}
          value={values.title}
          placeholder={waiting && values.title === '' ? t('editor.loading') : undefined}
          maxLength={CARD_LIMITS.titleMax}
          hint={counter('title')}
          error={errors.title}
          onChange={(event) => edit('title', event.target.value)}
        />
        <TextArea
          ref={(node) => {
            fields.current.interest = node;
          }}
          label={t('editor.interest')}
          value={values.interest}
          placeholder={waiting && values.interest === '' ? t('editor.loading') : undefined}
          rows={3}
          maxLength={CARD_LIMITS.interestMax}
          hint={counter('interest')}
          error={errors.interest}
          onChange={(event) => edit('interest', event.target.value)}
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
        <section aria-labelledby={hintsId} className="flex flex-col gap-2">
          <h3 id={hintsId} className="text-sm font-medium">
            {t('hints.heading')}
          </h3>
          <ul aria-labelledby={hintsId} className="flex flex-col gap-1.5">
            {hintTexts.map((text, index) => (
              <li
                key={text}
                className={cx(
                  'flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-sm',
                  flagged[index] === true
                    ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
                    : 'text-slate-600 dark:text-slate-300',
                )}
              >
                <span>{text}</span>
                {flagged[index] === true ? <Badge tone="warning">{t('hints.check')}</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
        <StrengthControl
          value={values.strength}
          onChange={(strength) => setValues((current) => ({ ...current, strength }))}
          hint={t('strength.hint')}
        />
        {source !== undefined ? null : (
          <ScopeSelect
            ref={(node) => {
              fields.current.scopeFeedId = node;
            }}
            value={values.scope === '' ? null : values.scope}
            subscriptions={subscriptions.data ?? []}
            error={errors.scopeFeedId}
            onChange={(feedId) => {
              setValues((current) => ({ ...current, scope: feedId ?? '' }));
              setErrors(({ scopeFeedId: _removed, ...rest }) => rest);
            }}
          />
        )}
        {!hasExamples ? null : (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t('editor.examples')}</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('editor.examplesHint')}</p>
            <ExampleLists
              yes={card.examplesYes}
              no={card.examplesNo}
              moreLabel={t('card.examplesMore')}
              lessLabel={t('card.examplesLess')}
            />
          </section>
        )}
        {!swapping ? null : (
          <CardSwap value={replaceId} onChange={setReplaceId} disabled={saving} />
        )}
        {failure === null ? null : <FormAlert>{failure}</FormAlert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={saving} disabled={swapping && replaceId === null}>
            {swapping ? t('swap.confirm') : t('common:actions.save')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
