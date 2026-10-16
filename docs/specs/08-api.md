# Spec 08: HTTP API (`apps/api`)

Status: **binding**. **Intent:** a small, typed JSON API that the PWA (and later other clients) uses.
Every per-user query runs under row-level security, and every limit that bounds cost is enforced here.

---

## 1. General

- **Base path:** `/api/v1`. JSON in and out (`application/json; charset=utf-8`), except the OPML
  upload/download and the export download.
- **Schemas:** all request and response bodies are zod schemas in `packages/shared/src/dto/` (one file
  per area), registered with `fastify-type-provider-zod`. OpenAPI JSON is served at
  `/api/v1/openapi.json` (admin session required in production).
- **Data formats:** IDs are strings. Timestamps are ISO 8601 UTC strings. Enumerations are lower-case
  strings exactly as in [spec 02](./02-data-model.md).
- **Errors:** `{ "error": { "code": "QUOTA_EXCEEDED", "message": "human text (en)", "details": {…} } }`
  with the HTTP status from the table below. The web client localizes by `code`.

  | Code | HTTP |
  |---|---|
  | `VALIDATION_FAILED` | 400 |
  | `INVALID_CODE` | 400 |
  | `UNAUTHENTICATED` | 401 |
  | `FORBIDDEN` | 403 |
  | `NOT_FOUND` | 404 |
  | `CONFLICT` | 409 |
  | `STALE_CURSOR` | 409 |
  | `STALE_STATE` | 409 |
  | `IDEMPOTENCY_CONFLICT` | 409 |
  | `QUOTA_EXCEEDED` | 409 |
  | `INVITE_REQUIRED` | 403 |
  | `RATE_LIMITED` | 429 |
  | `FEED_*` (spec 03 §4) | 422 |
  | `ENGINE_UNAVAILABLE` | 503 (only admin endpoints surface it) |
  | `INTERNAL` | 500 |

- **Pagination:** cursor-based. `?cursor=<opaque>&limit=<1..100>` (default 30). Paginated responses
  have `{items, nextCursor: string | null}`. Cursors contain a version, complete sort-key tuple
  (including null ordering and final id), normalized filter hash, user id and expiry. They are
  base64url encoded and HMAC authenticated; reject a cursor for another user/query or an invalid
  signature with `VALIDATION_FAILED`. A cursor is never an authorization grant. Article-list
  consistency across reranking is defined in §5.1. Quota-bounded lists explicitly shown as arrays
  remain arrays; admin users/feeds/invites/waitlist and library searches use the paginated envelope.
- **Tenancy:**
  - The `tenant` plugin exposes `req.withTx(fn)`. It opens a transaction **lazily**, on first use, runs
    `set_config('app.user_id', …, true)`, and hands `fn` a `TenantTx`. Route handlers must use it for
    per-user tables.
  - Slow outbound work (feed discovery, OPML validation, translation of card text) runs **before** the
    transaction is opened, so no pooled connection is held during network I/O.
  - Persist state changes and typed job intents in `job_outbox` in the **same transaction**; the
    relay publishes through `packages/shared/src/jobs.ts` (specs 02/03). No acknowledged mutation may
    depend on an in-memory callback that could be lost after commit.
- **Authorization:** all routes require an active, unrevoked session and a non-deleted user except
  request-code, verify, waitlist, `GET /setup`, `POST /setup/complete`, healthz and readyz (and the separately protected metrics/ops routes).
  Admin roles are read from the current DB row on every request. Per-user RLS does not protect shared
  article/feed ids or auth/control-plane tables by itself: repositories must additionally constrain
  every detail, action, bulk member, example and rule reference to the authenticated user's owned
  subscription/bookmark/card/label. Foreign or inaccessible ids return `404` without revealing
  existence; mixed-access bulk requests fail atomically. UUID/bigint strings are validated losslessly.
- **CSRF:**
  - Every non-GET request must carry the header `X-Bantoozi-Client: web`. Browsers cannot send a custom
    header cross-site without a CORS preflight, and preflights are refused.
  - If an `Origin` header is present, it must equal `new URL(PUBLIC_BASE_URL).origin`; `null` and
    malformed origins fail. Reject `Sec-Fetch-Site: cross-site`. GET/HEAD/OPTIONS never mutate user
    state except bounded session activity and the documented asynchronous rank-refresh intent.
  - **Exempt:** requests authenticated with the `METRICS_TOKEN` bearer (`POST /admin/ops-event`,
    `GET /metrics`). These come from host scripts, not browsers, and carry no cookie.
- **CORS:** disabled. The web app is same-origin through Caddy.
- **Validation and privacy:** reject unknown request keys, invalid enum/range values and unbounded
  nested JSON. JSON bodies are limited to 1 MiB, multipart OPML to its separate cap. Authenticated
  responses use `Cache-Control: private, no-store`; the explicit per-user offline projection in
  spec 09 is the only persistent client copy. Never log codes, cookies, authorization headers, invite
  tokens, raw emails, or article/private-card bodies. Return a request id with generic 500 messages.

### 1.1 Atomic mutations, idempotency and concurrency

- Every authenticated data mutation carries `Idempotency-Key: <UUID>`. A client retries the same
  logical operation with the same key; a new intentional operation gets a new key. In the state
  transaction, reserve the `(user_id, key)` in `api_mutations` (spec 02), bind it to method, canonical
  route and canonical body hash, and save the response, feedback and outbox effects before commit.
  Concurrent duplicates serialize and return the saved status/body without another event/job; a
  reused key with a different request returns `409 IDEMPOTENCY_CONFLICT`. No partial receipt remains
  after rollback. Receipts are retained for 7 days; offline replay stops after 24 hours (spec 09).
  Authentication is checked before receipt replay. Auth login/logout and bearer ops events use their
  own flow and are exempt. External discovery/translation may precede the transaction, but quotas and
  ownership must be checked again under lock before persisting anything.
- Serialize quota-affecting writes on the caller's `users` row: count, insert/re-point, counter update
  and outbox intent are one transaction. Existing subscriptions/holdings are idempotent no-ops, not
  additional quota usage. Lock referenced rows in deterministic id order; use bounded retries for
  deadlock/serialization errors, retaining the same idempotency key.
- Reader writes use `user_article.state_version` (a decimal string in JSON). Clients submit the
  expected version for each target; zero denotes an absent row. Update reader state and increment
  the version atomically, or return `409 STALE_STATE` with the current readable item. Ranking-only
  writes never increment this version; the worker's automatic archive and article merge do (spec 11
  §6, spec 03 §8.4). Return the committed item(s), version(s) and `mutationId`. Bulk reader writes
  are all-or-nothing, including version checks. A stale offline write is surfaced for review; it
  must never silently overwrite a newer action from another device.
- Preference PATCHes merge only supplied leaves under the user-row lock; arrays are replaced, not
  concatenated. Other PATCHes update only supplied columns. Missing means unchanged; `null` clears
  only explicitly nullable fields. Empty PATCHes and unauthorized nested ids fail validation.

---

## 2. Authentication, signup and invites

### 2.1 Flow

| Endpoint | Body | Behaviour |
|---|---|---|
| `POST /auth/request-code` | `{email, inviteCode?, locale?}` | **Always** `202 {next: 'check_email'}` (no user enumeration). The email content decides what happens next (below) |
| `POST /auth/verify` | `{email, code}` | On success: create the user if this is a signup, create a session, set the cookie → `200 {user: Me}`. Otherwise `400 INVALID_CODE` |
| `POST /auth/logout` | — | Revoke the current session, clear the cookie → `204` |
| `GET /auth/sessions` | — | The user's active sessions `[{id, userAgent, ip, createdAt, lastSeenAt, current}]` |
| `DELETE /auth/sessions/:id` | — | Revoke one session → `204` |
| `GET /setup` | — | Public, `Cache-Control: no-store` → `200 {open: boolean}`; `open` is true while no active admin exists |
| `POST /setup/complete` | `{token, email}` | First-run setup (below). Public; needs the CSRF header (§1); no `Idempotency-Key`. Success sets the session cookie → `200 {user: Me}` |

**`request-code` decision table.** "Mode" is the effective signup mode: `settings['signup_mode']` if
set, otherwise `SIGNUP_MODE` (spec 02 §2). It is read on every request, so an admin change applies
to the next one, and no row reads the environment value alone. A stored value that no longer parses
is logged and treated as `closed` for signups (D-122).

| Situation | Email sent |
|---|---|
| a `users` row exists (active, or soft-deleted and not yet purged) | login code (verifying restores a soft-deleted account) |
| unknown email listed in `ADMIN_EMAILS`, mode ≠ `closed` | signup code (**admin bootstrap**: a listed address needs no invite) |
| unknown email, mode `open` | signup code |
| unknown email, mode `invite`, valid invite (unused, unexpired, email-bound invites must match) | signup code (invite remembered on the code row) |
| unknown email, mode `invite`, no or invalid invite | "Bantoozi is invite-only" email with a waitlist link |
| unknown email, mode `closed` | nothing |

**Codes:**
- Trim and case-normalize emails consistently with `citext`; validate syntax/length without
  provider-specific dot/plus rewriting. Requested locales are only `en`/`sk`, with fallback `en`.
- 6 digits from a CSPRNG, stored as `HMAC-SHA256(SESSION_PEPPER, challenge_nonce || email || code)`
  using an unambiguous canonical encoding, TTL **10 minutes**, at most
  **5** verify attempts per code.
  `challenge_nonce` is a fresh UUID generated before insert, not the database identity id.
- The requested `locale` and the `inviteCode` are stored on the `login_codes` row.
- A new request invalidates older unconsumed codes for the email (it sets their `consumed_at`;
  D-122).
- Serialize requests/verifications for a normalized email (transaction advisory lock plus challenge
  row lock). Compare digests in constant time; atomically consume the code, create/restore the user,
  consume any invite and create the session. Concurrent correct verifications cannot create two
  sessions from one code. Failed-attempt increments must commit even when the API returns
  `INVALID_CODE`; do not throw an exception that rolls back the attempt counter.
- Recheck invite expiry, unused state and email binding under lock at **verification**, and recheck
  signup eligibility then; a code is not a reserved invite. Use the same generic error for expired,
  consumed, incorrect or ineligible codes. A login code created for an existing user must not become
  a signup authorization if that user was purged in the meantime.
- Emails come from localized templates (en/sk) in `packages/shared/src/server/mail/templates.ts` (shared with
  the worker's alert emails), with a plain-text and an HTML part.
- Public responses disclose neither account existence nor SMTP outcome. After committing the code,
  attempt synchronous SMTP delivery with a bounded timeout and keep plaintext only in request
  memory. This is the explicit auth-mail exception to durable jobs: if the process/SMTP fails, the
  user requests a new code; do not imply guaranteed delivery or persist plaintext in the outbox.
  Bound response timing independently of account existence. A per-email throttled request retains the same 202;
  IP abuse can return 429 without an account-existence signal.

**The signup mode** is the effective mode above. Verification rechecks signup eligibility under
the mode in effect at that moment, so a signup code issued before a switch to `closed` creates no
account.

**On signup:**
- insert `users`:
  - UUID v7
  - locale from `login_codes.locale`, else `Accept-Language`
  - `invites_left` from the plan
- mark the invite used with a conditional `used_at IS NULL AND expires_at > now()` update
- if the email is on the waitlist, delete that row in the same transaction: the account replaces it

**On every successful verify:**
- `ADMIN_EMAILS` is **bootstrap only**: the user is made admin when the email is listed **and** either the
  account is being created by this verify or no active admin exists (a login while there is none, for
  example after the last admin was deleted). Otherwise the stored role stands, so a demotion in the admin
  UI sticks. The "no active admin" check runs under the setup advisory lock (below), so two concurrent
  bootstraps and a first-run setup cannot all pass it (D-215)
- only when restoring within the 7-day window: clear `deleted_at`, call
  `refresh_feed_subscribers`/`refresh_feed_cards`, advance `rank_revision` and enqueue
  `user.rank {full: true}`. Ordinary logins need only normal freshness catch-up. A delayed purge must
  not extend the restore window; verify and purge lock the user row to resolve their race.
- update `last_active_at`

A soft-deleted account keeps its `users` row until `house.purge-users` removes it after 7 days, so an
email never hits the unique constraint through the signup path.

**Session cookie:** `bantoozi_sid` = 32 random bytes, base64url, stored hashed.
- Attributes: `HttpOnly`, `Secure` (production), `SameSite=Lax`, `Path=/`, `Max-Age = SESSION_TTL_DAYS`.
- Sliding: `sessions.last_seen_at`, `sessions.expires_at` **and `users.last_active_at`** are refreshed
  at most every 5 minutes, with a matching refreshed cookie Max-Age. "Active in the last N days"
  everywhere means `users.last_active_at`. Check expiration/revocation on every request, reject
  deleted users, and clear cookies with the same Path/attributes on logout. Session ids exposed by
  `/auth/sessions` are database ids, never token hashes or tokens. Do not bind sessions rigidly to IP.
  An admin demotion is permanent: `ADMIN_EMAILS` no longer restores the role (above). The
  last-active-admin guard of §9 still applies.

#### First-run setup (M8b)

A fresh install has no admin and needs no `ADMIN_EMAILS`. While **no active admin exists** (`role='admin'`
and `deleted_at IS NULL`), setup is open:

- **Token.** At start-up, after the server is ready, the API takes the advisory lock `bantoozi:setup`
  and, if setup is open, generates 32 CSPRNG bytes (base64url, 43 characters), stores only its keyed digest
  and `createdAt` in `settings['auth.setup']` (spec 02 §2) and logs the plaintext once, at `warn`
  (to stderr when the log level hides `warn`): `First-run setup is open. Setup token (shown once, valid
  until the next start): …`. **Every start rotates it**, so only the newest line works; the token is never
  stored or returned. **Fail closed (D-227):** a process redeems no token until it has committed its own new
  digest (or found an active admin). If the start-up rotation fails (the error is logged; start-up never
  throws), `POST /setup/complete` answers the generic `400 INVALID_CODE` for every token, including one left
  by the previous process, and the next `GET /setup` or `POST /setup/complete` retries the rotation under
  the lock (one attempt at a time) and logs the new token once; the request that triggered a retry is still
  refused. With an active admin the API generates and logs nothing and **closes** any open
  row left by an earlier start: the row takes the consumed shape (`{createdAt, consumedAt, userId}` with
  the id of an active admin, no digest), so a token logged earlier cannot be redeemed if that admin is
  later deleted (the strict `auth.setup` schema is unchanged and the API role cannot `DELETE` settings, so
  the row is rewritten, not removed; D-224). The same close runs, under the `bantoozi:setup` lock, at every
  moment a user becomes an active admin: the `ADMIN_EMAILS` bootstrap in `verify`, the restore of a
  soft-deleted admin at `verify`, and `PATCH /admin/users/{id}` with `role: 'admin'`. No migration is
  involved (D-212). Every one of these paths takes the setup lock before the auth-email lock (D-225).
- **Redeem.** `POST /setup/complete {token, email}`, in one transaction under the setup lock: recheck that
  no active admin exists, compare the token digest in constant time, normalize the email, then either
  create the user with `role='admin'` (locale from `Accept-Language`, plan `invites_left` as for any
  signup) or **promote in place** an existing active user with that email (their data stays). A
  soft-deleted user with that email is refused (D-216). It deletes a matching waitlist row, marks the setup
  `consumed` (`{createdAt, consumedAt, userId}`) and creates the session like `verify`. No email is sent
  and no invite, signup mode or `ADMIN_EMAILS` is consulted: it works in every signup mode.
- **Errors.** A wrong token, a closed setup and every refusal above answer the same `400 INVALID_CODE`
  ("Invalid setup token"), so the response says neither whether an admin exists nor why. Limits: spec 08 §11
  (10 attempts per 15 minutes per IP, wrong ones included, D-213).
- A single use: after success the same token, and any older one, fails. A token also stops working at the
  moment any admin exists, not only at the next start (D-224).

### 2.2 Invites and waitlist

| Endpoint | Body | Behaviour |
|---|---|---|
| `GET /invites` | — | `{items: [{code, email, createdAt, expiresAt, usedAt, url}], invitesLeft}` |
| `POST /invites` | `{email?, note?}` | Atomically requires/decrements `invites_left > 0` under the user lock. Creates a CSPRNG code (10 chars, Crockford base32, expires in 30 days; retry unique collisions). If `email` is given, sends the invite email after commit (below) → `201 {code, url: PUBLIC_BASE_URL + '/join?code=' + code, emailSent?: boolean}`. No slot left → `409 QUOTA_EXCEEDED {limit: 'invites', invitesLeft: 0}` (D-122) |
| `POST /waitlist` | `{email, locale?, note?}` | Public. Upsert → `202 {next: 'waitlisted'}`. Rate-limited per IP |

**Invite email** follows the auth-mail pattern of §2.1: there is no mail queue, and the invite code
never enters an outbox payload. After the invite commits, attempt bounded synchronous SMTP delivery.
A failure keeps the invite and returns `emailSent: false`, so the inviter can share the link from the
response or `GET /invites`. `POST /admin/waitlist/:id/invite` sends and reports the same way.

---

## 3. Me and preferences

| Endpoint | Body | Behaviour |
|---|---|---|
| `GET /me` | — | `Me` = `{id, email, displayName, locale, timezone, role, plan, planInfo, invitesLeft, preferences, quotas: {used, limits}}` |
| `PATCH /me` | `{displayName?, locale?, timezone?, preferences?}` | Partial update. `preferences` is deep-merged and validated (§3.1), timezone must be an accepted IANA identifier. Ranking-relevant changes advance `rank_revision` and enqueue `user.rank {full:true}` (spec 06) |
| `DELETE /me` | — | Sets `deleted_at`, revokes all sessions, and calls `refresh_feed_subscribers` and `refresh_feed_cards` for the user's feeds (soft-deleted users no longer count) → `204`. `house.purge-users` hard-deletes after 7 days |
| `GET /me/learning` | — | Read-only learning status (spec 06 §8.5, D-236, D-237) → `200 {model: {thresholds: {minExplicit, minEachClass, minCvAuc}, counts: {explicit, likes, dislikes}, active: {version, since} \| null, lastAttempt: {at, status: 'activated'\|'rejected', reasons: string[], cvAuc, baselineAuc} \| null, deactivated: {at, reason: 'incompatible'\|'lost_evidence'} \| null}, feeds: [{feedId, status: 'collecting'\|'ready'\|'not_yet'\|'one_sided', likes, dislikes, auc, aucLow, ratedHigh: {total, liked}, ratedLow: {total, disliked}, uncovered: {count, suggest, articles: [{id, title}]}, unwanted: {count, suggest, articles: [{id, title}]}, articlesPerWeek}]}` (`uncovered`: spec 06 §8.5, D-241; `unwanted`, the same shape for topical dislikes no Never card caught: spec 06 §8.5, D-244; `articles` are the newest ≤ 5 the caller can still see); `feeds` lists the caller's `training` subscriptions only. Computed live; no writes |
| `GET /me/export` | — | Stream a consistent read-only snapshot as `application/json` attachment: `{schemaVersion: 2, exportedAt, user, subscriptions, feedPreferences, opml, cards, labels, rules, ratings: [{url, title, rating, reason, ratedAt}], bookmarks: [{url, title, bookmarkedAt, capture: BookmarkCapture, snapshot: BookmarkSnapshot \| null}]}`. Include full retained bookmark text/HTML; exclude provider/session/code/token secrets and every other user's data. Cancel on disconnect and rate-limit large exports |

`Me.planInfo` reports `{label, labelSk, releaseIntervalS, minFetchIntervalS, nextUpdateAt}` from the
stored plan. `nextUpdateAt` is the next account release (null for immediate plans); the key remains
`Me.plan`. This metadata is also returned after login and profile updates.

### 3.1 `UserPreferences` (stored in `users.preferences`; zod defaults applied on read)

```ts
{
  defaultTier: 1 | 2 | 3 | 4 | 5,              // default 1
  hideEverything: boolean,                      // default false: collapse the "Everything else" lane
  simpleMode: boolean,                          // default false (FeedIt Simple Mode)
  showRead: boolean,                            // default false: unread lanes ask for status=all (D-234)
  sort: 'score' | 'date',                       // default 'score' (For you)
  feedSort: 'score' | 'date',                   // default 'date': feed, folder and label views of all lanes (D-247)
  feedMinTier: 1|2|3|4|5,                       // default 1: minimum tier of those views (D-248)
  markReadOnExpand: boolean,                    // default true
  markReadOnRate: boolean,                      // default true
  feedbackPrompt: 'often' | 'occasionally' | 'never',   // default 'occasionally'
  exampleSuggestions: boolean,                  // default true: offer a card example after a rating (spec 06 §10)
  demote: { clickbait: Tri, promotional: Tri, shallow: Tri, stale: Tri },  // Tri = 'auto'|'on'|'off', default 'auto'
  implicitNegative: boolean,                    // default false
  swipe: { left: 'dislike' | 'read' | 'none', right: 'like' | 'bookmark' | 'none' },   // default dislike / like
  theme: 'system' | 'light' | 'dark',          // default 'system'
  loadRemoteImages: boolean,                    // default false: publisher images/icons require opt-in
  implicitFeedback: boolean,                    // default false: opt in to dwell/read-derived learning
  folderOrder: string[],                        // default []: folder names in sidebar order
  onboardingCompletedAt: string | null,         // ISO; default null → the web app shows onboarding
}
```

---

## 4. Subscriptions and feeds

| Endpoint | Body / query | Behaviour |
|---|---|---|
| `GET /subscriptions` | — | `[{feed: FeedInfo, titleOverride, folder, allowDuplicates, hidden, inferenceMode, inferenceVersion, inferenceActivatedAt, imagePolicy, effectiveImagesAllowed, unread: {forYou, maybe, everything, new}}]` (`unread` is what the feed's own `lane=all` view lists with `status=unread` and `minTier = prefs.feedMinTier`, D-248; it never depends on `defaultTier`) |
| `POST /subscriptions` | `{url, folder?}` | Discovery (spec 03 §10). One feed → `201 {subscription}` with `inferenceMode:'off'`; local fetch/parse makes articles readable without inference/backfill. Several → `200 {status: 'choose', candidates: [{url, title, type}]}`. Errors `FEED_*` (422). Quota `maxFeeds`. Existing subscriptions keep their mode |
| `PATCH /subscriptions/:feedId` | `{titleOverride?, folder?, allowDuplicates?, hidden?, imagePolicy?: 'inherit'\|'allow'\|'block'}` | Update metadata/image policy only; inference mode changes use the explicit endpoint below |
| `POST /subscriptions/:feedId/inference` | `{mode:'off'\|'training'\|'active', expectedVersion}` | CAS `inference_version`, persist the selected mode, refresh demand and rank eligibility → `200 {subscription}`. Active requires explicit enable and applies to new arrivals only (§4.1) |
| `POST /subscriptions/:feedId/analyze` | `{articles:[{id, contentRevision}][1..20], expectedInferenceVersion, startTraining?:boolean}` | In training/active, create exact article requests only (§4.1); off requires explicit `startTraining:true`. Persist requests plus `analysis.process {analysisRequestId}` intents atomically → `202 {requests:[{id, articleId, status}]}` |
| `GET /analysis-requests/:id` | — | Own request only → `{id, feedId, articleId, contentRevision, status, createdAt, completedAt, errorCode?}`; status is `pending\|running\|complete\|failed\|cancelled` |
| `GET /feed-preferences` | — | Own remembered preferences, including unsubscribed bookmark sources: `[{feedId,imagePolicy,effectiveImagesAllowed}]` |
| `PUT /feed-preferences/:feedId` | `{imagePolicy:'inherit'\|'allow'\|'block'}` | Upsert durable `user_feed_preferences`; require owned subscription, bookmark source or already-owned preference, return the effective policy. Never changes inference mode |
| `DELETE /subscriptions/:feedId` | — | Delete, then `refresh_feed_subscribers`, `refresh_feed_cards`, `user.rank {full}`. The user's pending/running `analysis_requests` for the feed lose their demand, and the worker cancels them on their next attempt or `house.reconcile` (the API role has no update grant; the worker owns completion). Completed ones stay for learning (spec 11 §5) |
| `POST /subscriptions/:feedId/mark-read` | `{olderThan, datasetVersion}` | Same operation as `/articles/mark-read` with `filter: {lane: 'all', feedId}` fixed by the path and the default `minTier` (`prefs.feedMinTier`, D-248), so `datasetVersion` is the one `GET /articles?lane=all&feedId=<id>` returned for `asOf = olderThan`; same scope, cap, receipt and undo contract. A feed without the caller's subscription is `404` |
| `POST /subscriptions/import-opml` | multipart `file` (≤ 1 MB) | spec 03 §11. `200 {added, existing, invalid: [...]}`. New subscriptions start off; no inference/card backfill. Existing subscriptions retain mode. Quota `opmlMaxFeeds` and `maxFeeds` |
| `GET /subscriptions/export-opml` | — | `text/x-opml` attachment |
| `POST /subscriptions/folders/rename` | `{from, to}` | Rename a folder across the user's subscriptions and in `preferences.folderOrder` → `200 {count}` |

`FeedInfo = {id, url, siteUrl, title, iconUrl, status, lastSuccessAt, lastErrorCode, lastErrorAt,
updateIntervalS, nextUpdateAt, intervalReason}`. The effective interval is the maximum of the account's
release cadence (or fetch floor for immediate plans), learned source/robots floor and publisher/cache
hint. `intervalReason` is `plan | source | publisher`; `nextUpdateAt` estimates the next fetch rounded
up to an account release boundary (immediate during subscription grace), or uses the next account
boundary when already fetched articles are waiting. Dead/paused feeds report null.
Shared last-success/error times are capped at the subscription's visible-through cutoff. No raw shared
fetch schedule is exposed. The new timing fields are optional in DTOs for older offline records.
`PATCH` returns `200 {subscription}` and delete returns `204`. Existing subscriptions return the
current object without changing the user's folder/preferences implicitly. Hidden means excluded
from aggregate reader/sidebar selection; it does not unsubscribe, stop shared fetches or disable
direct feed view. Subscription changes call both refresh functions in the state transaction and
invalidate affected ranking; folder/duplicate visibility changes also invalidate list cursors.
Errors exposed to users are sanitized error codes, never upstream credentials or response bodies.

### 4.1 Explicit inference demand

`inferenceMode` is per **user subscription**, not global feed status. `off` is the default and never
creates inference demand. Entering `training` itself makes no model call: the user must select actual
article ids and submit `/analyze`. Every requested id/revision must still belong to that owned feed;
validate the complete selection before inserting any `analysis_requests`. A request is an auditable
authorization for exactly that user/feed/article/revision, not permission to analyze siblings,
future articles, the whole feed or the entire card backfill window. Repeated current requests reuse
the same completed/pending work; shared current cache entries may satisfy them without new calls.
Freeze the selected inputs/card/model-policy context per spec 05 in the request transaction, and
enqueue `analysis.process {analysisRequestId}` through the outbox for **each** persisted request.
A bare live-id `article.enrich` is not an equivalent contract. `startTraining:true` is an explicit
combined action: CAS off→training plus selected request creation in the same transaction, never a
hidden consequence of ordinary reading/rating. Without that flag off returns `409 CONFLICT`.

`active` means automatic article demand for this user's enabled subscription, while model inputs and
answers remain shareable by their complete content/question/cache identity. Concurrent demand from
two users must not force duplicate provider calls. Another user's active subscription never enables
this user's off subscription. Local feed fetching, reading, rating and bookmark capture remain
available while off; GET/counts/card edits/calibration polls must not bypass the demand gate.

**Activation policy:** the user explicitly chooses "Enable automatic
classification" to enter active. Record the activation timestamp atomically; only new feed arrivals
from that point create automatic demand. Existing backlog requires explicit article selection; no
rating-count threshold, automatic graduation or whole-feed backfill is inferred.

Changing mode advances `inference_version` and invalidates stale demand. Off cancels unstarted manual
requests and automatic work for this subscription; running external calls may finish for accounting
or another authorized subscriber, but cannot revive cancelled per-user work. Leaving active for
training stops future automatic demand and requires new explicit selections. Rank/background jobs
recheck the mode/request and revision at admission and commit (specs 02/03/05/06). A stored rating
alone is never fresh inference authorization. API `rankingPending` excludes intentionally off or
unselected training items so the UI never waits for work that will not run.

### 4.2 Remembered source image policy

Resolve per-user source preference first: `allow → true`, `block → false`, otherwise use global
`preferences.loadRemoteImages`. Thus explicit feed **allow overrides global block**, and explicit
feed block overrides global allow. Store it separately from the subscription so unsubscribe/re-add
and saved bookmark views retain the same choice; never mutate shared `feeds` for this preference.
DTOs identify `mediaPolicyFeedId` and `effectiveImagesAllowed`. For duplicate articles, use the
selected display feed consistently; a bookmark freezes its selected source id at save time. Do not
pick a different sibling feed to bypass a block. Source-less content uses the global preference.
These controls cover sidebar icons, thumbnails, detail images and saved HTML image placeholders;
bookmark archives contain text and sanitized HTML only, with no retained image/media binaries.
Any permitted live remote image display still obeys the same source preference; allowing images
does not cause the bookmark capture/export path to download or archive them.

---

## 5. Reading and feedback

### 5.1 `GET /articles`

**Query:**
- `lane` ∈ `for_you | maybe | everything | new | all | bookmarks | hidden` (default `for_you`)
- `feedId?`, `folder?`, `labelId?`
- `status` ∈ `unread | all` (default `unread`; default `all` for bookmarks/hidden)
- `minTier?` (1–5, default `prefs.defaultTier`, or `prefs.feedMinTier` for `lane=all` with `feedId`, `folder` or
  `labelId`; applies to `for_you` and `maybe`, and to every row of `lane=all` in such a scoped view, D-248)
- `sort` ∈ `score | date` (default: `prefs.sort` for `for_you`; uncertainty order for `maybe`, spec 06 §10;
  `date` otherwise)
- `cursor`, `limit`

**Plan releases (D-257):** the server reads the user's stored plan and IANA timezone. A positive
`releaseIntervalS` (60..86400 seconds) sets local wall-clock boundaries, anchored at midnight; the
last interval ends at the next midnight. Beta uses 900 seconds; Free/Premium use the approved schedule
in `docs/design/plan-velocity.md`. Null/zero is immediate. Repeated DST boundaries release twice;
nonexistent boundaries are skipped. A timezone edit preserves the current release cutoff until at least
one full plan interval has elapsed and a boundary in the new zone occurs. Repeated edits cannot
advance it early or hide released arrivals. The display timezone changes immediately; next-update
metadata includes this transition hold. A changed plan cadence applies immediately. A client `asOf` is always capped at server time. Each carrier
must have `first_seen_at <= least(asOf, greatest(release_at, subscription.created_at + 15 minutes))`.
The grace cutoff keeps already visible grace articles visible after grace expires. Unsubscribe remembers
the original subscription start in per-feed preferences; normal and OPML re-subscriptions restore it,
so re-adding a feed or resetting its image policy does not renew grace. Feed merges keep the earliest
remembered start. The same predicate
applies to list/counts/badges/filter actions, calibration, detail/context/cluster members, individual
mutations, explicit analysis selection and card article inputs. Owned bookmarks remain accessible.
Automatic ranking alone does not grant article access. Ingestion and background analysis continue
at the shared arrival time. Client-signed pagination preserves its snapshot while current plan
rules still apply. No per-user release job or materialized article-copy is created.

**Semantics, in this order:**
1. **Candidate set:** distinct articles carried by the user's subscriptions (excluding `hidden`
   feeds unless `feedId` is given) whose **arrival** is `≥ asOf − 14 days AND ≤ asOf` (the fixed
   `RANK_WINDOW_DAYS` the ranker also uses, spec 06 §11). Arrival is the latest
   `feed_items.first_seen_at` among the user's subscribed carriers in the view's feed/folder scope,
   not the global `articles.first_seen_at`, so an older deduplicated article newly carried by a
   subscribed feed still appears.
   Apply `feedId`/`folder`/`labelId` scope **before folding**, using EXISTS predicates rather than
   fan-out joins. A feed/folder intersection with no owned subscription is empty. For
   `lane = bookmarks`: every personally bookmarked article, without window/subscription requirement;
   only owned labels and accessible feed metadata are exposed. Explicit bookmarks are not suppressed
   by ranking `hidden` or `archived_at` and are not folded together: each saved article is retrievable.
   `lane=hidden` is an explicit recovery view for window articles with `ua.lane='hidden'` **or**
   `archived_at IS NOT NULL`; it includes subscribed hidden feeds, does not fold and ignores minTier.
   Other scopes/access checks still apply. It is never included implicitly by `lane=all`.
   **Demand projection before lane/tier/folding:** intersect article carriers with this view's
   feed/folder scope, then test this user's active arrival policy or exact selection request. With
   no eligible carrier, project `lane='new', pLike=null, tier=null, scoreSource='none'` and
   `analysis.status='not_requested'`, suppress inferred card/demotion/label-suggestion effects and
   semantic-cluster folding; keep explicit read/rating/bookmark/manual-label/hide/mute state. Global
   view may use an eligible carrier; direct off-feed A stays neutral even if the user also has active
   feed B carrying the same article. A feed/folder view that keeps at least one eligible carrier
   shows the cached global score (spec 06 §6.4). A different user's authorization never qualifies. Counts,
   filtering and detail apply this same pure projection without starting model work (spec 06). The
   implementation evaluates it once per (view, article) in a `carrier` CTE (display feed, smallest
   in-scope carrier, and whether an active subscription carried the article at/after its activation)
   and decides each row's eligibility once; results are identical to a per-use evaluation (D-185).
2. **Cluster folding**, applied to the scoped candidate set before the lane filter:
   - An article is foldable if **any** subscription carrying it has `allow_duplicates = false`.
   - Foldable articles sharing a `story_cluster_id` collapse into one row: the member with the highest
     `p_like`, then the earliest `first_seen_at`, computed with
     `row_number() OVER (PARTITION BY story_cluster_id ORDER BY p_like DESC NULLS LAST,
     first_seen_at ASC, id ASC) = 1`. Hidden/archived articles are excluded before choosing a
     representative (except in bookmarks/hidden), so a hidden sibling cannot suppress visible stories.
     With `status=unread`, read members are excluded the same way, so a read sibling cannot hide
     unread ones: the best unread member represents the cluster, and spec 06's seen-story rule
     still caps a scored one at `everything`.
   - That row reports `cluster.size` as the number of the cluster's **accessible** members in this
     view's scoped candidate set (never the global `story_clusters.size`), and the other accessible
     members' feed titles. Hidden subscriptions and unrelated subscribers' private feed names are
     never returned.
   - Non-foldable and unclustered articles are their own rows.
3. **Filters:**
   - lane = `coalesce(ua.lane, 'new')`, where `all` means every lane except `hidden`; `hidden` is
     excluded outside the explicit bookmarks/hidden views
   - `status = unread` means `ua.read_at IS NULL AND ua.archived_at IS NULL` in ordinary lanes;
     bookmark/hidden views filter only `read_at` when explicitly requesting unread
   - `minTier` on `for_you`/`maybe` only (also when those lanes occur in `all`). Exception (D-248): in
     `lane=all` of a view with `feedId`, `folder` or `labelId`, `minTier > 1` keeps only rows with
     `tier >= minTier`, so `new` and tierless rows are hidden; `minTier = 1` keeps everything
4. Sort, then paginate.

`GET /articles/counts` accepts the same scope/status/minTier and `asOf` inputs (no cursor/sort).
It uses the same query builder and per-lane predicates as the list, so counts equal list totals
for the same dataset version. `bookmarks` is computed separately using bookmark-view semantics.
Folder/feed counts are scoped counts, not sums of globally folded lane counts.

**Outdated scores:** if any eligible row has a missing/stale `score_version` or `rank_revision`
(spec 06 §7), request a debounced incremental rank via the outbox (`user.rank {reason:'list'}`, deduplicated per
user, without advancing `users.rank_revision`: the rows are already outdated, and a bump from a read
would make every later read outdated again; the dirty set is exactly those rows). Taking only the
newest version would miss partially updated batches. No intent is written when a rank of the caller is
already on its way (`rank_covered()`: an undelivered `user.rank` intent without a cursor, or a
created/retry `rank:<user>` or `rank-full:<user>` job; D-186).
Serve existing scores immediately and return `rankingPending`.
Eligibility includes the user's inference-demand policy (§4.1). Plain untrained articles may remain
in New indefinitely with `rankingPending:false`; neither reading nor polling authorizes a model
call. Expose `analysis` below so the UI distinguishes deliberately untrained from queued processing.
- **Sort keys:**
  - score: `(p_like DESC NULLS LAST, first_seen_at DESC, id DESC)`
  - maybe: `(abs(p_like − 0.5) ASC, first_seen_at DESC, id DESC)`
  - date: `(coalesce(published_at, first_seen_at) DESC, id DESC)`

**Pagination under change:** the first page fixes `asOf` and returns `datasetVersion`, a digest of
the ordered eligible/folded ids and all mutable filter/sort fields, plus relevant user rank/settings
revisions. Evaluate the page and digest in one consistent read transaction. The signed cursor
contains these values. If the same query's digest differs on the next page, return
`409 STALE_CURSOR`; the client refreshes from page one and de-duplicates ids. This explicitly handles
reranking, cluster changes, read/label changes and unsubscribe without silent skips or repeats.
Do not promise an immutable reading snapshot while users are taking actions. Cap cursor validity
at 15 minutes; new articles after `asOf` appear on refresh.

**Response:** `{ items: ArticleListItem[], nextCursor, asOf, datasetVersion, rankingPending }`, where

```ts
ArticleListItem = { id, title, url /* string | null: linkless feeds are valid */,
  feed: {id, title, iconUrl} | null, author, publishedAt, firstSeenAt,
  excerpt /* ≤ 300 chars */, imageUrl, lang, lane, tier, pLike, topReason: TopReason | null,
  labelIds, labelSuggestions, rating, reason, readAt, bookmarkedAt, archivedAt,
  stateVersion /* decimal string, '0' when no user_article row */,
  contentRevision /* articles.content_revision, decimal string */,
  translationAvailable: boolean,
  analysis: {mode:'off'|'training'|'active', status:'not_requested'|'pending'|'running'|'complete'|'failed'|'cancelled', requestId:string|null,
             overDailyCap:number|null},   // D-252: the cap that kept an Active feed's arrival from automatic analysis
  mediaPolicyFeedId: string | null, effectiveImagesAllowed: boolean,
  bookmarkCapture: BookmarkCapture | null,
  cluster: { id, size, otherFeeds: string[] } | null }

TopReason =                                        // structured; the web client localizes it
  | { kind: 'card'; cardId: string; title: string; p: number }
  | { kind: 'rule'; code: string; ruleId?: string }
  | { kind: 'model'; feature: string; label: string }
  | { kind: 'keyword' }                            // degraded (BM25)
```

Select the display feed from the user's in-scope subscriptions deterministically (requested feed
first, otherwise smallest feed id), applying that user's title override. A bookmarked article with
no remaining source relation has `feed:null`; the UI shows "Saved article" rather than linking to
an inaccessible subscription. Optional metadata and `pLike`/`tier` for unscored items are explicitly
nullable in the DTO; clients must not coerce null probabilities to zero.

`topReason` is derived from `explain`:
- a fired floor or cap rule → `rule`
- otherwise, source `cards` → the deciding card (`explain.decidingCardId`)
- otherwise, source `model` → its top contribution
- otherwise, source `degraded` → `keyword`

`GET /articles/counts` → `{forYou, maybe, everything, new, bookmarks, hidden, scored, total, asOf,
datasetVersion, rankingPending}` using the requested status (default unread; bookmark badge counts
all saved items). `total = forYou + maybe + everything + new`; `scored = forYou + maybe + everything`.
These are visible reader counts, not engine-job progress: filtering, deduplication and actions can
change them. Onboarding must say "38 scored of 120 available", not claim that 38 jobs completed.
The opt-in `hidden` count is separate and excluded from `total`/`scored`, as bookmarks are.

`GET /articles/calibration` → `{ items: ArticleListItem[] }`: up to 10 unrated articles for the
calibration round (selection rules in spec 06 §10). Used by onboarding and the weekly "Tune your feed"
card.

### 5.2 `GET /articles/:id`

Optional `sourceFeedId` identifies the owned carrying feed whose reader view opened the detail;
validate it and apply the same demand/image policy as that view. For saved snapshots, use the
bookmark's captured origin. Omitting it uses §5.1's deterministic global-view display-feed selection,
never an arbitrary other user's feed.

Returns `ArticleListItem` plus:
- `excerptHtml`
- `bodyLead` (when available)
- `explain`
- `translation: {title, excerpt, engine, quality} | null`
- `clusterMembers: [{id, title, feedTitle, url}]`
- `bookmarkCapture: BookmarkCapture | null` and `bookmarkSnapshot: BookmarkSnapshot | null`

`404` unless the article is carried by one of the user's subscriptions **or** the user has bookmarked
it. Bookmarks of unsubscribed feeds stay readable.
The same access predicate applies to every action/example, including articles outside the 14-day
list window. `clusterMembers` includes only members independently accessible to this user; do not
leak global cluster membership. `excerptHtml` is sanitized server-side (spec 03); plain text and
translations are escaped by the client. Detail GET has no read/open side effect.

**Bookmarked full-content mirror:** `GET /articles/:id?view=saved` returns the immutable snapshot
bound to the caller's current bookmark; the default detail also includes its capture status. It
works after unsubscribe, publisher disappearance, source URL loss or later article edits. It never
silently substitutes the current publisher text for the saved version. `view=saved` without an
owned bookmark returns `404`; a pending/failed capture returns its truthful metadata and any retained
partial text, not a fabricated successful mirror.

```ts
BookmarkCapture = {
  status:'pending'|'saved'|'partial'|'failed', generation:string,
  snapshotId:string|null, capturedAt:string|null, errorCode:string|null
}
BookmarkSnapshot = {
  id:string, sourceUrl:string|null, title:string, author:string|null,
  publishedAt:string|null, capturedAt:string, contentRevision:string,
  completeness:'complete'|'partial', text:string, html:string|null,
  mediaPolicyFeedId:string|null, effectiveImagesAllowed:boolean
}
```

Persist the full safely captured article text/sanitized HTML indefinitely while any bookmark pins
the snapshot, and losslessly compress snapshots older than 30 days (specs 03/11). A feed teaser,
paywall, failed fetch or extraction limit yields `partial`/`failed` with a stable error code; never
claim a complete body that was not captured. Snapshot storage and exports exclude image/media
binaries, attachments, image data URLs and embedded media payloads; sanitized HTML may retain inert
remote-image references or descriptive alt text, never an embedded archived image. Text capture
completeness does not depend on excluded images. Decompression and streaming have bounded memory and
response-size checks; compression is invisible to readers/exports and cannot truncate text. All
snapshot access is authorized through the user's bookmark, never an unguessable snapshot id alone.

### 5.3 Actions (all `POST` unless a method is shown)

Single-article bodies additionally require `stateVersion` and `contentRevision` from the displayed
item; DELETE actions carry them as query parameters. A `contentRevision` other than the article's
current revision returns `STALE_STATE` rather than assigning feedback to content the reader did not
see. Bulk target objects carry both versions too. All use §1.1 and return
`200 {item: ArticleListItem, mutationId}` unless noted.
Saved-snapshot actions are the one exception to that live-revision check: they additionally send
`snapshotId` and are fenced against the snapshot instead. Validate that it is bound to the user's
current bookmark and that its captured revision matches `contentRevision`; a newer live article
revision then does not make the action stale (`stateVersion` is still checked). Record that snapshot
identity in the feedback event. Never substitute current-article features for an older snapshot's
text; unavailable matching features remain null and are excluded from training (spec 06).
When feedback belongs to a selected training request, rating/prompt-answer bodies additionally send
`analysisRequestId` (and bulk targets each carry their own optional id). Validate ownership, feed,
article/revision, frozen context and a currently released carrier (including after plan changes);
reject an unrelated/obsolete id, never silently choose the
"latest" request. Persist the association in the event as `feedback_events.value.analysisRequestId`,
which the worker's completion reads to record `user.learn` (D-73). Delayed features may attach only via that
specific request's frozen pre-feedback inputs (specs 05/06); unrelated live future analysis cannot
retrofit training evidence. A non-null rating or a prompt answer without a request id asks for the
article's analysis itself (D-238): in the same transaction, before the rating is applied, it reuses
a current request of the article on one of the user's training/active feeds or creates one as
`POST /subscriptions/:feedId/analyze` would (first training feed carrying it, else an active one),
and links it as if the client had sent its id. It asks for nothing for an off feed, an article an
active feed admits on its own, an article that changed since it was shown, or while classification
is not configured; the rating is kept either way.

| Endpoint | Body | Effect |
|---|---|---|
| `/articles/:id/read` | `{trigger?: 'expand'}` | Set `read_at` (expand in the list, when `markReadOnExpand`). The list's expand side effect sends `trigger:'expand'` and is recorded with `signalOrigin:'expand'` (spec 06 §8.2), never as an individual explicit read; the client can only weaken the recorded origin this way, never claim consent |
| `/articles/:id/unread` | `{}` | Clear `read_at` and `archived_at`, record `unread`; the cluster's members and the article's own row are made due (D-186) |
| `/articles/:id/unhide` | `{}` | Clear only `archived_at`, record `unhide`, preserve read/rating state and rerank. A Never card or block/mute rule may still hide it; expose that explanation rather than silently deleting the user's rule |
| `/articles/:id/open` | `{}` | Require a non-null safe original URL; otherwise `400 VALIDATION_FAILED`. Set `opened_at` and `read_at`, and record a `feedback_events` `open` (the user opened the original URL) |
| `/articles/:id/dwell` | `{ms}` | Integer 0..1,800,000; require a prior open (`409 CONFLICT`, `details.reason: 'not_opened'`), clamp to elapsed time since it. Set `dwell_ms = max(existing, ms)` and record `dwell`. Includes `prompt: boolean` from spec 06 §10; atomically set `feedback_prompted_at` when true so two tabs cannot prompt twice. Dwell is only a weak signal, never proof of reading |
| `/articles/:id/rating` | `{rating: 1 \| -1 \| null, reason?, hide?: boolean, analysisRequestId?, selection?: 'calibration'}` | Set explicit state, never toggle server-side. Reason enum is `off_topic\|clickbait\|seen\|shallow\|promo\|other`, allowed only for -1; null/+1 clears it. Null also clears `rated_at` and leaves read/archive state alone; only non-null ratings mark read if `markReadOnRate`. `hide:true` sets `archived_at`; false/absent does not clear it. Records `rate`/`unrate`, applies spec 06 §8.4. The response adds `exampleSuggestion: {cardId, side: 'yes' \| 'no'} \| null` from spec 06 §10; a non-null one is also stored in the `rate` event's `value`, where the suggestion limits count it. `selection:'calibration'` marks a rating of a calibration-round item; the event stores `selection: {method:'calibration', sourceLane}` (spec 06 §10) |
| `/articles/:id/prompt-answer` | `{liked: boolean, analysisRequestId?}` | Store as a rating (`rating = liked ? 1 : -1`, `rated_at = now`), record `prompt_answer`, and apply the learn trigger |
| `/articles/:id/bookmark` / `DELETE` of the same path | `{mediaPolicyFeedId?}` on POST; no body on DELETE | Set/clear bookmark and record the event. POST validates the chosen owned display feed, captures existing full trusted body transactionally or records pending status and a local capture intent. Return capture status immediately. Capture generation fences late completions after unbookmark/rebookmark; no inference demand is created |
| `/articles/:id/bookmark/retry-capture` | `{captureGeneration}` | Explicit local fetch/extraction retry for an owned partial/failed bookmark; keep the existing snapshot readable until a replacement is safely captured, then bind atomically. No paid classification/translation call → `202 {item, mutationId}` |
| `/articles/:id/labels` | `{labelId}` | Add to `label_ids`, remove from `label_suggestions`, record neutral organization only; no positive/negative preference-learning signal. **Cards are not changed** (spec 05 §5.1). Label examples are explicit (§7) |
| `DELETE /articles/:id/labels/:labelId` | — | Remove it, record `unlabel`, and make the article's own row due so its label suggestions can return (D-186) |
| `/articles/:id/mute-story` | `{days: 1\|3\|7\|30}` | Create a cluster for the article if it has none, create a `mute_story` rule with `expires_at` through the `POST /rules` path (§8: live-rule quota, an existing live mute of the story is returned with the later of both expiries), enqueue `user.rank {full}` → `201 {rule}` in the §8 rule shape. No reader fence: it changes no reader state |
| `/articles/mark-read` | `{targets: [{id, stateVersion, contentRevision}]}` **or** `{filter: {lane, feedId?, folder?, labelId?, minTier?, olderThan}, datasetVersion}` | Explicit targets ≤500; filter uses §5.1 query semantics with `status=unread` and an inclusive arrival cutoff (§5.1) captured when confirming. Materialize/lock the displayed representatives once; no later arrivals. Maximum 5,000 targets; reject an oversized set rather than silently truncate. A changed dataset returns `STALE_STATE`. → `200 {count, mutationId}` |
| `/articles/rate-bulk` | `{targets: [{id, stateVersion, contentRevision, analysisRequestId?}][1..200], rating: 1 \| -1 \| null}` | One transaction using single-rating semantics, per-item feedback snapshots and one coalesced learn/rank intent → `200 {count, mutationId, items}`. Explicit un-rate is supported; exact undo uses the endpoint below |
| `/articles/undo` | `{mutationId}` | Restore the original mutation's captured reader fields (§5.4) → `200 {count, mutationId, items}` |

**Row creation:** `user_article` rows are created on first action (upsert). All feedback writes also
append `feedback_events` with the event-time provenance required by spec 06 §8; capture learning
features only for eligible signals under that section's consent rules. Persist server-derived
`learningConsent` and `signalOrigin` in `value`, never trust these fields from a client;
retry replays append nothing. Do not let API upserts replace worker-owned ranking columns. Lock
ownership and expected-version checks in the same transaction. Label assignment/removal requires a
label held by the user; deleted/repointed labels must never be resurrected by an offline replay.
Reader actions (read, open, unread, mark-read, rate, prompt answer, bulk rate, unhide, unlabel,
undo) do not advance `rank_revision` or record a full rank: they mark only the rows whose ranking
can differ (`user_article.next_rank_at`, the one ranking column the API role may write) and enqueue
one incremental, debounced rank (a full rank only for an automatic demotion flag flip or a
mark-read of more than 2,000 targets; D-186). Other rank-relevant mutations (cards, rules,
preferences, subscriptions) advance the user's `rank_revision` and enqueue rank/learn effects per spec 06. Cluster actions never mark every sibling read implicitly; the seen-story rule
and folding provide deduplication.
These effects must obey §4.1: a thumbs-up, label, bookmark, open or dwell never implicitly enables
subscription inference. Neutral labels do not trigger positive personal-model training. With
`implicitFeedback:false`, `/dwell` returns the current item with `prompt:false`, without storing
behavioral telemetry or changing state; clients do not send it. Necessary read/open state still
works, but it is not used as inferred preference evidence while disabled. Explicit ratings work
independently of that preference. Changing behavioral-consent preferences invalidates incompatible
personal models and queues learning from still-eligible evidence as specified in spec 06 §8;
enabling them never retroactively opts old events into learning.

### 5.4 Exact undo

The mutation receipt stores the target ids, affected reader fields' **before** values and resulting
state versions for read/unread/unhide/rating/bookmark/label and bulk actions. Undo is accepted for 10 minutes
after commit only if the receipt belongs to the user, has not already been undone and every target
still has the receipt's resulting state version. A receipt without undo data (open, dwell, mute-story,
a no-op) is `409 CONFLICT` with `details.reason: 'not_undoable'`; another user's or an unknown
receipt is `404`. It restores only fields changed by that action,
increments state versions, records an `undo` event referencing the original mutation and requests
the same rank/learn invalidation, recomputed from the restored state (new receipts do not store `effects.rankFull`; an older receipt that has it still undoes and the value is ignored, D-203). It never writes old ranking-cache fields or fabricates a rating.
An intervening device action/deleted label/inaccessible article returns `409 STALE_STATE` atomically;
the client refreshes and explains that newer changes were kept. This restores pre-existing ratings,
reasons, read state and SHIFT-hide correctly. Undo of a bulk mutation is one atomic operation, not
hundreds of independent requests. Receipts themselves are private, excluded from ordinary exports,
purged after their retention and inaccessible to other users.
Bookmark undo also restores the prior snapshot binding/origin where still retained and advances the
capture generation; late capture jobs cannot attach to an undone save. The unbookmark mutation pins
exactly the snapshot that `clear_bookmark_snapshot` returned in the same transaction (spec 02 §6); no
client or route supplies a snapshot ID. Snapshot GC retains pins
needed by still-valid undo receipts, so undo does not refer to content already deleted.

---

## 6. Plans and quotas

The `plans` table is the source of truth (D-255, migration 0029); `packages/shared/src/plans.ts`
holds only the shape and validation. Quota checks and `GET /me` read it on each request. These are
the seeded allowances; Admin → Plans can change them without a restart:

| Limit | `beta` | `admin` |
|---|---|---|
| `maxFeeds` | 200 | 2,000 |
| `maxCards` (interest cards incl. never) | 150 | 500 |
| `maxLabels` | 20 | 200 |
| `maxForks` (private cards) | 20 | 200 |
| `maxRules` | 200 | 2,000 |
| `opmlMaxFeeds` (per import) | 300 | 2,000 |
| `minFetchIntervalS` | 900 | 300 |
| `backfillDays` | 7 | 14 |
| `invitesOnSignup` | 3 | 50 |

The seed also includes `free` (21600 s), `basic` (3600 s), `plus` (1800 s), `pro` (600 s), `max`
(300 s), and `premium` (60 s), with beta's other allowances. `beta` remains the signup default.
Plans have an immutable key, English and optional Slovak labels, `sortOrder`, a version and an
optional retirement timestamp. Exactly one active plan is the signup default; signup reads its key
and invite allowance together. `users.plan` references `plans.key`. A referenced or default plan
cannot be deleted. Retirement prevents new assignments and preserves current users.
`releaseIntervalS` controls article visibility (§5.1), independently of the shared fetch floor.
The seeded beta/admin/Free–Premium release intervals match their fetch floors (900/300/21600/3600/
1800/600/300/60 seconds). Admin may choose null/zero for immediate visibility, or 60..86400 seconds.
The scheduler supports a 60-second floor; shared source protection and publisher hints bind every tier.

- Exceeding a limit → `409 QUOTA_EXCEEDED {limit, used, max}`.
- `feeds.min_interval_s` = the minimum of `minFetchIntervalS` over the feed's subscribers. It is
  recomputed on subscribe/unsubscribe, plan changes, account deletion/restoration and purge; deleted
  users do not contribute. Editing a plan recomputes only feeds with a live subscriber on that
  plan (`refresh_plan_feeds`); changing a user's plan recomputes only that user's feeds
  (`refresh_user_feeds`). When the resulting floor drops, the next fetch is pulled forward to at most
  `coalesce(last_fetch_at, now()) + floor`; no change pushes it later. Reducing a plan does not silently delete data: existing over-quota rows
  remain readable/deletable, while additions exceeding the new limit are blocked.

---

## 7. Cards, library, suggestions, labels

```ts
Card = { id, kind: 'interest', title /* title_override ?? localized card.title */, titleOverride,
         interest, notFor, strength, scopeFeedId, origin, isPrivateFork, examplesYes, examplesNo,
         topicIds, lang, librarySlug, createdAt }
Label = { id /* card id */, name, color, definition, notFor, examplesYes, examplesNo, count /* articles labelled */ }
```

Library cards are localized to the user's locale from `i18n`: `GET /library` and suggestions show
the localized title and interest; a held card (`Card`) shows the localized title only, because its
interest is the stored text an edit starts from. Cards are **immutable** (spec 05 §5.1),
so every endpoint that changes text or examples returns the card with its possibly **new id**. The web
client must replace its cached id.

| Endpoint | Body | Behaviour (spec 05 §5.1) |
|---|---|---|
| `GET /cards` | — | The user's interest cards |
| `POST /cards` | `{title?, interest, notFor?, strength, scopeFeedId?, replaceCardId?}` | Create or reuse → `201 {card}`. Quota `maxCards`; with `replaceCardId` the user's holding of that card is removed first in the same transaction (404 when not held; a failed create keeps it, D-242) |
| `PATCH /cards/:id` | `{title?, interest?, notFor?, strength?, scopeFeedId? \| null}` | `title` only sets the user's override. `interest`/`notFor` re-point to another card (new id) |
| `DELETE /cards/:id` | — | Remove from the user |
| `POST /cards/:id/examples` | `{articleId, side: 'yes' \| 'no'}` | Add the article title as an example (private fork, new id) → `{card}`. Quota `maxForks` |
| `POST /cards/:id/examples/remove` | `{side, text}` | Remove an example (new fork id) → `{card}` |
| `POST /cards/from-article` | `{articleId, moreArticleIds?[0..4], interest, notFor?, title?, strength, replaceCardId?}` | Shared text card plus a private fork with the article titles (`articleId` first) as `examples_yes` → `201 {card}`. Quotas `maxCards`, `maxForks` |
| `GET /cards/usage` | — | Per held card, the distinct articles the user rated +1 in the last 90 days that the card answered (current revision, not the prefilter) with `p ≥ lanes.maybe` → `[{cardId, likedMatches}]` (D-242; orders the swap list) |
| `POST /cards/drafts` | `{articleIds[1..5]}` (distinct, each visible to the user as for from-article) | Record a card draft and its `card.draft {draftId}` intent → `202 {id, status: 'pending', title: null, interest: null, source: null}`. Drafts older than a day are removed first (D-240) |
| `GET /cards/drafts/:id` | — | Own draft only → `{id, status: 'pending' \| 'complete' \| 'failed', title, interest, source: 'llm' \| 'fallback' \| null}`; `title` may be null on a complete draft |
| `GET /library` | `?topic=&q=&cursor=&limit=` | Current public cards (`visibility = 'public'`, not retired, not an older library version), localized, ordered by L1 topic then id, in the paginated envelope; each carries `l1TopicId`, `version` and `held` |
| `POST /library/:id/adopt` | `{strength, scopeFeedId?, replaceCardId?}` | Hold a library card. A superseded library version is `409 CONFLICT {reason: 'superseded'}` (D-39). Quota `maxCards`; with `replaceCardId` the user's holding of that card is removed in the same transaction first, as in `POST /cards` (D-249) |
| `GET /library/updates` | — | Available immutable semantic successors for the user's library holdings: `[{currentCardId,newCardId,librarySlug,fromVersion,toVersion,diff,hasPrivateCustomization}]`. Private forks receive advisory notices only |
| `POST /library/:id/updates/:newId/apply` | `{expectedCurrentCardId}` | Explicitly accept a validated successor for an unchanged held library card; replace the holding, retain strength/scope/display override, refresh authorized demand and invalidate answers by new identity → `200 {card,idChange}`. Custom/private forks require the explicit editor; never overwrite their examples |
| `GET /cards/publication-requests` | — | Requests addressed to this original creator, with exact card text, proposed title/translations/topics, payload digest, version and status |
| `POST /cards/publication-requests/:id/respond` | `{decision:'approve'\|'decline',expectedVersion}` | Creator-only CAS approval/rejection of the exact publication payload; no public publication yet → `200 {request}` |
| `GET /cards/suggestions` | — | `[{card, score}]`: not dismissed, produced by the active `suggest` set under the current Jev model pin (suggestions never use the LLM fallback), and never a card the user currently holds as an interest card or label (for example after adopting it from the library or creating it again) |
| `POST /cards/suggestions/:cardId/dismiss` | — | `204` |
| `GET /labels` | — | `Label[]` |
| `POST /labels` | `{name, definition, notFor?, color?}` | Create or reuse a label card (kind `label`; the hash includes the name) plus `user_labels` → `201 {label}`. Quota `maxLabels` |
| `PATCH /labels/:id` | `{name?, definition?, notFor?, color?}` | `color`, and a name that changes only in case or spacing, change in place (D-36). Otherwise a name or definition re-points to a new card id, and `label_ids`/`label_suggestions` are migrated with `array_replace` |
| `POST /labels/:id/examples` | `{articleId, side: 'yes' \| 'no'}` | Add a label example (private label fork, new id, ids migrated). Not counted in `maxForks` |
| `POST /labels/:id/examples/remove` | `{side, text}` | Remove one (new id, migrated) |
| `DELETE /labels/:id` | — | Remove the label, and remove its id from the user's `label_ids`/`label_suggestions` |

`GET /topics` → the taxonomy (id, parent, names, level) for the web client.
Create routes return `201 {card|label, idChange: null, translation}`; PATCH/adopt/example/update routes
return `200 {card, idChange, translation}` or `200 {label, idChange, translation}` with the final id,
where `translation` is the non-blocking card-text status of spec 07 §5 (`null` when no new text was
submitted or the answer is a receipt replay); deletes return
`204`. `notFor:null` clears the field; `scopeFeedId:null` means all feeds. Fork/re-point transactions
return `idChange: {from, to} | null` so queued client references can be reconciled. A stale old id
not currently held by the user returns `404`; it must not create another implicit holding. Quotas
count resulting distinct holdings/forks, not historical retired rows. Label colour is a validated
hex value, never arbitrary CSS (`#64748b` when omitted, D-42); text/example length and count limits come from spec 05.
An example or card made from an article needs the article to be carried by one of the user's
subscriptions or to be on their reading list (otherwise `404`); an article without a usable title is
`400 VALIDATION_FAILED {reason: 'no_title'}` (D-39). A label re-point or delete increments
`user_article.state_version` only on rows whose `label_ids` change, never for `label_suggestions`
alone (D-41).

Shared text-only card deduplication is approved; it does not identify a later adopter as the original
creator or disclose who holds the card. Public promotion is a separate consent flow (§9). A library
semantic update is a new immutable version: existing holders keep their current meaning until they
explicitly apply it or create an edited/private fork through the existing lifecycle. New answers and
models must use the accepted version, and no bulk background migration may replace private examples.
Labels are neutral organization in every endpoint and UI: assigning a label neither likes the article
nor grants permission to analyze other articles.

---

## 8. Rules

| Endpoint | Body | Behaviour |
|---|---|---|
| `GET /rules` | — | `[{id, kind, value, displayValue, createdAt, expiresAt}]` |
| `POST /rules` | `{kind, value, expiresInDays?}` | Validate `value` per kind (feed id owned by a subscription, cluster id of a story carried by a subscription or on the reading list, domain syntax stored as its registrable domain, keyword 2–100 chars). `mute_story` requires `expiresInDays` ∈ {1, 3, 7, 30}, as `/articles/:id/mute-story` does; other kinds may omit it. A live rule of the same kind and value is returned instead of a second one, keeping the later expiry. Quota `maxRules` counts live (unexpired) rules. Enqueue `user.rank {full}` → `201 {rule}` |
| `DELETE /rules/:id` | — | Delete, rank full → `204` |

---

## 9. Admin (`role = 'admin'`; prefix `/admin`)

| Endpoint | Purpose |
|---|---|
| `GET /admin/overview` | users (total, active 7 d), feeds by status, articles ingested today, pipeline backlog per queue, engine status (breakers, spend today vs budget, LLM calls today), translation stats. Budget and caps are the effective settings; where a key is unset, the API reports the registry default, because worker-only env such as `DAILY_BUDGET_USD` is not API configuration |
| `GET /admin/usage?days=30` | platform $/day by engine and kind (from `usage_daily`), and the top 20 users by attributed cost via `admin_usage_attribution(days)` (spec 02 §6, spec 04 §7) |
| `GET /admin/settings` / `PATCH /admin/settings` | Allow-listed keys only (spec 02 §2 registry): `engine.daily_budget_usd`, `engine.llm_daily_cap`, `engine.prefilter_enabled`, `engine.laya`, `language_modes`, `card_text_mode`, `ranker.thresholds`, `translate.tier2_daily_cap`, `question_sets.active`, `signup_mode`, and the fourteen runtime keys of spec 02 §2 (`engine.typesafe_model`, `engine.typesafe_base_url`, `engine.typesafe_price_per_mtok_usd`, `engine.concurrency`, `engine.llm_fallback_enabled`, `engine.ollama_models`, `engine.ollama_base_url`, `engine.ollama_max_concurrency`, `engine.prefilter_min_cards`, `ingest.max_age_days`, `engine.auto_analysis_daily_cap`, `fetch.limits`, `api.rate_limits_enabled`, `translate.libretranslate_url`). Each key is validated by its zod schema. **Side effects:** `ranker.thresholds` bumps `ranker.settings_version` and enqueues `user.rank {full}` for users active in the last 7 days, plus `user.learn` for those same recently active users when `strengthWeights` or `model` changed (spec 06 §8.4; the API cannot read other tenants' `user_models` under RLS, and the handler trains only when a user's model context or eligible samples changed); `question_sets.active.enrich` enqueues `house.reenrich`; `question_sets.active.match`, any `card_text_mode` change and any `engine.prefilter_enabled` change enqueue `house.rematch` (spec 05 §2); `card_text_mode = 'english'` also enqueues `house.translate-cards`, which translates missing cards and rematches them as their translations publish; `language_modes` changes enqueue `house.reenrich {lang}` for each language whose stored mode changed (the seed stores the initial modes, spec 02 §2), and `question_sets.active.cluster`/`.suggest` apply prospectively (spec 05 §2); each language added to or removed from `engine.laya` enqueues `house.reenrich {lang}`, because its enrich engine changes (spec 04 §9); `engine.prefilter_enabled` and `engine.laya` are set only after the recall validation (spec 05 §5.5) or replay (spec 10 §6) they require (an operator procedure; the API cannot verify it); a non-empty `engine.laya` is also refused unless `settings['worker.heartbeat']` has an entry younger than 90 s consuming both `.laya` queues, so producers never route work that nothing consumes (spec 11 §2). Likewise, a `language_modes` value of `translate` or `card_text_mode = 'english'` is refused unless a bounded API probe of `GET {LIBRETRANSLATE_URL}/languages` lists every language it needs (spec 11 §2): `{lang}→en` for each language newly set to `translate`, and for `card_text_mode = 'english'` every non-English `language_modes` language `→en`; the pairs are rechecked against the probe inside the settings transaction. A failed probe answers `503 ENGINE_UNAVAILABLE` with `details {engine:'libretranslate', reason, missing}`. The `PATCH` answer is the `GET` body plus `changed` (the keys whose value changed) and `queued` (the house queues it stored work for, of `house.reenrich`, `house.rematch` and `house.translate-cards`, from the server's comparison with the stored values; per-user `user.rank`/`user.learn` intents are not listed), so a screen follows exactly the work its save started (D-232) |
| `POST /admin/translations/reprocess` | `{reasons?: ('no_key'\|'cap'\|'budget')[]}` (default all three): enqueue `house.retranslate-skipped` → `202 {queued: true}`. The only retry for a tier-2 translation skipped on an unchanged article revision, used after the Ollama key, cap or budget is restored (spec 07 §3) |
| `POST /admin/engine/reset-breaker` | `{engine}`: writes `engine.circuit.resetRequested[engine] = now`. Worker routers close that breaker (including auth mode) within 10 s (spec 04 §5) |
| `GET /admin/engine/credentials` | Metadata-only configuration status for `typesafe` (Jev) and `ollama`: `CredentialStatus[]`; never plaintext, ciphertext, key suffix or reversible secret material |
| `PUT /admin/engine/credentials/:provider` | `{apiKey,expectedRevision}`. Encrypt and stage a candidate, preserving the active credential; save alone makes no provider call → `200 {credential:CredentialStatus}` |
| `POST /admin/engine/credentials/:provider/validate` | `{candidateVersion,expectedRevision}`. Explicitly authorize the bounded capability/auth probe via `provider.validate`, respecting budget/accounting → `202 {credential:CredentialStatus}` |
| `POST /admin/engine/credentials/:provider/activate` | `{candidateVersion,expectedRevision}`. Require a successful validation for this exact candidate/model/config, atomically activate and invalidate router credential caches → `200 {credential:CredentialStatus}`. The API checks the exact candidate version, `valid` status and a validation at most 24 h old (`admin_activate_provider_credential`); it cannot compare the endpoint/model fingerprint, because the provider endpoint/model configuration is worker-only env, so that comparison stays with the worker CLI |
| `DELETE /admin/engine/credentials/:provider` | Query `expectedRevision`; disable provider and erase stored active/candidate envelopes. Retain a disabled tombstone so env fallback cannot silently re-enable it → `200 {credential:CredentialStatus}` |
| `GET /admin/feeds?status=&q=` / `PATCH /admin/feeds/:id` / `POST /admin/feeds/:id/reset` | Feed health; edit `fetch_options`; clear quarantine/dead |
| `GET /admin/library/candidates?minHolders=3` | Promotion candidates: all non-retired `shared` interest cards, with holder counts from `admin_card_holders` (spec 02 §6), filtered to `holders ≥ minHolders`, sorted by holders descending, at most 100 |
| `GET /admin/library` / `POST /admin/library` / `PATCH /admin/library/:id` | Manage library metadata; semantic text changes create a new immutable library version with predecessor identity (spec 05), never replace existing holders' text/examples. Every returned card carries `publication: {requestId, authorizationKind, promotedAt} \| null`: the authorization basis and audit time of the promotion that published it from a user's shared card (spec 09 §8), `null` for a card created in the library or a new version. Every returned card also carries `latestVersion`: the newest version of its slug (`null` for a card that is no library version), so a client knows an older version on any page, although only the newest version holds the slug |
| `POST /admin/library/promotion-requests` | `{cardId,title,titleSk?,topicIds,slug?}`. Require shared card and ≥3 holders (checked by the API itself) and known topics; create a versioned exact-payload request addressed to its original creator → `201 {request}`. The proposed `slug` defaults to `<slugified title>-<cardId>` and is part of the disclosed payload |
| `POST /admin/library/promote` | `{requestId,expectedVersion}`. Require shared card with ≥3 holders and either exact creator approval or audited ≥30-day creator inactivity (§9.2); recheck under lock and publish preserving unchanged text/id/answers; the same transaction records the promoted card as version 1 of its payload slug (`admin_publish_library_card_version`). Decline, recent unapproved activity or missing/deleted provenance → `409 CONFLICT` |
| `GET /admin/plans` / `POST /admin/plans` | Sorted plans with all allowances and reference counts; create a new key → `201 {plan}` (duplicate → `409`) |
| `PATCH /admin/plans/:key` | `{expectedVersion, ...changedFields}`: labels, typed limits, sort order, retire/restore. Stale version → `409 STALE_STATE`; default cannot retire. Recomputes affected feed intervals when needed |
| `POST /admin/plans/:key/default` | Make an active plan the signup default atomically; versions of both affected plans advance |
| `DELETE /admin/plans/:key` | Delete an unused non-default plan → `204`; default or referenced → `409` |
| `GET /admin/users?q=&plan=` / `PATCH /admin/users/:id` | Role, plan, `invites_left` → `200 {user, sessionsRevoked}`. A stored plan key is required; retired plans are refused unless already current. A plan change recomputes only that user's feeds via `refresh_user_feeds` and pulls faster fetches forward |
| `GET /admin/invites?status=unused\|used\|expired` / `POST /admin/invites` | List all invites; create `{count ≤ 50, email?, note?, expiresDays ≤ 90}` → `201 {items: Invite[], emailSent?}`. An `email` binds the invite, requires `count` 1 and sends the §2.2 invite email |
| `GET /admin/waitlist` / `POST /admin/waitlist/:id/invite` | Create an invite bound to that email, set the row's `invited_at` and `invite_code`, and email it in the entry's locale (§2.2 invite email) → `200 {entry, invite, emailSent?}`. `emailSent` reports this request's delivery; a replayed receipt omits it and never re-sends |
| `POST /admin/ops-event` | `{kind: 'backup_ok' \| 'backup_failed' \| 'restore_ok' \| 'restore_failed' \| 'host_health', detail?}`. `host_health` uses spec 11's bounded structured disk/inode/heartbeat payload, plus `containers: {<compose service>: {restarts, oomKilled}}` (at most 16 services). Authenticated with the `METRICS_TOKEN` bearer and exempt from the CSRF header (§1); used by the host scripts in spec 11 §4. It appends to `settings['ops.events']` (the last 50 kept), which `house.alerts` reads → `201 {kind, at, stored}`; `host_health` detail is stored as canonical JSON text (≤2000 characters) |

**Admin write constraints:** validate every field with the shared schemas; no arbitrary JSON-to-SQL
updates. Feed fetch options use spec 03's allowlist and may not disable SSRF checks or smuggle auth
headers. User role is `user|admin`, plan is a defined plan key and invites_left is a nonnegative
bounded integer. Prevent accidental removal of the last active admin; revoke affected sessions on
role downgrade, recompute feed intervals on plan changes, and record actor/target/changed keys in
the audit log without secrets. Card promotion cannot bypass the sharing/consent policy (PLAN §17).
Settings patches validate the **merged** configuration, lock/version the settings rows and commit
all side effects through the outbox. Setting unchanged values is a no-op. Activating question sets
must validate existence/kind and apply spec 05's cache-invalidation/backfill policy for every changed
kind; the abbreviated table is not permission to activate a set without its lifecycle effects.
Admin queries default to 30 rows, limit at 100, validate `days` 1..90 and search `q` length ≤200.
Each admin route's complete request/success/error DTO is part of its implementation task and OpenAPI
contract, including explicit empty results; generic `any`/unbounded JSON is not an acceptable DTO.

**Runtime settings (M8b).** `GET /admin/settings` returns, besides `values` and `stored`:
`sources` (`{[runtimeKey]: 'env'|'stored'|'last_good'}`), `defaults` (the env value of each runtime key, or
`null` when no process can tell: the API knows its own, workers report theirs in `worker.heartbeat`
`runtime.defaults`) and `workers` (`[{processId, at, pendingRestart, problems}]` for heartbeats younger than
90 s). The effective value of a key is the valid stored row, else (for a row that no longer validates) the
last good value this API process saw, else the default (D-219); `values` and `defaults` show any value the
environment accepts (spec 02 §2 lists the wider env ranges), while a `PATCH` keeps the narrower write bounds (D-226). A `PATCH` takes `null` to reset a runtime key
and an optional `acknowledge: boolean`. Rules:

- A runtime value is validated by the shared rules (spec 02 §2; in production https URLs on
  `PROVIDER_HOST_ALLOWLIST`, a pinned `engine.typesafe_model`, a price above 0, Ollama models with a price).
  A failure answers `400 VALIDATION_FAILED` with `details {key, message}`.
- Changing `engine.typesafe_model`, `engine.llm_fallback_enabled`, or `engine.ollama_models` while the fallback
  is on re-enriches and re-matches the corpus (spec 11 §8), so without `acknowledge: true` the PATCH answers
  `409 CONFLICT` with `details {reason: 'confirmation_required', effects: ['reenrich', 'rematch']}`. A value
  that does not change the effective value needs no acknowledgement.
- A changed `translate.libretranslate_url` triggers the `GET /languages` probe above against the **new** URL
  for the pairs the current `language_modes`/`card_text_mode` need (`503 ENGINE_UNAVAILABLE`, also
  `reason: 'not_configured'`); pairs are rechecked inside the transaction (`409 settings_changed` on a race).
- A changed `engine.prefilter_min_cards` enqueues `house.rematch` while `engine.prefilter_enabled` is on.
- The API applies the live values itself: its settings cache (TTL 10 s, invalidated by a PATCH it served)
  drives `api.rate_limits_enabled`, `fetch.limits` for discovery and OPML, the LibreTranslate client and the
  Jev model it freezes into analysis requests until a pin exists. Workers apply theirs by the live/restart
  split of spec 02 §2.

### 9.1 Provider credentials

```ts
CredentialStatus = {
  provider:'typesafe'|'ollama', source:'none'|'env'|'db', enabled:boolean, revision:string,
  activeVersion:string|null, candidateVersion:string|null,
  candidateStatus:'pending'|'validating'|'valid'|'invalid'|null,
  validatedAt:string|null, capabilities:ProviderCapabilities|null, lastErrorCode:string|null
}
```

`GET /admin/engine/credentials` returns `{items: CredentialStatus[], keyring}` with
`keyring = {api: {status, activeKeyId?}, workers: [{workerId, status, activeKeyId?}], mismatch: boolean}`;
`status` is `ok | missing | malformed | active_key_missing` and no key material is ever returned. `workers`
lists heartbeats younger than 90 s (`runtime.keyring`); `mismatch` is true when the API's keyring is `ok` and a worker reports an
`ok` keyring with another active key id. Staging a key while the API's keyring is not `ok` answers
`503 ENGINE_UNAVAILABLE` with `details {reason: 'keyring_unavailable'}`.

`source` is `db` when the provider has a credential row (a disabled tombstone included). Otherwise it
is `env` when a `settings['worker.heartbeat']` entry younger than 90 s lists the provider in
`envCredentials`, else `none`. The API never receives the env keys themselves (spec 01 §3).

Provider keys belong to the administrator's actual Jev/Ollama accounts; no separate organization
account is required. These are deployment credentials, not per-reader keys. The encrypted DB store,
keyring recovery and validation/rotation contract are in specs 01/02/04. API credentials endpoints
are admin-only, same-origin/CSRF protected, CAS and idempotent. Secret-bearing PUT bypasses generic
request-body logging/tracing/capture: retain only a versioned keyed request digest for duplicate
detection and the metadata response in `api_mutations`. Never persist the request body in receipts,
outbox payloads, errors or exports. Encryption and decrypt capability remain separate from normal
tenant DB reads. `provider.validate` carries only provider/candidate version; the worker resolves the
encrypted secret through its narrow credential path. A stale probe result cannot validate/activate
a newer candidate; failed validation leaves the previous active key untouched. DELETE disables local
use only; the UI explains that upstream account revocation is done in the provider account itself.

### 9.2 Public-card approval

Internal reuse of identical text-only cards is approved. The request must disclose the exact proposed
public text/title/translations/topics to the **original creator**. An administrator may promote a
shared card with at least three holders on either of these distinct authorization bases:

- `creator_approval`: affirmative, version-specific creator approval of the exact current payload.
- `creator_inactive_30d`: the known, existing creator has been inactive for **at least 30 days**,
  measured from `last_active_at`, or that creator's `created_at` when last_active_at is null. The
  absence of a reply is not recorded as approval. The administrator makes the promotion explicitly;
  reaching 30 days does not publish anything automatically.

With less than 30 days' inactivity, exact creator approval is required. An explicit decline vetoes
promotion on the inactivity basis; creating a new request/version cannot erase that veto. Only a
later affirmative creator decision may supersede it. Missing/deleted or ambiguous creator provenance
remains held, and another holder's approval/activity cannot stand in for the original creator.

The promotion transaction locks and rechecks the request, current card/payload, original creator's
activity and any applicable decline. A return to the service resets the inactivity clock: the age of
the request, email or notification alone never establishes eligibility. Store `authorization_kind`
(`creator_approval` or `creator_inactive_30d`), the evaluated activity timestamp/source, checked-at
time, exact payload/version, authorization-policy version, and promoting administrator in the audit
ledger (specs 02/05). Inactivity
publication does not synthesize `approved`/`responded_at` or a fictitious creator response.

Admin request/candidate DTOs expose current `promotionEligibility` (basis or held reason) and, once
published, `authorizationKind` and sanitized audit evidence. Eligibility displayed before the click
is advisory; a concurrent creator return/decline can make promotion fail with `409 CONFLICT`.
Any text/publication-payload change invalidates earlier approval and requires a new version and a
fresh authorization check. Promotion is idempotent. Ordinary library adoption does not change
creator provenance or consent records. Seeded administrator-authored library cards follow their own
authorship policy, not a forged user approval.

---

## 10. Health and metrics

- `GET /healthz`: liveness, always `200` while the process runs.
- `GET /readyz`: `200` if the DB is reachable and every migration the release bundles is applied (newer ones from a later release are fine, so a rollback over the expanded schema is ready, D-207), otherwise `503`.
- `GET /dev/last-email`: **only when `NODE_ENV=test`** (the route is not registered otherwise). Returns the last email captured by `MAIL_TRANSPORT=log`, for E2E tests.
- `GET /metrics`: Prometheus text, protected by an admin session **or** a `METRICS_TOKEN` bearer.
  - Counters and histograms: HTTP requests, latency, errors by code.
  - The worker exposes its own `/metrics` on `WORKER_METRICS_PORT` (default 9101): queue depths,
    engine calls by status, spend, fetch outcomes, extract outcomes.

---

## 11. Rate limits (API hooks over `rate_limit_hit()`, D-120; keyed as noted)

| Route group | Limit |
|---|---|
| everything, per IP | 300 / min |
| `POST /auth/request-code` | 5 / hour per email, 20 / hour per IP |
| `POST /auth/verify` | 10 / 10 min per IP |
| `POST /waitlist` | 5 / hour per IP |
| authenticated mutations, per user | 120 / min |
| `POST /subscriptions` | 30 / hour per user |
| `POST /subscriptions/import-opml` | 5 / day per user |
| `POST /subscriptions/:feedId/analyze` | 20 / hour per user; maximum 20 explicitly selected article revisions per request |
| `POST /articles/:id/bookmark/retry-capture` | 20 / hour per user, plus safe-fetch host limits |
| Provider credential stage/validate/activate/delete | 20 / hour per admin; validation additionally obeys shared engine admission |
| `POST /admin/ops-event` | 30 / min per IP |
| `POST /setup/complete` | 10 / 15 min per IP; every attempt counts, a wrong token included (D-213) |
| `GET /me/export` | 2 / hour per user |
| `POST /cards/drafts` | 30 / hour per user (each may cost one LLM call, D-240) |
| `POST /cards`, `POST /cards/from-article`, `PATCH /cards/*`, `POST /cards/*/examples*`, `POST /labels*`, `PATCH /labels/*` | 60 / hour per user, one shared bucket (each may trigger backfills) |

All limits are enforced unless rate limits are disabled: `api.rate_limits_enabled` if stored, else
`RATE_LIMITS_ENABLED` (spec 01 §3). The env value `false` is accepted with `NODE_ENV=test` only (E2E and
load tests); config validation rejects it in production. In production the setting `false` turns off only
the general limits (global per-IP, per-user mutation, per-route quotas); the unauthenticated groups
`auth-request-code`, `auth-verify`, `waitlist`, `setup-complete` and `ops-event` stay on (D-222).
Only Caddy's known internal proxy address/network is trusted for forwarded IP headers; never
`trustProxy: true` for arbitrary clients. The API trusts loopback and the RFC 1918 private ranges of the compose
network, whose API port is not published elsewhere (D-121). Limits are shared across API processes and restarts through
the DB-backed limiter: `rate_limit_hit()` over `rate_limit_buckets` (spec 02 §6), cleaned up by
`house.purge-auth`.
Send `Retry-After` for 429. Public waitlist upserts never expose whether an address already exists.
Every limited response carries `X-RateLimit-Limit` (the tightest applicable maximum); a 429 adds
`Retry-After` and `X-RateLimit-Reset` in seconds. `X-RateLimit-Remaining` is not sent, because
`rate_limit_hit()` reports only whether a hit is allowed and when to retry (D-120).

---

## 12. Tests

- **Route tests** with `fastify.inject` against the integration DB:
  - every endpoint's happy path and validation failure
  - auth flows: login, signup with an invite, invite-only rejection email, code expiry, attempt limit
  - quotas
- **The RLS isolation suite:** seed users A and B, then call **every** GET endpoint as A and assert
  that nothing of B's appears. This includes cards (shared rows with private forks), labels, rules,
  bookmarks and exports.
- **CSRF:** a mutation without `X-Bantoozi-Client` returns `403`.
- **Snapshots:** the OpenAPI document (a breaking change fails CI unless the snapshot is updated in
  the same commit).
- **Operation list:** `apps/api/test/expected-operations.txt` lists every `METHOD /path` of this spec
  (one per line, written by hand from §2–§10). A test asserts that the OpenAPI document contains exactly
  these operations, plus nothing undocumented.
- **Write-path grants:** every mutation endpoint succeeds against a database where the API connects as
  `bantoozi_app`. This catches missing grants (spec 02 §1.2).
- **Enqueue:** an integration test proves the API role can persist its job intent and the relay can
  deliver it to pg-boss, and that the admin
  bootstrap row of the §2.1 decision table works with an empty `invites` table.
- **Race/replay tests:** two verifies of one code yield one success; attempts persist after invalid
  verification; two invite uses/last quota-slot requests cannot both succeed; concurrent duplicate
  idempotency keys produce one mutation/event/outbox intent. Crash after state commit still delivers
  jobs. Stale expected versions never overwrite reader changes; exact bulk undo restores prior
  ratings/read/archive and refuses intervening edits.
- **Cross-user writes:** exercise every mutation with B's ids as A, including shared article detail,
  examples, cluster members, labels, bulk ids, receipts and sessions. RLS read tests alone are
  insufficient. Test old-session replay after deletion/demotion.
- **Reader query fixtures:** duplicate stories in two feeds/folders, hidden best member, bookmark
  after unsubscribe/block, tier-filtered counts, null scores, tie ids, reranking between pages and
  malformed/cross-user cursors. Assert list/count parity for identical query versions.
- **Inference authorization:** new/imported off feeds, GET/counts/card edits/rating/bookmark and
  onboarding polls yield zero article-inference calls. One explicit selection enqueues exactly its
  frozen `analysis.process` request, no siblings/future arrivals; its feedback links to that exact
  request. Active begins only on the explicit CAS transition and only for new arrivals. Off/Training
  transitions fence stale jobs. Two users requesting identical current inputs reuse calls while
  remaining independently authorized; direct off-feed A never inherits active-feed B's ranking.
- **Bookmark retention:** snapshot body survives source loss, unsubscribe, article revision and
  30-day lossless compression; export contains byte-equivalent text/HTML and capture provenance.
  Partial/failed/pending status is honest. Unbookmark/rebookmark/retry/undo races cannot bind stale
  content; inaccessible snapshot ids return 404 and cannot be downloaded by another user.
- **Image precedence:** user-feed allow overrides global false, block overrides global true, inherit
  follows global; reload, another device, unsubscribe/re-add and bookmark saved view retain the same
  stable source policy. Changing one user's preference changes no other user's response.
- **Credentials and consent:** staged keys never appear in GET/export/logs/idempotency bodies;
  invalid/obsolete probes cannot replace the active key; stale admin writes fail CAS and local
  disable prevents environment fallback. A hash adopter cannot approve creator publication; recent
  unapproved activity, explicit decline, unknown/deleted provenance and changed payload cannot use
  stale authorization. Test 29 days 23:59:59 versus exactly 30 days, null last_active_at falling back
  to known created_at, a creator return racing promotion, and an old request from a recently active
  creator. Inactivity publication records its own audit basis without inventing approval. Library upgrades are
  explicit and do not overwrite private examples; label assignment contributes no preference label.
