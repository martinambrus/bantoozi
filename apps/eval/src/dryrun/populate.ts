import {
  addRaterCard,
  createRater,
  ensureEvalUser,
  insertSyntheticArticle,
  listAssignments,
  listGoldenFeeds,
  markSyntheticFeed,
  rateAssignment,
  sampleArticleLangs,
  saveFacetLabels,
  setRaterFeeds,
  subscribeToFeed,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import { sha256Hex } from '@bantoozi/shared/server';

import { drawSample, type SampleOutcome } from '../collection/sample.js';
import { ensureAssignments } from '../rating-server/assignments.js';
import { facetSeed, selectFacetSet, selectOverlap } from '../rating-server/facets.js';
import { issueToken } from '../rating-server/tokens.js';
import { EvalCommandError } from '../runtime.js';
import {
  DRYRUN_LANGS,
  PERSONAS,
  rateSynthetic,
  TOPIC_BY_ID,
  type Corpus,
  type Persona,
  type SyntheticArticle,
} from './synthetic.js';

/**
 * Fill the dry-run database the way the real collection and rating would (spec 10 §2): golden feeds
 * subscribed by the evaluation user, extracted articles with detected languages, the `eval sample`
 * draw (lane A's `drawSample`), raters with cards and picked feeds, assignments from the rating
 * app's `ensureAssignments`, every assignment rated by the hidden model through `rateAssignment`,
 * and the owner's (plus a second labeller's overlap) facet labels on the rating app's facet set.
 */

export interface PopulateOptions {
  seed: string;
  /** Articles `eval sample` draws per language. */
  samplePerLang: number;
  assignmentsPerRater: number;
  facetsPerLang: number;
  facetOverlap: number;
  now: Date;
}

export interface PopulatedRater {
  raterId: string;
  persona: Persona;
  participantKey: string;
  assigned: number;
  likes: number;
  dislikes: number;
}

export interface PopulateResult {
  version: string;
  sample: Extract<SampleOutcome, { status: 'sampled' | 'unchanged' }>;
  articleIds: Map<string, SyntheticArticle>;
  raters: PopulatedRater[];
  facetLabels: number;
}

/** A deterministic UUID-shaped participant key per persona. */
function participantKey(seed: string, persona: Persona): string {
  const h = sha256Hex(`${seed}|participant|${persona.key}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function populate(
  db: Database,
  corpus: Corpus,
  options: PopulateOptions,
): Promise<PopulateResult> {
  // 1. Golden feeds and collected articles.
  const user = await db.transaction((tx) => ensureEvalUser(tx));
  const feedIds = new Map<string, string>();
  for (const feed of corpus.feeds) {
    const feedId = await db.transaction(async (tx) => {
      const sub = await subscribeToFeed(tx, workerOutbox(tx), {
        userId: user.id,
        url: feed.url,
        fetchUrl: feed.url,
        title: feed.title,
      });
      await markSyntheticFeed(tx, { feedId: sub.feedId, langHint: feed.lang, title: feed.title });
      return sub.feedId;
    });
    feedIds.set(feed.key, feedId);
  }
  const articleIds = new Map<string, SyntheticArticle>();
  const byFeed = new Map<string, SyntheticArticle[]>();
  for (const article of corpus.articles) {
    const list = byFeed.get(article.feedKey) ?? [];
    list.push(article);
    byFeed.set(article.feedKey, list);
  }
  for (const [feedKey, articles] of byFeed) {
    const feedId = feedIds.get(feedKey);
    if (feedId === undefined) throw new Error(`unknown feed ${feedKey}`);
    await db.transaction(async (tx) => {
      for (const article of articles) {
        const id = await insertSyntheticArticle(tx, feedId, {
          url: article.url,
          title: article.title,
          excerpt: article.excerpt,
          lang: article.lang,
          wordCount: article.wordCount,
          publishedAt: article.publishedAt,
          firstSeenAt: article.publishedAt,
        });
        articleIds.set(id, article);
      }
    });
  }

  // 2. `eval sample`.
  const sample = await drawSample(
    db,
    { seed: options.seed, perLang: options.samplePerLang, langs: DRYRUN_LANGS },
    options.now,
  );
  if (sample.status === 'frozen') throw new EvalCommandError('the dry-run dataset is frozen');
  const version = sample.version;

  // 3. Raters: cards, picked feeds, assignments and ratings.
  const golden = await listGoldenFeeds(db);
  const raters: PopulatedRater[] = [];
  let minute = 0;
  for (const persona of PERSONAS) {
    const key = participantKey(options.seed, persona);
    const token = issueToken(options.now, 30);
    const rater = await createRater(db, {
      name: persona.name,
      participantKey: key,
      contextName: null,
      langs: persona.langs,
      tokenHash: token.tokenHash,
      tokenExpiresAt: token.expiresAt,
    });
    await db.transaction(async (tx) => {
      for (const card of persona.cards) {
        await addRaterCard(tx, rater.id, {
          title: null,
          interest: card.interest,
          notFor: null,
          strength: card.strength,
          examplesYes: [],
          examplesNo: [],
          lang: card.lang,
        });
      }
      await setRaterFeeds(
        tx,
        rater.id,
        golden
          .filter((f) => f.langHint !== null && persona.langs.some((l) => l === f.langHint))
          .map((f) => f.feedId),
      );
    });
    await ensureAssignments(db, {
      raterId: rater.id,
      langs: persona.langs,
      now: options.now,
      target: options.assignmentsPerRater,
    });
    const assigned = await listAssignments(db, rater.id, version);
    let likes = 0;
    let dislikes = 0;
    await db.transaction(async (tx) => {
      for (const assignment of assigned) {
        const article = articleIds.get(assignment.articleId);
        if (article === undefined) continue;
        const rated = rateSynthetic(options.seed, persona, article);
        if (rated.rating === 1) likes += 1;
        else dislikes += 1;
        minute += 1;
        await rateAssignment(tx, {
          raterId: rater.id,
          position: assignment.position,
          rating: rated.rating,
          reason: rated.reason,
          now: new Date(options.now.getTime() - 86_400_000 + minute * 60_000),
        });
      }
    });
    raters.push({
      raterId: rater.id,
      persona,
      participantKey: key,
      assigned: assigned.length,
      likes,
      dislikes,
    });
  }

  // 4. Facet labels: the owner (first participant) on the facet set, the second on the overlap.
  const candidates = await sampleArticleLangs(db, version);
  const seed = facetSeed(options.seed);
  const primary = selectFacetSet({ seed, candidates, perLang: options.facetsPerLang });
  const overlap = selectOverlap({ seed, primary, size: options.facetOverlap });
  let facetLabels = 0;
  const label = async (labeler: string, articleId: string, disagree: boolean) => {
    const article = articleIds.get(articleId);
    if (article === undefined) return;
    const topic = TOPIC_BY_ID.get(article.topic);
    const deep = article.wordCount >= 800;
    await db.transaction((tx) =>
      saveFacetLabels(tx, {
        labeler,
        articleId,
        values: {
          content_type: article.clickbait ? 'listicle' : 'news_report',
          topic_l1: topic?.taxonomy ?? 'other',
          depth: String((deep ? 2 : 1) + (disagree ? 1 : 0)),
          clickbait: article.clickbait ? 'yes' : 'no',
          promotional: 'no',
          time_sensitive: topic?.timeSensitive === true ? 'yes' : 'no',
        },
        now: options.now,
      }),
    );
    facetLabels += 6;
  };
  const owner = raters[0];
  const second = raters[1];
  if (owner !== undefined) {
    for (const item of primary) await label(owner.participantKey, item.articleId, false);
  }
  if (second !== undefined) {
    for (const [i, item] of overlap.entries()) {
      await label(second.participantKey, item.articleId, i % 5 === 0);
    }
  }
  return { version, sample, articleIds, raters, facetLabels };
}
