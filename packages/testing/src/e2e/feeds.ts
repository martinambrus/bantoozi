import { createHash } from 'node:crypto';

import {
  startFixtureServer,
  type FixtureServer,
  type ScriptedResponse,
} from '../fixture-server.js';
import { E2E_FEED_KEYS, type E2eFeedKey } from './env.js';
import { solidPng } from './png.js';

/**
 * The three dynamic fixture feeds of the E2E environment (spec 09 §9), one origin each because the
 * shared origin limiter spaces requests per origin. A feed is RSS 2.0 built per request from
 * in-memory items; every item links to a readable article page, and one item per feed carries an
 * image. Titles and excerpts use topic words that no other item uses: the fake TypeSafe server
 * scores a card 0.9 when one of its ≥ 4-character interest tokens occurs in a title or excerpt
 * (spec 04 §10), so a card naming a topic word matches exactly one item.
 */

const HOUR_MS = 3_600_000;

export interface CatalogueEntry {
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  /** The word a card's interest names to match this item. */
  readonly topic: string;
  /** Publication time: this many hours before the feed started. */
  readonly ageHours: number;
  readonly image: boolean;
}

export interface FeedCatalogue {
  readonly title: string;
  readonly description: string;
  readonly items: readonly CatalogueEntry[];
}

export const FEED_CATALOGUE: Readonly<Record<E2eFeedKey, FeedCatalogue>> = {
  tech: {
    title: 'E2E Tech Wire',
    description: 'Fixture feed: technology news.',
    items: [
      {
        slug: 'tech-quantum',
        title: 'Quantum processors pass a thousand stable qubits',
        excerpt:
          'A laboratory reports lasting coherence on superconducting circuits, a milestone for fault tolerant machines.',
        topic: 'quantum',
        ageHours: 2,
        image: false,
      },
      {
        slug: 'tech-robotics',
        title: 'Warehouse robotics firm unveils a gentler gripper',
        excerpt:
          'Soft silicone fingers let the arm lift ripe fruit and thin glassware without a single crack.',
        topic: 'robotics',
        ageHours: 14,
        image: true,
      },
      {
        slug: 'tech-firmware',
        title: 'Router firmware update closes a decade old loophole',
        excerpt:
          'Vendors rushed patches after researchers showed how attackers could chain two small flaws.',
        topic: 'firmware',
        ageHours: 30,
        image: false,
      },
    ],
  },
  science: {
    title: 'E2E Science Desk',
    description: 'Fixture feed: science news.',
    items: [
      {
        slug: 'science-exoplanet',
        title: 'Astronomers detect exoplanet atmosphere containing water vapour',
        excerpt: 'Starlight filtered through a distant rocky world hints at a thin humid envelope.',
        topic: 'exoplanet',
        ageHours: 3,
        image: false,
      },
      {
        slug: 'science-glacier',
        title: 'Glacier survey finds meltwater lakes deeper than expected',
        excerpt: 'Radar flights over Greenland mapped hidden basins beneath the ice sheet.',
        topic: 'glacier',
        ageHours: 19,
        image: true,
      },
      {
        slug: 'science-enzyme',
        title: 'Engineered enzyme digests stubborn plastic bottles',
        excerpt: 'A hybrid protein breaks polyester chains within days at moderate temperatures.',
        topic: 'enzyme',
        ageHours: 35,
        image: false,
      },
    ],
  },
  culture: {
    title: 'E2E Culture Post',
    description: 'Fixture feed: arts and culture news.',
    items: [
      {
        slug: 'culture-orchestra',
        title: 'Youth orchestra premieres a commissioned symphony',
        excerpt: 'Teenage players rehearsed the new score for six months before opening night.',
        topic: 'orchestra',
        ageHours: 5,
        image: false,
      },
      {
        slug: 'culture-cinema',
        title: 'Independent cinema revives midnight screenings',
        excerpt: 'Volunteers restored a vintage projector and filled every seat each weekend.',
        topic: 'cinema',
        ageHours: 22,
        image: true,
      },
      {
        slug: 'culture-pottery',
        title: 'Village pottery festival draws record crowds',
        excerpt: 'Craftspeople demonstrated wood fired kilns while visitors tried the wheel.',
        topic: 'pottery',
        ageHours: 44,
        image: false,
      },
    ],
  },
};

/** Generic news prose (≈ 24 words each); {topic} is replaced by the item's topic word. */
const FILLER = [
  'People familiar with the {topic} story say the first signs appeared quietly several months ago, long before anyone outside the group paid attention.',
  'Officials declined to give exact figures, but they confirmed that the numbers released so far are broadly in line with what the working group expected.',
  'Analysts who follow the sector caution that early reports often change as more details emerge, so the picture may look different by next week.',
  'A spokesperson described the response as encouraging and said the organisation intends to share further updates as soon as the data has been checked.',
  'Neighbours and colleagues interviewed for this report described a steady, unglamorous effort that depended on patience, careful record keeping and a great deal of coffee.',
  'Critics argue that the claims deserve more scrutiny, pointing out that similar announcements in the past promised more than they eventually delivered.',
  'Supporters reply that the evidence is stronger this time, because several independent groups have repeated the key steps and reached comparable conclusions.',
  'The timeline matters here, because each stage depended on the previous one, and a delay at the start pushed every later milestone back by weeks.',
  'Funding came from a mix of public grants and private donors, and the accounts published last spring show that most of it went to equipment and salaries.',
  'Several ordinary users have already written in to describe how the {topic} development affects their daily routine, and their accounts are remarkably consistent.',
  'Experts from nearby universities have offered to review the methods, which would add a welcome layer of outside checking to the work.',
  'For now the practical advice is simple: wait for the full report, read it carefully, and treat dramatic summaries on social media with caution.',
  'Looking back, the turning point came during a long meeting in which a junior member of the group asked a question nobody had thought to raise.',
  'The costs are modest compared with similar projects, partly because the team reused tools and materials that were already sitting in storage.',
  "Local newspapers covered the {topic} announcement on their front pages, and radio stations devoted whole morning programmes to listeners' questions and reactions.",
  'Not everyone is convinced, and a small but vocal group continues to ask whether the benefits will reach the people who need them most.',
  'Regulators have been kept informed throughout and have so far raised no objections, although they reserve the right to ask for changes later.',
  'What happens next depends on funding, on weather, on supply chains and, above all, on whether the early results hold up under repeated testing.',
  'Younger readers may find it hard to imagine how different things were only a decade ago, when this kind of progress seemed almost out of reach.',
  'In the end the story is about people more than machines or numbers: those who stayed late, double-checked the results and refused to cut corners.',
  'The organisers plan a public briefing next month, where questions from the audience will be answered and the full set of supporting documents will be released.',
  'Comparisons with earlier efforts are tempting but misleading, since the conditions, the budgets and the expectations were very different on each occasion.',
  'Observers expect the debate to continue for some time, which is probably healthy, because good decisions rarely come from conversations that end too quickly.',
  'This report will be updated when new information arrives, and readers are welcome to send corrections, questions or observations of their own.',
] as const;

const SENTENCES_PER_PARAGRAPH = 4;

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface E2eFeedItem {
  readonly slug: string;
  readonly guid: string;
  readonly title: string;
  readonly excerpt: string;
  readonly topic: string;
  /** The article page. */
  readonly url: string;
  readonly imageUrl: string | null;
  /** ISO 8601. */
  readonly publishedAt: string;
}

/**
 * The paragraphs of an article page: the excerpt, then {@link FILLER} rotated by a hash of the slug,
 * so every page has well over 400 words and no two pages read the same.
 */
export function articleParagraphs(item: Pick<E2eFeedItem, 'slug' | 'excerpt' | 'topic'>): string[] {
  const offset = Number.parseInt(
    createHash('sha256').update(item.slug).digest('hex').slice(0, 8),
    16,
  );
  const sentences = FILLER.map((_, i) => FILLER[(offset + i) % FILLER.length] as string).map((s) =>
    s.replaceAll('{topic}', item.topic),
  );
  const paragraphs = [item.excerpt];
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARAGRAPH) {
    paragraphs.push(sentences.slice(i, i + SENTENCES_PER_PARAGRAPH).join(' '));
  }
  return paragraphs;
}

/** A complete article page that Readability extracts (≥ 7 paragraphs, ≈ 590 words). */
export function buildArticlePage(feedTitle: string, item: E2eFeedItem): string {
  const [lead = '', ...rest] = articleParagraphs(item).map((p) => `<p>${escapeXml(p)}</p>`);
  const figure =
    item.imageUrl === null
      ? ''
      : `<figure><img src="${escapeXml(item.imageUrl)}" alt="" width="120" height="80"></figure>\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeXml(item.title)} - ${escapeXml(feedTitle)}</title>
</head>
<body>
<header><p>${escapeXml(feedTitle)}</p></header>
<article>
<h1>${escapeXml(item.title)}</h1>
${lead}
${figure}${rest.join('\n')}
</article>
<footer><p>Fixture page for the Bantoozi end-to-end tests.</p></footer>
</body>
</html>
`;
}

export interface RssFeedInput {
  readonly title: string;
  readonly link: string;
  readonly description: string;
  readonly builtAt: Date;
  /** Newest first. */
  readonly items: readonly E2eFeedItem[];
}

/** RSS 2.0; the item description is the excerpt as HTML (plus the image when the item has one). */
export function buildRss(feed: RssFeedInput): string {
  const items = feed.items
    .map((item) => {
      const html =
        `<p>${escapeXml(item.excerpt)}</p>` +
        (item.imageUrl === null ? '' : `<img src="${escapeXml(item.imageUrl)}" alt="">`);
      return `<item>
<title>${escapeXml(item.title)}</title>
<link>${escapeXml(item.url)}</link>
<guid isPermaLink="false">${escapeXml(item.guid)}</guid>
<pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
<description>${escapeXml(html)}</description>
</item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
<channel>
<title>${escapeXml(feed.title)}</title>
<link>${escapeXml(feed.link)}</link>
<description>${escapeXml(feed.description)}</description>
<language>en</language>
<lastBuildDate>${feed.builtAt.toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

export class FeedInputError extends Error {
  override readonly name = 'FeedInputError';
}

export interface AppendItemInput {
  title: string;
  excerpt?: string | undefined;
  slug?: string | undefined;
  topic?: string | undefined;
  image?: boolean | undefined;
  /** ISO 8601; default: now. */
  publishedAt?: string | undefined;
}

export interface RequestRecord {
  method: string;
  path: string;
  at: string;
  userAgent: string | null;
  referer: string | null;
}

export interface E2eFeed {
  readonly key: E2eFeedKey;
  readonly title: string;
  readonly origin: string;
  /** The feed document a reader subscribes to. */
  readonly url: string;
  /** Catalogue and appended items, newest first. */
  items(): E2eFeedItem[];
  append(input: AppendItemInput): E2eFeedItem;
  /** Answer `path` with `status` (400-599) from now on, or with its normal content again for null. */
  script(path: string, status: number | null): void;
  requests(): RequestRecord[];
  /** Drop appended items, scripted failures and the request log. */
  reset(): void;
  close(): Promise<void>;
}

export interface StartFeedOptions {
  /** Listening port on 127.0.0.1; default: a random free port. */
  port?: number;
  now?: () => Date;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const CONTROL_CHARS = /\p{Cc}/u;
const MAX_TITLE_CHARS = 200;
/** The API's list DTO caps an excerpt at 300 characters. */
const MAX_EXCERPT_CHARS = 300;

function text(value: string, name: string, max: number): string {
  if (value.trim() === '' || value.length > max || CONTROL_CHARS.test(value)) {
    throw new FeedInputError(`${name} must be 1-${max} printable characters`);
  }
  return value;
}

function defaultTopic(title: string): string {
  const words = title.toLowerCase().match(/\p{L}{4,}/gu) ?? [];
  return words.reduce((best, word) => (word.length > best.length ? word : best), 'news');
}

const textResponse = (status: number, body: string): ScriptedResponse => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body,
});

/** One fixture feed on its own origin: `/feed.xml`, `/articles/<slug>.html`, `/img/<slug>.png`, `/robots.txt`. */
export async function startFeed(key: E2eFeedKey, options: StartFeedOptions = {}): Promise<E2eFeed> {
  const now = options.now ?? (() => new Date());
  const catalogue = FEED_CATALOGUE[key];
  const server: FixtureServer = await startFixtureServer(
    options.port === undefined ? {} : { port: options.port },
  );
  const startedAt = now();
  const baseItems: E2eFeedItem[] = catalogue.items.map((entry) => ({
    slug: entry.slug,
    guid: `urn:bantoozi-e2e:${entry.slug}`,
    title: entry.title,
    excerpt: entry.excerpt,
    topic: entry.topic,
    url: server.url(`/articles/${entry.slug}.html`),
    imageUrl: entry.image ? server.url(`/img/${entry.slug}.png`) : null,
    publishedAt: new Date(startedAt.getTime() - entry.ageHours * HOUR_MS).toISOString(),
  }));
  const appended: E2eFeedItem[] = [];
  const failures = new Map<string, number>();
  const installed = new Set<string>();
  /** Never reset: an appended item's default slug (and so its URL) is not reused after a reset. */
  let appendedCount = 0;

  const items = (): E2eFeedItem[] =>
    [...baseItems, ...appended].sort(
      (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
    );

  const install = (path: string, normal: () => ScriptedResponse): void => {
    installed.add(path);
    server.route(path, () => {
      const status = failures.get(path);
      return status === undefined ? normal() : textResponse(status, `scripted ${status}`);
    });
  };
  const installItem = (item: E2eFeedItem): void => {
    install(new URL(item.url).pathname, () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: buildArticlePage(catalogue.title, item),
    }));
    if (item.imageUrl !== null) {
      const png = solidPng(item.slug);
      install(new URL(item.imageUrl).pathname, () => ({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: png,
      }));
    }
  };
  const installBase = (): void => {
    install('/feed.xml', () => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: buildRss({
        title: catalogue.title,
        link: server.url('/'),
        description: catalogue.description,
        builtAt: now(),
        items: items(),
      }),
    }));
    install('/robots.txt', () => ({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'User-agent: *\nDisallow:\n',
    }));
    for (const item of baseItems) installItem(item);
  };
  installBase();

  return {
    key,
    title: catalogue.title,
    origin: server.origin,
    url: server.url('/feed.xml'),
    items,
    append(input) {
      const title = text(input.title, 'title', MAX_TITLE_CHARS);
      const excerpt = text(input.excerpt ?? `${title}.`, 'excerpt', MAX_EXCERPT_CHARS);
      const serial = appendedCount + 1;
      const slug = input.slug ?? `${key}-extra-${serial}`;
      if (!SLUG.test(slug)) throw new FeedInputError('slug must match [a-z0-9][a-z0-9-]{0,60}');
      if (items().some((item) => item.slug === slug)) {
        throw new FeedInputError(`slug "${slug}" is already used`);
      }
      const publishedAt = input.publishedAt === undefined ? now() : new Date(input.publishedAt);
      if (Number.isNaN(publishedAt.getTime())) {
        throw new FeedInputError('publishedAt must be an ISO 8601 date');
      }
      const item: E2eFeedItem = {
        slug,
        guid: `urn:bantoozi-e2e:${slug}`,
        title,
        excerpt,
        topic: input.topic ?? defaultTopic(title),
        url: server.url(`/articles/${slug}.html`),
        imageUrl: input.image === true ? server.url(`/img/${slug}.png`) : null,
        publishedAt: publishedAt.toISOString(),
      };
      appendedCount = serial;
      appended.push(item);
      installItem(item);
      return item;
    },
    script(path, status) {
      if (!path.startsWith('/') || path.includes('?') || path.length > 200) {
        throw new FeedInputError('path must start with / and carry no query string');
      }
      if (status === null) {
        failures.delete(path);
        return;
      }
      if (!Number.isInteger(status) || status < 400 || status > 599) {
        throw new FeedInputError('status must be an integer from 400 to 599, or null');
      }
      failures.set(path, status);
      if (!installed.has(path)) install(path, () => textResponse(404, 'not found'));
    },
    requests: () =>
      server.requests.map((request) => ({
        method: request.method,
        path: request.path,
        at: request.at.toISOString(),
        userAgent: request.headers['user-agent'] ?? null,
        referer: request.headers['referer'] ?? null,
      })),
    reset() {
      server.reset();
      failures.clear();
      installed.clear();
      appended.length = 0;
      installBase();
    },
    close: () => server.close(),
  };
}

/** Starts all three feeds; on a failure the ones already listening are closed again. */
export async function startFeeds(
  ports: Readonly<Record<E2eFeedKey, number>>,
  options: Pick<StartFeedOptions, 'now'> = {},
): Promise<Record<E2eFeedKey, E2eFeed>> {
  const settled = await Promise.allSettled(
    E2E_FEED_KEYS.map((key) => startFeed(key, { port: ports[key], ...options })),
  );
  const started = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    await Promise.all(started.map((feed) => feed.close()));
    throw failed.reason as Error;
  }
  return Object.fromEntries(started.map((feed) => [feed.key, feed])) as Record<E2eFeedKey, E2eFeed>;
}
