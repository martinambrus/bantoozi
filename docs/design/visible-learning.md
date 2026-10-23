# Design: Jev upgrades, word estimates and visible learning (approved 2026-10-20)

Status: approved by the owner on 2026-10-20 (decisions in §3). Evidence comes from the owner's dev database on
2026-10-20 (read-only queries and offline replays; the scripts lived in that session's scratchpad and are not in
the repository). Tasks and their order: §5. PLAN.md §14.4 tracks their status.

## 1. Goals

1. A reader's ratings visibly change a feed from about the tenth rating on, in every subscription mode, long
   before the cards agree (D-236) or the personal model activates (spec 06 §8.3).
2. `engine.typesafe_model = jev-latest` works and keeps Bantoozi on a supported Jev release without manual
   upgrades and without throwing away anyone's training on a 1.x release.
3. A classification outage is reported within minutes and explained to the reader, instead of failing silently for days.
4. "Show fewer like these?" (D-268) reaches the readers it was built for.

## 2. What exists today

### 2.1 The 2026-10-17 outage (dev)

- 10-17 01:08 UTC: Admin → Settings set `engine.typesafe_model` to `jev-latest`. TypeSafe accepts the alias but
  answers `"model": "jev-1.13.0"`, and `packages/engine/src/typesafe-engine.ts` accepts only an answer naming the
  requested id, so every enrich and match call failed with `invalid_response model_mismatch:jev-1.13.0`. The breaker
  reopened 68 times. No alert rule covers this.
- The pin became `jev-latest`, which changed the rating fingerprint (`22190257…` → `2bee2ee2…`). The 3,907 earlier
  explicit samples became `rating_sha_mismatch`, and the active personal model (v263: 3,896 ratings, CV AUC 0.96) was
  deactivated as `incompatible`. The 1,039 ratings given after the switch have no facets (`no_facets`). 650 analysis
  requests froze `model: jev-latest` and can never complete.
- For three days no facets or card answers were written, and Bazos arrivals fell back to BM25 in Maybe.
- 10-20 13:15 UTC: the setting was reset to the env default `jev-1.13.0`, the worker restarted and the pin was rebuilt (§4.7).

### 2.2 Model pinning and the rating fingerprint

- Spec 11 §8 and `apps/worker/src/model-pin.ts`: a worker records its model in `engine.model_pin`. A changed
  model enqueues `house.reenrich` and `house.rematch` once, and the stale-worker guard fences workers that have not
  restarted yet.
- `ratingShaOf` (`packages/db/src/api/article-actions.ts`) hashes the raw snapshot spec with
  `engine.model_pin.model`, `question_sets.active`, `language_modes` and `card_text_mode`. `sampleEligibility`
  (`packages/ranker/src/learn/samples.ts`) needs exact equality, and `modelContextSha` includes the fingerprint.
  Every model change therefore drops every user's samples and deactivates their models until each has about 30
  new ratings again (`model.minExplicit` 30, `minEachClass` 5).
- Production refuses aliases: `PINNED_MODEL` in `packages/shared/src/runtime-settings.ts` and
  `packages/shared/src/server/config.ts`.
- `analysis.process` ends a request whose frozen `model` differs from the primary model as `context_unavailable`.

### 2.3 Unanalysed rows have no score

- Rows of Off and Training feeds, and Active arrivals over the D-252 cap, leave `rankArticle` as `new` with P null
  and source `none` (spec 06 §2 steps 1b, 2, 4d). The personal model cannot score them, because `FEATURE_SPEC_V1`
  is built from card answers and the 44 facets that only an analysis produces. A model that has not activated
  adds nothing on analysed rows either: activation is exactly the test "does it beat the cards?".
- D-248: in a scoped `all` view, a `minTier` above 1 keeps only rows with `tier >= minTier`, so a Training feed
  shows nothing at tier 2 and above.
- Owner dev data: 12.7k of 19k reader rows are unscored (11.2k Bazos over-cap and outage arrivals, 1.5k
  Training-feed rows).

### 2.4 "Show fewer like these?" (D-268)

- The offer needs all of these:
  - A held positive card that scored the article ≥ `lanes.maybe` at rating time. That rules out rows in New and
    Everything else.
  - At least 2 title-similar dislikes of that card family in the last 30 days, beating look-alike likes by 0.10.
  - A single rating (not bulk) with reason none, `off_topic` or `other`.
  - No offer for that family in the last 14 days.
- A replay of the owner's history through the same code: 3,654 qualifying dislikes → 97 with a deciding card →
  20 lowered → 1 offer (Škoda Vehicles, 10-15).
- The offer is an 8-second toast that reuses the undo toast's id, so the next rating replaces it. The 14-day
  cooldown starts when the server makes the offer, whether or not it was seen.
- The code works: `apps/api/test/dislike-pattern.int.test.ts` 9/9, `apps/web/test/reader/dislike-pattern.test.tsx`
  6/6 and `packages/ranker/test/similar-dislikes.test.ts` 21/21 pass.

### 2.5 Word estimates measured on the owner's ratings

Prequential test: each block of 25 ratings of a feed was predicted by an L2 logistic regression on title and
excerpt words plus the feed, trained on every earlier rating (all feeds). AUC 0.5 is a random order and 1.0 a
perfect one. The cards column uses the current cards on the analysed rated articles, with their count in brackets.

The first measurement was one shuffle order of the training. The "ratings 11–60" cells pool only about 50 predictions
from models trained on 60–200 ratings, so another order moves them by a standard deviation of 0.02–0.08 (EST-1,
D-271). The table below gives the mean over 8 orders of the implemented trainer, which uses D-268's title tokens, with
the first single-order value in brackets. Read it as ±0.05 for the large feeds and ±0.10 for the small ones.

| Feed | Ratings | Words, ratings 11–60 | Words, all later | Cards |
|---|---|---|---|---|
| Auto · Bazos.sk | 3,926 | 0.58 (0.61) | 0.93 (0.93) | 0.96 (3,524) |
| Hacker News | 322 | 0.50 (0.37) | 0.60 (0.58) | 0.71 (81) |
| ScienceDaily | 112 | 0.81 (0.78) | 0.67 (0.65) | 0.49 (14) |
| Space.com | 105 | 0.71 (0.70) | 0.73 (0.73) | 0.55 (22) |
| BBC News | 82 | 0.56 (0.61) | 0.58 (0.53) | 0.52 (64) |
| Ars Technica | 72 | 0.51 (0.52) | 0.45 (0.48) | 0.70 (53) |
| NASA | 52 | 0.76 (0.73) | 0.76 (0.73) | – |
| The Verge | 50 | 0.67 (0.73) | 0.67 (0.73) | 0.66 (47) |

Most news feeds sort usefully after a few dozen ratings (ScienceDaily, Space.com, NASA, The Verge: 0.67–0.81),
sometimes better than the cards. BBC, Hacker News and Ars stay near random. Classified ads become strong with enough ratings. This is good enough to sort and to show progress,
not to hide articles with confidence. The owner accepts that (§3 decision 5).

## 3. Owner decisions (2026-10-20)

1. Follow `jev-latest`. Until §4.1 ships, the dev instance runs `jev-1.13.0` (applied 10-20 13:15 UTC).
2. Alias upgrades are adopted automatically and admins are notified. There is no eval replay for them (amends
   locked decision 8).
3. Ratings and personal models survive upgrades within a Jev major version (1.x): the fingerprint compares the
   model family. A major or non-Jev model change resets as today. Re-analysing every rated article under each new
   version was considered and not chosen (§7).
4. Word estimates are not inference (clarifies locked decision 9). Any article without a card or model score may
   get one, in every subscription mode. No provider is called.
5. Estimates sort and filter: the tier slider includes estimated rows, which are marked as estimated.
6. Also approved: outage alerts and a paused status, a save-time model probe, visible progress, the D-268 fixes,
   and re-rating the outage ratings.

## 4. Design

### 4.1 `jev-latest`: resolve, then pin (JEV-1, JEV-2, JEV-3, JEV-5)

As built (JEV-1, JEV-2; D-273, D-274): `settings['engine.model_probe']` keeps the newest 10 results keyed by
requested id (not one slot); while the alias is unresolved the router has no Jev lane and `RouterStatus.typesafeLane`
makes recovery jobs wait; the worker heartbeat shows an `engine.typesafe_model` problem; the retired-model mapping is
an assumption until one real Jev answer is recorded.

- **Accepted values.** `engine.typesafe_model` and `TYPESAFE_MODEL` take a concrete id (`PINNED_MODEL`) or
  exactly `jev-latest`, in production too. Other aliases stay refused.
- **Model probe.** It runs in the worker only, because provider keys are decrypted only there (spec 11).
  - It sends a synthetic request: one fixed yes/no question about a fixed sentence, no user data.
  - It uses the active TypeSafe credential outside `router.ask`, so the breaker is not touched (like
    `provider.validate`, spec 04 §1.2).
  - Bounds: at most 2 attempts and $0.002 reserved. Calls are recorded in `engine_calls` with the new kind
    `model_probe` (migration).
  - Result: `{requested, answered, ok, at, error}`. An alias resolves when `answered` is a concrete id; a
    concrete id is valid only when `answered === requested`.
- **Resolution.** `settings['engine.model_resolution']`, written by the worker:
  `{alias: 'jev-latest', model: 'jev-1.13.0', resolvedAt, checkedAt, previous?: {model, until}}`.
- **Worker start.**
  - A concrete setting works as today.
  - With the alias, the worker uses the stored resolution when its alias matches. Otherwise it runs a
    blocking probe with a 30 s timeout.
  - With no resolution, classification handlers defer as under an open breaker, and the probe retries every
    5 minutes.
  - Production traffic never sends the alias. The process model, `engine.model_pin.model` and every request
    use the concrete id; the pin also records `alias`. The exact answer check in `typesafe-engine.ts` stays.
- **Restart.** The restart fingerprint includes `engine.model_resolution.model`. A new resolution therefore
  drains and restarts the workers (production self-restart; dev reports `pendingRestart`). The first restarted
  worker records the pin and enqueues the single rebuild through the unchanged `recordModelPin`. The stale-worker
  guard works as today, because the pin names another model.
- **Switching values.** Moving the setting between `jev-1.13.0` and `jev-latest` while the alias resolves to
  1.13.0 leaves the pin, the fingerprint and the caches as they are, and runs no rebuild.
- **`house.model-watch`.** A new cron job runs every 6 hours. It also runs:
  - at worker start when following the alias;
  - on Admin "Check now";
  - at once when the pinned id fails as `model_unavailable` (at most every 10 minutes).

  It probes the alias. A different concrete answer writes the new resolution (keeping `previous`) and mails the
  admins on the alert channel:
  - same major: "Jev jev-1.13.0 → jev-1.14.0: ratings and personal models kept";
  - otherwise: "major change: personal models restart from new ratings".

  A failed probe keeps the current resolution and counts towards `engine.typesafe_down` (§4.3).
- **Retired models.** The TypeSafe engine maps the provider's "unknown or retired model" response to a failure
  with detail `model_unavailable`. Confirm the status and body against the Jev API documentation, and add the
  case to the fake server. The router treats it like a provider outage for the breaker. It triggers
  `house.model-watch` when following the alias, and otherwise the alert of §4.3.
- **Admin → Settings.**
  - The TypeSafe model editor offers "Follow the newest Jev (jev-latest)" next to a concrete id, and shows
    "Resolves to jev-1.13.0 · checked 13:15 · Check now".
  - Any changed value needs a successful probe of exactly that value from the last 10 minutes:
    `POST /admin/engine/model-probe {model}` enqueues the probe, whose result lands in
    `settings['engine.model_probe']` for the UI to poll.
  - Without one, `PATCH /admin/settings` answers 409 `model_probe_required`, or `model_probe_failed` with the
    answered id.
  - The eval-replay acknowledgement stays only for a change that restarts personal models (another family); a
    change inside one major or between a release and the alias that resolves to it needs none (as built, D-295;
    deviates from "stays for changes to a concrete id"). Check now is `POST /admin/engine/model-check`; N is the
    worker-written `engine.model_impact` (D-296).
  - The confirmation states the impact from §4.2: same family → "Ratings and personal models are kept; the
    14-day window is analysed again"; another family → "N users' personal models restart".

### 4.2 Fingerprint families (JEV-4)

- **Family.** `modelFamily(id)` is `jev-<major>` for a concrete Jev id `jev-<major>.<minor>.<patch>[suffix]`.
  Any other id is its own family, including an alias, so an alias can never merge families.
- **Two fingerprints.** The exact rating fingerprint stays and is still stamped everywhere: snapshots, requests,
  model metrics. New: `familySha` is the same hash with `engine.model_pin.model` replaced by its family.
- **Registry** (as built, D-275). `settings['engine.rating_fingerprints']` =
  `{<exact sha>: {family, settings, firstSeenAt}}`, at most 64 entries (other families evicted first, oldest first,
  never the current sha), written only by the worker (start-up, `user.learn`, `house.nightly-learn`) and read
  leniently. No migration and no table: another branch owned the next migration number. The family sha is
  domain-separated (`{family}` for a release, `{id}` otherwise); every model-id comparison uses `sameModelFamily`.
- **Where families replace exact matches.**
  - `sampleEligibility` compares `family(sample.ratingSha) === currentFamilySha`, using a sha → family map
    loaded once per run. An unregistered sha stays incompatible, as today.
  - `modelContextSha` and `decideActivation` use the family sha. The learn `inputSha` keeps the exact sha and also
    carries the family sha (D-276), so an upgrade or the deploy retrains once on the same samples.
  - `analysis.process` accepts a frozen model of the primary model's family and records the answering model in
    its result. Across families it ends `context_unavailable` as today.
  - `GET /me/learning`, the feed agreement (D-236) and the card hints (D-241, D-244) share the trainer's
    eligibility; each call site must pass the family map.
- **Upgrade guard.** When the exact sha changes inside a family, each active personal model keeps scoring. Once
  at least `model.minExplicit` explicit samples (`minEachClass` per class) carry the new exact sha, `user.learn`
  compares the candidate's out-of-fold AUC on them with the cards baseline on the same samples. As built (D-277),
  it trips only when the upper end of the 95% bootstrap interval of the difference is below
  −`model.maxBaselineDrop` (the point rule tripped healthy models 22–50% of the time); the model is deactivated
  (`upgrade_regression`) and training uses the new exact sha only until the exact sha changes (D-278).
- **Deploy effect.** The context formula changes once, so every active model is retrained at its next learn run
  on the same samples and reactivates.
- **Owner data.** After OPS-1 the exact sha is `22190257…` again, and its 3,907 samples stay eligible across this
  change.

### 4.3 Outage guardrails (JEV-6)

- **Alerts** (spec 11 §6.1, `apps/worker/src/alerts/rules.ts`):
  - The existing `engine.breaker` rule, retitled "Classification engine failing" (the key stays, so open incidents
    continue). It fires when the TypeSafe breaker has been open or half-open for a failing streak of 30 minutes,
    measured from `failingSince` (kept across re-opens; the old rule measured `openedAt`, which every failed probe
    resets, so it could never fire), or, with the breaker closed, when at least 3 classification requests failed and
    none succeeded in 30 minutes (the breaker trips only at 20 requests in 5 minutes). The mail names the streak or
    the failure count, the last failure, and the configured and pinned model (D-272).
  - `engine.model_mismatch`, "Jev answered with another model". Fires on any classification call with
    `invalid_response` `model_mismatch:*` in the last 45 minutes (15 minutes cleared and re-fired the incident at
    every probe of a flapping breaker); the mail names the requested and answered ids.
  - Only classification calls count: credential checks, evaluations and model probes never feed these alerts.
  - Both close through the existing recovery mail.
- **Paused status.** `GET /me/learning` adds
  `classification: {state: 'ok'|'paused', since, reason: 'engine_unavailable'|'model_upgrade'|null}`, derived
  from the breaker state and from a running rebuild after a pin change. Settings → Personal learning and the
  Training-feed chip (§4.5) show "Analysis paused since …. Your ratings are kept and analysed when it resumes".

### 4.4 Word estimates (EST-1 … EST-6)

- **What.** A per-user L2 logistic regression over words, scoring every row that would otherwise have no score.
  It costs nothing (no provider call) and trains in well under a second.
- **Features** (pure code in `packages/ranker/src/estimate/`):
  - title tokens: `tokenize` after D-268's price-suffix strip, with tokens of 6 or more characters cut to 5;
  - title word pairs;
  - the first 80 excerpt tokens;
  - the feed (`f:<feedId>`).

  All are binary presence features.
- **Training data.** Explicit ratings within `model.historyDays`, read from `user_article` (current truth), with
  each article's title and excerpt and its lowest-id subscribed carrier feed.
- **Fitting.** Class-balanced weights; Adagrad, 8 epochs in a seeded order; L2 1e-4. Platt scaling is fitted on
  out-of-fold scores from 5 folds in time order: 5 contiguous blocks of the ratings ordered by (rated time, article
  id), each scored by a model trained on the other four. The 20,000 largest weights by absolute value are kept.
  Equal inputs give byte-equal models. `ESTIMATE_SPEC` hashes the feature definition; a stored model of another spec
  is never scored (EST-1, D-271).
- **Metrics.** Out-of-fold AUC overall and per feed (feeds with at least 10 ratings and both classes), plus counts.
  A block's model also sees later ratings, so these are not the prequential numbers of §2.5; small feeds move by up
  to 0.2 with a few hundred new ratings (dev data: overall 0.905).
- **Cost.** Training the owner's 4,946 ratings takes 0.28–0.37 s (about 60 ms per 1k); the stored model is about
  630 KB of JSON. Scoring costs 60–80 µs per article.
- **Gate.** At least `estimate.minRatings` (10) explicit ratings, with at least `estimate.minEachClass` (3) of
  each class. These live in a new `RankerConfig.estimate` block with defaults; no G1 is needed.
- **Storage** (migration 0034):
  - `user_estimate_models(user_id, version, trained_at, n, n_pos, n_neg, intercept, weights jsonb, platt jsonb,
    metrics jsonb)`, with tenant RLS like `user_models`; the newest 2 are kept.
  - `user_article.score_source` also allows `estimate`.
- **Job `user.estimate {userId}`** (new queue). One per user with a 20-second debounce. The outbox enqueues it
  for every explicit rating change (rate, un-rate, prompt answer, bulk rate, undo) and for an account restore. It
  trains, stores the model and records `user.rank {reason: 'estimate'}`.
- **Ranking** (spec 06 §2).
  - It applies at the exits that return P null: 1b `inference_not_requested`, 2 stale and not selected, and 4d no
    usable answer. Never at a hidden exit.
  - Conditions: an estimate model exists and `prefs.estimates = 'on'`.
  - Result: P is the calibrated estimate and the tier is `tierFromP(P)`. The lane stays `new`, the source is
    `estimate` and the rule `estimate`. `explain.estimate = {version, top}` lists at most 5 positive and 5
    negative words.
  - The cards, model and degraded paths do not change, and an estimate never replaces an analysis result.
  - `RANKER_VERSION` becomes 4.
- **Refresh.** An estimate run re-ranks the user's window rows whose source is `none` or `estimate`, through the
  existing keyset pages and continuations. It writes only rows whose tier changes or whose P moves by at least 0.01.
  It stores `metrics.lastRun = {at, movedUp, movedDown}`: the unread rows whose tier rose or fell. Target: at most
  5 s for the owner's ~12.7k such rows.
- **Reading.**
  - Scoped `all` views already filter on `tier` (D-248), so estimated rows show at tier 2 and above and count in
    the feed badges.
  - Score sort orders them by P together with analysed rows.
  - Unscoped lanes keep their rule: `new` rows never enter For you or Maybe.
  - Optional: a Score/Date control in the global New lane (`newSort`, default `date`).
- **As built (EST-2…EST-4, D-281…D-285).**
  - Storage: `user_estimate_models` also stores `spec` (a model of another spec is retrained, never scored);
    `intercept` is `double precision`; the API role has SELECT only. Migration 0034 (not 0035) also replaces
    `rank_covered()`, so a pending estimate refresh is not "a rank on its way".
  - Job: `stately`, concurrency 2, debounced 20 s with pg-boss leading + trailing job semantics; an input hash
    (`ESTIMATE_SPEC`, options, sorted samples) makes a repeated run a no-op; training runs on the CPU pool. Below the
    gate stored models are deleted. Triggers: a reader action that changed a rating value or time
    (`ratingValueChanged`), an account restore, a change of `prefs.estimates`, and the rank handler's self-heal (no
    model while the gate is open, or a model of another spec), which also backfills existing raters. Ratings aging
    out of the window, merges and admin changes of `estimate.*` do not retrain (found, not fixed).
  - Ranking: exit 1b fires `[inference_not_requested, estimate]`, exits 2 and 4d `[estimate]`; floors, caps,
    boosts and must cards never lift an estimate. Exit 2 is unreachable through the worker (1b fires first). The
    estimate model is not part of `contextSha`. Top words are shown as the article's own words; `f:` is excluded.
  - Refresh: `user.rank {estimate: {version?, up?, down?}}` (keys `rank-est:` / `rank-est-cont:`), one page of up to
    20,000 window rows with lane `new` and source `none`/`estimate`, no BM25 corpus query. A row is written when its
    tier, rules or labels differ or P moves ≥ 0.01. `lastRun` counts written unread rows with a null tier as 1, so
    the first model's `movedUp` counts every newly estimated row at tier ≥ 2 (PRG-3 shows no notice without an
    earlier `lastRun`). Measured on a seeded test database (12,700 estimate rows + 3,500 analysed): 2.7 s first,
    1.9 s nudged, 1.8 s unchanged.
  - Reading: a stored estimate keeps its lane `new`, tier and P in every view (the neutral projection's one
    exception; a hide rule still wins). Story folding ignores an estimate's P. Unscoped lanes and counts are
    unchanged (S19 overlay test). Dataset digests include P and tier, so refreshes cause more `STALE_CURSOR` /
    `dataset_changed` (accepted; PRG-3 is the planned UX). `GET /me/learning.estimates {n, auc, trainedAt, lastRun}
    | null`. The estimate does not depend on the Jev model: a model change leaves it untouched.
  - Debounce precisely: the trailing job exists only when a rating arrives after the leading job started, and it starts
    at the next 20 s boundary, so a model exists 2–23 s (about 30 s end to end) after the last rating.
  - Web as built (EST-5, D-293): the outlined-ring chip in the row's chip line, the Why this? word lists, the Settings
    switch and a trained-on line. `newSort` was not built (it needs an account preference and an API change; the list
    API already honours `sort=score` on lane `new`).
  - Release order: EST-2…EST-4 ship with EST-5; a cached older web bundle rejects `source: 'estimate'` until the
    D-163 reload bar.
- **Web.**
  - Estimated tiers are drawn as outlined dots labelled "Estimated".
  - Why this? explains "Estimated from the words of articles you rated" and lists the top words.
  - Settings → Reading preferences gets "Estimate unanalysed articles" (`prefs.estimates`, default on).

### 4.5 Visible progress (PRG-1 … PRG-4)

- **`GET /me/learning` additions.** `estimates: {n, auc, trainedAt, lastRun} | null`, and per feed
  `estimate: {n, auc} | null`. `feeds` also lists feeds that have estimates, not only Training feeds.
- **Feed header chip** in a Training or Off feed view, by state:
  1. Below the gate: "Rate N more to turn on estimates".
  2. Estimates on: "Estimates on · 23 rated · quality 71 %". This shows the AUC; a tooltip explains it.
  3. With the D-236 agreement: "Cards agree 0.64 · ready at 0.70".
  4. `ready`: the existing Ready for automatic with Enable.

  The paused state of §4.3 overrides all of them.
- **Effect notice.** When `estimates.lastRun.at` advances after the reader's own ratings in this tab, a polite
  live region above the list says "Updated from your ratings: 12 unread articles moved up, 30 down · Show". Show
  reloads under D-243 and D-245, so rows never move under a reader who is scrolled down or reading.
- **History.** `user_learning_history(user_id, at, kind 'model'|'estimate', n, auc, baseline_auc, activated)`
  (migration; RLS; the newest 200 per user are kept), written by `user.learn` and `user.estimate`. Settings →
  Personal learning draws AUC over time, with milestones: estimates on, personal model active, upgrades.

### 4.6 "Show fewer like these?" fixes (DPF-6, DPF-7, DPF-8)

- **Seen-based cooldown.**
  - New table `dislike_pattern_offers(id, user_id, scope 'card'|'feed', scope_id, offered_at, article_ids,
    seen_at, answer, answered_at)` (migration; RLS).
  - The rating transaction inserts the offer, and `POST /articles/:id/pattern-offer {offerId, event:
    'seen'|'accepted'|'dismissed'}` updates it.
  - The 14-day rule counts only seen offers. The web sends `seen` after the toast has been visible for 1 s in a
    visible document.
- **Own toast.** The offer gets the id `pattern-offer:<scope>:<id>` and stays 15 s. Its buttons close it, and a
  later rating's undo toast never replaces it; the undo toast stays separate.
- **Feed scope.** When no held card decides the article (New, Everything else, Training feeds), the same
  `similarDislikes` check runs against the user's ratings of the article's feed from the last 30 days (pool 200).
  - On a pass, the response carries `pattern: {kind: 'feed', feedId, offer, offerId}`.
  - The toast offers "Make a Never card from these", which opens the D-244 editor with Never preselected and
    these articles as examples, and "Not now".
  - It says "Similar unread articles in this feed will be ranked lower." only while estimates are on; the next
    estimate run makes that true.
- **Response schema.** `RatingResponseSchema.pattern` becomes a union on `kind` (`card` | `feed`). Tabs opened
  before the release reject it until they reload (the D-163 bar), as with D-268.

### 4.7 Outage recovery (OPS-1 … OPS-3, dev)

- **OPS-1, done 10-20 13:15 UTC.**
  - The setting is reset to the env default `jev-1.13.0`, the worker restarted, and the pin is now
    `{model: jev-1.13.0}` with one rebuild enqueued.
  - The 650 requests frozen with `jev-latest` end as `context_unavailable` before any engine call.
  - The fingerprint is `22190257…` again: the 3,907 earlier samples count, and the next rating retrains.
- **OPS-2, after JEV-2.** Set `jev-latest`. While it resolves to 1.13.0, nothing is rebuilt.
- **OPS-3, once OPS-1 has drained.** "Drained" means the stale requests have ended and `house.rescore-degraded`
  has re-analysed the outage arrivals.
  - A dev-only script re-applies each outage rating through the API's rating code path, in a tenant transaction,
    as D-238 did for 31 Verge ratings. Outage ratings are those whose effective time falls between 10-17 01:08
    and 10-20 13:15 UTC and whose sample is not eligible.
  - Training-feed articles get a fresh analysis request. Active-feed articles get a live snapshot with facets;
    any still without facets are skipped and reported.
  - Scope and cost: about 1,039 ratings, roughly $0.70. Their rating times move to the re-rating.

## 5. Tasks

Every task is written test-first: a harness that fails before the change, with a negative control. Each phase is
done when all its tasks are done and `pnpm typecheck && pnpm lint && pnpm test && pnpm test:int` pass (run turbo
with `--force`), plus `pnpm e2e` for web work, with CI green. Specs, DECISIONS (from D-271) and the RUNBOOK are
updated in the phase's docs task. Migrations are numbered from 0033 in phase order, and only one branch adds
migrations at a time (CLAUDE.md). Commits: `<task-id>: <summary>`.

**Order.** JEV-6 is independent and ships first. Then JEV-1 → JEV-2 → JEV-4 → JEV-3 → JEV-5. JEV-3 must not
adopt a new version before JEV-4 is merged, or an upgrade resets training again. The other phases follow and can
overlap where they add no migration.

### Phase 1: Jev alias, families and guardrails (migration 0033: `engine_calls.kind` `model_probe`)

| ID | Task | Needs | Lane | Done when |
|---|---|---|---|---|
| JEV-6 | Alerts `engine.typesafe_down` and `engine.model_mismatch`; `/me/learning.classification`; paused banners in Personal learning | — | D | The 10-17 scenario on the fake server (configured id ≠ answered id) fires `engine.model_mismatch` at the next evaluation and `engine.typesafe_down` after 30 min of fake time; recovery mails follow; Personal learning shows the paused state |
| JEV-1 | Model probe job and `model_unavailable` mapping; fake TypeSafe gets an alias table, a configurable answered model and a retired-model error | — | A | Probing `jev-latest` on the fake returns the mapped concrete id; an unknown id fails; reserved spend stays within the cap; the call is recorded as `model_probe`; no test reaches a live API |
| JEV-2 | Resolve and pin at worker start; settings and env validation accept `jev-latest`; `engine.model_resolution`; restart fingerprint | JEV-1 | A | With `jev-latest` → `jev-1.13.0` on the fake, every request and accepted answer uses `jev-1.13.0`; the pin and the rating fingerprint equal those of `jev-1.13.0` (asserted); switching between the two values runs no rebuild; production validation accepts `jev-latest` and still refuses other aliases |
| JEV-4 | Fingerprint families: `modelFamily`, `familySha`, registry, eligibility, model context, activation, family acceptance in `analysis.process`, upgrade guard | — | B | A 1.13 → 1.14 pin change keeps every sample eligible and the active model active; a `jev-2.0.0` change resets as today; the guard deactivates a model that trails the cards on ≥ 30 new-version samples; on the owner's data (bench) the eligible sample count is unchanged by the deploy |
| JEV-3 | `house.model-watch` (cron, on demand, retired-model trigger) and the admin upgrade notice | JEV-2, JEV-4 | A | A flip on the fake from 1.13.0 to 1.14.0 produces exactly one rebuild, the pin 1.14.0 and one admin mail, with the stale-worker guard holding across two worker processes (as the M8b-T5 test does) |
| JEV-5 | Admin: alias option, resolution display, Check now, save-time probe, impact text in the confirmation | JEV-1, JEV-2 | C | Saving an id the probe answers with another id is refused with the answered id; `jev-latest` shows its resolution; the editor is covered by an e2e test |
| JEV-7 | Docs: specs 04 §1.2/§3/§5, 05 §2, 06 §8.1–§8.5, 08 §3/§9, 11 §6.1/§8; PLAN §2 decision 8; DECISIONS; RUNBOOK (alias upgrades, rollback) | all | lead | — |

### Phase 2: Word estimates (migration 0034: `user_estimate_models`, `score_source` `estimate`)

| ID | Task | Needs | Lane | Done when |
|---|---|---|---|---|
| EST-1 | Pure trainer, scorer and calibration in `packages/ranker/src/estimate/`; bench mode `estimate` | — | A | Deterministic output; property tests (calibrated P in [0, 1], higher score never gives a lower P); on the owner's data the per-feed out-of-fold AUC is within ±0.05 of §2.5, and training 5k ratings takes ≤ 1 s |
| EST-2 | Storage, `user.estimate` job with debounce, outbox triggers, `RankerConfig.estimate`, `prefs.estimates` | EST-1 | A | A burst of ratings trains once; un-rate and undo retrain; below the gate no model is stored; the RLS and write-grant suites cover the table |
| EST-3 | Ranker integration (P-null exits, Explain, `RANKER_VERSION` 4), refresh with `lastRun` | EST-2 | B | Truth table: each P-null exit gets the estimate, hidden exits do not, analysed rows are unchanged, `prefs.estimates = 'off'` restores P null; an owner-data refresh takes ≤ 5 s |
| EST-4 | API and DTOs: `ScoreSource`, Explain, preferences, `/me/learning.estimates`, OpenAPI snapshot; list and count tests | EST-3 | B | A Training feed at `minTier` 3 lists exactly its estimated rows with tier ≥ 3, and its badge equals the list; unscoped lanes and counts are unchanged |
| EST-5 | Web: outlined estimated tiers, Why this? estimate section, Settings toggle, en/sk strings; optional New-lane sort | EST-4 | C | Component tests; an e2e smoke: after 10 ratings in a Training feed, tier 2 shows estimated rows |
| EST-6 | Docs: spec 06 §2/§8.6 (new)/§11, 02, 08, 09; PLAN §2 decision 9; DECISIONS | all | lead | — |

### Phase 3: Visible progress (migration 0035: `user_learning_history`)

| ID | Task | Needs | Lane | Done when |
|---|---|---|---|---|
| PRG-1 | `user_learning_history` and its writers; `/me/learning` additions (`estimates`, per-feed `estimate`, feeds with estimates) | EST-2 | A | Every learn and estimate run appends one row; the newest 200 are kept; the schema and OpenAPI tests pass |
| PRG-2 | Feed header chip for Training and Off feeds | PRG-1, JEV-6 | B | Each of the four states and the paused override render from fixtures; en/sk strings |
| PRG-3 | Effect notice after an estimate run | EST-3, PRG-1 | B | A rating, then a completed run, shows the counts once; Show reloads without moving rows under a scrolled reader (D-245 test pattern) |
| PRG-4 | Learning curve and milestones in Settings → Personal learning | PRG-1 | C | Renders from history fixtures in both themes; accessible table fallback |
| PRG-5 | Docs: specs 08 §3, 09 §5/§7, 02; DECISIONS | all | lead | — |

### Phase 4: "Show fewer like these?" (migration 0036: `dislike_pattern_offers`)

| ID | Task | Needs | Lane | Done when |
|---|---|---|---|---|
| DPF-6 | Seen-based cooldown: table, offer insert in the rating transaction, `POST /articles/:id/pattern-offer`, the web `seen`/`accepted`/`dismissed` events | — | A | An unseen offer does not block the next one; a seen one blocks its scope for 14 days |
| DPF-7 | The offer's own toast id and 15 s duration | — | B | A second rating within 15 s leaves the offer visible; the undo toast still updates |
| DPF-8 | Feed-scoped offers and "Make a Never card from these"; the `pattern` union | DPF-6 | A | A Training-feed dislike that looks like ≥ 2 recent dislikes of the feed returns `kind: 'feed'`, and the editor opens with the three articles and Never selected |
| DPF-9 | Docs: specs 06 §10, 08 §5.3, 09 §3.3; DECISIONS | all | lead | — |

### Operations (dev)

| ID | Task | Needs | Status |
|---|---|---|---|
| OPS-1 | Interim pin `jev-1.13.0` (§4.7) | — | ✓ 2026-10-20 13:15 UTC |
| OPS-2 | Switch the setting to `jev-latest` | JEV-2 | owner |
| OPS-3 | Re-rate the outage ratings (dev-only script, report of skipped articles) | OPS-1 drained | lead |

## 6. Implementation notes

- **Migrations.**
  - drizzle-kit stamps `when` with the real time. Set it to the previous entry + 1, which
    `packages/db/test/migration-journal.test.ts` checks.
  - New columns with column-level grants need their own GRANT, and `expected-schema.json` lists columns in
    catalog order.
  - New tables need RLS policies and entries in the RLS-isolation and write-grant suites.
- **Shared registration points.** The lead adds them before builders start (PLAN §0.3): the new queues
  (`user.estimate`, `house.model-watch`, the probe job), the cron entry, routes, i18n namespaces and any
  dependency.
- **New env vars.** A new variable touches `config.ts` ENV_VARS, `packages/shared/test/config.test.ts`,
  `.env.example`, the spec 01 table and `turbo.json` `globalPassThroughEnv`.
- **Tests and APIs.** Tests never call TypeSafe. Extend `packages/testing/src/fake-typesafe.ts`; the client's
  `acceptFake` path stays test-only.
- **Schemas.** `RatingResponseSchema` is strict on the web, so the `pattern` union needs the D-163 reload bar.
  Regenerate the OpenAPI snapshot after DTO changes.
- **The owner's dev stack.**
  - `tsx watch` misses edits under `packages/*`: touch `apps/api/src/main.ts` and `apps/worker/src/main.ts`.
  - Vite can serve stale shared modules: touch `apps/web/vite.config.ts`.
  - The dev worker does not restart itself after a restart-class setting change (`pendingRestart`).
  - Run builders in a separate worktree while the owner uses the app.
- **Benchmarks.** Use `pnpm --filter @bantoozi/worker bench <userId> …` and add an `estimate` mode. The estimate
  trainer runs inline; it needs the CPU pool only if it exceeds 50 ms per 1k samples.

## 7. Risks and later work

- **Calibration drift.** A minor Jev upgrade may shift answer calibration. G1 set the lane and tier thresholds
  on 1.13.0, and alias upgrades skip the eval replay (decision 2). The upgrade guard protects only the personal
  model. After an upgrade notice, the owner can replay the golden set by hand on the golden DB.
- **Weak feeds.** In feeds like Hacker News (~0.58), estimates hide some liked rows at high tiers. This is
  accepted (decision 5), and the chip shows the quality.
- **Major Jev releases.** A 2.x release still resets training. Re-analysing the rated articles from their
  pre-rating inputs is feasible: frozen request snapshots hold the article state and card questions, cards are
  immutable (an edit creates a new card id), and live snapshots name their card ids. It can be added before such
  a release (decision 3 alternative).
- **Later.**
  - Estimate weights as an input of the personal model (PLAN §15 "Words in the personal model",
    `FEATURE_SPEC_V2`).
  - Embeddings for similarity (PLAN §15).
