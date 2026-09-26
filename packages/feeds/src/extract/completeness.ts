import { type DomDocument, type DomElement, hasAncestor, tagOf } from './dom.js';

/**
 * Readability's own default minimum article length. Spec 03 §8.1 step 5 accepts results down to
 * 200 characters, but text shorter than this is too short to be claimed as a complete article: it
 * is recorded as a `teaser` (spec 03 §8.1 step 6, "a short result … does not prove access").
 */
export const SHORT_TEXT_CHARS = 500;

/** Class/id fragments of paywall and registration-wall containers. */
const PAYWALL_TOKEN =
  /paywall|regwall|registration-wall|meteredcontent|metered-content|subscriber-only|subscribers-only|subscriber-content|premium-only|members-only|article-locked|content-locked|locked-content/i;

/**
 * A last paragraph that only points at the rest of the article, or text that ends in an ellipsis
 * (`…`, `...`, `[…]`): the page shows a teaser (English, Slovak, Czech and German cues).
 */
const TEASER_TAIL =
  /(?:\b(?:read more|continue reading|keep reading|read the full (?:story|article)|subscribe to (?:read|continue)|weiterlesen)|čítajte ďalej|čítať ďalej|pokračovanie článku|celý článok|číst dál|pokračování článku)[\s.:!…»›→>)\]]*$|(?:…|\.\.\.|\[…\]|\[\.\.\.\])$/iu;

/** JSON-LD graphs are walked at most this deep and this wide. */
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 5000;

/**
 * Known paywall markers of the original page (before Readability rewrites the DOM):
 * - schema.org `isAccessibleForFree: false` anywhere in a JSON-LD block (the article or a
 *   `hasPart` web page element), or in microdata (`itemprop="isAccessibleForFree"`);
 * - `<meta property="article:content_tier" content="locked">`;
 * - a paywall/registration-wall container (class or id, {@link PAYWALL_TOKEN}) that holds text;
 *   empty placeholders filled by scripts, and flags on `<html>`/`<body>`, do not count.
 */
export function hasPaywallMarkers(document: DomDocument): boolean {
  return jsonLdSaysNotFree(document) || metaSaysLocked(document) || hasPaywallContainer(document);
}

/**
 * Whether the readable text looks like a teaser: shorter than {@link SHORT_TEXT_CHARS}, or ending in
 * a "read more" cue or an ellipsis.
 */
export function looksLikeTeaser(text: string): boolean {
  if (text.length < SHORT_TEXT_CHARS) return true;
  return TEASER_TAIL.test(text.slice(-200));
}

function jsonLdSaysNotFree(document: DomDocument): boolean {
  const scripts = document.getElementsByTagName('script');
  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index];
    const type = script?.getAttribute('type')?.trim().toLowerCase() ?? '';
    if (script === undefined || !type.startsWith('application/ld+json')) continue;
    const source = (script.textContent ?? '')
      .trim()
      .replace(/^<!\[CDATA\[|\]\]>$/g, '')
      .replace(/^<!--|-->$/g, '');
    let data: unknown;
    try {
      data = JSON.parse(source);
    } catch {
      continue;
    }
    if (containsNotFree(data)) return true;
  }
  return false;
}

function containsNotFree(root: unknown): boolean {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  for (let next = 0; next < queue.length && next < MAX_JSON_NODES; next += 1) {
    const { value, depth } = queue[next] as { value: unknown; depth: number };
    if (value === null || typeof value !== 'object' || depth > MAX_JSON_DEPTH) continue;
    const children = Array.isArray(value) ? (value as unknown[]) : Object.values(value);
    if (
      !Array.isArray(value) &&
      isFalse((value as Record<string, unknown>)['isAccessibleForFree'])
    ) {
      return true;
    }
    for (const child of children) queue.push({ value: child, depth: depth + 1 });
  }
  return false;
}

function isFalse(value: unknown): boolean {
  return value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

function metaSaysLocked(document: DomDocument): boolean {
  const metas = document.querySelectorAll('meta, [itemprop]');
  for (let index = 0; index < metas.length; index += 1) {
    const element = metas[index];
    if (element === undefined) continue;
    const name = (element.getAttribute('property') ?? element.getAttribute('name') ?? '').trim();
    const content = element.getAttribute('content') ?? '';
    if (
      name.toLowerCase() === 'article:content_tier' &&
      content.trim().toLowerCase() === 'locked'
    ) {
      return true;
    }
    const itemprop = (element.getAttribute('itemprop') ?? '').trim().toLowerCase();
    if (itemprop === 'isaccessibleforfree') {
      const value = tagOf(element) === 'meta' ? content : (element.textContent ?? '');
      if (isFalse(value)) return true;
    }
  }
  return false;
}

/** Page-wide flags and non-rendered elements are not paywall containers. */
const NOT_CONTAINERS = new Set(['html', 'head', 'body', 'script', 'style', 'template', 'noscript']);

function hasPaywallContainer(document: DomDocument): boolean {
  const elements = document.querySelectorAll('[class], [id]');
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (element === undefined || NOT_CONTAINERS.has(tagOf(element))) continue;
    const names = `${element.getAttribute('class') ?? ''} ${element.getAttribute('id') ?? ''}`;
    if (!PAYWALL_TOKEN.test(names) || isHidden(element) || !hasAncestor(element, 'body')) continue;
    if ((element.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

/** A statically hidden prompt (shown by scripts only when a meter runs out) is not a paywall. */
function isHidden(element: DomElement): boolean {
  if (element.getAttribute('hidden') !== null) return true;
  if (element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') return true;
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
    element.getAttribute('style') ?? '',
  );
}
