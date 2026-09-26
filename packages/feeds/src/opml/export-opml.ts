/** One subscription to export (spec 03 §11). */
export interface OpmlSubscription {
  /** Display title, with the user's title override already applied. */
  title: string;
  /** The feed URL to publish (the canonical survivor of a merged feed). */
  xmlUrl: string;
  htmlUrl: string | null;
  /** Folder name; `null` or blank → top level. */
  folder: string | null;
}

export interface ExportOpmlOptions {
  /** `<head><title>`; default `Bantoozi subscriptions`. */
  title?: string;
  /** `<head><dateCreated>` (RFC 822); omitted when not given, so the output is deterministic. */
  dateCreated?: Date;
}

const DEFAULT_TITLE = 'Bantoozi subscriptions';

/**
 * OPML 2.0 export (spec 03 §11, `GET /subscriptions/export-opml`): one `<outline>` per folder, in
 * the order folders first appear in `subscriptions`, holding one
 * `<outline type="rss" text title xmlUrl htmlUrl/>` per subscription in input order; subscriptions
 * without a folder are top-level outlines at their position. A blank title falls back to the
 * `xmlUrl` (OPML requires `text`); an absent `htmlUrl` is omitted. Every string is emitted as XML
 * text: `& < > " '` and TAB/LF/CR are escaped and characters XML 1.0 forbids are dropped, so a
 * title or folder can never inject markup. `parseOpml` reads the output back to the same folders,
 * titles and URLs.
 */
export function exportOpml(
  subscriptions: readonly OpmlSubscription[],
  options: ExportOpmlOptions = {},
): string {
  const groups: Array<{ folder: string | null; items: OpmlSubscription[] }> = [];
  const folders = new Map<string, OpmlSubscription[]>();
  for (const subscription of subscriptions) {
    const folder = subscription.folder?.trim() ?? '';
    if (folder === '') {
      groups.push({ folder: null, items: [subscription] });
      continue;
    }
    let items = folders.get(folder);
    if (items === undefined) {
      items = [];
      folders.set(folder, items);
      groups.push({ folder, items });
    }
    items.push(subscription);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(options.title ?? DEFAULT_TITLE)}</title>`,
  ];
  const created = options.dateCreated;
  if (created !== undefined && Number.isFinite(created.getTime())) {
    lines.push(`    <dateCreated>${created.toUTCString()}</dateCreated>`);
  }
  lines.push('  </head>', '  <body>');
  for (const group of groups) {
    if (group.folder === null) {
      for (const item of group.items) lines.push(`    ${feedOutline(item)}`);
      continue;
    }
    const label = escapeXml(group.folder);
    lines.push(`    <outline text="${label}" title="${label}">`);
    for (const item of group.items) lines.push(`      ${feedOutline(item)}`);
    lines.push('    </outline>');
  }
  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}

function feedOutline(subscription: OpmlSubscription): string {
  const title = subscription.title.trim() === '' ? subscription.xmlUrl : subscription.title;
  const label = escapeXml(title);
  const attributes = [
    'type="rss"',
    `text="${label}"`,
    `title="${label}"`,
    `xmlUrl="${escapeXml(subscription.xmlUrl)}"`,
  ];
  if (subscription.htmlUrl !== null && subscription.htmlUrl.trim() !== '') {
    attributes.push(`htmlUrl="${escapeXml(subscription.htmlUrl)}"`);
  }
  return `<outline ${attributes.join(' ')}/>`;
}

/** Characters XML 1.0 does not allow at all, even as references (and lone surrogates). */
const XML_FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

/** Escapes text for an XML attribute value or element content. */
function escapeXml(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replace(/[&<>"'\t\n\r]/g, (char) => ESCAPES[char] ?? char);
}
