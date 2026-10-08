import type { CardDto, LibraryCardDto } from '@bantoozi/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { QueryState } from '../../components/states/query-state.js';
import { InlineAlert } from '../feeds/inline-alert.js';
import { useCards, useLibrary, type LibraryPage } from '../interests/queries.js';
import { useTopicIndex } from '../interests/topics.js';
import { DescribeForm } from './describe-form.js';
import { LibraryChips, type ChipKind } from './library-chips.js';
import { StepFooter } from './step-footer.js';
import type { StepProps } from './steps.js';

/** The cards that say what the person wants to read about; a never card says the opposite. */
function interestsOf(cards: readonly CardDto[]): CardDto[] {
  return cards.filter((card) => card.strength !== 'never');
}

function Choices({ cards }: { cards: readonly CardDto[] }) {
  const { t } = useTranslation('onboarding');
  const library = useLibrary({ topic: undefined, q: undefined });
  const { topics, index } = useTopicIndex();
  // The pages loaded so far. The library screen is out of reach until the wizard is done, so the
  // next page is loaded here when the person asks for it.
  const offered = (data: InfiniteData<LibraryPage>) => data.pages.flatMap((page) => page.items);
  const chips = (kind: ChipKind, items: LibraryCardDto[]) => (
    <LibraryChips
      kind={kind}
      cards={cards}
      library={items}
      topics={index}
      topicsLoading={topics.isLoading}
    />
  );
  return (
    <>
      <QueryState query={library} isEmpty={(data) => offered(data).length === 0} empty={null}>
        {(data) => chips('like', offered(data))}
      </QueryState>
      {library.isFetchNextPageError ? (
        <InlineAlert>{errorMessage(t, library.error)}</InlineAlert>
      ) : null}
      {library.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            loading={library.isFetchingNextPage}
            onClick={() => void library.fetchNextPage()}
          >
            {t('interests.more')}
          </Button>
        </div>
      ) : null}
      <DescribeForm />
      {library.data === undefined || offered(library.data).length === 0
        ? null
        : chips('never', offered(library.data))}
    </>
  );
}

/** Step 3 of the wizard (spec 09 §4): what the person wants to read about, and what never. */
export function InterestsStep({ go }: StepProps) {
  const { t } = useTranslation('onboarding');
  const cards = useCards();
  const [warning, setWarning] = useState(false);

  return (
    <>
      <p className="text-base">{t('interests.lead')}</p>
      <QueryState query={cards}>{(held) => <Choices cards={held} />}</QueryState>
      <StepFooter step="interests" go={go}>
        {cards.data === undefined ? null : (
          <Button
            onClick={() => {
              if (interestsOf(cards.data).length === 0) setWarning(true);
              else go('calibrate');
            }}
          >
            {t('continue')}
          </Button>
        )}
      </StepFooter>
      <ConfirmDialog
        open={warning}
        title={t('interests.warn.title')}
        body={t('interests.warn.body')}
        cancelLabel={t('interests.warn.back')}
        confirmLabel={t('interests.warn.confirm')}
        onClose={() => {
          setWarning(false);
        }}
        onConfirm={() => {
          go('calibrate');
        }}
      />
    </>
  );
}
