# Design: plan-tiered feed update velocity (approved 2026-10-16)

Status: approved by the owner on 2026-10-16 with every recommendation in §4 and the admin requirement in §6 (task #15). Research notes:
`.claude/tmp/cards-suggest/analysis/velocity.md` (untracked), numbers from the dev DB.

## 1. Goal

Sell faster feed updates. Free users see their feeds update every 6 or 12 hours, the lowest paid plan every
hour, upgrades every 30, 10 and 5 minutes, and a premium tier every minute where the source allows it.

## 2. What exists today

- Two plans: `beta` (fetch floor 900 s) and `admin` (300 s), in `packages/shared/src/plans.ts` and spec 08 §6.
  `users.plan` is free text. There is no billing, and PLAN §2 locks nothing about cadence. Plans belong to M9.
- Fetching is shared per feed. `feeds.min_interval_s` is the lowest plan floor among the feed's live
  subscribers, so the fastest subscriber sets the pace for everyone (`0003_functions.sql:76-95`).
- The adaptive scheduler has a hard floor of `max(300 s, min_interval_s)` (`next-schedule.ts:110`). It
  slows down after an empty fetch, and publisher hints (ttl, `sy:updatePeriod`, Cache-Control up to 6 h)
  act as a floor. On the dev DB only firehose feeds sit at the floor: Bazos, The Verge, Hacker News and
  WIRED. The other 19 feeds have slowed to 21–105 minutes on their own.
- Rate limits: a 429 or 503 sets an origin cooldown, but `feed.fetch` records it as an ordinary feed error.
  The backoff doubles each time and the feed is quarantined from the 10th error. A source that throttles
  a fast feed would push that feed into quarantine. Nothing learns a minimum interval per source.
- Reader views: every list, count, unread badge and mark-read is bounded by `first_seen_at <= asOf` in
  one query builder (`packages/db/src/api/articles.ts`).

## 3. Proposal

### 3.1 Tiers

| Tier | Interval | Fetches per feed per day (at the floor) |
|---|---|---|
| Free | 6 h (or 12 h) | 4 (2) |
| Basic | 1 h | 24 |
| Plus | 30 min | 48 |
| Pro | 10 min | 144 |
| Max | 5 min | 288 |
| Premium | 1 min, where the source allows | 1,440 |

Names and prices are placeholders. The interval is a plan limit (`minFetchIntervalS`), as today.

### 3.2 One fetch per feed, released to each user on their own schedule

- The server keeps fetching each feed once, at the fastest interval any live subscriber pays for
  (unchanged mechanism). A faster plan therefore costs us only on the feeds such a user actually follows.
- Each user sees new arrivals at their own **release boundary**: visible = `first_seen_at <=
  least(asOf, release_at)`. `release_at` is the start of the user's current plan window, aligned to their
  time zone (for example 00/06/12/18 for 6 h), computed by the server. Free users therefore get the full
  content of each update window, as if their feeds were fetched at those times; nothing is thinned out.
- A new subscription gets about 15 minutes of grace, so its first fetch shows at once.
- This is one change in the shared query builder. List, counts, unread badges, mark-all-read, the
  D-243 "N new articles" banner (it fires once per release, which becomes the visible "your feeds
  updated" moment) and the offline copy all follow it. There is no schema change and no per-user write.
- Ranking and analysis keep working on arrival time, so results are ready when an article is released.
  The D-252 daily analysis cap is per feed and unaffected.
- For fairness, the server clamps any client-supplied `asOf` to `release_at`. Article detail by id and
  the feed drawer's "last fetched" times are bounded the same way, and the drawer shows "Next update at
  hh:mm" instead.

Alternatives considered: a per-user virtual fetch snapshot (more writes and a new job, little gain); no
hiding (free users would get premium speed on shared feeds, leaving no reason to upgrade); selling speed
per feed ("N fast feeds per plan"), which can be added on top of 3.2 later.

### 3.3 Protecting sources (needed before any tier under 5 minutes)

1. A 429 or 503 becomes a `throttled` outcome. It never counts as a feed error or towards quarantine.
2. Each origin learns a minimum interval: `max(Retry-After, 2 × current interval)`, relaxed by ×0.8 after
   24 hours without throttling.
3. `Crawl-delay` from robots.txt is honoured for fast tiers.
4. A fetch budget per origin, so many fast feeds on one host (for example several Bazos categories) cannot
   add up to many requests a minute.

The effective interval is `max(plan floor, source floor, publisher hint)`. The feed drawer says "Updates every
X — limited by the source" (or "by the publisher") when the plan's speed is not reached.

### 3.4 Cost

- Fetching costs bandwidth and parsing only, which is negligible except on firehose feeds.
- Analysis cost depends on the articles captured, not on fetch count. For a normal feed a faster fetch only
  brings the same articles sooner, at no extra analysis cost.
- On a truncated firehose such as Bazos (50 items per fetch, about 7,000 posted a day), a 1-minute fetch
  captures about 7,000 a day instead of about 4,500. Automatic analysis stays bounded by the D-252 cap
  (1,000 a day, about $0.58); extraction grows to about 7,000 pages a day on one origin.
- When the fastest subscriber leaves, the feed slows down after one more fetch at the old pace.

## 4. Owner decisions (2026-10-16)

1. Tiers: Free 6 h, Basic 1 h, Plus 30 min, Pro 10 min, Max 5 min, Premium 1 min (where the source allows). Current beta users
   keep 15 minutes during the beta and are mapped to a paid tier when billing exists.
2. Release times are aligned to each user's time zone; a new subscription has 15 minutes of grace.
3. Speed is per plan only for now ("N fast feeds" may come later).
4. Publisher hints (Cache-Control, ttl, `sy:updatePeriod`) bind every tier, including Premium.
5. The D-252 daily analysis cap stays per feed and does not scale with the plan.
6. "Refresh now" stays admin-only until billing exists.

## 5. Phased plan (rough effort)

| Phase | Content | Effort |
|---|---|---|
| P0 | Editable plans and users in Admin (§6): plans move from `plans.ts` into the database with the current values as seed; Admin → Plans edits them; Admin → Users changes a user's plan and role. | ~2–3 days |
| P1 | The new tiers as seeded plans. The scheduler floor drops to 60 s; growth after empty fetches scales with the interval (spec 03 §9). | ~1 day |
| P2 | Source protection: throttled outcome, learned per-origin floor (migration), Crawl-delay, per-origin fetch budget (spec 03 §8.2, §9). | ~1.5 days |
| P3 | Release boundary in the article query builder, server-clamped `asOf`, bounded detail, FeedInfo `nextUpdateAt` and `intervalReason` (spec 08 §5.1, 06 §6.4), with integration tests. | ~1.5 days |
| P4 | Web: "Updates every X / next at hh:mm" in the feed drawer and Settings, plan badge, banner wording (en, sk). | ~1 day |
| P5 | Load check of the scheduler and fetch concurrency with many 1-minute feeds; RUNBOOK; DECISIONS. | ~0.5 day |

Billing and payment are out of scope. Until they exist, an admin assigns plans.

## 6. Admin: editable plans and per-user plan (owner requirement, 2026-10-16)

Tiers and their allowances must be editable without a code change:

- **Admin → Plans.** Plans move from the `PLANS` constant (`packages/shared/src/plans.ts`) into the database, seeded with today's
  `beta` and `admin` plus the tiers of §4. An admin can add a plan and edit each plan's name and every limit: feeds, cards, labels,
  forks, rules, OPML size, fetch interval (`minFetchIntervalS`), release cadence, backfill days, invites. Admin can also pick the
  default plan for new users. A plan in use cannot be deleted; it can be retired, so no new user gets it. A change applies live:
  quota checks read the stored plan, and the feeds of affected users get their intervals recomputed (as a plan change already does).
- **Admin → Users** already exists (search, edit role, plan and invites; `apps/web/src/features/admin/users-page.tsx`,
  `PATCH /admin/users/:id`). Its plan choices come from the stored plans instead of the `PLAN_NAMES` constant, and a user plan
  change recomputes only that user's feeds and pulls their next fetch forward when the interval drops.
- **Global analysis cap.** `engine.auto_analysis_daily_cap` (D-252) is already editable in Admin → Settings; the Plans page links to it.
- **Storage:** a `plans` table (migration after #44), `users.plan` references it, so a plan in use cannot be deleted. A plan's key
  never changes; its display name is editable in English and Slovak. The §4 tiers are seeded in P0, so they are visible and editable
  at once; intervals under 5 minutes take effect only with P1's scheduler change, and Admin → Plans says so.
- Details: `.claude/tmp/cards-suggest/analysis/plans-admin.md` (every reader of plan data, endpoints, live apply).
