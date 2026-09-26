-- Hand-written (spec 02 §6): SECURITY DEFINER functions owned by the BYPASSRLS bantoozi_owner, each with
-- a fixed trusted search path, PUBLIC execute revoked and explicit EXECUTE grants.
--
-- Error SQLSTATEs used by these functions (mapped by packages/db `mapDbError`):
--   42501 insufficient_privilege  — no active tenant, not an administrator or not the original author
--   BZ404                         — object missing or not accessible to the caller (API 404)
--   BZ409                         — stale revision/version or a state that forbids the action (API 409)
--   22023 invalid_parameter_value — malformed arguments (API 400)

-- ── Internal helpers (no EXECUTE for app/worker) ────────────────────────────────────────────────

-- The authenticated, non-deleted tenant of this transaction (`app.user_id`).
CREATE FUNCTION active_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_user AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'an active tenant session is required' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END;
$$;

-- Canonical checksum of a snapshot's exact stored title/author/date/source/text/HTML (spec 02 §3.5).
CREATE FUNCTION snapshot_content_sha256(p_title text, p_author text, p_published_at timestamptz,
                                        p_source_url text, p_body_text text, p_body_html text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(digest(convert_to(jsonb_build_array(
    p_title, p_author,
    to_char(p_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_source_url, p_body_text, p_body_html)::text, 'UTF8'), 'sha256'), 'hex');
$$;

-- Mark a snapshot unreferenced when its final bookmark/pin reference detached (spec 02 §3.5).
CREATE FUNCTION mark_snapshot_if_unreferenced(p_snapshot_id bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM article_snapshots s WHERE s.id = p_snapshot_id FOR UPDATE;
  UPDATE article_snapshots s SET unreferenced_at = now()
   WHERE s.id = p_snapshot_id AND s.unreferenced_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM user_article ua
                      WHERE ua.bookmark_snapshot_id = s.id AND ua.bookmarked_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM bookmark_snapshot_pins p
                      WHERE p.snapshot_id = s.id AND p.expires_at > now());
END;
$$;

-- ── Core functions (spec 02 §6, verbatim) ───────────────────────────────────────────────────────

-- Recompute feed_cards for the given feeds: cards and labels of active-inference, non-deleted subscribers,
-- respecting card scope.
CREATE FUNCTION refresh_feed_cards(p_feed_ids bigint[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Serialize overlapping feed refreshes; new snapshots after the wait see committed subscribers.
  PERFORM f.id FROM feeds f WHERE f.id = ANY(p_feed_ids) ORDER BY f.id FOR NO KEY UPDATE;
  DELETE FROM feed_cards WHERE feed_id = ANY(p_feed_ids);
  INSERT INTO feed_cards (feed_id, card_id, holders)
  SELECT s.feed_id, x.card_id, count(DISTINCT s.user_id)
  FROM subscriptions s
  JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
  JOIN (
    SELECT user_id, card_id, scope_feed_id FROM user_cards
    UNION ALL
    SELECT user_id, card_id, NULL::bigint FROM user_labels
  ) x ON x.user_id = s.user_id AND (x.scope_feed_id IS NULL OR x.scope_feed_id = s.feed_id)
  JOIN interest_cards c ON c.id = x.card_id AND c.retired_at IS NULL
  WHERE s.feed_id = ANY(p_feed_ids) AND s.inference_mode = 'active'
  GROUP BY s.feed_id, x.card_id;
END;
$$;

-- Keep feeds.subscriber_count and feeds.min_interval_s in sync.
-- p_plan_min_interval = {"beta": 900, "admin": 300}, built from packages/shared/src/plans.ts.
CREATE FUNCTION refresh_feed_subscribers(p_feed_ids bigint[], p_plan_min_interval jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM f.id FROM feeds f WHERE f.id = ANY(p_feed_ids) ORDER BY f.id FOR NO KEY UPDATE;
  UPDATE feeds f
     SET subscriber_count = coalesce(x.cnt, 0),
         unsubscribed_at  = CASE WHEN coalesce(x.cnt, 0) = 0 THEN coalesce(f.unsubscribed_at, now()) END,
         min_interval_s   = coalesce(x.min_iv, 900),
         updated_at       = now()
    FROM (SELECT DISTINCT unnest(p_feed_ids) AS feed_id) ids
    LEFT JOIN (
      SELECT s.feed_id, count(*) AS cnt,
             min(coalesce((p_plan_min_interval ->> u.plan)::int, 900)) AS min_iv
      FROM subscriptions s JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
      WHERE s.feed_id = ANY(p_feed_ids)
      GROUP BY s.feed_id) x ON x.feed_id = ids.feed_id
   WHERE f.id = ids.feed_id;
END;
$$;

-- True only for an active administrator session or an operational login.
-- session_user preserves the real login inside SECURITY DEFINER; test role connections separately.
CREATE FUNCTION admin_context_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT session_user IN ('bantoozi_owner','bantoozi_worker') OR EXISTS (
    SELECT 1 FROM users u WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
      AND u.role = 'admin' AND u.deleted_at IS NULL
  );
$$;
REVOKE EXECUTE ON FUNCTION admin_context_allowed() FROM PUBLIC;

-- Admin statistics: how many active users hold each card (as interest or label).
CREATE FUNCTION admin_card_holders(p_card_ids bigint[]) RETURNS TABLE (card_id bigint, holders int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.id,
         ((SELECT count(*) FROM user_cards uc JOIN users u ON u.id = uc.user_id
             WHERE uc.card_id = c.id AND u.deleted_at IS NULL)
        + (SELECT count(*) FROM user_labels ul JOIN users u ON u.id = ul.user_id
             WHERE ul.card_id = c.id AND u.deleted_at IS NULL))::int
  FROM unnest(p_card_ids) AS c(id) WHERE admin_context_allowed();
$$;

-- Admin usage: per-user attributed cost over the last p_days UTC days.
-- direct = user-attributed usage_daily rows (backfills, suggestions, fork questions);
-- shared = platform 'match' cost × (Σ over the user's (feed, card) holdings of 1/holders) / count(feed_cards).
CREATE FUNCTION admin_usage_attribution(p_days int)
RETURNS TABLE (user_id uuid, direct_usd numeric, shared_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH win AS (SELECT * FROM usage_daily WHERE day > (now() AT TIME ZONE 'UTC')::date - p_days
               AND day <= (now() AT TIME ZONE 'UTC')::date AND p_days BETWEEN 1 AND 366),
  direct AS (SELECT w.user_id, sum(w.cost_usd) AS usd FROM win w
             WHERE w.user_id <> '00000000-0000-0000-0000-000000000000' GROUP BY w.user_id),
  m AS (SELECT coalesce(sum(cost_usd), 0) AS usd FROM win
        WHERE user_id = '00000000-0000-0000-0000-000000000000' AND kind = 'match'),
  tot AS (SELECT greatest(count(*), 1) AS n FROM feed_cards),
  holding AS (
    SELECT DISTINCT s.user_id, fc.feed_id, fc.card_id, fc.holders
    FROM feed_cards fc
    JOIN subscriptions s ON s.feed_id = fc.feed_id AND s.inference_mode = 'active'
    JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
    JOIN (SELECT user_id, card_id, scope_feed_id FROM user_cards
          UNION ALL SELECT user_id, card_id, NULL::bigint FROM user_labels) x
      ON x.user_id = s.user_id AND x.card_id = fc.card_id
     AND (x.scope_feed_id IS NULL OR x.scope_feed_id = fc.feed_id)),
  shared AS (SELECT h.user_id, sum(1.0 / h.holders) AS share FROM holding h GROUP BY h.user_id)
  SELECT coalesce(d.user_id, sh.user_id), coalesce(d.usd, 0),
         coalesce(sh.share, 0) * (SELECT usd FROM m) / (SELECT n FROM tot)
  FROM direct d FULL JOIN shared sh ON sh.user_id = d.user_id
  WHERE admin_context_allowed() AND p_days BETWEEN 1 AND 366;
$$;

-- ── Shared rate limiter (spec 02 §6, spec 08 §11) ────────────────────────────────────────────────
-- One atomic upsert: a new window when the old one has ended, otherwise one more hit.
CREATE FUNCTION rate_limit_hit(p_key text, p_window_s int, p_max int)
RETURNS TABLE (allowed boolean, retry_after_s int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window interval;
  v_start timestamptz;
  v_hits int;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 512 OR p_window_s IS NULL
     OR p_window_s NOT BETWEEN 1 AND 604800 OR p_max IS NULL OR p_max < 1 THEN
    RAISE EXCEPTION 'invalid rate limit arguments' USING ERRCODE = '22023';
  END IF;
  v_window := make_interval(secs => p_window_s);
  INSERT INTO rate_limit_buckets AS b (key, window_start, hits)
  VALUES (p_key, v_now, 1)
  ON CONFLICT (key) DO UPDATE
    SET window_start = CASE WHEN b.window_start + v_window <= v_now THEN v_now ELSE b.window_start END,
        hits         = CASE WHEN b.window_start + v_window <= v_now THEN 1 ELSE b.hits + 1 END
  RETURNING b.window_start, b.hits INTO v_start, v_hits;
  allowed := v_hits <= p_max;
  retry_after_s := CASE WHEN v_hits <= p_max THEN 0
                        ELSE greatest(1, ceil(extract(epoch FROM (v_start + v_window - v_now)))::int) END;
  RETURN NEXT;
END;
$$;

-- ── Narrow API accounting helper (spec 02 §6, spec 07 §5) ────────────────────────────────────────
-- Free tier-1 card translation audit: attribution from the active tenant, zero cost, at most once per
-- logical request/engine/attempt, with the zero-cost usage increment in the same transaction.
CREATE FUNCTION record_card_translation(p_logical_request_id uuid, p_attempt int, p_latency_ms int,
                                        p_status text, p_error_code text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := active_tenant();
  v_rows int;
BEGIN
  IF p_logical_request_id IS NULL OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 10
     OR p_latency_ms IS NULL OR p_latency_ms NOT BETWEEN 0 AND 600000
     OR p_status IS NULL OR p_status NOT IN ('ok','error','timeout','rate_limited','invalid_request',
                                             'invalid_response','auth_error')
     OR (p_status = 'ok' AND p_error_code IS NOT NULL)
     OR (p_error_code IS NOT NULL AND p_error_code NOT IN ('timeout','network','http_4xx','http_5xx',
         'rate_limited','invalid_response','unsupported_language','text_too_long','unavailable')) THEN
    RAISE EXCEPTION 'invalid card translation record' USING ERRCODE = '22023';
  END IF;
  INSERT INTO engine_calls (engine, kind, logical_request_id, user_id, n_questions, input_tokens,
                            output_tokens, cost_usd, billing, latency_ms, attempts, status, error)
  VALUES ('libretranslate', 'translate', p_logical_request_id, v_user, 0, 0, 0, 0, 'known',
          p_latency_ms, p_attempt, p_status, p_error_code)
  ON CONFLICT (logical_request_id, engine, attempts) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    INSERT INTO usage_daily AS u (day, user_id, engine, kind, calls)
    VALUES ((now() AT TIME ZONE 'UTC')::date, v_user, 'libretranslate', 'translate', 1)
    ON CONFLICT (day, user_id, engine, kind) DO UPDATE SET calls = u.calls + 1;
  END IF;
END;
$$;

-- ── Bookmark archive functions (spec 02 §3.5, §6) ───────────────────────────────────────────────
-- Lock order: the owning users row, the article row, the reader (user_article) row. None of these
-- helpers increments reader state_version or appends feedback: the enclosing idempotent API action
-- does that exactly once.

CREATE FUNCTION capture_bookmark_snapshot(p_article_id bigint, p_origin_feed_id bigint)
RETURNS TABLE (snapshot_id bigint, capture_status text, capture_generation bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := active_tenant();
  v_article articles%ROWTYPE;
  v_body article_bodies%ROWTYPE;
  v_ua user_article%ROWTYPE;
  v_ua_found boolean;
  v_origin bigint;
  v_text text; v_html text; v_complete text; v_reason text; v_source text; v_extractor text;
  v_sha text;
  v_snapshot bigint;
  v_status text;
  v_generation bigint;
BEGIN
  PERFORM 1 FROM users u WHERE u.id = v_user FOR NO KEY UPDATE;
  SELECT * INTO v_article FROM articles a WHERE a.id = p_article_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'article not found' USING ERRCODE = 'BZ404';
  END IF;
  SELECT * INTO v_ua FROM user_article ua WHERE ua.user_id = v_user AND ua.article_id = p_article_id FOR UPDATE;
  v_ua_found := FOUND;

  -- Access: a current subscribed carrier, or the caller's own bookmark.
  IF NOT EXISTS (SELECT 1 FROM feed_items fi JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = v_user
                  WHERE fi.article_id = p_article_id)
     AND NOT (v_ua_found AND v_ua.bookmarked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'article not accessible' USING ERRCODE = 'BZ404';
  END IF;

  -- The display/media source: a subscribed carrier (or the bookmark's existing origin).
  IF p_origin_feed_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM feed_items fi JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = v_user
                    WHERE fi.article_id = p_article_id AND fi.feed_id = p_origin_feed_id)
       AND NOT (v_ua_found AND v_ua.bookmark_origin_feed_id = p_origin_feed_id) THEN
      RAISE EXCEPTION 'origin feed not accessible' USING ERRCODE = 'BZ404';
    END IF;
    v_origin := p_origin_feed_id;
  ELSIF v_ua_found AND v_ua.bookmark_origin_feed_id IS NOT NULL THEN
    v_origin := v_ua.bookmark_origin_feed_id;
  ELSE
    SELECT min(fi.feed_id) INTO v_origin FROM feed_items fi
      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = v_user
     WHERE fi.article_id = p_article_id;
  END IF;

  -- Copy only stored, trusted current source: the extracted body of this revision, else the feed excerpt.
  SELECT * INTO v_body FROM article_bodies b
   WHERE b.article_id = p_article_id AND b.article_revision = v_article.content_revision AND b.status = 'ok'
     AND (b.body_text IS NOT NULL OR b.body_html IS NOT NULL);
  IF FOUND THEN
    v_text := coalesce(v_body.body_text, ''); v_html := v_body.body_html;
    v_complete := v_body.completeness; v_reason := v_body.completeness_reason;
    v_source := 'page'; v_extractor := v_body.extractor_version;
  ELSE
    v_text := coalesce(v_article.excerpt, ''); v_html := v_article.excerpt_html;
    v_complete := 'partial'; v_reason := 'excerpt_only'; v_source := 'feed'; v_extractor := 'feed';
  END IF;
  -- A complete saved snapshot is preserved when the current source is less complete; nothing new is
  -- archived then (an unbound row would never be garbage-collected).
  IF v_ua_found AND v_ua.bookmarked_at IS NOT NULL AND v_ua.bookmark_capture_status = 'saved'
     AND v_complete <> 'complete' THEN
    v_snapshot := v_ua.bookmark_snapshot_id;
    v_complete := 'complete';
  ELSE
    v_sha := snapshot_content_sha256(v_article.title, v_article.author, v_article.published_at, v_article.url,
                                     v_text, v_html);
    INSERT INTO article_snapshots (article_id, source_revision, source_url, title, author, published_at, body_text,
                                   body_html, content_sha256, completeness, completeness_reason, source,
                                   extractor_version)
    VALUES (p_article_id, v_article.content_revision, v_article.url, v_article.title, v_article.author,
            v_article.published_at, v_text, v_html, v_sha, v_complete, v_reason, v_source, v_extractor)
    ON CONFLICT (article_id, source_revision, content_sha256) DO NOTHING
    RETURNING id INTO v_snapshot;
    IF v_snapshot IS NULL THEN
      SELECT s.id INTO v_snapshot FROM article_snapshots s
       WHERE s.article_id = p_article_id AND s.source_revision = v_article.content_revision
         AND s.content_sha256 = v_sha;
    END IF;
  END IF;
  v_status := CASE WHEN v_complete = 'complete' THEN 'saved' ELSE 'pending' END;

  -- Attach (clears the unreferenced marker under the snapshot row lock).
  PERFORM 1 FROM article_snapshots s WHERE s.id = v_snapshot FOR UPDATE;
  UPDATE article_snapshots s SET unreferenced_at = NULL WHERE s.id = v_snapshot AND s.unreferenced_at IS NOT NULL;

  IF v_ua_found THEN
    UPDATE user_article ua
       SET bookmarked_at = coalesce(ua.bookmarked_at, now()),
           bookmark_snapshot_id = v_snapshot,
           bookmark_origin_feed_id = v_origin,
           bookmark_capture_generation = ua.bookmark_capture_generation + 1,
           bookmark_capture_status = v_status,
           bookmark_capture_error_code = NULL
     WHERE ua.user_id = v_user AND ua.article_id = p_article_id
    RETURNING ua.bookmark_capture_generation INTO v_generation;
    IF v_ua.bookmark_snapshot_id IS NOT NULL AND v_ua.bookmark_snapshot_id <> v_snapshot THEN
      PERFORM mark_snapshot_if_unreferenced(v_ua.bookmark_snapshot_id);
    END IF;
  ELSE
    INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_snapshot_id, bookmark_origin_feed_id,
                              bookmark_capture_generation, bookmark_capture_status)
    VALUES (v_user, p_article_id, now(), v_snapshot, v_origin, 1, v_status)
    RETURNING bookmark_capture_generation INTO v_generation;
  END IF;

  -- Partial content schedules a local capture (never model inference).
  IF v_status = 'pending' THEN
    INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
    VALUES ('article.capture-bookmark', jsonb_build_object('articleId', p_article_id::text),
            format('{"payload":{"articleId":"%s"},"revision":"%s"}', p_article_id, v_article.content_revision),
            v_user)
    ON CONFLICT (queue, dedupe_key) WHERE delivered_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING;
  END IF;

  snapshot_id := v_snapshot;
  capture_status := v_status;
  capture_generation := v_generation;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION clear_bookmark_snapshot(p_article_id bigint)
RETURNS TABLE (previous_snapshot_id bigint, capture_generation bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := active_tenant();
  v_ua user_article%ROWTYPE;
  v_ua_found boolean;
  v_generation bigint;
BEGIN
  PERFORM 1 FROM users u WHERE u.id = v_user FOR NO KEY UPDATE;
  PERFORM 1 FROM articles a WHERE a.id = p_article_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'article not found' USING ERRCODE = 'BZ404';
  END IF;
  SELECT * INTO v_ua FROM user_article ua WHERE ua.user_id = v_user AND ua.article_id = p_article_id FOR UPDATE;
  v_ua_found := FOUND;
  -- Access: the caller's own bookmark, or a current subscribed carrier.
  IF NOT (v_ua_found AND v_ua.bookmarked_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM feed_items fi JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = v_user
                      WHERE fi.article_id = p_article_id) THEN
    RAISE EXCEPTION 'article not accessible' USING ERRCODE = 'BZ404';
  END IF;
  IF NOT v_ua_found OR v_ua.bookmarked_at IS NULL THEN
    previous_snapshot_id := NULL;
    capture_generation := CASE WHEN v_ua_found THEN v_ua.bookmark_capture_generation ELSE 0 END;
    RETURN NEXT;
    RETURN;
  END IF;
  UPDATE user_article ua
     SET bookmarked_at = NULL, bookmark_snapshot_id = NULL, bookmark_origin_feed_id = NULL,
         bookmark_capture_status = NULL, bookmark_capture_error_code = NULL,
         bookmark_capture_generation = ua.bookmark_capture_generation + 1
   WHERE ua.user_id = v_user AND ua.article_id = p_article_id
  RETURNING ua.bookmark_capture_generation INTO v_generation;
  IF v_ua.bookmark_snapshot_id IS NOT NULL THEN
    PERFORM mark_snapshot_if_unreferenced(v_ua.bookmark_snapshot_id);
  END IF;
  previous_snapshot_id := v_ua.bookmark_snapshot_id;
  capture_generation := v_generation;
  RETURN NEXT;
END;
$$;

-- Exact undo of an unbookmark: no caller-supplied snapshot id. The caller's unexpired receipt
-- (api_mutations.undo = {"kind":"unbookmark","articleId":"<id>","stateVersion":"<reader version after
-- the unbookmark>","prior":{"bookmarkedAt":"<iso>","originFeedId":"<id>"|null,"captureStatus":"saved"|
-- "partial"|"pending"|"failed"}}) and its unexpired pin identify the exact snapshot to restore.
CREATE FUNCTION restore_bookmark_snapshot(p_article_id bigint, p_mutation_id uuid)
RETURNS TABLE (snapshot_id bigint, capture_status text, capture_generation bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := active_tenant();
  v_article articles%ROWTYPE;
  v_ua user_article%ROWTYPE;
  v_undo jsonb;
  v_snapshot bigint;
  v_status text;
  v_origin bigint;
  v_generation bigint;
BEGIN
  PERFORM 1 FROM users u WHERE u.id = v_user FOR NO KEY UPDATE;
  SELECT * INTO v_article FROM articles a WHERE a.id = p_article_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'article not found' USING ERRCODE = 'BZ404';
  END IF;
  SELECT * INTO v_ua FROM user_article ua WHERE ua.user_id = v_user AND ua.article_id = p_article_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing to restore' USING ERRCODE = 'BZ404';
  END IF;
  SELECT m.undo INTO v_undo FROM api_mutations m
   WHERE m.user_id = v_user AND m.id = p_mutation_id AND m.expires_at > now();
  IF NOT FOUND OR v_undo IS NULL OR v_undo->>'kind' IS DISTINCT FROM 'unbookmark'
     OR v_undo->>'articleId' IS DISTINCT FROM p_article_id::text THEN
    RAISE EXCEPTION 'no undo receipt for this bookmark' USING ERRCODE = 'BZ404';
  END IF;
  SELECT p.snapshot_id INTO v_snapshot FROM bookmark_snapshot_pins p
    JOIN article_snapshots s ON s.id = p.snapshot_id AND s.article_id = p_article_id
   WHERE p.user_id = v_user AND p.mutation_id = p_mutation_id AND p.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'undo pin expired' USING ERRCODE = 'BZ409';
  END IF;
  IF v_ua.bookmarked_at IS NOT NULL OR v_undo->>'stateVersion' IS DISTINCT FROM v_ua.state_version::text THEN
    RAISE EXCEPTION 'reader state changed since the unbookmark' USING ERRCODE = 'BZ409';
  END IF;
  -- An article that became inaccessible (no subscribed carrier any more) cannot be restored (spec 08 §5.4).
  IF NOT EXISTS (SELECT 1 FROM feed_items fi JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = v_user
                  WHERE fi.article_id = p_article_id) THEN
    RAISE EXCEPTION 'article no longer accessible' USING ERRCODE = 'BZ409';
  END IF;
  v_status := coalesce(v_undo #>> '{prior,captureStatus}', 'partial');
  IF v_status NOT IN ('saved','partial','pending','failed') THEN
    RAISE EXCEPTION 'invalid undo receipt' USING ERRCODE = '22023';
  END IF;
  v_origin := nullif(v_undo #>> '{prior,originFeedId}', '')::bigint;
  IF v_origin IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.id = v_origin) THEN
    v_origin := NULL;
  END IF;

  PERFORM 1 FROM article_snapshots s WHERE s.id = v_snapshot FOR UPDATE;
  UPDATE article_snapshots s SET unreferenced_at = NULL WHERE s.id = v_snapshot AND s.unreferenced_at IS NOT NULL;
  UPDATE user_article ua
     SET bookmarked_at = coalesce((v_undo #>> '{prior,bookmarkedAt}')::timestamptz, now()),
         bookmark_snapshot_id = v_snapshot,
         bookmark_origin_feed_id = v_origin,
         bookmark_capture_status = v_status,
         bookmark_capture_error_code = NULL,
         bookmark_capture_generation = ua.bookmark_capture_generation + 1
   WHERE ua.user_id = v_user AND ua.article_id = p_article_id
  RETURNING ua.bookmark_capture_generation INTO v_generation;

  IF v_status = 'pending' THEN
    INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
    VALUES ('article.capture-bookmark', jsonb_build_object('articleId', p_article_id::text),
            format('{"payload":{"articleId":"%s"},"revision":"%s"}', p_article_id, v_article.content_revision),
            v_user)
    ON CONFLICT (queue, dedupe_key) WHERE delivered_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING;
  END IF;

  snapshot_id := v_snapshot;
  capture_status := v_status;
  capture_generation := v_generation;
  RETURN NEXT;
END;
$$;

-- ── Provider credential admin functions (spec 02 §2.1, §6; spec 04 §1.2) ───────────────────────

-- An administrator's (or operational login's) active session; returns the attributed user id.
CREATE FUNCTION require_admin_session() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := active_tenant();
BEGIN
  IF NOT admin_context_allowed() THEN
    RAISE EXCEPTION 'administrator session required' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END;
$$;

CREATE FUNCTION check_credential_provider(p_provider text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('typesafe','ollama') THEN
    RAISE EXCEPTION 'unknown provider' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Envelope shape and byte lengths (spec 04 §1.2, format 1); never decrypts anything.
CREATE FUNCTION valid_credential_envelope(p_envelope jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_wrapped jsonb;
BEGIN
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_envelope) k)
        <> ARRAY['ciphertext','format','key_id','nonce','tag','wrapped_key']
     OR p_envelope->'format' <> '1'::jsonb
     OR coalesce(p_envelope->>'key_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN
    RETURN false;
  END IF;
  v_wrapped := p_envelope->'wrapped_key';
  IF jsonb_typeof(v_wrapped) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_wrapped) k) <> ARRAY['ciphertext','nonce','tag'] THEN
    RETURN false;
  END IF;
  RETURN length(decode(p_envelope->>'nonce', 'base64')) = 12
     AND length(decode(p_envelope->>'tag', 'base64')) = 16
     AND length(decode(p_envelope->>'ciphertext', 'base64')) BETWEEN 1 AND 4096
     AND length(decode(v_wrapped->>'nonce', 'base64')) = 12
     AND length(decode(v_wrapped->>'tag', 'base64')) = 16
     AND length(decode(v_wrapped->>'ciphertext', 'base64')) = 32;
EXCEPTION WHEN invalid_parameter_value OR data_exception THEN
  RETURN false;
END;
$$;

-- Metadata only: versions, status, timestamps and sanitized health — never envelopes.
CREATE FUNCTION admin_provider_credentials_metadata()
RETURNS TABLE (provider text, revision bigint, enabled boolean, active_version bigint, candidate_version bigint,
               candidate_status text, candidate_validation jsonb, updated_at timestamptz,
               activated_at timestamptz, validated_at timestamptz, last_error_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM require_admin_session();
  RETURN QUERY
    SELECT c.provider, c.revision, c.enabled, c.active_version, c.candidate_version, c.candidate_status,
           c.candidate_validation, c.updated_at, c.activated_at, c.validated_at, c.last_error_code
      FROM provider_credentials c ORDER BY c.provider;
END;
$$;

-- Stage an already encrypted envelope as the candidate for the exact next revision. No provider call,
-- no validation probe; the working active version is retained.
CREATE FUNCTION admin_stage_provider_credential(p_provider text, p_expected_revision bigint, p_envelope jsonb)
RETURNS TABLE (revision bigint, candidate_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
BEGIN
  PERFORM check_credential_provider(p_provider);
  IF NOT valid_credential_envelope(p_envelope) THEN
    RAISE EXCEPTION 'invalid credential envelope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO provider_credentials (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'BZ409';
  END IF;
  UPDATE provider_credentials c
     SET revision = c.revision + 1, candidate_version = c.revision + 1, candidate_envelope = p_envelope,
         candidate_status = 'pending', candidate_validation = '{}', validation_token = NULL,
         validation_until = NULL, validated_at = NULL, last_error_code = NULL,
         updated_at = now(), updated_by = v_admin
   WHERE c.provider = p_provider
  RETURNING c.revision, c.candidate_version INTO revision, candidate_version;
  RETURN NEXT;
END;
$$;

-- Explicit Validate: queue `provider.validate {provider, candidateVersion}` (no secret in the payload).
CREATE FUNCTION admin_validate_provider_credential(p_provider text, p_candidate_version bigint,
                                                   p_expected_revision bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
BEGIN
  PERFORM check_credential_provider(p_provider);
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no credential staged' USING ERRCODE = 'BZ404';
  END IF;
  IF v_row.revision <> p_expected_revision OR v_row.candidate_version IS DISTINCT FROM p_candidate_version
     OR v_row.candidate_status NOT IN ('pending','valid','invalid') THEN
    RAISE EXCEPTION 'stale or busy credential candidate' USING ERRCODE = 'BZ409';
  END IF;
  INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
  VALUES ('provider.validate',
          jsonb_build_object('provider', p_provider, 'candidateVersion', p_candidate_version::text),
          format('{"payload":{"candidateVersion":"%s","provider":"%s"},"revision":null}', p_candidate_version, p_provider),
          v_admin)
  ON CONFLICT (queue, dedupe_key) WHERE delivered_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING;
END;
$$;

-- Activate the exact validated candidate (validation no older than 24 h) under CAS; clear the superseded
-- envelope and candidate state, enable the provider and invalidate its old auth breaker.
CREATE FUNCTION admin_activate_provider_credential(p_provider text, p_expected_revision bigint,
                                                   p_candidate_version bigint)
RETURNS TABLE (revision bigint, active_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
  v_breaker text;
BEGIN
  PERFORM check_credential_provider(p_provider);
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no credential staged' USING ERRCODE = 'BZ404';
  END IF;
  IF v_row.revision <> p_expected_revision OR v_row.candidate_version IS DISTINCT FROM p_candidate_version
     OR v_row.candidate_status IS DISTINCT FROM 'valid' OR v_row.validated_at IS NULL
     OR v_row.validated_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'candidate is not a current valid validation' USING ERRCODE = 'BZ409';
  END IF;
  UPDATE provider_credentials c
     SET revision = c.revision + 1, enabled = true,
         active_version = c.candidate_version, active_envelope = c.candidate_envelope,
         candidate_version = NULL, candidate_envelope = NULL, candidate_status = NULL,
         candidate_validation = '{}', validation_token = NULL, validation_until = NULL,
         activated_at = now(), last_error_code = NULL, updated_at = now(), updated_by = v_admin
   WHERE c.provider = p_provider
  RETURNING c.revision, c.active_version INTO revision, active_version;
  v_breaker := CASE p_provider WHEN 'typesafe' THEN 'typesafe' ELSE 'llm' END;
  UPDATE settings s
     SET value = jsonb_set(s.value, ARRAY[v_breaker], '{"state":"closed","reopenCount":0}'::jsonb),
         updated_at = now(), updated_by = v_admin
   WHERE s.key = 'engine.circuit' AND s.value #>> ARRAY[v_breaker, 'state'] = 'auth';
  RETURN NEXT;
END;
$$;

-- Enable an active credential, or disable: clear both envelopes and leave an enabled=false tombstone
-- that blocks environment fallback (spec 04 §1.2 step 4). Outstanding validation leases are invalidated.
CREATE FUNCTION admin_set_provider_enabled(p_provider text, p_expected_revision bigint, p_enabled boolean)
RETURNS TABLE (revision bigint, enabled boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
BEGIN
  PERFORM check_credential_provider(p_provider);
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled flag required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO provider_credentials (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'BZ409';
  END IF;
  IF p_enabled THEN
    IF v_row.active_version IS NULL THEN
      RAISE EXCEPTION 'no active credential to enable' USING ERRCODE = 'BZ409';
    END IF;
    UPDATE provider_credentials c SET enabled = true, revision = c.revision + 1, updated_at = now(),
           updated_by = v_admin
     WHERE c.provider = p_provider RETURNING c.revision, c.enabled INTO revision, enabled;
  ELSE
    UPDATE provider_credentials c
       SET enabled = false, revision = c.revision + 1, active_version = NULL, active_envelope = NULL,
           candidate_version = NULL, candidate_envelope = NULL, candidate_status = NULL,
           candidate_validation = '{}', validation_token = NULL, validation_until = NULL,
           updated_at = now(), updated_by = v_admin
     WHERE c.provider = p_provider RETURNING c.revision, c.enabled INTO revision, enabled;
  END IF;
  RETURN NEXT;
END;
$$;

-- ── Publication consent and library versions (spec 02 §3.6, §6; spec 05 §8.1) ─────────────────
-- Lock order: the original creator's users row, the card, the request.

CREATE FUNCTION admin_request_card_publication(p_card_id bigint, p_payload jsonb, p_expires_at timestamptz)
RETURNS TABLE (request_id bigint, version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_creator uuid;
  v_card interest_cards%ROWTYPE;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 16384
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('slug','title','topic_ids','i18n')) THEN
    RAISE EXCEPTION 'invalid publication payload' USING ERRCODE = '22023';
  END IF;
  SELECT c.creator_user_id INTO v_creator FROM interest_cards c WHERE c.id = p_card_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'card not found' USING ERRCODE = 'BZ404';
  END IF;
  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'card has no known creator' USING ERRCODE = 'BZ409';
  END IF;
  PERFORM 1 FROM users u WHERE u.id = v_creator AND u.deleted_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'card creator is deleted' USING ERRCODE = 'BZ409';
  END IF;
  SELECT * INTO v_card FROM interest_cards c WHERE c.id = p_card_id FOR UPDATE;
  IF v_card.visibility <> 'shared' OR v_card.origin <> 'user' OR v_card.creator_user_id IS DISTINCT FROM v_creator THEN
    RAISE EXCEPTION 'only shared user cards can be proposed for publication' USING ERRCODE = 'BZ409';
  END IF;
  -- A label's title is hashed card text, never publication metadata.
  IF v_card.kind = 'label' AND p_payload ? 'title' AND p_payload->>'title' IS DISTINCT FROM v_card.title THEN
    RAISE EXCEPTION 'a label title cannot change' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO card_publication_requests AS r (user_id, card_id, requested_by, card_text_hash, publication_payload,
                                               publication_sha, expires_at)
    VALUES (v_creator, p_card_id, v_admin, v_card.text_hash, p_payload,
            encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex'), p_expires_at)
    RETURNING r.id, r.version INTO request_id, version;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'a publication request is already open for this card' USING ERRCODE = 'BZ409';
  END;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION admin_list_card_publication_requests(p_status text)
RETURNS TABLE (id bigint, card_id bigint, card_title text, card_text_hash text, status text, version bigint,
               requested_at timestamptz, expires_at timestamptz, responded_at timestamptz,
               publication_payload jsonb, publication_sha text, creator_known boolean,
               creator_last_active_at timestamptz, holders int, vetoed boolean,
               authorization_kind text, promoted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM require_admin_session();
  RETURN QUERY
    SELECT r.id, r.card_id, c.title, r.card_text_hash, r.status, r.version, r.requested_at, r.expires_at,
           r.responded_at, r.publication_payload, r.publication_sha,
           (u.id IS NOT NULL AND u.deleted_at IS NULL), u.last_active_at,
           ((SELECT count(*) FROM user_cards uc JOIN users hu ON hu.id = uc.user_id
              WHERE uc.card_id = r.card_id AND hu.deleted_at IS NULL)
          + (SELECT count(*) FROM user_labels ul JOIN users hu ON hu.id = ul.user_id
              WHERE ul.card_id = r.card_id AND hu.deleted_at IS NULL))::int,
           c.publication_veto_at IS NOT NULL, r.authorization_kind, r.promoted_at
      FROM card_publication_requests r
      JOIN interest_cards c ON c.id = r.card_id AND c.visibility <> 'private'
      LEFT JOIN users u ON u.id = r.user_id
     WHERE p_status IS NULL OR r.status = p_status
     ORDER BY r.requested_at DESC, r.id DESC;
END;
$$;

-- The authenticated original author's genuine response. A decline sets the durable veto; only a later
-- approval of an exact proposal by the same creator clears it. Transitions: pending → approved|rejected,
-- approved → rejected (consent can be withdrawn before promotion); rejected is final.
CREATE FUNCTION respond_card_publication(p_request_id bigint, p_expected_version bigint, p_approve boolean)
RETURNS TABLE (status text, version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := active_tenant();
  v_owner uuid;
  v_card_id bigint;
  v_card interest_cards%ROWTYPE;
  v_req card_publication_requests%ROWTYPE;
BEGIN
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'approve flag required' USING ERRCODE = '22023';
  END IF;
  SELECT r.user_id, r.card_id INTO v_owner, v_card_id FROM card_publication_requests r WHERE r.id = p_request_id;
  IF NOT FOUND OR v_owner IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'publication request not found' USING ERRCODE = 'BZ404';
  END IF;
  PERFORM 1 FROM users u WHERE u.id = v_user FOR NO KEY UPDATE;
  SELECT * INTO v_card FROM interest_cards c WHERE c.id = v_card_id FOR UPDATE;
  SELECT * INTO v_req FROM card_publication_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF v_card.creator_user_id IS DISTINCT FROM v_user OR v_req.user_id IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'only the original author can respond' USING ERRCODE = '42501';
  END IF;
  IF v_req.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale publication request version' USING ERRCODE = 'BZ409';
  END IF;
  IF NOT (v_req.status = 'pending' OR (v_req.status = 'approved' AND NOT p_approve))
     OR (v_req.expires_at IS NOT NULL AND v_req.expires_at <= now())
     OR v_card.text_hash <> v_req.card_text_hash THEN
    RAISE EXCEPTION 'publication request cannot be answered' USING ERRCODE = 'BZ409';
  END IF;
  -- The response flag authorizes exactly these two writes (integrity triggers, 0004).
  PERFORM set_config('bantoozi.card_publication_response', v_card_id::text, true);
  UPDATE card_publication_requests r
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         responded_at = now(), version = r.version + 1
   WHERE r.id = p_request_id
  RETURNING r.status, r.version INTO status, version;
  UPDATE interest_cards c SET publication_veto_at = CASE WHEN p_approve THEN NULL ELSE now() END
   WHERE c.id = v_card_id;
  PERFORM set_config('bantoozi.card_publication_response', '', true);
  RETURN NEXT;
END;
$$;

-- Promote an eligible shared card (≥ 3 active holders) to the public library: genuine exact approval,
-- or verified 30-day (720 h) inactivity of the known original creator, measured against a timestamp
-- captured after the locks. The chosen authorization evidence is recorded atomically with visibility.
CREATE FUNCTION admin_promote_card(p_request_id bigint, p_expected_version bigint)
RETURNS TABLE (card_id bigint, authorization_kind text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_creator_id uuid;
  v_card_id bigint;
  v_creator users%ROWTYPE;
  v_card interest_cards%ROWTYPE;
  v_req card_publication_requests%ROWTYPE;
  v_now timestamptz;
  v_holders int;
  v_kind text;
  v_evidence jsonb;
  v_anchor timestamptz;
  v_anchor_source text;
BEGIN
  SELECT r.user_id, r.card_id INTO v_creator_id, v_card_id FROM card_publication_requests r WHERE r.id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication request not found' USING ERRCODE = 'BZ404';
  END IF;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION 'the creator was erased; this request can never be promoted' USING ERRCODE = 'BZ409';
  END IF;
  SELECT * INTO v_creator FROM users u WHERE u.id = v_creator_id FOR NO KEY UPDATE;
  SELECT * INTO v_card FROM interest_cards c WHERE c.id = v_card_id FOR UPDATE;
  SELECT * INTO v_req FROM card_publication_requests r WHERE r.id = p_request_id FOR UPDATE;
  v_now := clock_timestamp();
  IF v_creator.id IS NULL OR v_creator.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'creator provenance missing or deleted' USING ERRCODE = 'BZ409';
  END IF;
  IF v_req.version <> p_expected_version OR v_req.status NOT IN ('pending','approved')
     OR v_req.user_id IS DISTINCT FROM v_creator.id OR v_card.creator_user_id IS DISTINCT FROM v_creator.id
     OR (v_req.expires_at IS NOT NULL AND v_req.expires_at <= v_now)
     OR v_card.visibility <> 'shared' OR v_card.origin <> 'user' OR v_card.retired_at IS NOT NULL
     OR v_card.text_hash <> v_req.card_text_hash
     OR v_req.publication_sha <> encode(digest(convert_to(v_req.publication_payload::text, 'UTF8'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'publication request is stale' USING ERRCODE = 'BZ409';
  END IF;
  IF v_card.publication_veto_at IS NOT NULL THEN
    RAISE EXCEPTION 'the creator declined publication' USING ERRCODE = 'BZ409';
  END IF;
  SELECT count(DISTINCT h.user_id)::int INTO v_holders FROM (
      SELECT uc.user_id FROM user_cards uc WHERE uc.card_id = v_card_id
      UNION SELECT ul.user_id FROM user_labels ul WHERE ul.card_id = v_card_id) h
    JOIN users hu ON hu.id = h.user_id AND hu.deleted_at IS NULL;
  IF v_holders < 3 THEN
    RAISE EXCEPTION 'card is not eligible (fewer than three holders)' USING ERRCODE = 'BZ409';
  END IF;

  IF v_req.status = 'approved' AND v_req.responded_at IS NOT NULL THEN
    v_kind := 'creator_approval';
    v_evidence := jsonb_build_object(
      'policyVersion', 1, 'creatorUserId', v_creator.id, 'cardTextHash', v_req.card_text_hash,
      'publicationSha', v_req.publication_sha, 'requestVersion', v_req.version::text,
      'respondedAt', to_char(v_req.responded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'approvedVersion', v_req.version::text);
  ELSE
    IF v_creator.last_active_at IS NOT NULL THEN
      v_anchor := v_creator.last_active_at; v_anchor_source := 'last_active_at';
    ELSE
      v_anchor := v_creator.created_at; v_anchor_source := 'created_at';
    END IF;
    IF v_now - v_anchor < interval '720 hours' THEN
      RAISE EXCEPTION 'the creator was active within 30 days and has not approved' USING ERRCODE = 'BZ409';
    END IF;
    v_kind := 'creator_inactive_30d';
    v_evidence := jsonb_build_object(
      'policyVersion', 1, 'creatorUserId', v_creator.id, 'cardTextHash', v_req.card_text_hash,
      'publicationSha', v_req.publication_sha, 'requestVersion', v_req.version::text,
      'anchorSource', v_anchor_source,
      'anchorAt', to_char(v_anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'checkedAt', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  END IF;

  -- The promotion flag authorizes exactly these two writes (integrity triggers, 0004).
  PERFORM set_config('bantoozi.card_promotion', v_card_id::text, true);
  UPDATE interest_cards c
     SET visibility = 'public',
         slug = coalesce(v_req.publication_payload->>'slug', c.slug),
         title = coalesce(v_req.publication_payload->>'title', c.title),
         topic_ids = CASE WHEN v_req.publication_payload ? 'topic_ids'
                          THEN ARRAY(SELECT jsonb_array_elements_text(v_req.publication_payload->'topic_ids'))
                          ELSE c.topic_ids END,
         i18n = coalesce(v_req.publication_payload->'i18n', c.i18n)
   WHERE c.id = v_card_id;
  UPDATE card_publication_requests r
     SET status = 'promoted', promoted_at = v_now, promoted_by = v_admin,
         authorization_kind = v_kind, authorization_evidence = v_evidence
   WHERE r.id = p_request_id;
  PERFORM set_config('bantoozi.card_promotion', '', true);
  card_id := v_card_id;
  authorization_kind := v_kind;
  RETURN NEXT;
END;
$$;

-- Append the next immutable semantic version of a library card and move the slug alias to it. Existing
-- holdings are never re-pointed (opt-in upgrades, spec 05 §8).
CREATE FUNCTION admin_publish_library_card_version(p_slug text, p_card_id bigint, p_expected_version int)
RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := require_admin_session();
  v_current int;
  v_previous bigint;
  v_visibility text;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{0,99}$' THEN
    RAISE EXCEPTION 'invalid library slug' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('library:' || p_slug));
  -- Only public library content can be a version: never a way to relabel user material (§3.6).
  SELECT c.visibility INTO v_visibility FROM interest_cards c WHERE c.id = p_card_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'card not found' USING ERRCODE = 'BZ404';
  END IF;
  IF v_visibility <> 'public' THEN
    RAISE EXCEPTION 'only public library cards can be library versions' USING ERRCODE = 'BZ409';
  END IF;
  SELECT max(v.version) INTO v_current FROM library_card_versions v WHERE v.library_slug = p_slug;
  IF v_current IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'stale library version' USING ERRCODE = 'BZ409';
  END IF;
  IF v_current IS NOT NULL THEN
    SELECT v.card_id INTO v_previous FROM library_card_versions v
     WHERE v.library_slug = p_slug AND v.version = v_current;
    UPDATE interest_cards c SET slug = NULL WHERE c.id = v_previous AND c.slug = p_slug;
  END IF;
  INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
  VALUES (p_slug, coalesce(v_current, 0) + 1, p_card_id, v_previous);
  UPDATE interest_cards c SET slug = p_slug WHERE c.id = p_card_id;
  RETURN coalesce(v_current, 0) + 1;
END;
$$;

-- ── EXECUTE grants ──────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION active_tenant(), snapshot_content_sha256(text, text, timestamptz, text, text, text),
  mark_snapshot_if_unreferenced(bigint), require_admin_session(), check_credential_provider(text),
  valid_credential_envelope(jsonb) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION refresh_feed_cards(bigint[]), refresh_feed_subscribers(bigint[], jsonb),
  admin_card_holders(bigint[]), admin_usage_attribution(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_feed_cards(bigint[]), refresh_feed_subscribers(bigint[], jsonb),
  admin_card_holders(bigint[]), admin_usage_attribution(int) TO bantoozi_app, bantoozi_worker;

REVOKE EXECUTE ON FUNCTION rate_limit_hit(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_hit(text, int, int) TO bantoozi_app;

REVOKE EXECUTE ON FUNCTION record_card_translation(uuid, int, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_card_translation(uuid, int, int, text, text) TO bantoozi_app, bantoozi_worker;

REVOKE EXECUTE ON FUNCTION capture_bookmark_snapshot(bigint, bigint), clear_bookmark_snapshot(bigint),
  restore_bookmark_snapshot(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION capture_bookmark_snapshot(bigint, bigint), clear_bookmark_snapshot(bigint),
  restore_bookmark_snapshot(bigint, uuid) TO bantoozi_app;

REVOKE EXECUTE ON FUNCTION admin_provider_credentials_metadata(),
  admin_stage_provider_credential(text, bigint, jsonb), admin_activate_provider_credential(text, bigint, bigint),
  admin_set_provider_enabled(text, bigint, boolean), admin_validate_provider_credential(text, bigint, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_provider_credentials_metadata(),
  admin_stage_provider_credential(text, bigint, jsonb), admin_activate_provider_credential(text, bigint, bigint),
  admin_set_provider_enabled(text, bigint, boolean), admin_validate_provider_credential(text, bigint, bigint)
  TO bantoozi_app;

REVOKE EXECUTE ON FUNCTION admin_request_card_publication(bigint, jsonb, timestamptz),
  admin_list_card_publication_requests(text), respond_card_publication(bigint, bigint, boolean),
  admin_promote_card(bigint, bigint), admin_publish_library_card_version(text, bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_request_card_publication(bigint, jsonb, timestamptz),
  admin_list_card_publication_requests(text), respond_card_publication(bigint, bigint, boolean),
  admin_promote_card(bigint, bigint), admin_publish_library_card_version(text, bigint, int) TO bantoozi_app;
