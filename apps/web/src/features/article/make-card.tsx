import type { ArticleListItem } from '@bantoozi/shared';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { PlusIcon } from '../../components/icons.js';
import { CardEditor } from '../interests/card-editor.js';

/** Opens the drafted card editor for the article; focus goes back to `returnTo`, else the button. */
export function MakeCard({
  item,
  variant = 'secondary',
  returnTo,
}: {
  item: ArticleListItem;
  variant?: 'secondary' | 'ghost';
  returnTo?: () => HTMLElement | null;
}) {
  const { t } = useTranslation('why');
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button ref={buttonRef} variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        {t('actions.makeCard')}
      </Button>
      {open ? (
        <CardEditor
          fromArticle={{ id: item.id, title: item.title }}
          returnFocus={returnTo ?? (() => buttonRef.current)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
