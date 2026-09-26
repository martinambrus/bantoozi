-- Hand-written (spec 02 §1.2, §4, §5, §5.1): deferrable card FKs, snapshot storage, row-level
-- security and the explicit bantoozi_app grants. bantoozi_worker gets its table/sequence privileges
-- from the default privileges of 0000_privileges.

-- Card holdings reference interest_cards through DEFERRABLE INITIALLY DEFERRED foreign keys, so an
-- account purge with held private forks succeeds in either FK execution order (spec 02 §5.2).
ALTER TABLE user_cards ADD CONSTRAINT user_cards_card_fk
  FOREIGN KEY (card_id) REFERENCES interest_cards(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE user_labels ADD CONSTRAINT user_labels_card_fk
  FOREIGN KEY (card_id) REFERENCES interest_cards(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Bookmark archives: TOAST compresses larger values losslessly from the first write (spec 02 §3.5).
ALTER TABLE article_snapshots ALTER COLUMN body_text SET STORAGE EXTENDED;
ALTER TABLE article_snapshots ALTER COLUMN body_html SET STORAGE EXTENDED;
ALTER TABLE article_snapshots ALTER COLUMN body_text SET COMPRESSION pglz;
ALTER TABLE article_snapshots ALTER COLUMN body_html SET COMPRESSION pglz;

-- ── Per-user tables (spec 02 §4, §5) ───────────────────────────────────────────────────────────
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant ON subscriptions
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_feed_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feed_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_feed_preferences_tenant ON user_feed_preferences
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE analysis_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY analysis_requests_tenant ON analysis_requests
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- user_id is NULL after the creator's erasure: such rows match no tenant (spec 02 §4).
ALTER TABLE card_publication_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_publication_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY card_publication_requests_tenant ON card_publication_requests
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY user_cards_tenant ON user_cards
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY user_labels_tenant ON user_labels
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY user_rules_tenant ON user_rules
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_article FORCE ROW LEVEL SECURITY;
CREATE POLICY user_article_tenant ON user_article
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_events_tenant ON feedback_events
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_models FORCE ROW LEVEL SECURITY;
CREATE POLICY user_models_tenant ON user_models
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE api_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY api_mutations_tenant ON api_mutations
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE bookmark_snapshot_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmark_snapshot_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY bookmark_snapshot_pins_tenant ON bookmark_snapshot_pins
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE card_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY card_suggestions_tenant ON card_suggestions
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- ── Private cards, saved snapshots and durable intents (spec 02 §5.1) ─────────────────────────
ALTER TABLE interest_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE interest_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY interest_cards_read ON interest_cards FOR SELECT TO bantoozi_app
  USING (visibility IN ('public','shared') OR
         owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY interest_cards_create ON interest_cards FOR INSERT TO bantoozi_app
  WITH CHECK (nullif(current_setting('app.user_id', true), '') IS NOT NULL AND
    ((visibility = 'shared' AND origin = 'user' AND owner_user_id IS NULL
      AND creator_user_id = nullif(current_setting('app.user_id', true), '')::uuid) OR
     (visibility = 'private' AND origin = 'fork' AND
      creator_user_id = nullif(current_setting('app.user_id', true), '')::uuid AND
      owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid) OR
     (visibility = 'public' AND origin = 'library' AND EXISTS
       (SELECT 1 FROM users WHERE id = nullif(current_setting('app.user_id', true), '')::uuid
          AND role = 'admin' AND deleted_at IS NULL))));
CREATE POLICY interest_cards_update ON interest_cards FOR UPDATE TO bantoozi_app
  USING (visibility IN ('public','shared') OR
         owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (visibility IN ('public','shared') OR
              owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE card_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY card_answers_read ON card_answers FOR SELECT TO bantoozi_app
  USING (EXISTS (SELECT 1 FROM interest_cards c WHERE c.id = card_id));

ALTER TABLE article_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY article_snapshots_saved_read ON article_snapshots FOR SELECT TO bantoozi_app
  USING (EXISTS (
      SELECT 1 FROM user_article ua WHERE ua.bookmark_snapshot_id = article_snapshots.id
        AND ua.bookmarked_at IS NOT NULL
        AND ua.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ) OR EXISTS (
      SELECT 1 FROM bookmark_snapshot_pins p WHERE p.snapshot_id = article_snapshots.id
        AND p.expires_at > now()
        AND p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));

ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY job_outbox_requester ON job_outbox FOR INSERT TO bantoozi_app
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- ── Explicit bantoozi_app privileges (spec 02 §1.2) ────────────────────────────────────────────
-- Auth/control-plane tables (no tenant RLS; named repositories only).
GRANT SELECT, INSERT, UPDATE ON users TO bantoozi_app;
GRANT SELECT, INSERT, UPDATE ON settings TO bantoozi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_codes, sessions, invites, waitlist TO bantoozi_app;
GRANT SELECT, INSERT, UPDATE ON origin_fetch_state TO bantoozi_app;
GRANT SELECT ON usage_daily TO bantoozi_app;

-- Shared article layer.
GRANT SELECT, INSERT ON feeds TO bantoozi_app;
GRANT UPDATE (min_interval_s, fetch_options, status, consecutive_errors, first_error_at, quarantined_until,
              quarantine_count, next_fetch_at, subscriber_count, updated_at) ON feeds TO bantoozi_app;
GRANT SELECT, INSERT, UPDATE ON story_clusters TO bantoozi_app;
GRANT SELECT ON articles TO bantoozi_app;
GRANT UPDATE (story_cluster_id) ON articles TO bantoozi_app;
GRANT SELECT ON feed_items, article_aliases, article_bodies, article_snapshots, article_translations,
                question_sets, article_facets, topics, card_answers, article_topics_l2,
                library_card_versions TO bantoozi_app;
GRANT SELECT, INSERT ON interest_cards TO bantoozi_app;
GRANT UPDATE (retired_at, title, topic_ids, i18n, slug) ON interest_cards TO bantoozi_app;

-- Per-user tables (RLS applies).
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions, user_feed_preferences, user_cards, user_labels,
                                       user_rules, api_mutations TO bantoozi_app;
GRANT SELECT ON user_article TO bantoozi_app;
GRANT INSERT (user_id, article_id, opened_at, read_at, rating, reason, rated_at, dwell_ms, bookmarked_at,
              archived_at, label_ids, feedback_prompted_at, state_version) ON user_article TO bantoozi_app;
GRANT UPDATE (opened_at, read_at, rating, reason, rated_at, dwell_ms, bookmarked_at, archived_at, label_ids,
              feedback_prompted_at, state_version, label_suggestions) ON user_article TO bantoozi_app;
GRANT SELECT, INSERT ON feedback_events TO bantoozi_app;
GRANT SELECT ON card_suggestions TO bantoozi_app;
GRANT UPDATE (dismissed_at) ON card_suggestions TO bantoozi_app;
GRANT SELECT ON user_models TO bantoozi_app;
GRANT SELECT, INSERT ON bookmark_snapshot_pins TO bantoozi_app;
GRANT SELECT ON analysis_requests TO bantoozi_app;
GRANT INSERT (id, user_id, feed_id, article_id, article_revision, inference_version, input_snapshot, input_sha)
  ON analysis_requests TO bantoozi_app;
GRANT SELECT ON card_publication_requests TO bantoozi_app;

-- Durable job intents: INSERT only (no SELECT, no relay privileges).
GRANT INSERT ON job_outbox TO bantoozi_app;

-- Identity sequences of the tables the API may insert into.
GRANT USAGE ON SEQUENCE feeds_id_seq, story_clusters_id_seq, interest_cards_id_seq, login_codes_id_seq,
                        sessions_id_seq, waitlist_id_seq, feedback_events_id_seq, user_rules_id_seq,
                        job_outbox_id_seq TO bantoozi_app;

-- /readyz compares the newest applied migration with the bundled journal.
GRANT USAGE ON SCHEMA drizzle TO bantoozi_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO bantoozi_app;
