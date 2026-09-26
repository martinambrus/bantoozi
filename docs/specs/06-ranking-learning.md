# Spec 06: Ranking, lanes and personal learning (`packages/ranker`)

Status: **binding**. **Intent:** turn stored model answers into a per-user probability of "you'll like
this", put each article into a lane, and always be able to say why. Card/BM25 scores are
heuristic confidence scores, not calibrated probabilities; only an evaluated personal model may
claim calibration. Only a confident "no" may hide anything. Personal learning *refines* the card-based score. Off feeds remain useful as chronological RSS
reading; inference begins only for selected training articles or explicitly active feeds (spec 05 §1.1).

`packages/ranker` is **pure**: every function takes plain inputs and returns plain outputs. The worker
handler `user.rank` does the I/O (§7). The same functions run inside `apps/eval`.

---

## 1. Inputs to `rankArticle(ctx, item, now)`

```ts
type Strength = 'must' | 'love' | 'like' | 'never';
type Reason = 'clickbait' | 'promo' | 'shallow' | 'seen' | 'off_topic' | 'other';
interface UserRankContext {
  userId: string;
  rankRevision: string;                 // bigint decimal; invalidates user-specific ranking inputs
  modelContextSha: string;              // model context for the active model's inputs (§8.1)
  config: RankerConfig;                 // fully validated shared defaults + settings overrides
  cards: { cardId: string; title: string; strength: Strength; scopeFeedId?: string;
           interest: string; interestEn?: string }[];                    // texts are needed by BM25 (§9)
  labels: { cardId: string; name: string }[];
  rules: { id: string; kind: RuleKind; value: string; expiresAt?: Date }[];   // non-expired only
  prefs: UserPreferences;                                                  // spec 08 §3.1
  reasonCounts90d: Record<Reason, number>;
  staleDislikes90d: number;        // dislikes (any reason) on items that were stale when rated (§5)
  model?: ActiveModel;                                                     // §8
  subscriptions: { feedId: string; allowDuplicates: boolean; inferenceMode: 'off'|'training'|'active';
                   inferenceVersion: string; inferenceActivatedAt?: Date }[];
  readClusterIds: Set<string>;                                             // clusters with a member read in the window
  bm25: Bm25Corpus;                                                        // document frequencies over the user's whole window (§9)
}
interface RankItem {
  articleId: string;
  feedIds: string[];               // all article carriers ∩ user's subscriptions (manual rules)
  inferenceFeedIds: string[];      // only carriers authorized for this user/article revision (§2)
  inferenceEligible: boolean;     // inferenceFeedIds is non-empty; not global cache availability
  explicitSelection: boolean;     // a current selected analysis request authorizes this revision (spec 05 §1.1)
  domain: string; author: string | null;
  titleNorm: string; excerptNorm: string; translatedTitleNorm?: string; translatedExcerptNorm?: string;
  firstSeenAt: Date; publishedAt?: Date; contentRevision: string; wordCount: number | null; hasImage: boolean; lang: string;
  hasVideo: boolean | null; bodyImageCount: number | null;   // articles.has_video / body_image_count (spec 03 §6.4)
  clusterId?: string; clusterSize: number;
  pipelineState: string;
  matchCoverage: 'complete'|'pending'|'unavailable'; // this user's applicable positives (§2)
  facets?: Record<string, number>;                 // article_facets.features (spec 05 §3.4)
  facetsEngine?: 'typesafe' | 'llm' | 'laya';      // articles.enrich_engine
  cardAnswers: Record<string, { p: number; engine: 'typesafe'|'llm'|'laya'|'prefilter' }>;  // the user's interest AND label cards
  labelIds: string[];                              // labels already assigned (user_article.label_ids)
  translation?: { engine: string; quality: string };
}
interface RankResult {
  lane: 'new'|'for_you'|'maybe'|'everything'|'hidden';
  tier: 1|2|3|4|5 | null; pLike: number | null;
  scoreSource: 'none'|'cards'|'model'|'degraded';
  rulesFired: string[]; explain: Explain; labelSuggestions: string[];
}
```

`Explain` is defined once, as a zod schema, in `packages/shared/src/dto/explain.ts`. The ranker imports
that type, and the API and web client read it (§6.2).

---

## 2. Order of evaluation (normative)

**Admission first:** derive `inferenceFeedIds` with spec 05 §1.1 from active arrival timestamps or
exact selected analysis requests. A global cached answer, an old rating/bookmark, personal-model
activation, or another user's active subscription grants no inference permission. Preserve plain
reading and explicit manual hide/mute rules for off/nonselected items; return `new`, P/tier null,
source `none`, no inferred label suggestions, with `inference_not_requested` in the explanation.

Before evaluation, discard answers for a different content revision, state/question manifest or
inactive card. Apply scope to **all** card operations (including never, must, explanations, BM25 and
training): only cards whose `scopeFeedId` is absent or in `item.inferenceFeedIds` (all authorized
carriers, whichever view lists the item, §6.4) are applicable. A `prefilter` result is a provisional
non-match, not negative evidence; it does not count as an answered card.
`matchCoverage` is derived from the applicable cards' work status (spec 05), never inferred solely
from the global article pipeline state. With no applicable positive cards, return `new` after explicit
hide checks. Incomplete positives must not quietly fall into Everything because unanswered ≠ no.

Lane order for "at most" and "at least": `hidden < everything < maybe < for_you`.

```
rankArticle(ctx, item, now):
  1. if a hide rule matches (§3.1)                   → RETURN 'hidden' (fire its code)
  1b. if NOT item.inferenceEligible                  → RETURN 'new', P null, source 'none',
                                                        fire 'inference_not_requested'
  2. if item.pipelineState == 'stale' AND NOT item.explicitSelection
                                                     → RETURN lane 'new', P null, source 'none'
                                                        (stale articles are never processed
                                                        automatically; a current explicit
                                                        selection still ranks from its answers)
  3. if a never-card has p ≥ never.hide (§4.2)       → RETURN 'hidden' (fire never:<id>)
  4. base probability P:
       a. compatible active model (§8.1), complete matchCoverage AND item.facets present AND pipelineState ∉ {'degraded','failed'}
          AND item.facetsEngine and every applicable interest answer come from the model's engine
          family (§8.1: 'typesafe' under FEATURE_SPEC_V1, so never 'llm' or 'laya'; a 'prefilter'
          answer is an unknown, not another engine)
                                                     → P = model(x), source 'model' (§8)
       b. else, some applicable positive card has a usable answer → P = cardScore (§4), source 'cards';
          apply quality demotions (§5); remember the deciding card
       c. else, matchCoverage = 'unavailable' and there are applicable positive cards
                                                     → P = bm25P (§9), source 'degraded'
       d. else                                        → RETURN lane 'new', P null, source 'none'
                                                        (label suggestions are still computed)
     Steps 5–8 run only when P is set.
  5. lane = laneFromP(P) (§6.1)
  6. precedence of modifiers: only the first that applies changes the lane; later ones are skipped
       i.   seen_story: the item's cluster is in readClusterIds → lane = min(lane, 'everything')
       ii.  source 'degraded' (so never after a seen_story cap) → lane = 'maybe' (floors are ignored)
       iii. floor: a 'must' card with p ≥ mustFloor, or a boost_feed/boost_domain rule
                                                       → lane = 'for_you' and P = max(P, lanes.forYou)
       iv.  caps (both may apply): a never-card with never.soft ≤ p < never.hide → lane = min(lane, 'maybe');
            the deciding card's answer engine is 'llm' and P < llmForYouMin → lane = min(lane, 'maybe')
  7. if matchCoverage != 'complete' AND lane = 'everything' AND NOT seen_story
                                                     → lane = 'maybe', fire 'pending_cards'
  8. tier = tierFromP(P); labelSuggestions (§6.3); explain (§6.2)
```

The "deciding card" is the positive card achieving `cardScore`, stored as `explain.decidingCardId`.
Every rule that changes the outcome appends its code to `rulesFired` (§3.2). Ties use the lowest
numeric card id. All exits return a valid `Explain` and label suggestions; hidden/new exits have null
P and tier. A lane cap does not rewrite the score: a high tier in Everything after `seen_story` is
intentional and is explained by the rule. `scoreSource = degraded` always fires `degraded`; actual
LLM evidence fires `llm_answer` even when no cap changes the lane. Reject out-of-range/nonfinite/malformed probabilities at the validated boundary;
invalid and missing values are unknown, never zero.

---

## 3. Rules

### 3.1 Semantics

| Kind | `value` | Matches when | Effect |
|---|---|---|---|
| `mute_keyword` | a keyword or phrase | `normalizeText(value)` (same as `title_norm`) occurs as a whole-word sequence in `titleNorm`, `excerptNorm` or `translatedTitleNorm` or `translatedExcerptNorm` | hidden |
| `mute_story` | cluster id | `item.clusterId === value` | hidden |
| `block_feed` | feed id | the non-empty `item.feedIds` set is a subset of the union of active block-feed rule values (all subscribed carriers are blocked) | hidden |
| `block_domain` | registrable domain | `item.domain === value` | hidden |
| `block_author` | author name | case- and diacritic-insensitive equality | hidden |
| `boost_feed` | feed id | any feed matches | floor `for_you` |
| `boost_domain` | domain | domain matches | floor `for_you` |

Expired rules are excluded when the context is loaded. A mute created from "mute this story for N days"
has `expires_at = now + N days`, with N ∈ {1, 3, 7, 30}.

### 3.2 Rule codes (stable strings, shown by "Why this?")

`mute_keyword:<value>`, `mute_story`, `block_feed`, `block_domain`, `block_author`, `boost_feed`,
`boost_domain`, `never:<cardId>`, `never_soft:<cardId>`, `must:<cardId>`, `demote:clickbait`,
`demote:promotional`, `demote:shallow`, `demote:stale`, `degraded`, `llm_answer`, `seen_story`, `pending_cards`, `inference_not_requested`.

---

## 4. Card score

### 4.1 Positive cards

`w = { must: 1.0, love: 1.0, like: 0.8 }`.

`cardScore = max over positive cards c with an answer of (w[c.strength] × p_c)`.

- A missing answer means unknown and is ignored.
- `prefilter` markers count as unknown, including in explanations and training.
- If **no** positive card has an answer yet (answers pending), the lane is `new`.
- If the user has no positive cards at all, the lane is `new` and the UI prompts for applicable interests
  (spec 09 §4).
- Scope: a card with `scopeFeedId` only counts for items carried by that feed.

### 4.2 Anti-interest cards (`strength = 'never'`)

For each never-card with an answer:
- `p ≥ 0.7` → `hidden` with `never:<id>`
- `0.5 ≤ p < 0.7` → cap the lane at `maybe` with `never_soft:<id>`

These apply even when the personal model is active.

---

## 5. Quality demotions (only when `scoreSource = 'cards'`)

| Flag | Triggered when | Driven by dislike reason |
|---|---|---|
| `clickbait` | `facets.clickbait ≥ 0.8` | `clickbait` |
| `promotional` | `facets.promotional ≥ 0.8` | `promo` |
| `shallow` | `facets.depth ≤ 0.25` (depth level ≤ 1) | `shallow` |
| `stale` | `facets.time_sensitive ≥ 0.7` **and** article age > 72 h | — ("auto" turns on when `staleDislikes90d ≥ 3`, i.e. three dislikes, of any reason, on items that met this condition when rated) |

A flag is **active** for the user if `prefs.demote[flag] === 'on'`, or if it is `'auto'` (the default)
and the user has ≥ 3 dislikes with the matching reason in the last 90 days.

Reason counts count **current distinct disliked articles**, not append-only event counts: editing a
reason moves one count, and undo/unrate removes it. Use the feedback-time snapshot for stale status;
missing facets never trigger shallow or any other flag. Article age is
`now - min(publishedAt ?? firstSeenAt, firstSeenAt)` (floor at zero), so freshly fetched old news can
still be stale. `pipelineState = stale` is the ingestion/backfill eligibility state, not this quality
flag. Recompute auto activation when the 90-day boundary passes (§7).

Each active and triggered flag multiplies `P` by **0.6** and fires `demote:<flag>`.

---

## 6. Lanes, tiers, explanations, labels

### 6.1 Lanes and tiers

| Lane | Condition |
|---|---|
| `hidden` | a hide rule or `never` hard rule fired |
| `for_you` | `P ≥ 0.65`, or raised by a floor (§2 step 6iii, which also raises `P` to at least 0.65 so the tier matches) |
| `maybe` | `0.35 ≤ P < 0.65`, or capped to `maybe` |
| `everything` | `P < 0.35` |
| `new` | no score yet |

**Tier:** 5 if `P ≥ 0.85`, 4 if `≥ 0.65`, 3 if `≥ 0.45`, 2 if `≥ 0.25`, otherwise 1. `null` when `P` is
null. The web client's tier slider (FeedIt's 1–5) filters `for_you` + `maybe` by minimum tier.

All thresholds come from `RankerConfig` (§11), which gate G1 may override globally; v1 has no per-language threshold schema.

### 6.2 Explain (`user_article.explain`, version 1; zod schema in `packages/shared/src/dto/explain.ts`)

```ts
interface Explain {
  v: 1;
  inputs: { contentRevision: string; rankRevision: string; contextSha: string };
  source: 'cards'|'model'|'degraded'|'none';
  p: number | null; lane: Lane; tier: number | null;
  decidingCardId?: string;                         // source 'cards': the card achieving cardScore (spec 08 §5.1 topReason)
  cards: { id: string; title: string; strength: Strength; p: number; engine: string }[];   // the user's cards with answers, p desc, ≤ 10
  facets?: { contentType: { choice: string; p: number }; topic: { l1: string; p: number; l2?: string };
             depth: number; clickbait: number; promotional: number; timeSensitive: number; evergreen: number };
  rules: { code: string; ruleId?: string; cardId?: string; detail?: string }[];   // ids let the UI offer "undo"
  model?: { version: number; top: { feature: string; label: string; contribution: number }[] };   // top 3 by |contribution|
  translation?: { engine: string; quality: string };
  cluster?: { id: string; size: number };
}
```

Labels in `explain` use the English names; the web client localizes the topic ids with `topics.name_sk`.

### 6.3 Label suggestions

Only for inference-eligible items, for each of the user's labels with an answer `p ≥ 0.8` that is not already in `item.labelIds`, add the
label to `labelSuggestions`. The UI shows them as tappable chips ("tap to keep", as in FeedIt).

### 6.4 View-scoped inference projection (shared pure helper; API spec 08)

`user_article` has one global score per user/article, derived from all that user's authorized carrying
feeds. A direct feed/folder view must not import inference permission from another carrier outside
that view. Example: the same article belongs to off feed A and active feed B; global/B may show a
score, while A remains an unclassified chronological reader.

Before folding, lane/tier filters and counts, intersect the row's authorized `inferenceFeedIds` with
the view's permitted feed set. If none remain, recompute only the explicit local hide/mute rules and
project `lane='new'`, `pLike/tier=null`, `scoreSource='none'`, no model/never-card/must-card result or
inferred label suggestions; explain `inference_not_requested`. Preserve manual read/rating/bookmark/
label state. Do not apply model-derived semantic story folding to this neutral projection. Any view
(global, feed or folder) with at least one remaining authorized carrier uses the cached global
score. The view decides only whether inference may be shown, not which authorized evidence counts:
card scope and the model's source feature are evaluated over all of the row's authorized carriers
(§2, §8.1), because the article is carried by each of them. A card scoped to authorized feed C
therefore still applies when the article is listed under authorized feed B. Bookmark-only retained
rows without a current authorized subscription are neutral too. Detail navigation carries `feedId`/view
context so it does not unexpectedly reveal a different score. Counts and list pagination apply the
same projection. This requires no provider work and never overwrites another view's global cache.

---

## 7. The `user.rank` handler

**Versioning:** `score_version = "<RANKER_VERSION>:<ranker.settings_version>"` (text equality,
never lexicographic or numeric ordering). This avoids collisions after 10,000 settings changes.
`users.rank_revision` is a monotonically increasing bigint changed in the same transaction as any
user-specific rank invalidation; `user_article.rank_revision` records the revision used. Queue
insertion goes through the transactional outbox (spec 03). Version numbers are serialized as strings.
- `RANKER_VERSION` and `scoreVersion(settingsVersion)` are exported by `packages/ranker`. They are
  created in the ranker bootstrap (M2-T10), so both the API (M4) and the rank handler (M5) can use
  them. The constant is bumped whenever the ranking semantics change.
- The API bumps `ranker.settings_version` on every change to `ranker.thresholds` (and to any future
  ranking-relevant key), and then enqueues `user.rank {full: true}` for users active in the last 7 days.
  A change to `strengthWeights` or `model` also records `user.learn` for users with an active model
  (§8.4).
- Inactive users catch up on their next visit: `GET /articles` enqueues a full rank if **any** eligible
  row is missing/outdated, has an old rank revision, or has `next_rank_at ≤ now`. A MAX/newest-version
  check is insufficient after partial runs.

**Steps:**

1. **Load `UserRankContext`**, including:
   - `readClusterIds`: clusters with any member read by the user in the window
   - `bm25`: document frequencies over **all inference-eligible** window articles, not just the dirty
     ones (§9); off/nonselected items remain neutral without running a keyword fallback
2. **Dirty set** (SQL, window `RANK_WINDOW_DAYS` = 14, §11; **5,000 is a batch size, not a total
   eligibility cap**). Iterate by stable `(arrival, id)` keyset until every eligible item is
   considered; use one captured `now` for the run. Articles
   from the user's subscriptions with arrival `≥ now − 14 days` (the latest subscribed carrier
   `feed_items.first_seen_at`, as in spec 08 §5.1), not archived for the user, plus, whatever
   their arrival, articles the user explicitly selected whose request completed at the current
   revision within its 180-day window (spec 05 §1.1), so an older selected article also reaches
   `rankArticle`; in both cases where any of these holds:
   - no `user_article` row
   - `ua.score_version != current score_version` or `ua.rank_revision != users.rank_revision`
   - `ua.next_rank_at ≤ now` or article content revision no longer matches `explain.inputs`
   - `ua.scored_at` is older than the newest of `article_facets.updated_at`,
     `card_answers.answered_at` (for the user's cards and labels), `article_translations.created_at`
     and `articles.media_changed_at` (media signals, spec 03 §6.4)
   - changes to cluster membership, read/unread/undo state, matching coverage, translations, or
     applicable feed membership since the previous input snapshot; these enqueue a full rank and
     increment `rank_revision`, so deleting evidence is detected too
   - BM25 corpus membership changed: rerank all degraded items, not just the newly arrived article
   - the payload says `full: true`, which re-ranks the whole window

   Stale articles (`pipeline_state = 'stale'`) are ranked as `new` without a score unless a current
   explicit selection covers them (`explicitSelection`, §2 step 2); the handler still passes them to
   `rankArticle`, which applies that rule.
3. **Batch-load** facets, card answers (the user's cards and labels), translations, clusters, the
   user's `label_ids`, the feed ids (intersected with the subscriptions), the domain (via `tldts`) and
   the user's current selected analysis requests, which set `inferenceFeedIds` and
   `explicitSelection` (§2). A completed selection's answers are read from these same caches:
   `analysis.process` publishes its result there whenever it still matches the current revision,
   state and context (spec 03 §2.2), and the rebuild jobs refill them for current selections after
   a context change (spec 05 §2), so a selected stale or older article has usable answers.
4. Run `rankArticle` for each item.
5. **Upsert** the ranking columns of `user_article` in batches of 500:
   `lane, tier, p_like, score_source, rules_fired, explain, label_suggestions, score_version,
   rank_revision, scored_at, next_rank_at`. `next_rank_at` is the earliest future freshness-bin,
   stale-quality, active-rule expiry or 90-day reason-count expiry that can change this result; null
   means there is no known clock deadline. A scheduled reconciliation picks due rows at least hourly,
   including active users who never reload the list.
   Serialize rank runs per user and compare captured `users.rank_revision` and article
   `content_revision` immediately before writes. If either changed, discard those results and enqueue
   a replacement; a slower old run cannot overwrite newer settings/content. Reader-state columns are
   never touched. Filter `label_suggestions` against current labels/assignments at write time so a
   concurrent label action is not undone. Commit batches plus a continuation through the outbox;
   completion is recorded only after the last batch, and a crash resumes safely.
6. **Weak-translation escalation** (spec 07 §3): for items newly placed in `maybe` whose best
   translation is a tier-1 `weak` one **and** that have no `ollama` translation row yet (a skipped
   attempt also leaves a row), enqueue `article.translate {forceTier2: true}` under its own queue
   key (`translate-t2:<id>`, spec 03 §2), so a pending plain translation job cannot absorb it. This
   happens once per article.

**Enqueued by** (incremental runs are debounced; full runs use their own key, spec 03 §2):

| Event | `full`? |
|---|---|
| match finished; enrich degraded; an article's media signals changed (spec 03 §6.4, subscribers of its carriers) | no |
| a read, mark-read, open, unread or undo affecting a cluster | yes (invalidate both addition and removal of seen evidence) |
| card or label added/removed/strength/scope changed | yes |
| rule created/deleted, or expired (hourly `house.expire-rules`) | yes |
| preferences changed (`demote`, `implicitFeedback`, `implicitNegative`), feedback reason/count changed or aged out | yes |
| `ranker.thresholds` changed | yes (users active in 7 days; the others lazily, as above) |
| new active model | yes |
| subscription added/removed/duplicate policy/inference mode changed; selection admitted/cancelled; article joins/leaves a carrier or cluster | yes |
| freshness/expiry deadline reached | no (due rows plus user-wide auto-demotion invalidation) |

---

## 8. Personal model

### 8.1 Features and compatibility (`FEATURE_SPEC_V1`)

| Group | Features |
|---|---|
| Card groups | For each strength s (`must`, `love`, `like`, `never`): `best.<s>` = the highest p among the user's applicable cards of that strength, with a `known.best.<s>` mask. `matched_log = ln(1 + n)`, where n counts applicable positive cards with p ≥ `model.cardMatchP`. `cardscore` = the cards-only score of §4.1 under the model's `strengthWeights` |
| Own card inputs | `card.<id>` = p with a `known.card.<id>` mask, only for held cards that pass the evidence rule below. Their number grows with the user's ratings, not with their cards |
| Facets | `ct.*` (12), `t1.*` (20), `depth`, `depth_conf`, `clickbait`, `promotional`, `time_sensitive`, `evergreen`, `paywall_teaser`, `tone`, `scope.*` (4) |
| Length | one-hot `len.short/medium/long/very_long/unknown`, boundaries from spec 05 §3.1 (<150 / <600 / <1500 / ≥1500 / null words) |
| Freshness | one-hot `age.lt6h/lt24h/lt72h/older`: disjoint [0,6h), [6h,24h), [24h,72h), [72h,∞), using age at snapshot for training and now for scoring (§5) |
| Language | one-hot `lang.en/sk/cs/other` |
| Media | `has_video` with a `known.has_video` mask (null is unknown). One-hot `img.none/light/moderate/heavy/unknown` from the in-body image density d = `bodyImageCount` × 500 / max(`wordCount`, 500): `unknown` when either value is null, otherwise `none` when the count is 0, `light` for d < 1, `moderate` for 1 ≤ d < 3 and `heavy` for d ≥ 3 |
| Other | `has_image`, `cluster_log = ln(1 + clusterSize)` |
| Source | `feed.h<k>`, one-hot with k = murmur3(feedId) mod 32, using the lowest numeric id in `item.inferenceFeedIds`. `author.h<k>`, one-hot with k = murmur3(`normalizeText(author)`) mod 16 (none if there is no author). murmur3 = **MurmurHash3 x86 32-bit, seed 0, over the UTF-8 bytes** of the decimal id string or the normalized author |

The media inputs capture two reading preferences the facets miss. `ct.media` covers pieces that are
mostly video, not a normal article with an embedded video, which readers who cannot play sound at
work may skip. Image density separates an image-padded piece (10 images around 200 words, `heavy`)
from an illustrated long read (10 images in 3,000 words, `moderate`); raw counts would conflate
them. The 500-word floor in the denominator keeps a short brief with one lead photo out of `heavy`
and bounds the density of very short texts; the length one-hot still tells them apart. Whether a
user likes or avoids either is learned per user, like every other input.

Scoring computes the card inputs from the item's current answers and the user's current strengths.
Training computes them from each sample's card list (§8.2), with every card's p and its strength
when the rating was given, so a later strength change does not rewrite old samples. Scope-excluded
cards are missing. A missing value is 0 with a 0 mask: a strength group with no applicable card, the
never group while any applicable never-card lacks a usable answer, and an own input whose card did
not apply or had no usable answer. The positive-card inputs need complete positive coverage, as
scoring does (§2 step 4a), so a sample without it is not trained on (§8.2).

The group inputs pool every rating into a few weights that mirror the cards-only score, and a new
card counts through its group straight away. An **own card input** adjusts one card on top of its
group. A held card (positive or never) gets one when, among a training partition's explicit samples,
at least `model.cardMinMatched` (8) had that card applicable with p ≥ `model.cardMatchP` (0.5),
including at least one like and one dislike. The rule runs on each training partition, never on its
validation samples (§8.3). Own inputs are keyed by card id: an edit that creates a new card id (text,
examples, an accepted library update) starts that card's evidence again, because its answers
changed; until then the card counts through its group.

`feature_spec_sha` hashes the canonical feature algorithm: the fixed feature names and the group and
evidence rules. Compatibility is checked at two levels:

- **Rating fingerprint** (`rating_sha`): the feature spec, the model engine/version and the active
  question/state/translation manifests, including language modes and the card text mode, that is,
  whatever changes the meaning of every answer. A feedback snapshot is used for training only while
  its fingerprint equals the current one (§8.2). Card ids, strengths and scopes are not part of it.
- **Model context** (`metrics.context_sha`): the rating fingerprint, the `strengthWeights` and
  `model` config the model was trained with, both behavioral-consent flags, and for each own card
  input its card id, strength, scope and current question hash (`card_input_sha256`, spec 05 §2). The
  model scores only while the context computed from the current state equals the stored one. A
  mismatch stops model scoring at once and enqueues `user.learn` (§8.4). The ratings stay usable, so
  the retrained model can activate from the same history without new feedback.

A card change that touches no own input (adding, deleting, re-weighting, rescoping or editing a
card, or adding an example) changes neither level: the model keeps scoring, and a new card counts
through its strength group. Display-only card renames, lane/tier thresholds and ordinary
subscription additions are excluded (source hash vocabulary is fixed). Store the manifest
(fingerprint, context, own inputs and chosen λ), scaler and dropped columns with the model. Inputs
are named, never positional, so a weight can never silently bind to a different card.

Only validated current-revision answers from the **same pinned engine family/version and question
manifest** are used. `prefilter` is unknown, not a probability. `FEATURE_SPEC_V1`'s engine family is
`typesafe` (Jev). If any applicable interest-card answer or facet came from another engine (`llm` or
`laya`), the item is left out of training and scoring and follows the cards path until compatible
answers exist. In M9 this covers a Laya-enriched article, whose facets come from Laya while its card
answers come from Jev. Label-card engines do not affect interest-model eligibility. Laya/Jev feature
families must not be mixed without a new evaluated feature spec. Facet unknowns need masks just like
cards.
Raw article/card text is not duplicated into feedback-event feature snapshots; selected analysis
requests keep the bounded private frozen input required for reproducibility under the same RLS.

### 8.2 Labels and event-time snapshots

There is **one current sample per user/article**, never one per event. Use the latest explicit state
first; otherwise use the highest-priority surviving implicit signal below. Signals do not accumulate
weights. Current undo/unbookmark state removes the corresponding interest evidence; label events never
provide such evidence.

| Signal (priority order) | y | weight |
|---|---|---|
| rating +1 / −1, including prompt answers | 1 / 0 | 1.0 |
| bookmarked, not rated | 1 | 0.8 |
| opened with observed dwell ≥ 30 s, not rated, event-time `implicitFeedback=true` | 1 | 0.3 |
| observed complete open/return session with dwell < 5 s, not rated, event-time `implicitFeedback=true` | 0 | 0.2 |
| explicit individual mark-read without opening, not rated, event-time `implicitFeedback=true` **and** `implicitNegative=true` | 0 | 0.1 |

**Behavioral consent:** `prefs.implicitFeedback` defaults to false and gates both positive and
negative evidence derived from dwell/open/read behavior. An explicit thumbs-up/down, prompt answer
or bookmark remains its separately declared signal; ordinary reader-state updates do not imply
behavioral consent. At event creation store
`learningConsent: {implicitFeedback: boolean, implicitNegative: boolean}` and
`signalOrigin: 'explicit'|'expand'|'rating_side_effect'|'open_side_effect'|'bulk_mark_read'` in
`feedback_events.value` (no new DB columns). Read the preferences inside the mutation transaction;
an offline replay cannot claim historical opt-in from an untrusted client value.

Without opt-in, `/dwell` stores no duration/event/features and produces no prompt. Read/open may
still update their functional reader state and minimal mutation audit/undo data, but do not capture
additional behavioral feature snapshots, schedule behavioral learning or reconstruct such features
from private bookmark/analysis snapshots. Unknown/legacy event-time consent means false. Enabling
consent later never retroactively makes pre-consent history eligible. Automatic mark-read from
expand/open/rating and bulk mark-read are never stand-alone negative labels, even with both flags
on; only a direct individual read action can supply that row of the table.

Sample extraction requires event-time opt-in **and** current opt-in. Disabling it invalidates models
that consumed behavioral samples and retrains from remaining eligible explicit/bookmark evidence;
include both consent flags in the model context manifest. Reader convenience and explicit training
continue to work when behavioral learning is off. This preference does not authorize feed inference.

**Labels are neutral (Q10 resolved).** Assigning, removing or editing an organizational label never
implies liking/disliking and never trains the personal-interest model. An explicit label example may
refine that label's own classifier, without contributing a personal-interest training sample. There
is no label-as-positive configuration switch. Only a separate explicit rating/bookmark or another
listed signal can supply interest evidence for the same article.

Un-rating suppresses all earlier implicit evidence for that article until a new positive/negative
action occurs; it must not immediately turn an undone dislike into a bounce dislike. A missing return
beacon is unknown dwell, not zero. Off-site dwell measures elapsed time away, not observed reading;
keep its weak weight and show this limitation in the privacy/learning explanation. Bulk mark-read and
archive operations are housekeeping, never stand-alone dislike evidence.

**`feedback_events.value` v1:** every feedback mutation stores the signal payload and an immutable
`before` snapshot `{lane,pLike,tier,scoreVersion,rankRevision,scoredAt}` from the ranking seen before
that action, plus `staleAtFeedback` (boolean or null). Learning-relevant actions additionally record
`features: {specSha,ratingSha,cards,values,sourceManifest,snapshotAt}` when valid inputs exist. Build
it before applying the action, under the same content revision as the displayed score. `cards` lists
every interest card (positive or never) the user held that applied to the item as `{id, strength, p}`,
with the strength at that moment and `p = null` when the card had no usable answer; the card inputs
and the cards-only baseline are derived from it at training time (§8.1). `values` holds the other
inputs with their known masks, and the story-group id at that time.
For selected slow training, capture or reference `analysisRequestId`, immutable `input_sha` and the
pre-feedback input snapshot before committing the first rating (spec 05 §1.1). `features` may be null
while analysis is pending; once complete, a separate immutable derived feature snapshot may be
linked through `analysis_requests.result_snapshot/result_sha` by that request/input hash. Computing a feature later is allowed **only from the exact frozen
pre-feedback article/card/question context**, never using the user's answer in model input. The
rating time determines age/features; later cluster growth, changed examples/text/translations or a
new question/model manifest cannot be substituted. Record processing time separately from snapshot
time. A current cache with identical pinned inputs may satisfy the request without a new call.

If inputs are absent/stale and no authorized frozen request exists, retain the rating but omit it
from training until a new compatible event; do not infer permission from the rating alone. The same
applies when an applicable positive card had no usable answer yet: training, like scoring, needs
complete positive coverage (§8.1). Saved
bookmark actions may reference an older `snapshotId/contentRevision` (spec 08). Bookmark archives
retain text and sanitized HTML (Q14), without capturing image or other media binaries. Harmless safe
URL references may remain under the image-preference policy; they are not permanently archived media
assets. Historical `has_image`, `has_video` and `img.*` features may remain as observed values in
their immutable feature snapshot; they authorize neither inference nor media download/retention,
and must not be recomputed from the archive's media availability.
Never borrow current
features for that old content: use matching captured features/authorized frozen input or omit the
sample. A changed rating supersedes its earlier label while keeping the exact source snapshot and
chronology; it does not create duplicate evidence. Undo refers to
its original receipt/events and restores the prior effective signal instead of producing a fresh
training example. Events and snapshots remain private per-user data under RLS and account deletion.

Feed training mode and personal model activation are separate. Selected training requests can
supply explicit samples before any feed is active; a successful `user.learn` never changes
`subscriptions.inference_mode`. Off/revoked demand prevents new provider work and score application;
retained explicit feedback is private history, not permission to reclassify arbitrary feed items.
Q11 is resolved: enable inference explicitly per feed; only new arrivals are automatic afterward.
Older articles require explicit selection, and no learned-model threshold changes that mode.

Only surviving samples with snapshot and feedback timestamps within the last **180 days** whose
`specSha` and `ratingSha` match the current feature spec and rating fingerprint (§8.1) are used.
Card changes never discard samples: a sample keeps the card answers and strengths it was captured
with, so adding, removing, re-weighting, rescoping or editing a card, adding an example or accepting
a library update keeps the user's training history. A new engine version, question set, translation
setting or card text mode changes the meaning of every answer, so it returns the user to cards-only
ranking until enough compatible feedback exists.

### 8.3 Training (`trainUserModel(samples, now)`, pure)

- **Reproducibility:** stable sample order and seed derived from user id + context sha + effective
  feedback cutoff; include data/manifest hashes in model metrics. Repeated events are deduplicated.
- **Leak-free validation:** group samples by story cluster (unclustered = article id); keep all
  versions/members of a group in one fold. Choose deterministic group-stratified k-fold with
  `k = min(5, minority explicit-class group count)`, at least 3; reduce k if needed. Every validation
  fold and its training partition must contain both explicit classes. If impossible, record
  `insufficient_validation` and do not activate. Implicit samples from a held-out group are also held
  out. Fit the own-card-input rule (§8.1), standardization and zero-variance dropping **inside each
  training partition**, outer and inner folds alike, never on its validation samples.
- **Objective:** minimize the weighted **sum** of logistic negative log-likelihoods (sample weights
  from §8.2) plus `lambda/2 * sum(w_i²)`; intercept unregularized. The penalty stays the same as
  ratings accumulate, so an input the ratings support earns its weight while thin evidence stays
  near zero. A mean loss would multiply the penalty by the number of ratings and keep every weight
  small however much evidence accumulates. Fit by damped Newton/IRLS, at most 25 iterations,
  stopping at loss change < 1e-6. Use stable sigmoid/log-sum-exp, positive ridge on singular Hessians and backtracking
  if loss rises. Nonfinite/nonconverged fits are rejected, never serialized as active models.
- **Choosing λ** from `model.lambdaGrid`: fit every grid value on the same grouped folds, fit a Platt
  calibrator (below) on each value's out-of-fold explicit logits, and take the value with the lowest
  calibrated out-of-fold logloss, ties to the larger λ. If those folds cannot be formed, take the
  largest value. Each outer training partition chooses its own λ with inner folds; the final model
  chooses with the outer folds and records its λ in the manifest.
- **Metrics:** out-of-fold `cv_auc` and `cv_logloss` use explicit examples only, one per article.
  `baseline_auc` and `baseline_logloss` use cards-only scores on exactly those snapshots and folds;
  report grouped bootstrap confidence intervals, class counts and skipped-sample reasons. Single-
  class AUC is null, never 0.5 or zero.
- **Calibration (Platt):** fit `P = sigmoid(a*z+b)` on out-of-fold explicit logits with a weak prior
  (strength 0.01) toward a=1,b=0 and constrain a>0. Calibration reporting uses nested folds: each
  outer validation fold uses a calibrator fitted only on inner out-of-fold predictions of its training
  partition, at that partition's λ. If inner data lacks both classes, use identity calibration for
  that fold. Fit the final calibrator on all out-of-fold logits at the final λ, and the final
  scaler/weights on all eligible training samples.
- **Activation** requires `n_explicit ≥ 30`, explicit positives ≥5 and negatives ≥5, valid grouped
  CV, `cv_auc ≥ 0.60`, `cv_auc ≥ baseline_auc − 0.02`, and calibrated `cv_logloss` no worse than
  `baseline_logloss`. An uncalibrated card score is a baseline, not ground truth probability.
  A failed candidate leaves the previous active model in place while it is still compatible (§8.1)
  and deletion/undo has not invalidated its training evidence. Activation and deactivation are one
  transaction under a user lock; the unique-active index must never transiently conflict.
- **Contributions:** explain `a*w_i*x_scaled_i`, top 3 by absolute value (stable feature-name tie
  break). Label a group input by its strength ("your Love interests") and an own card input by the
  card's current display title. Explain these as associations in this model, not causal reasons.
  Hash collisions make `feed.h*` mean "source group", not uniquely "this source". Include the
  calibrated intercept separately if needed; top three need not sum to the full score.
- **Retention:** keep the active version plus the 3 newest other versions. Store attempt cutoff and
  rejection reason even when activation fails; no change repeatedly retrains the same data.

### 8.4 When to train (`user.learn {userId}`)

- The API enqueues after **at least** `model.retrainEvery` (default 10) newly effective explicit
  feedback changes since the last processed cutoff, including a bulk operation that crosses the
  boundary. Do not use `n % 10 == 0`; it misses batches and concurrent updates. Count event ids with
  deterministic effective-state reduction, not only current non-null `rated_at` rows.
- Undo/unrate/deletion invalidates affected models immediately and enqueues learn even below ten.
  So does a model-context mismatch (§8.1). Every interest-card change, every behavioral-consent change
  and, for users with an active model, a `ranker.thresholds` change to `strengthWeights` or `model`
  records a debounced `user.learn` in the same outbox transaction. The handler trains only when the
  model context or the eligible samples differ from the last attempt, and it reuses the stored
  ratings, so a card edit never waits for new feedback. Changes to implicit evidence, preferences and
  180-day retention also participate in the nightly trigger. No revoked evidence may remain silently
  active in a stored model.
- A selected analysis request completing valid features for already-recorded feedback also enqueues
  learning; the earlier pending rating must not be stranded below a stale training watermark.
- `house.nightly-learn` enqueues users whose effective input manifest differs from the last attempt,
  including implicit-only changes and expiry; users with no changed inputs do not retrain.
- Handler: under per-user serialization capture a committed feedback cutoff, rating fingerprint and
  card manifest → build samples → train → compare the current cutoff, fingerprint and model context
  before activation → store candidate and attempt metadata → activate if eligible. If newer
  invalidating input appeared, keep the attempt inactive and enqueue another run.
  Activation/deactivation increments rank_revision, enqueues a full rank;
  activation also enqueues `user.suggest`. A failure to train must not suppress future retries after
  new evidence arrives.

---

## 9. Degraded ranking (BM25)

Used when the article has no facets or answers because the engine was unavailable, and by the eval as a
baseline (spec 10).

- **Tokenizer:** `normalizeText` (diacritics stripped, lower-case), split on non-alphanumerics, drop
  tokens shorter than 2 chars and stop-words (small built-in EN/SK/CZ lists, ~150 words each).
- **Document:** the title twice, then the excerpt (translated text instead, when a translation exists).
- **Query:** applicable card `interest`, using `interest_en` only with an English document; do not
  compare translated English documents to untranslated Slovak/Czech queries. Without a matching
  query translation, use the original document/query pair and report this in eval.
- **Corpus statistics:** document frequencies over **all** articles in the user's rank window
  (`RANK_WINDOW_DAYS` = 14 days of their authorized subscriptions/selections, using §1.1 admission
  from spec 05). They are computed once per `user.rank` run, so scores don't depend on how
  many items happen to be dirty. IDF uses +0.5 smoothing. `k1 = 1.2`, `b = 0.75`. The eval builds the
  corpus from the rater's assigned frozen articles (no rating information enters the corpus).
  Exact IDF is `ln(1 + (N-df+0.5)/(df+0.5))`; term contribution is
  `IDF * tf*(k1+1)/(tf + k1*(1-b + b*docLength/avgLength))`, summed over unique query terms.
  Empty corpus/document/query or zero average length yields score 0, never NaN.
- `s = max over positive cards of BM25(card, doc)`. `P = 1 − exp(−s / 3)`.
- The lane is **always `maybe`**: never hidden and never `for_you`, because keywords are not trusted to
  hide or promote. Explicit hide rules/never evidence still apply first, and `seen_story` may
  cap it to Everything under §2; “always Maybe” describes BM25 itself, not overriding those rules.

---

## 10. Active learning and feedback prompts

- **Maybe lane order:** by `|P − 0.5|` ascending (most uncertain first), then newest first.
- **Feed training selection:** before scores exist, let the user select up to 20 articles from the
  chosen feed using chronological/source metadata only; confirm training mode and create exact
  analysis requests. A rating may be recorded immediately against the frozen request input and
  processed slowly. Never run hidden inference over the whole feed to choose those samples.
- **Calibration round** (onboarding step, and a weekly "Tune your feed" card in the reader):
  - eligible sources are active arrivals or already selected training articles only; retrieving a
    calibration page does not authorize or pay for new articles
  - 10 unrated articles from `maybe`, at most 7 days old, at most 3 per feed
  - pick the most uncertain first
  - if `maybe` has fewer than 10, fill from `everything` with the highest P
  - one member per cluster; exclude explicit hides and archived items; preserve the at-most-three-
    per-feed cap in the fill step and break ties by numeric article id. Return fewer than ten if
    necessary. Do not reoffer already answered items. Record source lane and selection method so
    evaluation can separate deliberately uncertain examples from ordinary reading.
- **"Did you like it?" prompt** (from FeedIt's todo list), shown when the reader returns to the app
  after opening an article:
  - only if current `prefs.implicitFeedback=true`, the correlated dwell event was collected with
    event-time consent, `dwell_ms ≥ 6,000`, the article is unrated, and `feedback_prompted_at` is null
  - whenever `POST /articles/:id/dwell` answers `prompt: true`, it also sets `feedback_prompted_at`, so
    an ignored prompt never returns
  - and either `lane = 'maybe'` or deterministic uniform hash(user, article, open-session) < f,
    sampled once per session, with f from `prefs.feedbackPrompt`:
    `often` = 1/5, `occasionally` = 1/20, `never` = 0
  - when the preference is `never`, no prompt is shown at all, even for Maybe items
  - checking and setting `feedback_prompted_at` is atomic; retries/concurrent dwell requests cannot
    issue two prompts or repeatedly roll the sampling probability
- **Card example suggestions** (`suggestExample`, pure, in `packages/ranker`; the rating endpoint
  calls it, spec 08 §5.3). An example changes Jev's own answer for every later article of that card,
  so it helps before any personal model exists. Use the item's stored `explain` only when its
  `inputs.contentRevision` is the rated revision and its source is `cards` or `model`. Among its
  positive cards with a `typesafe` answer, take the one with the highest p (ties: lowest numeric id):
  - a dislike with reason `off_topic` and p ≥ `lanes.maybe` → `{cardId, side: 'no'}`. Other reasons,
    or none, never suggest: the card may have matched correctly, and a "not this" example would
    teach Jev to reject the topic itself
  - a like with `lanes.maybe` ≤ p < `lanes.forYou` → `{cardId, side: 'yes'}`. A like that every card
    scored below `lanes.maybe` is an unexplained like, handled by card suggestions (spec 05 §7) and
    "make a card from this" (spec 09 §3.5)
  - nothing otherwise. Never-cards are not suggested, because their examples change what gets hidden
    (the Why-this drawer still offers them), and neither bulk ratings, prompt answers, un-rating,
    bookmarks nor implicit signals produce a suggestion
  - no suggestion when `prefs.exampleSuggestions` is false, the article title is already an example
    on that side, the card is not yet a private fork and the user already holds `maxForks` forks, the
    same card was suggested in the last 7 days, or 3 suggestions were made in the last 24 hours,
    counted from earlier rating events that carried one (spec 08 §5.3)
  - a suggestion is only an offer: nothing changes until the user accepts it through
    `POST /cards/:id/examples`

---

## 11. `RankerConfig` (defaults; `settings['ranker.thresholds']` overrides; gate G1 writes it)

The schema and defaults live in `packages/shared/src/ranker-config.ts` from M0-T2; the ranker
imports/re-exports them. M2-T10 exports pure card-score/lane/tier/policy-preview helpers for G1;
M5 adds the full worker/ranking orchestration. Do not create a shared→ranker dependency cycle.

```ts
export const DEFAULT_RANKER_CONFIG = {
  lanes: { forYou: 0.65, maybe: 0.35 },
  tiers: [0.25, 0.45, 0.65, 0.85],
  strengthWeights: { must: 1.0, love: 1.0, like: 0.8 },
  never: { hide: 0.7, soft: 0.5 },
  mustFloor: 0.5,
  llmForYouMin: 0.85,
  demotion: { factor: 0.6, clickbait: 0.8, promotional: 0.8, shallowDepth: 0.25,
              staleTimeSensitive: 0.7, staleAgeHours: 72, autoMinDislikes: 3, autoWindowDays: 90 },
  labelSuggest: 0.8,
  model: { lambdaGrid: [1, 3, 10, 30, 100], minExplicit: 30, minEachClass: 5, minCvAuc: 0.60,
           maxBaselineDrop: 0.02, retrainEvery: 10, historyDays: 180, keepVersions: 3,
           cardMatchP: 0.5, cardMinMatched: 8 },
  bm25: { k1: 1.2, b: 0.75, scale: 3 },
} as const;

// Not a setting: the API list window (spec 08 §5.1), the rank dirty set and BM25 corpus (§7, §9)
// and degraded recovery (spec 04 §5, spec 11 §6) must share it, so only a release changes it.
export const RANK_WINDOW_DAYS = 14;
```

Validate the fully merged config: all numbers finite; `0 ≤ lanes.maybe < lanes.forYou ≤ 1`;
`tiers` exactly four strictly increasing values in (0,1); `0 ≤ never.soft < never.hide ≤ 1`;
all probabilities/weights/factors in [0,1]; window/history/count fields positive integers with
implementation bounds; BM25 scale/k1 positive and b in [0,1]; `model.lambdaGrid` 1–10 strictly
increasing positive values (an override replaces the whole list, like `tiers`); `model.cardMatchP`
in (0,1]. Reject invalid admin updates atomically,
including unknown keys such as `windowDays`: the window is the fixed `RANK_WINDOW_DAYS`.
The implementation derives all examples/tables above from these defaults, not duplicated literals.

---

## 12. Tests

**Unit:**
- truth tables for every rule kind, and for never/must/boost interplay
- the lane and tier boundaries
- demotion activation (auto vs on vs off)
- `seen_story`, including a degraded (BM25) item of a read story, which stays in Everything
- cards-only monotonicity (property test with `fast-check`): raising a positive card's p never
  lowers the base card score with everything else fixed. This is **not** guaranteed for a learned
  model with negative coefficients or for lane changes from a deciding-engine tie break
- logistic regression recovers the signs of known weights on synthetic data and reaches AUC ≥ 0.9
- card inputs from a snapshot card list: group maxima and masks, `matched_log`, `cardscore`, a
  strength change after the snapshot (the snapshot strength counts) and partial never coverage
  (unknown)
- the own-card-input rule at its boundaries (7 vs 8 matches, one class only) and inside each training
  partition; λ chosen by the folds, ties to the larger value
- with the summed-loss penalty, a predictive own card input's weight grows from 30 to 1,000
  synthetic ratings, while a card without signal stays near zero
- `suggestExample`: reasons, the p bands, never-cards, content revision and source, the 7-day and
  24-hour limits, `maxForks`, duplicate examples and the preference
- Platt scaling reduces ECE on synthetic over-confident scores
- the activation rule
- BM25 ordering on a hand-made corpus
- `Explain` snapshots

**Integration:**
- `user.rank` on a seeded DB writes the expected lanes
- idempotency: a second run with nothing dirty writes nothing
- `full` re-rank after card strength/scope, unread/undo, reason change, rule expiry and model invalidation
- >5,000 eligible items all finish; crash/continuation and simultaneous old/new ranking runs cannot
  lose work or overwrite new input; old/new score versions mixed in one window trigger catch-up
- clock-only freshness and 90-day auto-demotion changes become visible without new articles
- partial/prefilter answers and scope-excluded never/must cards never produce false negative hides
- fold-local scalers, story grouping, nested calibration, single-class folds and nonconvergence
- a card change without an own input keeps the active model scoring and every sample usable;
  editing, re-weighting, rescoping or removing a card with an own input stops model scoring at once,
  and a retrain from the stored samples reactivates a model without new feedback; a new engine
  version or question set still returns the user to cards-only
- event/request input snapshot predates rating; deferred features use that frozen input only;
  repeated dwell/rate/undo adds no duplicate sample; bulk 9→12 explicit ratings
  schedules training; revoked evidence cannot survive in an active model
- labels produce no interest training sample, even when the user has no explicit ratings
- off/nonselected items stay neutral even with shared cached answers; active B cannot classify an
  article in its off A view; projected counts/detail/folding agree without extra inference calls
- explicit training does not activate the feed, and active mode does not infer old backlog
- default-off behavioral consent stores no dwell telemetry/feature snapshot, gives no implicit
  positive/negative sample, and is not bypassed by server mark-read or private retained snapshots
- enabling consent does not train old events; disabling invalidates behavioral models; automatic
  read side effects and bulk read never masquerade as individual explicit negative feedback
