-- Hand-written (M1-T7; spec 02 §5.2 and §6, spec 03 §7, §8.5 and §9; D-13 to D-16): worker-side
-- ingestion.
--
-- 1. Bookmark capture completion is worker-only and generation-fenced (spec 02 §6, spec 03 §8.5). The
--    worker stores a captured snapshot with the same canonical checksum as the API-side capture
--    helper, and records final-reference lifecycle state when it replaces a partial binding, so it
--    needs EXECUTE on both helpers (still revoked from PUBLIC and never granted to the API role).
GRANT EXECUTE ON FUNCTION snapshot_content_sha256(text, text, timestamptz, text, text, text),
  mark_snapshot_if_unreferenced(bigint) TO bantoozi_worker;

-- 2. A feed identity merge (spec 03 §9) advances every merged subscription's inference_version
--    beyond both prior versions, gives a moved active subscription a new activation boundary at the
--    merge, and keeps the later activation of two active duplicates, even when the mode itself does
--    not change. The API role keeps the mode-change rules of spec 02 §3.4 unchanged; any other role
--    (the worker's merge transaction, the owner) may only strictly advance the version, and never
--    moves an activation boundary into the future. The table CHECK still ties activation to 'active'.
CREATE OR REPLACE FUNCTION subscriptions_inference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'bantoozi_app' AND (NEW.inference_mode <> 'off' OR NEW.inference_version <> 0
                                          OR NEW.inference_activated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a new subscription starts with inference off'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR (NEW.feed_id <> OLD.feed_id AND current_user = 'bantoozi_app') THEN
    RAISE EXCEPTION 'subscription identity is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF current_user <> 'bantoozi_app' AND NEW.inference_version > OLD.inference_version THEN
    -- Identity merge: a strictly advanced generation, with an activation that is kept or not later
    -- than the merge transaction.
    IF NEW.inference_activated_at IS DISTINCT FROM OLD.inference_activated_at
       AND NEW.inference_activated_at > now() THEN
      RAISE EXCEPTION 'an activation boundary cannot be in the future'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.inference_mode <> OLD.inference_mode THEN
    IF NEW.inference_version <> OLD.inference_version + 1
       OR (NEW.inference_mode = 'active' AND NEW.inference_activated_at IS DISTINCT FROM now()) THEN
      RAISE EXCEPTION 'an inference mode change must advance the version and activation time'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
  ELSIF NEW.inference_version <> OLD.inference_version
        OR NEW.inference_activated_at IS DISTINCT FROM OLD.inference_activated_at THEN
    RAISE EXCEPTION 'inference version and activation change only with the mode'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. GUIDs are opaque identifiers of up to 4,096 characters that are never truncated (spec 03 §6),
--    but a B-tree index entry cannot exceed about 2.7 KB, so a long GUID failed its item on every
--    fetch (SQLSTATE 54000). The per-feed uniqueness is enforced on md5(guid) instead: a fixed-size
--    key for any GUID length. Lookups still compare the GUID itself; a collision could only turn an
--    item of the same feed into an identity conflict, never cross feeds (D-15).
DROP INDEX feed_items_guid_idx;
CREATE UNIQUE INDEX feed_items_guid_idx ON feed_items USING btree (feed_id, md5(guid))
  WHERE guid IS NOT NULL;

-- 4. Ingest stores the publisher's own feed text as a revisioned body with a feed extractor version
--    (`feed-v1`, spec 03 §6 and §7): complete for a linkless item, partial for a linked one until page
--    extraction replaces it. A bookmark snapshot copied from such a body must record feed provenance,
--    not page provenance (spec 03 §8.1 step 6, §8.5); only that assignment changes (D-16).
CREATE OR REPLACE FUNCTION capture_bookmark_snapshot(p_article_id bigint, p_origin_feed_id bigint)
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
    v_source := CASE WHEN v_body.extractor_version LIKE 'feed-%' THEN 'feed' ELSE 'page' END;
    v_extractor := v_body.extractor_version;
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
