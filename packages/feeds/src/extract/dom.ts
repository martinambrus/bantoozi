import { parseHTML } from 'linkedom';

/**
 * The subset of the DOM, as implemented by `linkedom`, that extraction reads. The package compiles
 * without the DOM lib, so these structural types stand in for `Node`, `Element` and `Document`.
 */
export interface DomNode {
  readonly nodeType: number;
  readonly childNodes: ArrayLike<DomNode>;
  readonly parentNode: DomNode | null;
  readonly textContent: string | null;
}

export interface DomElement extends DomNode {
  readonly localName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild(node: DomNode): DomNode;
  remove(): void;
}

export interface DomDocument extends DomNode {
  readonly documentElement: DomElement | null;
  readonly head: DomElement | null;
  readonly body: DomElement | null;
  querySelectorAll(selectors: string): ArrayLike<DomElement>;
  getElementsByTagName(name: string): ArrayLike<DomElement>;
  createElement(name: string): DomElement;
}

const ELEMENT_NODE = 1;

function isElement(node: DomNode): node is DomElement {
  return node.nodeType === ELEMENT_NODE;
}

/** Lower-case tag name of an element (`linkedom` keeps the case elements were created with). */
export function tagOf(element: DomElement): string {
  return element.localName.toLowerCase();
}

/**
 * Parses an HTML page inertly (spec 03 §8.1 step 5): `linkedom` runs no scripts and loads no
 * resources. `linkedom` is not an HTML5 tree builder, so content outside `<body>` would be invisible
 * to Readability; markup without a `<body>` is wrapped first (after `</head>` when there is one).
 */
export function parseDocument(html: string): DomDocument {
  const { document } = parseHTML(withBody(html)) as unknown as { document: DomDocument };
  return document;
}

function withBody(html: string): string {
  if (/<body[\s>/]/i.test(html)) return html;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  let rest = html.slice(doctype?.[0].length ?? 0);
  const htmlOpen = /^\s*<html(?:\s[^>]*)?>/i.exec(rest);
  rest = rest.slice(htmlOpen?.[0].length ?? 0).replace(/<\/html\s*>\s*$/i, '');
  const headEnd = /<\/head\s*>/i.exec(rest);
  const split = headEnd === null ? 0 : headEnd.index + headEnd[0].length;
  const head = headEnd === null ? '<head></head>' : rest.slice(0, split);
  return [
    doctype?.[0].trim() ?? '<!DOCTYPE html>',
    htmlOpen?.[0].trim() ?? '<html>',
    head,
    `<body>${rest.slice(split)}</body></html>`,
  ].join('');
}

/** Whether `node` has an ancestor element named `tag`. */
export function hasAncestor(node: DomNode, tag: string): boolean {
  for (let parent = node.parentNode; parent !== null; parent = parent.parentNode) {
    if (isElement(parent) && tagOf(parent) === tag) return true;
  }
  return false;
}
