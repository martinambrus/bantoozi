import type { LibraryCardDto } from '@bantoozi/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { CheckIcon, PlusIcon } from '../../components/icons.js';
import { Select } from '../../components/select.js';
import { useSession } from '../../session/context.js';
import { conflictReason } from './card-errors.js';
import { useCardCache } from './queries.js';
import { DEFAULT_STRENGTH, STRENGTHS, isStrength, type Strength } from './strengths.js';

/** The card that replaced the one asked for, when the library has moved on since it was listed. */
function supersededBy(error: unknown): string | undefined {
  if (conflictReason(error) !== 'superseded' || !isApiError(error)) return undefined;
  const current = error.details?.['currentCardId'];
  return typeof current === 'string' ? current : undefined;
}

export interface AdoptControlProps {
  card: LibraryCardDto;
  /** Says why adding failed; called with null when a new attempt starts. */
  onMessage: (message: string | null) => void;
}

/** "Add as" a strength: puts a library card among the person's interests. */
export function AdoptControl({ card, onMessage }: AdoptControlProps) {
  const { t } = useTranslation('interests');
  const cache = useCardCache();
  const session = useSession();
  const adopt = useApiMutation(routes.libraryAdopt);
  const [strength, setStrength] = useState<Strength>(DEFAULT_STRENGTH);
  const [busy, setBusy] = useState(false);

  async function adoptAs(id: string) {
    cache.apply(await adopt.mutateAsync({ params: { id }, body: { strength } }));
  }

  async function add() {
    if (busy) return;
    const signIn = session.currentSignIn();
    setBusy(true);
    onMessage(null);
    try {
      try {
        await adoptAs(card.id);
        cache.hold([card.id]);
      } catch (error) {
        const current = supersededBy(error);
        if (current === undefined) throw error;
        // Once the sign-in that asked has ended, the request would go out with the cookie of
        // whoever signs in next, who asked for nothing.
        if (session.currentSignIn() !== signIn) return;
        // A newer version took its place: what the person wants is the current one.
        await adoptAs(current);
        cache.hold([card.id, current]);
        cache.refreshLibrary();
      }
    } catch (error) {
      if (conflictReason(error) === 'already_held') {
        cache.hold([card.id]);
        cache.refreshCards();
        onMessage(t('library.alreadyHeld'));
      } else {
        onMessage(errorMessage(t, error));
      }
    } finally {
      setBusy(false);
    }
  }

  if (card.held) {
    return (
      <Badge tone="success">
        <CheckIcon className="size-3.5" />
        {t('library.held')}
      </Badge>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        label={t('library.addAs')}
        value={strength}
        // The card is added at the strength that was chosen when Add was pressed.
        disabled={busy}
        onChange={(event) => {
          if (isStrength(event.target.value)) setStrength(event.target.value);
        }}
      >
        {STRENGTHS.map((option) => (
          <option key={option} value={option}>
            {t(`strength.${option}`)}
          </option>
        ))}
      </Select>
      <Button loading={busy} onClick={() => void add()}>
        <PlusIcon className="size-4" />
        {t('common:actions.add')}
      </Button>
    </div>
  );
}
