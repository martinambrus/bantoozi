import type { ReactNode, SVGProps } from 'react';

import { cx } from './cx.js';

/** `className` replaces the default `size-5`: Tailwind utilities cannot be overridden by order. */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'>;

// Inline SVG, because the CSP forbids `data:` image URIs (spec 11 §7). The icons are decorative:
// every control that uses one carries its own accessible name.
function createIcon(displayName: string, shapes: ReactNode) {
  function Icon({ className, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
        className={cx('shrink-0', className ?? 'size-5')}
        aria-hidden="true"
        focusable="false"
      >
        {shapes}
      </svg>
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

export const MenuIcon = createIcon('MenuIcon', <path d="M4 6h16M4 12h16M4 18h16" />);

export const CloseIcon = createIcon('CloseIcon', <path d="M6 6l12 12M18 6L6 18" />);

export const CheckIcon = createIcon('CheckIcon', <path d="M5 12.5l4.5 4.5L19 7.5" />);

export const ChevronUpIcon = createIcon('ChevronUpIcon', <path d="M6 15l6-6 6 6" />);

export const ChevronDownIcon = createIcon('ChevronDownIcon', <path d="M6 9l6 6 6-6" />);

export const ChevronLeftIcon = createIcon('ChevronLeftIcon', <path d="M15 6l-6 6 6 6" />);

export const ChevronRightIcon = createIcon('ChevronRightIcon', <path d="M9 6l6 6-6 6" />);

export const MoreIcon = createIcon(
  'MoreIcon',
  <path strokeWidth={3} d="M5 12h.01M12 12h.01M19 12h.01" />,
);

const thumbShapes = (
  <>
    <rect x="3" y="10" width="4" height="11" rx="1" />
    <path d="M7 11l3.6-7.4A1.4 1.4 0 0 1 11.9 3H12a2 2 0 0 1 2 2v4.5h5.2a2 2 0 0 1 1.97 2.35l-1.15 7.5A2 2 0 0 1 18.05 21H7" />
  </>
);

export const ThumbsUpIcon = createIcon('ThumbsUpIcon', thumbShapes);

export const ThumbsDownIcon = createIcon(
  'ThumbsDownIcon',
  <g transform="matrix(1 0 0 -1 0 24)">{thumbShapes}</g>,
);

const bookmarkPath = 'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z';

export const BookmarkIcon = createIcon('BookmarkIcon', <path d={bookmarkPath} />);

export const BookmarkFilledIcon = createIcon(
  'BookmarkFilledIcon',
  <path d={bookmarkPath} fill="currentColor" />,
);

export const TagIcon = createIcon(
  'TagIcon',
  <>
    <path d="M3 5a2 2 0 0 1 2-2h6.2a2 2 0 0 1 1.4.6l8 8a2 2 0 0 1 0 2.8l-6.2 6.2a2 2 0 0 1-2.8 0l-8-8A2 2 0 0 1 3 11.2z" />
    <path strokeWidth={2.5} d="M8 8h.01" />
  </>,
);

export const EyeOffIcon = createIcon(
  'EyeOffIcon',
  <>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    <path d="M4 4l16 16" />
  </>,
);

export const UndoIcon = createIcon(
  'UndoIcon',
  <>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h9.5a6.5 6.5 0 0 1 0 13H11" />
  </>,
);

export const InfoIcon = createIcon(
  'InfoIcon',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <path d="M12 7.75h.01" />
  </>,
);

export const WarningIcon = createIcon(
  'WarningIcon',
  <>
    <path d="M12 3.2L2.6 19.5a1 1 0 0 0 .87 1.5h17.06a1 1 0 0 0 .87-1.5z" />
    <path d="M12 9.5V14" />
    <path d="M12 17.25h.01" />
  </>,
);

export const ExternalIcon = createIcon(
  'ExternalIcon',
  <>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </>,
);

export const SearchIcon = createIcon(
  'SearchIcon',
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>,
);

export const PlusIcon = createIcon('PlusIcon', <path d="M12 5v14M5 12h14" />);

export const TrashIcon = createIcon(
  'TrashIcon',
  <>
    <path d="M4 7h16" />
    <path d="M9.5 7V4.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5V7" />
    <path d="M6 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h7.2a1.5 1.5 0 0 0 1.5-1.3L18 7" />
    <path d="M10 11v6M14 11v6" />
  </>,
);

export const DragIcon = createIcon(
  'DragIcon',
  <path strokeWidth={3} d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" />,
);

export const RefreshIcon = createIcon(
  'RefreshIcon',
  <>
    <path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L20 9.2" />
    <path d="M20 4.5v4.7h-4.7" />
    <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1L4 14.8" />
    <path d="M4 19.5v-4.7h4.7" />
  </>,
);

export const OfflineIcon = createIcon(
  'OfflineIcon',
  <>
    <path d="M2.5 9a14 14 0 0 1 19 0" />
    <path d="M5.8 12.6a9.4 9.4 0 0 1 12.4 0" />
    <path d="M9 16.2a4.7 4.7 0 0 1 6 0" />
    <path d="M12 19.75h.01" />
    <path d="M4 4l16 16" />
  </>,
);

export const SunIcon = createIcon(
  'SunIcon',
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </>,
);

export const MoonIcon = createIcon(
  'MoonIcon',
  <path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z" />,
);
