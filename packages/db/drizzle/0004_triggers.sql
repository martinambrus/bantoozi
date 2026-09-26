-- Hand-written (spec 02 §5.2): integrity triggers Drizzle cannot express. PostgreSQL FKs bypass RLS
-- and array/JSON elements are not FKs, so API validation alone does not enforce these invariants.
--
-- Trigger functions are owned by bantoozi_owner with PUBLIC execute revoked; firing a trigger needs no
-- EXECUTE privilege. Checks that must see the true rows whatever the writer's RLS view run SECURITY
-- DEFINER. Guards whose rules depend on the writing role (a direct bantoozi_app statement vs. the
-- worker vs. a SECURITY DEFINER function running as the owner) run SECURITY INVOKER, so current_user
-- is the role of the statement. Violations raise 23514 (check_violation) naming the trigger as the
-- constraint, without private values.
--
-- Transaction-local flags (set_config(..., true)) name the single card a vetted transaction may change:
--   bantoozi.card_promotion            — admin_promote_card (shared → public, promotion evidence)
--   bantoozi.card_publication_response — respond_card_publication (veto, genuine response)
--   bantoozi.card_retranslation        — the worker's audited full-pair retranslation/reset (spec 07 §5)
-- The API role cannot write the guarded columns at all (column grants, 0002); the flags keep the worker
-- and owner paths honest too.

-- ── Card holdings (user_cards, user_labels, card_suggestions) ───────────────────────────────────
-- The card exists, is public/shared or owned by NEW.user_id, and has the table's kind (TG_ARGV[0]).
CREATE FUNCTION card_holding_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM interest_cards c
       WHERE c.id = NEW.card_id AND c.kind = TG_ARGV[0]
         AND (c.visibility IN ('public','shared') OR c.owner_user_id = NEW.user_id)) THEN
    RAISE EXCEPTION 'card holding is not allowed'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_cards_card_check BEFORE INSERT OR UPDATE OF user_id, card_id ON user_cards
  FOR EACH ROW EXECUTE FUNCTION card_holding_check('interest');
CREATE TRIGGER user_labels_card_check BEFORE INSERT OR UPDATE OF user_id, card_id ON user_labels
  FOR EACH ROW EXECUTE FUNCTION card_holding_check('label');
CREATE TRIGGER card_suggestions_card_check BEFORE INSERT OR UPDATE OF user_id, card_id ON card_suggestions
  FOR EACH ROW EXECUTE FUNCTION card_holding_check('interest');

-- ── Interest cards ──────────────────────────────────────────────────────────────────────────────

-- State of the derived English pair in a card body (spec 05 §5.1): 'absent' (both null/missing),
-- 'complete' (non-empty interest_en, and not_for_en exactly when the card has a not_for), else 'invalid'.
CREATE FUNCTION card_en_pair_state(p_body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(p_body -> 'interest_en'), 'null') = 'null'
     AND coalesce(jsonb_typeof(p_body -> 'not_for_en'), 'null') = 'null' THEN 'absent'
    WHEN coalesce(jsonb_typeof(p_body -> 'interest_en') = 'string' AND btrim(p_body ->> 'interest_en') <> '', false)
     AND CASE WHEN coalesce(jsonb_typeof(p_body -> 'not_for') = 'string' AND btrim(p_body ->> 'not_for') <> '', false)
              THEN coalesce(jsonb_typeof(p_body -> 'not_for_en') = 'string' AND btrim(p_body ->> 'not_for_en') <> '', false)
              ELSE coalesce(jsonb_typeof(p_body -> 'not_for_en'), 'null') = 'null' END THEN 'complete'
    ELSE 'invalid' END;
$$;

-- Content on insert and change: a valid English pair, and every topic_ids entry an existing topic.
CREATE FUNCTION interest_cards_content_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF card_en_pair_state(NEW.body) = 'invalid' THEN
    RAISE EXCEPTION 'card translation pair is incomplete'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.topic_ids) AS t(id)
              WHERE t.id IS NULL OR NOT EXISTS (SELECT 1 FROM topics x WHERE x.id = t.id)) THEN
    RAISE EXCEPTION 'card references an unknown topic'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER interest_cards_content_check BEFORE INSERT OR UPDATE OF body, topic_ids ON interest_cards
  FOR EACH ROW EXECUTE FUNCTION interest_cards_content_check();

-- Immutable identity and the only permitted in-place transitions (spec 02 §3.6, §5.2; spec 05 §5.1).
CREATE FUNCTION interest_cards_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  -- Identity never changes, whoever writes: kind, text hash, language, origin, access owner,
  -- base text/examples, and a label's (hashed) title.
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.text_hash <> OLD.text_hash OR NEW.lang <> OLD.lang
     OR NEW.origin <> OLD.origin OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.created_at <> OLD.created_at
     OR (NEW.body - 'interest_en' - 'not_for_en') <> (OLD.body - 'interest_en' - 'not_for_en')
     OR (OLD.kind = 'label' AND NEW.title <> OLD.title) THEN
    RAISE EXCEPTION 'card identity is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- Authorship: cleared only by the original author's account erasure, never reassigned.
  IF NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id AND NOT (
       NEW.creator_user_id IS NULL AND current_user <> 'bantoozi_app'
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.creator_user_id AND u.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'card authorship is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- Fork provenance: cleared only when the parent card itself was deleted (ON DELETE SET NULL).
  IF NEW.parent_card_id IS DISTINCT FROM OLD.parent_card_id AND NOT (
       NEW.parent_card_id IS NULL AND current_user <> 'bantoozi_app'
       AND NOT EXISTS (SELECT 1 FROM interest_cards p WHERE p.id = OLD.parent_card_id)) THEN
    RAISE EXCEPTION 'card provenance is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- Derived English pair: initial fill of an absent pair, or an explicit audited full-pair
  -- retranslation/reset of this card. Partial or silent overwrites are rejected.
  IF jsonb_build_object('i', OLD.body -> 'interest_en', 'n', OLD.body -> 'not_for_en')
     <> jsonb_build_object('i', NEW.body -> 'interest_en', 'n', NEW.body -> 'not_for_en') THEN
    IF NOT ((card_en_pair_state(OLD.body) = 'absent' AND card_en_pair_state(NEW.body) = 'complete')
            OR (coalesce(current_setting('bantoozi.card_retranslation', true), '') = OLD.id::text
                AND card_en_pair_state(NEW.body) IN ('complete','absent'))) THEN
      RAISE EXCEPTION 'card translation pair can only be filled once or retranslated explicitly'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
  END IF;

  -- Visibility: private forks are never promoted; shared → public only in the promotion transaction.
  IF NEW.visibility <> OLD.visibility AND NOT (
       OLD.visibility = 'shared' AND NEW.visibility = 'public' AND OLD.publication_veto_at IS NULL
       AND coalesce(current_setting('bantoozi.card_promotion', true), '') = OLD.id::text) THEN
    RAISE EXCEPTION 'card visibility cannot change here'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- The durable creator veto is maintained only by the original author's response function.
  IF NEW.publication_veto_at IS DISTINCT FROM OLD.publication_veto_at
     AND coalesce(current_setting('bantoozi.card_publication_response', true), '') <> OLD.id::text THEN
    RAISE EXCEPTION 'publication veto is maintained by the creator response only'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- Non-admin API writes may only un-retire an otherwise identical accessible row.
  IF current_user = 'bantoozi_app' AND NOT EXISTS (
       SELECT 1 FROM users u WHERE u.id = v_tenant AND u.role = 'admin' AND u.deleted_at IS NULL) THEN
    IF (to_jsonb(NEW) - 'retired_at') <> (to_jsonb(OLD) - 'retired_at')
       OR (NEW.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
      RAISE EXCEPTION 'only an administrator can change card metadata'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER interest_cards_guard BEFORE UPDATE ON interest_cards
  FOR EACH ROW EXECUTE FUNCTION interest_cards_guard();

-- ── Topics: level-2 parents are level 1; referenced topic IDs are never deleted or renamed ─────
CREATE FUNCTION topics_parent_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.level = 2 AND NOT EXISTS (SELECT 1 FROM topics p WHERE p.id = NEW.parent_id AND p.level = 1) THEN
    RAISE EXCEPTION 'a level-2 topic needs a level-1 parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF NEW.level <> 1 AND EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'a topic with children must stay level 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;

-- AFTER ROW: fires at the end of the statement, so one seeding INSERT may carry parents and children.
CREATE TRIGGER topics_parent_check AFTER INSERT OR UPDATE OF level, parent_id ON topics
  FOR EACH ROW EXECUTE FUNCTION topics_parent_check();

CREATE FUNCTION topics_reference_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (TG_OP = 'DELETE' OR NEW.id <> OLD.id)
     AND EXISTS (SELECT 1 FROM interest_cards c WHERE c.topic_ids @> ARRAY[OLD.id]) THEN
    RAISE EXCEPTION 'topic is still referenced by cards'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER topics_reference_check BEFORE DELETE OR UPDATE OF id ON topics
  FOR EACH ROW EXECUTE FUNCTION topics_reference_check();

-- ── Label assignment integrity (deferred: validates the final row state at commit) ─────────────
CREATE FUNCTION user_article_labels_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_labels bigint[];
  v_suggestions bigint[];
BEGIN
  SELECT ua.label_ids, ua.label_suggestions INTO v_labels, v_suggestions
    FROM user_article ua WHERE ua.user_id = NEW.user_id AND ua.article_id = NEW.article_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF array_position(v_labels, NULL) IS NOT NULL OR array_position(v_suggestions, NULL) IS NOT NULL
     OR cardinality(v_labels) <> (SELECT count(DISTINCT x) FROM unnest(v_labels) AS x)
     OR cardinality(v_suggestions) <> (SELECT count(DISTINCT x) FROM unnest(v_suggestions) AS x)
     OR v_labels && v_suggestions
     OR EXISTS (SELECT 1 FROM unnest(v_labels || v_suggestions) AS l(card_id)
                 WHERE NOT EXISTS (SELECT 1 FROM user_labels ul
                                    WHERE ul.user_id = NEW.user_id AND ul.card_id = l.card_id)) THEN
    RAISE EXCEPTION 'article labels must be distinct labels the user holds'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER user_article_labels_check
  AFTER INSERT OR UPDATE OF label_ids, label_suggestions ON user_article
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (cardinality(NEW.label_ids) + cardinality(NEW.label_suggestions) > 0)
  EXECUTE FUNCTION user_article_labels_check();

-- A removed or re-pointed label must no longer be assigned or suggested anywhere for its user.
CREATE FUNCTION user_labels_removal_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_labels ul WHERE ul.user_id = OLD.user_id AND ul.card_id = OLD.card_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM user_article ua
              WHERE ua.user_id = OLD.user_id
                AND (OLD.card_id = ANY (ua.label_ids) OR OLD.card_id = ANY (ua.label_suggestions))) THEN
    RAISE EXCEPTION 'a removed label is still assigned'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER user_labels_removal_check
  AFTER DELETE OR UPDATE OF user_id, card_id ON user_labels
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION user_labels_removal_check();

-- ── Inference gate generation (spec 02 §3.4) ────────────────────────────────────────────────────
-- Every new API subscription starts off. A mode change increments inference_version by one and sets
-- inference_activated_at to the activation transaction time when entering active; reapplying a mode
-- changes nothing. Only vetted worker merges may relocate a subscription to another feed.
CREATE FUNCTION subscriptions_inference_guard() RETURNS trigger
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

CREATE TRIGGER subscriptions_inference_guard BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_inference_guard();

-- Manual request creation: the active tenant, a live training/active subscription at this exact
-- inference version, an actual carrier of the article, the current article revision, and the frozen
-- input hash. input_sha = hex sha256 of input_snapshot::text (PostgreSQL's normalized jsonb text).
CREATE FUNCTION analysis_requests_insert_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
     OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'an analysis request needs its active tenant'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions s
                  WHERE s.user_id = NEW.user_id AND s.feed_id = NEW.feed_id
                    AND s.inference_mode IN ('training','active')
                    AND s.inference_version = NEW.inference_version)
     OR NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.feed_id = NEW.feed_id AND fi.article_id = NEW.article_id)
     OR NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = NEW.article_id AND a.content_revision = NEW.article_revision) THEN
    RAISE EXCEPTION 'analysis request is not authorized by a live subscription and carrier'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF jsonb_typeof(NEW.input_snapshot) <> 'object'
     OR NEW.input_sha <> encode(sha256(convert_to(NEW.input_snapshot::text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'analysis request input hash does not match its snapshot'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF NEW.status <> 'pending' OR NEW.result_snapshot IS NOT NULL OR NEW.lease_token IS NOT NULL
     OR NEW.attempts <> 0 OR NEW.completed_at IS NOT NULL OR NEW.last_error_code IS NOT NULL THEN
    RAISE EXCEPTION 'a new analysis request starts pending'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_requests_insert_check BEFORE INSERT ON analysis_requests
  FOR EACH ROW EXECUTE FUNCTION analysis_requests_insert_check();

-- The frozen input is immutable; finished requests are final; a stored result never changes. Vetted
-- feed/article identity merges may relocate the operational FKs (feed_id, article_id) only.
CREATE FUNCTION analysis_requests_update_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.article_revision <> OLD.article_revision
     OR NEW.inference_version <> OLD.inference_version OR NEW.input_snapshot <> OLD.input_snapshot
     OR NEW.input_sha <> OLD.input_sha OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'analysis request input is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF (OLD.result_snapshot IS NOT NULL AND (NEW.result_snapshot IS DISTINCT FROM OLD.result_snapshot
                                           OR NEW.result_sha IS DISTINCT FROM OLD.result_sha))
     OR (OLD.status IN ('complete','failed','cancelled')
         AND (NEW.status <> OLD.status OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
              OR NEW.result_snapshot IS DISTINCT FROM OLD.result_snapshot
              OR NEW.lease_token IS NOT NULL OR NEW.attempts <> OLD.attempts
              OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code)) THEN
    RAISE EXCEPTION 'a finished analysis request is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_requests_update_check BEFORE UPDATE ON analysis_requests
  FOR EACH ROW EXECUTE FUNCTION analysis_requests_update_check();

-- ── Bookmark binding: snapshot payload/provenance is immutable ─────────────────────────────────
-- Only lifecycle (cold_at, unreferenced_at) and a vetted article-merge relocation (article_id) change
-- in place; those columns are not in the trigger's column list, so lifecycle updates never compare
-- (or detoast) the archived bodies.
CREATE FUNCTION article_snapshots_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.source_revision <> OLD.source_revision OR NEW.captured_at <> OLD.captured_at
     OR NEW.source_url IS DISTINCT FROM OLD.source_url OR NEW.title <> OLD.title
     OR NEW.author IS DISTINCT FROM OLD.author OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.body_text <> OLD.body_text OR NEW.body_html IS DISTINCT FROM OLD.body_html
     OR NEW.content_sha256 <> OLD.content_sha256 OR NEW.completeness <> OLD.completeness
     OR NEW.completeness_reason IS DISTINCT FROM OLD.completeness_reason OR NEW.source <> OLD.source
     OR NEW.extractor_version <> OLD.extractor_version THEN
    RAISE EXCEPTION 'snapshot content and provenance are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER article_snapshots_guard
  BEFORE UPDATE OF id, source_revision, captured_at, source_url, title, author, published_at, body_text,
                   body_html, content_sha256, completeness, completeness_reason, source, extractor_version
  ON article_snapshots
  FOR EACH ROW EXECUTE FUNCTION article_snapshots_guard();

-- An undo pin is a new reference: attaching it clears the snapshot's unreferenced marker (§3.5), so
-- GC's seven-day delay counts from the final release, never while an undo is still possible.
CREATE FUNCTION bookmark_snapshot_pins_attach() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE article_snapshots s SET unreferenced_at = NULL
   WHERE s.id = NEW.snapshot_id AND s.unreferenced_at IS NOT NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER bookmark_snapshot_pins_attach AFTER INSERT ON bookmark_snapshot_pins
  FOR EACH ROW EXECUTE FUNCTION bookmark_snapshot_pins_attach();

-- ── Original-author publication (spec 02 §3.6) ──────────────────────────────────────────────────
-- Insert: the requester row belongs to the card's immutable creator, with the card's exact text hash
-- and the proposal's hash (hex sha256 of publication_payload::text), and starts pending.
-- Update: genuine responses only through the creator's response function, promotion only in the
-- promotion transaction, finished requests stay final, and published authorization evidence is
-- immutable except that the creator's erasure nulls creatorUserId (with user_id already null).
CREATE FUNCTION card_publication_requests_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_response boolean := coalesce(current_setting('bantoozi.card_publication_response', true), '') = NEW.card_id::text;
  v_promotion boolean := coalesce(current_setting('bantoozi.card_promotion', true), '') = NEW.card_id::text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM interest_cards c WHERE c.id = NEW.card_id AND c.creator_user_id = NEW.user_id
            AND c.text_hash = NEW.card_text_hash)
       OR NEW.publication_sha <> encode(sha256(convert_to(NEW.publication_payload::text, 'UTF8')), 'hex')
       OR NEW.status <> 'pending' OR NEW.responded_at IS NOT NULL OR NEW.authorization_kind IS NOT NULL
       OR NEW.promoted_at IS NOT NULL OR NEW.promoted_by IS NOT NULL THEN
      RAISE EXCEPTION 'publication request must be a pending proposal for the card''s creator'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.card_id <> OLD.card_id OR NEW.requested_at <> OLD.requested_at
     OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
     OR (NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL)
     OR NEW.version < OLD.version THEN
    RAISE EXCEPTION 'publication request identity is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- A changed proposal is a new version awaiting a fresh response.
  IF (NEW.card_text_hash <> OLD.card_text_hash OR NEW.publication_payload <> OLD.publication_payload
      OR NEW.publication_sha <> OLD.publication_sha)
     AND NOT (OLD.status IN ('pending','approved') AND NEW.status = 'pending' AND NEW.version > OLD.version
              AND NEW.responded_at IS NULL
              AND NEW.publication_sha = encode(sha256(convert_to(NEW.publication_payload::text, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'a changed proposal needs a new version'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  -- A request whose creator was erased (user_id NULL) can never be answered or promoted (§3.6).
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('approved','rejected') AND v_response AND NEW.user_id IS NOT NULL)
    OR (OLD.status = 'approved' AND NEW.status = 'rejected' AND v_response AND NEW.user_id IS NOT NULL)
    OR (OLD.status = 'approved' AND NEW.status = 'pending' AND NEW.version > OLD.version)
    OR (OLD.status IN ('pending','approved') AND NEW.status = 'expired')
    OR (OLD.status IN ('pending','approved') AND NEW.status = 'promoted' AND v_promotion
        AND NEW.user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'publication request status cannot change this way'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  IF NEW.responded_at IS DISTINCT FROM OLD.responded_at AND NOT v_response
     AND NOT (NEW.responded_at IS NULL AND NEW.status = 'pending' AND NEW.version > OLD.version) THEN
    RAISE EXCEPTION 'only the creator response records a response'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  IF OLD.status = 'promoted' THEN
    IF NEW.authorization_kind IS DISTINCT FROM OLD.authorization_kind
       OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at
       OR (NEW.promoted_by IS DISTINCT FROM OLD.promoted_by AND NEW.promoted_by IS NOT NULL)
       OR (NEW.authorization_evidence IS DISTINCT FROM OLD.authorization_evidence AND NOT (
             NEW.user_id IS NULL
             AND NEW.authorization_evidence = jsonb_set(OLD.authorization_evidence, '{creatorUserId}', 'null'::jsonb))) THEN
      RAISE EXCEPTION 'published authorization evidence is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
    END IF;
  ELSIF NEW.status <> 'promoted'
        AND (NEW.authorization_kind IS NOT NULL OR NEW.promoted_at IS NOT NULL OR NEW.promoted_by IS NOT NULL) THEN
    RAISE EXCEPTION 'authorization evidence is written only by the promotion'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER card_publication_requests_guard BEFORE INSERT OR UPDATE ON card_publication_requests
  FOR EACH ROW EXECUTE FUNCTION card_publication_requests_guard();

-- ── Library revision chain: consecutive versions with the same-slug predecessor; immutable ─────
CREATE FUNCTION library_card_versions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'library card versions are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('library:' || NEW.library_slug));
  IF (NEW.version = 1 AND NEW.previous_card_id IS NOT NULL)
     OR (NEW.version > 1 AND NOT EXISTS (
           SELECT 1 FROM library_card_versions v
            WHERE v.library_slug = NEW.library_slug AND v.version = NEW.version - 1
              AND v.card_id = NEW.previous_card_id)) THEN
    RAISE EXCEPTION 'library versions must follow their same-slug predecessor'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER library_card_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON library_card_versions
  FOR EACH ROW EXECUTE FUNCTION library_card_versions_guard();

REVOKE EXECUTE ON FUNCTION card_holding_check(), interest_cards_content_check(),
  interest_cards_guard(), topics_parent_check(), topics_reference_check(), user_article_labels_check(),
  user_labels_removal_check(), subscriptions_inference_guard(), analysis_requests_insert_check(),
  analysis_requests_update_check(), article_snapshots_guard(), bookmark_snapshot_pins_attach(),
  card_publication_requests_guard(), library_card_versions_guard() FROM PUBLIC;
-- A pure helper that the SECURITY INVOKER card guard evaluates as the writing role.
REVOKE EXECUTE ON FUNCTION card_en_pair_state(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION card_en_pair_state(jsonb) TO bantoozi_app, bantoozi_worker;
