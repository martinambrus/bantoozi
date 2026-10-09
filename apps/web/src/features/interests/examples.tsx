import { useId } from 'react';

import { IconButton } from '../../components/icon-button.js';
import { CloseIcon } from '../../components/icons.js';

export type ExampleSide = 'yes' | 'no';

export const exampleKey = (side: ExampleSide, text: string) => `${side}:${text}`;

export interface ExampleRemoval {
  /** The accessible name of the button that removes one example. */
  label: (text: string) => string;
  onRemove: (side: ExampleSide, text: string) => void;
  /**
   * The example whose removal is under way, as `exampleKey` makes it. The other examples wait for
   * it: each removal gives the card or label a new id, which the next one is sent for.
   */
  removing: string | null;
}

export interface ExampleListsProps {
  yes: readonly string[];
  no: readonly string[];
  moreLabel: string;
  lessLabel: string;
  /** Adds a remove button to every example; without it the lists only show them. */
  removal?: ExampleRemoval | undefined;
}

/** The examples that show what a card or label does and does not mean, one list per side. */
export function ExampleLists({ yes, no, moreLabel, lessLabel, removal }: ExampleListsProps) {
  return (
    <>
      <ExampleSection side="yes" label={moreLabel} items={yes} removal={removal} />
      <ExampleSection side="no" label={lessLabel} items={no} removal={removal} />
    </>
  );
}

function ExampleSection({
  side,
  label,
  items,
  removal,
}: {
  side: ExampleSide;
  label: string;
  items: readonly string[];
  removal: ExampleRemoval | undefined;
}) {
  const labelId = useId();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p id={labelId} className="text-xs font-medium text-slate-600 dark:text-slate-300">
        {label}
      </p>
      <ul aria-labelledby={labelId} className="flex flex-col gap-1">
        {items.map((text) => (
          <li
            key={exampleKey(side, text)}
            className="flex items-center justify-between gap-2 rounded-md bg-slate-100 py-0.5 pl-3 pr-0.5 text-sm dark:bg-slate-800"
          >
            <span className="min-w-0 break-words">{text}</span>
            {removal === undefined ? null : (
              <IconButton
                label={removal.label(text)}
                disabled={removal.removing !== null}
                onClick={() => removal.onRemove(side, text)}
              >
                <CloseIcon className="size-4" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
