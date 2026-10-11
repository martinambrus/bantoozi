# Security checklist verification (M8-T6)

Date: 2026-10-11. Branch: `claude/m8-ops`. Source: `docs/specs/11-operations.md` section 7.
Raw outputs: `/home/zathrus/.cache/bantoozi-m8/S14/evidence-T6/` (vitest json reports, audit output)
and `/home/zathrus/.cache/bantoozi-m8/S11/evidence/` (rehearsal header check).

Everything here ran locally. There is no production host, so nothing below is evidence about a real
domain, DNS or Let's Encrypt issuance.

## 1. TLS

- Requirement: Caddy-managed certificates with HSTS `max-age=31536000`.
- How verified: `infra/caddy/Caddyfile:1-6,16-24` (site address `{$PUBLIC_HOST:localhost}`, a domain
  name gets ACME certificates, `Strict-Transport-Security "max-age=31536000"`); rehearsal run
  `S11/evidence/headers-rehearsal.txt`: HSTS `max-age=31536000` passed on `/`, `/login`, an asset,
  `/api/v1/readyz`, a missing API path and a missing asset.
- Result: PARTIAL. HSTS and Caddy-managed TLS are configured and pass in the rehearsal, but the
  rehearsal used Caddy's internal CA on localhost. ACME issuance for the real domain needs DNS and is
  an owner step.

## 2. Headers set by Caddy

- Requirement: CSP (exact string of spec 11 section 7), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- How verified: `infra/caddy/Caddyfile:13-24` defines the `security_headers` snippet, imported at
  line 28 for the site and in `handle_errors` (so Caddy-produced errors carry them). The rehearsal
  check script printed `SUMMARY pass=44 fail=0` (`headers-rehearsal.txt`): CSP exact, nosniff,
  Referrer-Policy, Permissions-Policy and HSTS on 6 response kinds, plus SPA fallback, `/privacy`,
  immutable asset cache, `no-cache` for `index.html` and `/sw.js`, and `/metrics` answering 404.
  Negative control `negctl-headers.txt`: against a header-less server the same script exits non-zero
  with `pass=5 fail=39`, so the check can fail.
- Result: PASS (in the rehearsal stack).

## 3. Third-party images

- Requirement: blocked by default; no remote `src`/CSS URLs without an explicit allow; a per-user
  per-feed "always allow" choice; opted-in images use `referrerpolicy="no-referrer"`,
  `loading="lazy"`, HTTPS only, local placeholders; the loading disclosure; login/privacy pages load no
  third-party media.
- How verified:
  - `apps/web/src/components/safe-html.tsx:66-93,100-116`: the only place feed HTML reaches the DOM.
    When `imagesAllowed` is false every `<img>` becomes an inert `span[data-blocked-image]` with the alt
    text (no `src`/`srcset`); allowed images get `referrerpolicy="no-referrer"` and `loading="lazy"`.
  - `apps/web/src/features/article/article-row.tsx:75-76` (feed icon and thumbnail only when
    `effectiveImagesAllowed`), `:101-102,235-236` (lazy, no-referrer).
  - Remembered choice: `image-policy-panel.tsx` ("Always show images from this feed" / "Always block",
    not offered without a feed), `features/settings/image-exceptions.tsx`; server side is spec 08
    section 4.1 (covered by the api suites, not re-run here).
  - Disclosure text: `apps/web/public/privacy/index.html:49-54` ("Remote images", IP address and
    request metadata, per-feed choice, no-referrer, lazy).
  - Tests run: `test/article/safe-html.test.tsx` (41), `article-row.test.tsx` (161, lazy and
    no-referrer at lines 220-226), `article-detail.test.tsx` (75, lines 161-162), plus
    `test/auth/privacy-link.test.tsx` (2): 279 of 279 passed (`web.json`).
  - Static pages: `grep -nE "https?://"` over `public/privacy/index.html`, `public/privacy/sk/index.html`,
    `public/bot/index.html`, `public/bot/sk/index.html` and `src/features/auth/login-page.tsx` finds
    one hit, `bot/index.html:41`, which is the example User-Agent text inside `<code>`, not a load.
    Every `src`/`href`/stylesheet is same-origin (`/static-pages.css`, `/login`, `/privacy`, ...);
    `index.html` loads `/theme.js`, `/src/main.tsx` and local icons only.
- HTTPS only (fixed): `safe-html.tsx` (`isHttpsUrl`) and `http-url.ts` (`httpsUrl`, used by
  `article-row.tsx` for the thumbnail and feed icon) accept `https:` only for images; links keep
  `httpUrl`. The only exception is an `http:` image whose host is loopback (`localhost`, `127.0.0.1`, `[::1]`) on a page that itself runs on a loopback origin (the E2E fixture server; production is never loopback and CSP `img-src 'self' https:` also enforces https); tests: the loopback cases in `safe-html.test.tsx` and `article-row.test.tsx`. Tests: `test/article/safe-html.test.tsx:227` (http: image becomes a placeholder, http link
  kept), `:211` (https image kept, http one dropped), `test/article/article-row.test.tsx:243`.
- Result: PASS.

## 4. Session cookie and CSRF (spec 08 sections 1-2)

- Requirement: `bantoozi_sid` with HttpOnly, SameSite=Lax, Path=/, Secure in production, sliding
  Max-Age; every non-safe request needs `X-Bantoozi-Client: web`; a present `Origin` must equal the
  public origin; `Sec-Fetch-Site: cross-site` refused; CORS disabled.
- How verified: `apps/api/src/plugins/auth.ts:42-58` (attributes; `Secure` added when
  `nodeEnv === 'production'`), `apps/api/src/plugins/csrf.ts:22-51`.
  Tests: `apps/api/test/plugins.int.test.ts:196` (missing header gives 403), `:202` (foreign, `null`,
  malformed and path-bearing Origin, `Sec-Fetch-Site: cross-site`, same-origin accepted), `:218`
  (metrics bearer exempt), `:236` (CORS preflights refused), `:150-166` (sliding, HttpOnly,
  SameSite=Lax, Path=/, Max-Age about 60 days); `auth.int.test.ts:594-693` (cookie attributes,
  logout clears and revokes, auth mutations need the CSRF header). `api-rls-isolation`,
  `plugins` and `auth` int suites: 66 of 66 passed (`api-int.json`); `auth.test.ts` 10 of 10.
- Production `Secure` (fixed): `apps/api/test/session-cookie.test.ts:38` builds the config through
  `loadConfig` with `NODE_ENV=production` and asserts `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`
  and `Max-Age` on the set and the cleared cookie; `:51` asserts no `Secure` outside production.
  Mutation check: with the condition disabled the first test fails (`api-cookie-mutation-fail.json`).
- Result: PASS.

## 5. Rate limits (spec 08 section 11)

- Requirement: Postgres-backed buckets shared across processes; global per-IP, per-user mutation and
  per-route limits; `Retry-After`; `trustProxy` limited to known proxies; off only under `NODE_ENV=test`.
- How verified: `apps/api/src/plugins/rate-limit.ts:19-31` (300/min per IP, 120/min per user for
  mutations), `:56-62` (429 with `Retry-After`), `:111-139` (hooks); `apps/api/src/server.ts:38-44,
  91-94` (`trustProxy` is the loopback and private ranges, never `true`);
  `packages/shared/src/server/config.ts:386` (`RATE_LIMITS_ENABLED=false` refused outside test).
  Tests: `plugins.int.test.ts:314` (refused in production); `auth.int.test.ts:779-826` (5 codes per
  hour per email, 20 per hour per IP, 10 verifies per 10 minutes per IP), and the `probe` rule with
  `max: 2` in `plugins.int.test.ts` (shared buckets, 429 and headers). Same 66 of 66 run as above.
- Result: PASS.

## 6. SSRF-safe fetcher (spec 03 section 4)

- Requirement: every blocked range tested; redirects into private space refused.
- How verified: `packages/feeds/src/http/address.ts:9,26-66` (allowed ports 80, 443, 8080, 8443; the
  pinned special-purpose table; only `2000::/3` global unicast passes). Tests
  `packages/feeds/test/http/ssrf.test.ts` (189 tests: `:84` every range through an injected resolver,
  `:170` IP literals including decimal and mapped forms, `:221` ports, `:265` a public name that
  redirects to a private literal or name is rejected on that hop, `:326` `isBlockedAddress`) and
  `safe-fetch.test.ts` (96), plus `parse/sanitize.test.ts` (41): 326 of 326 passed (`feeds.json`).
  The API and worker use `safeFetch` (`apps/api/src/server.ts:73-87`).
- Ranges covered. IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
  172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15,
  198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32. IPv6: ::/128,
  ::1/128, ::/96, ::ffff:0:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2001::/32,
  2001:db8::/32, 2002::/16, 3fff::/20, 5f00::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8.
- Result: PASS. `FETCH_ALLOW_PRIVATE=true` is refused when `NODE_ENV=production`
  (`config.ts:383`).

## 7. HTML handling

- Requirement: all third-party HTML sanitized server-side (spec 03 section 6.3); the web client uses
  `dangerouslySetInnerHTML` only on sanitized fields, sanitized again with DOMPurify.
- How verified: `grep -rn dangerouslySetInnerHTML apps/web/src` gives exactly one hit,
  `components/safe-html.tsx:148`, which renders only the output of `sanitizeHtml()` (DOMPurify
  3.4.16, allow-list, `ALLOWED_URI_REGEXP: /^https?:/i`, scripts, styles, forms, svg, math and
  frames removed). Callers: `article-detail.tsx:124`, `article-body.tsx:56`. Server-side sanitizer:
  `packages/feeds/src/parse/sanitize.ts`, tests `packages/feeds/test/parse/sanitize.test.ts` (41, in
  the 326 above). Client tests: `safe-html.test.tsx` (41: allow-list, script and handler removal,
  frames, forms, svg/math, javascript: URLs).
- Result: PASS.

## 8. Database

- Requirement: API uses `bantoozi_app` (RLS); the BYPASSRLS worker role is never used by the API;
  the RLS isolation suite passes (spec 08 section 12).
- How verified: `infra/compose.yml:169` (api `DATABASE_URL` is `bantoozi_app`); the api service
  environment (`:167-185`) has no `DATABASE_URL_WORKER`; the worker alone gets
  `DATABASE_URL_WORKER` (`:44`, `x-worker-env`); the migrate job uses `bantoozi_owner` (`:138`).
  `packages/shared/src/server/config.ts:37-38,217-221`: `DATABASE_URL` is `usedBy: ['api','test']`,
  `DATABASE_URL_WORKER` is `usedBy: ['worker','eval']`, and the api process requires only
  `DATABASE_URL` and `SESSION_PEPPER`. `apps/api/src/main.ts:11-14` builds the pool from
  `config.databaseUrl` only. `grep -rn "DATABASE_URL_WORKER" apps/api/src` finds nothing.
  RLS suite `apps/api/test/api-rls-isolation.int.test.ts` (8 tests: GET sweep as A with B ids,
  private ids 404, lists, export and OPML, every mutation as A with B ids changes nothing of B, B
  still intact): all passed, in the 66 of 66 run.
- Result: PASS.

## 9. Logs

- Requirement: no secrets, codes, tokens, raw URL queries, provider prompt/response text, login/email
  bodies or exported data; redact Authorization, cookies and SMTP/DB URLs centrally; correlation IDs,
  entity IDs, bounded error codes; hash or omit user emails.
- How verified: central redaction `packages/shared/src/server/logger.ts:9-37`, applied at `:53`
  (`[redacted]`). Redacted: `password`, `apiKey`, `token`, `sessionToken`, `secret`, `loginCode` (top
  level and one level deep), `req.body.code`, `req.body.apiKey`, `req.headers.authorization`,
  `req.headers.cookie`, `res.headers["set-cookie"]`, `envelope`/`active_envelope`/`candidate_envelope`,
  `bodyText`, `bodyHtml` (and snake_case forms). Test: `packages/shared/test/mailer.test.ts:74`
  (apiKey, bearer and cookie absent from output); `config.test.ts` covers `redactConfig`/`toJSON` of
  the config object (secret fields `[redacted]`). The `log` mail transport (which prints login codes)
  is refused in production (`config.ts:389-390`) and compose defaults `MAIL_TRANSPORT` to `smtp`.
  Admin audit lines carry actor id, action, target and changed field names only
  (`apps/api/src/routes/admin/shared.ts:190-205`). The engine router logs engine names and
  `err.message`, not prompts (`packages/engine/src/router.ts:311-320`). Caddy's access log strips the
  query string, `Authorization`, `Cookie`, `X-Csrf-Token` and `Set-Cookie` (Caddyfile `log` block).
- Fixed in this round: (1) `REDACT_PATHS` now has `smtpUrl`, `databaseUrl`, `databaseUrlWorker`,
  `databaseUrlMigrate`, `testAdminDatabaseUrl` and the env-style names `SMTP_URL`, `DATABASE_URL`,
  `DATABASE_URL_WORKER`, `DATABASE_URL_MIGRATE`, `TEST_ADMIN_DATABASE_URL`, each top level and one
  level deep; tests `packages/shared/test/logger-redaction.test.ts:39` (each key) and `:48` (logging
  the config object). (2) `createLogger` has a `req` serializer (`serializeRequest`) that logs
  method, path without query or fragment, host and address; test `apps/api/test/request-log.test.ts:17`
  (`GET /api/v1/healthz?q=secret@example.com` logs the path and no `secret`).
- Not verified (not known failures): no API log call includes an email (all `request.log` calls were
  reviewed) but there is no central email hashing or test; there is no `X-Request-Id` propagation
  through Caddy (Fastify's `reqId` is attached to each request line).
- Result: PASS for the redaction, query and URL items. Emails are omitted from logs rather than
  hashed, which the spec allows ("hash/omit"); request-id propagation through Caddy is not
  implemented and is not a §7 requirement.

## 10. Dependencies

- Requirement: `pnpm audit --prod` in CI (high and critical fail the build) and Renovate weekly.
- How verified: `.github/workflows/ci.yml:49-50` runs `pnpm audit --prod --audit-level high`. Local
  run (`audit-raw.txt`): `1 vulnerabilities found, Severity: 1 moderate`, exit code 0. The one finding
  is `uuid` (missing buffer bounds check in v3/v5/v6 when `buf` is provided, below 11.1.1); at
  `--audit-level moderate` the exit code is 1, at `high` it is 0, so the gate works as specified.
  Renovate: no config existed. Created `/home/zathrus/bantoozi/renovate.json`: `config:recommended`,
  schedule `before 6am on monday`, timezone UTC, `rangeStrategy: pin` (the repo pins exact versions in
  every `package.json`, for example `fastify` 5.12.5, `dompurify` 3.4.16), weekly lock file
  maintenance, and `pinDigests: true` for `dockerfile` and `docker-compose` (compose and Dockerfile
  already carry five `@sha256` pins). The JSON parses (`node -e JSON.parse`).
- Result: PARTIAL. CI audit and the config file are in place, but the Renovate GitHub App must be
  installed on the repository by the owner; until then no update PRs are opened. The moderate `uuid`
  advisory is open (not gating).

## 11. Model input and the privacy page

- Requirement: article text sent to Jev and Ollama is public; card texts and example titles are
  personal; documented on `/privacy`, a static page linked from login.
- How verified: `apps/web/public/privacy/index.html:34-44` (article text is public content, card
  texts and example titles are personal, Ollama Cloud off by default, LibreTranslate on our own
  server), Slovak version `public/privacy/sk/index.html:34-36`; the login link
  `apps/web/src/features/auth/login-page.tsx:20-26` (`/privacy` or `/privacy/sk/` by language); test
  `apps/web/test/auth/privacy-link.test.tsx` (English and Slovak, 2 of 2 passed in `web.json`);
  Caddy serves `/privacy` as a static directory page (`try_files {path} {path}/index.html`, rehearsal
  `PASS /privacy exists`).
- Result: PASS.

## Summary

| Item                              | Result                                                    |
| --------------------------------- | --------------------------------------------------------- |
| 1. TLS and HSTS                   | PARTIAL (internal CA in rehearsal; ACME is an owner step) |
| 2. Headers                        | PASS                                                      |
| 3. Third-party images             | PASS                                                      |
| 4. Session cookie and CSRF        | PASS                                                      |
| 5. Rate limits                    | PASS                                                      |
| 6. SSRF-safe fetcher              | PASS                                                      |
| 7. HTML handling                  | PASS                                                      |
| 8. Database roles and RLS         | PASS                                                      |
| 9. Logs                           | PASS (email hashing, request-id propagation unverified)   |
| 10. Dependencies                  | PARTIAL (Renovate app install is an owner step)           |
| 11. Model input and privacy page  | PASS                                                      |

## Open items

1. Owner: real-domain ACME issuance and a header check against the live host (item 1).
2. Owner: install the Renovate app on the repository; review the moderate `uuid` advisory (item 10).
3. Optional: add a test that no API log line contains an email address, and decide on request-id
   propagation from Caddy (item 9).
