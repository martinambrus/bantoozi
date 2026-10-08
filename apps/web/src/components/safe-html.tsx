import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';
import { useMemo } from 'react';

import { cx } from './cx.js';

/** The display allow-list of the server (packages/feeds, spec 03 §6.3) and the placeholder. */
const ALLOWED_TAGS = [
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'h2',
  'h3',
  'h4',
  'img',
  'figure',
  'figcaption',
  'span',
];

/** Elements whose text must not survive the removal of the element itself. */
const DROP_WITH_CONTENT = [
  'form',
  'textarea',
  'select',
  'option',
  'button',
  'object',
  'embed',
  'applet',
  'frame',
  'frameset',
  'audio',
  'video',
  'canvas',
  'map',
  'xmp',
  'noembed',
  'noframes',
];

const PLACEHOLDER_ATTRIBUTE = 'data-blocked-image';

function isHttpUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function createPurifier(imagesAllowed: boolean): Purifier {
  const purifier = DOMPurify();

  purifier.addHook('uponSanitizeElement', (node) => {
    if (node.nodeName !== 'IMG') return;
    const image = node as Element;
    if (imagesAllowed && isHttpUrl(image.getAttribute('src'))) return;
    const placeholder = image.ownerDocument.createElement('span');
    placeholder.setAttribute(PLACEHOLDER_ATTRIBUTE, '');
    placeholder.textContent = (image.getAttribute('alt') ?? '').trim();
    image.replaceWith(placeholder);
  });

  purifier.addHook('afterSanitizeAttributes', (element) => {
    if (element.nodeName === 'A' && element.hasAttribute('href')) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    } else if (element.nodeName === 'IMG') {
      element.setAttribute('referrerpolicy', 'no-referrer');
      element.setAttribute('loading', 'lazy');
      if (!element.hasAttribute('alt')) element.setAttribute('alt', '');
    }
  });

  return purifier;
}

const purifiers = new Map<boolean, Purifier>();

function purifierFor(imagesAllowed: boolean): Purifier {
  let purifier = purifiers.get(imagesAllowed);
  if (purifier === undefined) {
    purifier = createPurifier(imagesAllowed);
    purifiers.set(imagesAllowed, purifier);
  }
  return purifier;
}

/**
 * The fragment as markup that is safe to insert: the server's allow-list, http(s) links that open
 * in a new tab without opener or referrer, and images only when the policy allows them. A blocked
 * image becomes an inert span with its alt text, and no element ever gets a `src` or `srcset` it
 * may not load (spec 09 §1).
 */
function sanitizeHtml(html: string, imagesAllowed: boolean): string {
  const purifier = purifierFor(imagesAllowed);
  if (!purifier.isSupported) return '';
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'src', 'alt', PLACEHOLDER_ATTRIBUTE],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^https?:/i,
    ADD_FORBID_CONTENTS: DROP_WITH_CONTENT,
  });
}

const BODY_CLASSES = cx(
  'break-words text-base leading-relaxed',
  '[&_p]:my-3 [&_a]:text-indigo-700 [&_a]:underline dark:[&_a]:text-indigo-300',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-6',
  '[&_blockquote]:my-3 [&_blockquote]:border-s-4 [&_blockquote]:border-slate-400 [&_blockquote]:ps-4 [&_blockquote]:italic',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-100 [&_pre]:p-3 dark:[&_pre]:bg-slate-800',
  '[&_code]:font-mono [&_code]:text-sm',
  '[&_figure]:my-3 [&_figcaption]:text-sm [&_figcaption]:text-slate-600 dark:[&_figcaption]:text-slate-300',
  '[&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-lg',
  '[&_[data-blocked-image]]:inline-block [&_[data-blocked-image]]:rounded-md [&_[data-blocked-image]]:border [&_[data-blocked-image]]:border-dashed [&_[data-blocked-image]]:border-slate-400 [&_[data-blocked-image]]:px-2 [&_[data-blocked-image]]:py-0.5 [&_[data-blocked-image]]:text-sm [&_[data-blocked-image]]:text-slate-600 dark:[&_[data-blocked-image]]:text-slate-300 [&_[data-blocked-image]:empty]:hidden',
);

export interface SafeHtmlProps {
  /** A fragment from a feed or a stored snapshot; it is sanitized here whatever its origin. */
  html: string;
  /** `effectiveImagesAllowed` of the item or snapshot the fragment belongs to. */
  imagesAllowed: boolean;
  className?: string | undefined;
}

/** The only place feed HTML reaches the DOM (spec 09 §1, spec 11 §7). */
export function SafeHtml({ html, imagesAllowed, className }: SafeHtmlProps) {
  const sanitized = useMemo(() => sanitizeHtml(html, imagesAllowed), [html, imagesAllowed]);
  return (
    <div className={cx(BODY_CLASSES, className)} dangerouslySetInnerHTML={{ __html: sanitized }} />
  );
}
