import {
  CARD_TEXT_LIMITS,
  DISLIKE_REASONS,
  SKIP_REASON_MAX,
  type AssignmentProgress,
  type AssignmentView,
  type DislikeReason,
  type GoldenFeed,
  type RaterCard,
} from '@bantoozi/db';

import { FACET_FIELDS, FACET_UNSURE_VALUES } from './facets.js';
import { html, page, type SafeHtml } from './html.js';
import {
  MAX_INTEREST_CARDS,
  MAX_NEVER_CARDS,
  MIN_FEEDS,
  MIN_INTEREST_CARDS,
  type StepState,
} from './steps.js';

/**
 * The rating app's pages (spec 10 §2.2–§2.4). Blind by construction: the article view model holds
 * only the frozen snapshot's feed, title, excerpt, date and link, so no score, lane, tier or model
 * answer can reach the HTML.
 */

/** What a rater sees of one article (from its frozen `eval.sample` snapshot). */
export interface ArticleView {
  feedTitle: string | null;
  title: string;
  /** At most 600 characters (spec 10 §2.2). */
  excerpt: string | null;
  /** http(s) only. */
  url: string | null;
  /** `YYYY-MM-DD` of publication (or first sighting). */
  date: string | null;
}

export const REASON_TEXT: Record<DislikeReason, string> = {
  off_topic: 'Off-topic',
  clickbait: 'Clickbait',
  seen: 'Seen it',
  shallow: 'Too shallow',
  promo: 'Promo',
  other: 'Other',
};

const STRENGTH_TEXT = {
  must: 'Must read',
  love: 'Love',
  like: 'Like',
  never: 'Never show me this',
} as const;

const csrfField = (csrf: string): SafeHtml =>
  html`<input type="hidden" name="_csrf" value="${csrf}" />`;

export function messagePage(title: string, message: string): string {
  return page(
    title,
    html`<h1>${title}</h1>
      <p>${message}</p>`,
  );
}

function stepNav(state: StepState, current: 'cards' | 'feeds' | 'rate'): SafeHtml {
  const item = (key: typeof current, href: string, text: string) =>
    key === current ? html`<strong>${text}</strong>` : html`<a href="${href}">${text}</a>`;
  return html`<p class="muted">
    ${item('cards', '/r/cards', `1. Interests (${state.interestCards})`)} ·
    ${item('feeds', '/r/feeds', `2. Feeds (${state.feeds})`)} · ${item('rate', '/r', '3. Rate')} ·
    <a href="/facets">Facet labels</a>
  </p>`;
}

// ── Step 1: cards ─────────────────────────────────────────────────────────────────────────────────

export interface CardFormValues {
  title?: string;
  interest?: string;
  notFor?: string;
  strength?: string;
  examplesYes?: string;
  examplesNo?: string;
  lang?: string;
}

export function cardsPage(input: {
  raterName: string;
  langs: readonly string[];
  cards: readonly RaterCard[];
  state: StepState;
  locked: boolean;
  csrf: string;
  error?: string | null;
  values?: CardFormValues;
}): string {
  const v = input.values ?? {};
  const langOptions = ['auto', ...new Set([...input.langs, 'en', 'sk', 'cs'])];
  const list =
    input.cards.length === 0
      ? html`<p class="muted">No cards yet.</p>`
      : html`<ul class="cards">
          ${input.cards.map(
            (card) =>
              html`<li>
                <strong>${card.title}</strong>
                <span class="muted">· ${STRENGTH_TEXT[card.strength]} · ${card.lang}</span>
                <p>${card.interest}</p>
                ${card.notFor === null ? '' : html`<p class="muted">Not for: ${card.notFor}</p>`}
                ${card.examplesYes.length > 0 ? html`<p class="muted">Yes: ${card.examplesYes.join(' | ')}</p>` : ''}
                ${card.examplesNo.length > 0 ? html`<p class="muted">No: ${card.examplesNo.join(' | ')}</p>` : ''}
                ${
                  input.locked
                    ? ''
                    : html`<form method="post" action="/r/cards/${card.cardId}/delete">
                        ${csrfField(input.csrf)} <button type="submit">Remove</button>
                      </form>`
                }
              </li>`,
          )}
        </ul>`;
  const form = input.locked
    ? html`<p class="notice">Your cards are final now that rating has started.</p>`
    : html`<h2>Add a card</h2>
        <form method="post" action="/r/cards">
          ${csrfField(input.csrf)}
          <label for="interest"
            >What you want to read about
            (${CARD_TEXT_LIMITS.interestMin}–${CARD_TEXT_LIMITS.interestMax} characters)</label
          >
          <textarea
            id="interest"
            name="interest"
            required
            minlength="${CARD_TEXT_LIMITS.interestMin}"
            maxlength="${CARD_TEXT_LIMITS.interestMax}"
          >
${v.interest ?? ''}</textarea>
          <label for="notFor">Not for (optional, up to ${CARD_TEXT_LIMITS.notForMax})</label>
          <textarea id="notFor" name="notFor" maxlength="${CARD_TEXT_LIMITS.notForMax}">
${v.notFor ?? ''}</textarea>
          <label for="title">Short name (optional, up to ${CARD_TEXT_LIMITS.titleMax})</label>
          <input
            type="text"
            id="title"
            name="title"
            maxlength="${CARD_TEXT_LIMITS.titleMax}"
            value="${v.title ?? ''}"
          />
          <label for="strength">Strength</label>
          <select id="strength" name="strength">
            ${(['like', 'love', 'must', 'never'] as const).map(
              (s) =>
                html`<option value="${s}" ${(v.strength ?? 'like') === s ? html` selected` : ''}>
                  ${STRENGTH_TEXT[s]}
                </option>`,
            )}
          </select>
          <label for="examplesYes"
            >Example headlines you would want (optional, one per line, up to
            ${CARD_TEXT_LIMITS.examplesPerSide})</label
          >
          <textarea id="examplesYes" name="examplesYes">${v.examplesYes ?? ''}</textarea>
          <label for="examplesNo"
            >Example headlines you would not want (optional, one per line, up to
            ${CARD_TEXT_LIMITS.examplesPerSide})</label
          >
          <textarea id="examplesNo" name="examplesNo">${v.examplesNo ?? ''}</textarea>
          <label for="lang">Card language</label>
          <select id="lang" name="lang">
            ${langOptions.map(
              (l) =>
                html`<option value="${l}" ${(v.lang ?? 'auto') === l ? html` selected` : ''}>
                  ${l === 'auto' ? 'detect automatically' : l}
                </option>`,
            )}
          </select>
          <p><button type="submit">Add card</button></p>
        </form>`;
  const ready =
    input.state.interestCards >= MIN_INTEREST_CARDS
      ? html`<p><a class="button" href="/r/feeds">Next: pick feeds →</a></p>`
      : html`<p class="muted">Write at least ${MIN_INTEREST_CARDS} interest cards to continue.</p>`;
  return page(
    'Your interests',
    html`${stepNav(input.state, 'cards')}
      <h1>Step 1: write your interests</h1>
      <p>
        Hi ${input.raterName}. Before you see any article, describe what you like to read, in your
        own words and your own language: ${MIN_INTEREST_CARDS}–${MAX_INTEREST_CARDS} interest cards,
        plus up to ${MAX_NEVER_CARDS} optional "never" cards.
      </p>
      <ul class="hints">
        <li>
          One interest per card; be specific ("new battery chemistry for electric cars", not
          "cars").
        </li>
        <li>Use "Not for" for what looks similar but you do not want ("stock-price moves").</li>
        <li>
          Examples are optional: real or invented headlines, at most
          ${CARD_TEXT_LIMITS.examplesPerSide} per side.
        </li>
        <li>"Never" cards describe things you never want to see, whatever else matches.</li>
      </ul>
      ${input.error ? html`<p class="error" role="alert">${input.error}</p>` : ''}
      <p class="progress">
        ${input.state.interestCards} interest cards, ${input.state.neverCards} never cards
      </p>
      ${list}${ready}${form}`,
  );
}

// ── Step 2: feeds ─────────────────────────────────────────────────────────────────────────────────

export function feedsPage(input: {
  feeds: readonly GoldenFeed[];
  selected: ReadonlySet<string>;
  state: StepState;
  locked: boolean;
  csrf: string;
  error?: string | null;
}): string {
  const groups = new Map<string, GoldenFeed[]>();
  for (const feed of input.feeds) {
    const key = feed.langHint ?? 'other';
    const list = groups.get(key) ?? [];
    list.push(feed);
    groups.set(key, list);
  }
  const fieldsets = [...groups].map(
    ([lang, feeds]) =>
      html`<fieldset>
        <legend>${lang}</legend>
        <ul class="feeds">
          ${feeds.map(
            (feed) =>
              html`<li>
                <label
                  ><input
                    type="checkbox"
                    name="feed"
                    value="${feed.feedId}"
                    ${
                      input.selected.has(feed.feedId) ? html` checked` : ''
                    }${input.locked ? html` disabled` : ''}
                  />
                  <span
                    >${feed.title ?? feed.url}<br /><span class="muted"
                      >${feed.siteUrl ?? feed.url}</span
                    ></span
                  ></label
                >
              </li>`,
          )}
        </ul>
      </fieldset>`,
  );
  return page(
    'Pick feeds',
    html`${stepNav(input.state, 'feeds')}
      <h1>Step 2: pick your feeds</h1>
      <p>
        Tick every feed you would actually subscribe to (at least ${MIN_FEEDS}). Your articles come
        from them.
      </p>
      ${input.error ? html`<p class="error" role="alert">${input.error}</p>` : ''}
      <p class="progress">${input.state.feeds} selected</p>
      ${
        input.locked
          ? html`<p class="notice">Your feeds are final now that rating has started.</p>
              ${fieldsets}`
          : html`<form method="post" action="/r/feeds">
              ${csrfField(input.csrf)}${fieldsets}
              <p><button type="submit">Save feeds</button></p>
            </form>`
      }`,
  );
}

// ── Step 3: rating ────────────────────────────────────────────────────────────────────────────────

export function startPage(input: {
  state: StepState;
  csrf: string;
  error?: string | null;
}): string {
  return page(
    'Start rating',
    html`${stepNav(input.state, 'rate')}
      <h1>Step 3: rate articles</h1>
      <p>
        You will see one article at a time: its feed, title and the start of the text. Say whether
        you would want to read it. There are no right answers; your progress is saved on every click
        and you can change a rating later.
      </p>
      <p>Once you start, your interest cards and feeds are final.</p>
      ${input.error ? html`<p class="error" role="alert">${input.error}</p>` : ''}
      <form method="post" action="/r/start">
        ${csrfField(input.csrf)} <button type="submit">Start rating</button>
      </form>`,
  );
}

export function donePage(input: {
  state: StepState;
  progress: AssignmentProgress;
  canLoadMore: boolean;
  csrf: string;
}): string {
  return page(
    'All done',
    html`${stepNav(input.state, 'rate')}
      <h1>Nothing left to rate</h1>
      <p>${progressText(input.progress)}</p>
      <p><a href="/r/a/0">Review your ratings from the start</a></p>
      ${
        input.canLoadMore
          ? html`<form method="post" action="/r/start">
              ${csrfField(input.csrf)} <button type="submit">Look for more articles</button>
            </form>`
          : ''
      }`,
  );
}

function progressText(progress: AssignmentProgress): string {
  return `${progress.rated} rated · ${progress.skipped} skipped · ${progress.pending} left of ${progress.total}`;
}

export function ratePage(input: {
  article: ArticleView;
  assignment: AssignmentView;
  progress: AssignmentProgress;
  lastPosition: number;
  csrf: string;
  /** The dislike was just saved: the reason bar is open. */
  askReason: boolean;
}): string {
  const { article, assignment } = input;
  const pos = assignment.position;
  const action = `/r/a/${pos}`;
  const current = (rating: 1 | -1) => (assignment.rating === rating ? html` current` : '');
  const status =
    assignment.status === 'rated'
      ? assignment.rating === 1
        ? 'You liked this.'
        : `You marked this "Not for me"${assignment.reason === null ? '' : ` (${REASON_TEXT[assignment.reason]})`}.`
      : assignment.status === 'skipped'
        ? `You skipped this${assignment.skipReason === null ? '' : ` (${assignment.skipReason})`}.`
        : '';
  const reasonsOpen = input.askReason || assignment.rating === -1;
  return page(
    'Rate',
    html`<p class="progress" id="progress">
        Article ${pos + 1} of ${input.lastPosition + 1} · ${progressText(input.progress)}
      </p>
      <article class="article">
        ${article.feedTitle === null ? '' : html`<p class="feed">${article.feedTitle}${article.date === null ? '' : html` · ${article.date}`}</p>`}
        <h1>${article.title}</h1>
        ${article.excerpt === null ? '' : html`<p class="excerpt">${article.excerpt}</p>`}
        ${
          article.url === null
            ? ''
            : html`<p>
                <a
                  id="open"
                  data-key="o"
                  href="${article.url}"
                  target="_blank"
                  rel="noopener noreferrer"
                  >Open original ↗</a
                >
              </p>`
        }
      </article>
      ${status === '' ? '' : html`<p class="notice" id="status">${status}</p>`}
      <div class="actions">
        <form method="post" action="${action}/rate">
          ${csrfField(input.csrf)}
          <button type="submit" name="rating" value="like" class="like${current(1)}" data-key="+">
            👍 I'd want to read this <kbd>+</kbd>
          </button>
          <button
            type="submit"
            name="rating"
            value="dislike"
            class="dislike${current(-1)}"
            data-key="-"
          >
            👎 Not for me <kbd>-</kbd>
          </button>
        </form>
      </div>
      <div class="reasons${reasonsOpen ? ' open' : ''}" id="reasons">
        <p class="muted">
          ${input.askReason ? 'Saved. Why not? (optional)' : 'Not for me because… (optional)'}
        </p>
        <form method="post" action="${action}/rate">
          ${csrfField(input.csrf)}
          <input type="hidden" name="rating" value="dislike" />
          ${DISLIKE_REASONS.map(
            (reason, i) =>
              html`<button
                type="submit"
                name="reason"
                value="${reason}"
                ${assignment.reason === reason ? html` class="current"` : ''}
                data-key="${String(i + 1)}"
              >
                ${REASON_TEXT[reason]} <kbd>${String(i + 1)}</kbd>
              </button>`,
          )}
        </form>
      </div>
      <div class="nav">
        ${pos > 0 ? html`<a class="button" id="prev" data-key="k" href="/r/a/${pos - 1}">← Previous <kbd>k</kbd></a>` : ''}
        ${pos < input.lastPosition ? html`<a class="button" id="next" data-key="j" href="/r/a/${pos + 1}">Next <kbd>j</kbd> →</a>` : ''}
      </div>
      <form class="skip" method="post" action="${action}/skip">
        ${csrfField(input.csrf)}
        <input
          type="text"
          name="skipReason"
          maxlength="${SKIP_REASON_MAX}"
          placeholder="Why skip? (optional)"
          aria-label="Why skip? (optional)"
          value="${assignment.skipReason ?? ''}"
        />
        <button type="submit" data-key="s">Skip <kbd>s</kbd></button>
      </form>
      <p class="keys">
        Keys: <kbd>+</kbd> like · <kbd>-</kbd> not for me, then <kbd>1</kbd>–<kbd>6</kbd> a reason ·
        <kbd>s</kbd> skip · <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>o</kbd> open original
      </p>`,
  );
}

// ── Facet labels ──────────────────────────────────────────────────────────────────────────────────

const UNSURE_TEXT: Record<(typeof FACET_UNSURE_VALUES)[number], string> = {
  uncertain: 'not sure',
  not_applicable: 'not applicable',
};

export function facetPage(input: {
  article: ArticleView;
  index: number;
  total: number;
  labelled: number;
  role: 'primary' | 'second';
  values: Readonly<Record<string, string>>;
  csrf: string;
  error?: string | null;
}): string {
  const { article, index } = input;
  return page(
    'Facet labels',
    html`<p class="progress">
        Article ${index + 1} of ${input.total} · ${input.labelled} labelled
        ${input.role === 'second' ? ' · overlap set (second labeller)' : ''} ·
        <a href="/r">Rating</a>
      </p>
      <article class="article">
        ${article.feedTitle === null ? '' : html`<p class="feed">${article.feedTitle}${article.date === null ? '' : html` · ${article.date}`}</p>`}
        <h1>${article.title}</h1>
        ${article.excerpt === null ? '' : html`<p class="excerpt">${article.excerpt}</p>`}
        ${
          article.url === null
            ? ''
            : html`<p>
                <a data-key="o" href="${article.url}" target="_blank" rel="noopener noreferrer"
                  >Open original ↗</a
                >
              </p>`
        }
      </article>
      ${input.error ? html`<p class="error" role="alert">${input.error}</p>` : ''}
      <form method="post" action="/facets/${index}">
        ${csrfField(input.csrf)}
        ${FACET_FIELDS.map(
          (field) =>
            html`<fieldset>
              <legend>${field.label}</legend>
              ${[
                ...field.options,
                ...FACET_UNSURE_VALUES.map((value) => ({ value, text: UNSURE_TEXT[value] })),
              ].map(
                (option) =>
                  html`<label class="choice"
                    ><input
                      type="radio"
                      name="${field.key}"
                      value="${option.value}"
                      ${input.values[field.key] === option.value ? html` checked` : ''}
                      required
                    />
                    ${option.text}</label
                  >`,
              )}
            </fieldset>`,
        )}
        <p><button type="submit">Save and next</button></p>
      </form>
      <div class="nav">
        ${index > 0 ? html`<a class="button" data-key="k" href="/facets/${index - 1}">← Previous <kbd>k</kbd></a>` : ''}
        ${index < input.total - 1 ? html`<a class="button" data-key="j" href="/facets/${index + 1}">Next <kbd>j</kbd> →</a>` : ''}
      </div>`,
  );
}

export function facetsDonePage(input: { total: number; labelled: number }): string {
  return page(
    'Facet labels',
    html`<h1>Facet labels</h1>
      <p>${input.labelled} of ${input.total} articles labelled.</p>
      ${input.total > 0 ? html`<p><a href="/facets/0">Review from the start</a></p>` : html`<p>No articles to label yet.</p>`}`,
  );
}
