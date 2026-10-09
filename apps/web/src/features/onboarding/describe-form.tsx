import { CARD_LIMITS } from '@bantoozi/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { TextField } from '../../components/text-field.js';
import { InlineAlert } from '../feeds/inline-alert.js';
import { cardFieldIssue, cardFieldMessage, saveMessage } from '../interests/card-errors.js';
import { useCardCache } from '../interests/queries.js';

/** Why a description cannot be sent, as the `reason` of a card field problem. */
function problemWith(interest: string): 'required' | 'too_short' | 'too_long' | null {
  if (interest === '') return 'required';
  if (interest.length < CARD_LIMITS.interestMin) return 'too_short';
  if (interest.length > CARD_LIMITS.interestMax) return 'too_long';
  return null;
}

/** A free-text interest: what the person describes becomes a card they like. */
export function DescribeForm() {
  const { t } = useTranslation('onboarding');
  const cache = useCardCache();
  const create = useApiMutation(routes.cardCreate);
  const headingId = useId();
  const sending = useRef(false);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  // What the field holds now, for an answer that comes after the person has typed on.
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const sent = text;
    const interest = text.trim();
    setAdded(null);
    setFailure(null);
    const problem = problemWith(interest);
    if (problem !== null) {
      setFieldError(cardFieldMessage(t, { field: 'interest', reason: problem }));
      return;
    }
    setFieldError(null);
    sending.current = true;
    try {
      const result = await create.mutateAsync({ body: { interest, strength: 'like' } });
      cache.apply(result);
      // Text typed while the interest was being created stays, for the next one.
      setText((current) => (current === sent ? '' : current));
      setAdded(result.card.title);
    } catch (error) {
      const issue = cardFieldIssue(error);
      // A refusal of the description is about the text that was sent, not about newer text.
      if (issue?.field === 'interest' && latest.current === sent) {
        setFieldError(cardFieldMessage(t, issue));
      } else setFailure(saveMessage(t, error));
    } finally {
      sending.current = false;
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('interests.describe.title')}
      </h2>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col items-start gap-3"
      >
        <TextField
          label={t('interests.describe.label')}
          hint={t('interests.describe.hint')}
          error={fieldError}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setFieldError(null);
          }}
          autoComplete="off"
          className="w-full"
        />
        <Button type="submit" loading={create.isPending}>
          {t('interests.describe.submit')}
        </Button>
      </form>
      <p role="status" className={added === null ? 'sr-only' : 'text-sm font-medium'}>
        {added === null ? null : t('interests.describe.added', { title: added })}
      </p>
      {failure === null ? null : <InlineAlert>{failure}</InlineAlert>}
    </section>
  );
}
