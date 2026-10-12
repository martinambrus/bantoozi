-- Hand-written (spec 11 §5-6): indexes only, no data or constraint change. The retention jobs delete
-- articles, feeds, cards and users in batches; every foreign key that cascades from them (and the
-- reconcile/purge scans) needs an index on the referencing column, or each deleted row costs a full
-- table scan. Columns already led by a primary key or an existing index are not repeated.
CREATE INDEX "user_article_article_id_idx" ON "user_article" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "user_article_bookmark_snapshot_id_idx" ON "user_article" USING btree ("bookmark_snapshot_id") WHERE bookmark_snapshot_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_article_bookmark_origin_feed_id_idx" ON "user_article" USING btree ("bookmark_origin_feed_id") WHERE bookmark_origin_feed_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_article_next_rank_at_idx" ON "user_article" USING btree ("next_rank_at") WHERE next_rank_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_article_pending_capture_idx" ON "user_article" USING btree ("article_id") WHERE bookmark_capture_status = 'pending';--> statement-breakpoint
CREATE INDEX "feedback_events_article_id_idx" ON "feedback_events" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "article_aliases_article_id_idx" ON "article_aliases" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "analysis_requests_article_id_idx" ON "analysis_requests" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "analysis_requests_feed_id_idx" ON "analysis_requests" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "story_clusters_representative_article_id_idx" ON "story_clusters" USING btree ("representative_article_id");--> statement-breakpoint
CREATE INDEX "story_clusters_empty_idx" ON "story_clusters" USING btree ("id") WHERE size = 0;--> statement-breakpoint
CREATE INDEX "bookmark_snapshot_pins_snapshot_id_idx" ON "bookmark_snapshot_pins" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "user_feed_preferences_feed_id_idx" ON "user_feed_preferences" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "feeds_merged_into_id_idx" ON "feeds" USING btree ("merged_into_id") WHERE merged_into_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "feed_cards_card_id_idx" ON "feed_cards" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "match_queue_card_id_idx" ON "match_queue" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_suggestions_card_id_idx" ON "card_suggestions" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "user_labels_card_id_idx" ON "user_labels" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "interest_cards_parent_card_id_idx" ON "interest_cards" USING btree ("parent_card_id") WHERE parent_card_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "card_publication_requests_card_id_idx" ON "card_publication_requests" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "engine_calls_user_id_idx" ON "engine_calls" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "engine_reservations_expires_at_idx" ON "engine_reservations" USING btree ("expires_at") WHERE status = 'reserved';--> statement-breakpoint
CREATE INDEX "article_bodies_extracted_idx" ON "article_bodies" USING btree ("extracted_at") WHERE body_text IS NOT NULL OR body_html IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_outbox_delivered_at_idx" ON "job_outbox" USING btree ("delivered_at") WHERE delivered_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sample_article_id_idx" ON "eval"."sample" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "assignments_article_id_idx" ON "eval"."assignments" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "ratings_article_id_idx" ON "eval"."ratings" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "run_answers_article_id_idx" ON "eval"."run_answers" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "run_answers_card_id_idx" ON "eval"."run_answers" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "rater_cards_card_id_idx" ON "eval"."rater_cards" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "rater_feeds_feed_id_idx" ON "eval"."rater_feeds" USING btree ("feed_id");
