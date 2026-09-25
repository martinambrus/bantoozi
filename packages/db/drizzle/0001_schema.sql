CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"created_by" uuid,
	"email" "citext",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_by" uuid,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "login_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" "citext" NOT NULL,
	"challenge_nonce" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"login_user_id" uuid,
	"invite_code" text,
	"locale" text,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_codes_challenge_nonce_unique" UNIQUE("challenge_nonce"),
	CONSTRAINT "login_codes_purpose_check" CHECK (purpose IN ('login','signup')),
	CONSTRAINT "login_codes_attempts_check" CHECK (attempts BETWEEN 0 AND 5),
	CONSTRAINT "login_codes_login_user_check" CHECK ((purpose = 'login') = (login_user_id IS NOT NULL)),
	CONSTRAINT "login_codes_expiry_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"provider" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"active_version" bigint,
	"active_envelope" jsonb,
	"candidate_version" bigint,
	"candidate_envelope" jsonb,
	"candidate_status" text,
	"candidate_validation" jsonb DEFAULT '{}' NOT NULL,
	"validation_token" uuid,
	"validation_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"activated_at" timestamp with time zone,
	"validated_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "provider_credentials_provider_check" CHECK (provider IN ('typesafe','ollama')),
	CONSTRAINT "provider_credentials_revision_check" CHECK (revision >= 0),
	CONSTRAINT "provider_credentials_active_version_check" CHECK (active_version > 0),
	CONSTRAINT "provider_credentials_candidate_version_check" CHECK (candidate_version > 0),
	CONSTRAINT "provider_credentials_candidate_status_check" CHECK (candidate_status IN ('pending','validating','valid','invalid')),
	CONSTRAINT "provider_credentials_active_pair" CHECK ((active_version IS NULL) = (active_envelope IS NULL)),
	CONSTRAINT "provider_credentials_candidate_pair" CHECK ((candidate_version IS NULL) = (candidate_envelope IS NULL)),
	CONSTRAINT "provider_credentials_candidate_status_pair" CHECK ((candidate_version IS NULL) = (candidate_status IS NULL)),
	CONSTRAINT "provider_credentials_validation_pair" CHECK ((validation_token IS NULL) = (validation_until IS NULL)),
	CONSTRAINT "provider_credentials_validating_token" CHECK (coalesce(candidate_status = 'validating', false) = (validation_token IS NOT NULL)),
	CONSTRAINT "provider_credentials_enabled_active" CHECK (NOT enabled OR active_version IS NOT NULL),
	CONSTRAINT "provider_credentials_active_le_revision" CHECK (active_version IS NULL OR active_version <= revision),
	CONSTRAINT "provider_credentials_candidate_le_revision" CHECK (candidate_version IS NULL OR candidate_version <= revision)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	CONSTRAINT "rate_limit_buckets_hits_check" CHECK (hits > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Europe/Bratislava' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"plan" text DEFAULT 'beta' NOT NULL,
	"invites_left" integer DEFAULT 3 NOT NULL,
	"rank_revision" bigint DEFAULT 0 NOT NULL,
	"suggest_lease_token" uuid,
	"suggest_lease_until" timestamp with time zone,
	"last_suggested_at" timestamp with time zone,
	"preferences" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_locale_check" CHECK (locale IN ('en','sk')),
	CONSTRAINT "users_role_check" CHECK (role IN ('user','admin')),
	CONSTRAINT "users_invites_left_check" CHECK (invites_left >= 0),
	CONSTRAINT "users_rank_revision_check" CHECK (rank_revision >= 0),
	CONSTRAINT "users_suggest_lease_check" CHECK ((suggest_lease_token IS NULL) = (suggest_lease_until IS NULL))
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "waitlist_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" "citext" NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_at" timestamp with time zone,
	"invite_code" text,
	CONSTRAINT "waitlist_email_unique" UNIQUE("email"),
	CONSTRAINT "waitlist_locale_check" CHECK (locale IN ('en','sk'))
);
--> statement-breakpoint
CREATE TABLE "article_aliases" (
	"url_key" text PRIMARY KEY NOT NULL,
	"article_id" bigint NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "article_aliases_source_check" CHECK (source IN ('feed_link','redirect','rel_canonical','near_duplicate'))
);
--> statement-breakpoint
CREATE TABLE "article_bodies" (
	"article_id" bigint PRIMARY KEY NOT NULL,
	"article_revision" bigint NOT NULL,
	"resolved_url" text,
	"status" text NOT NULL,
	"http_status" integer,
	"body_text" text,
	"body_html" text,
	"completeness" text DEFAULT 'partial' NOT NULL,
	"completeness_reason" text,
	"body_lead" text,
	"extractor_version" text NOT NULL,
	"error" text,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_bodies_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "article_bodies_status_check" CHECK (status IN ('ok','skipped','failed','blocked','too_large','not_html')),
	CONSTRAINT "article_bodies_completeness_check" CHECK (completeness IN ('complete','partial')),
	CONSTRAINT "article_bodies_size_check" CHECK (coalesce(octet_length(body_text), 0) + coalesce(octet_length(body_html), 0) <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "article_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "article_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"article_id" bigint NOT NULL,
	"source_revision" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_url" text,
	"title" text NOT NULL,
	"author" text,
	"published_at" timestamp with time zone,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"content_sha256" text NOT NULL,
	"completeness" text NOT NULL,
	"completeness_reason" text,
	"source" text NOT NULL,
	"extractor_version" text NOT NULL,
	"cold_at" timestamp with time zone,
	"unreferenced_at" timestamp with time zone,
	CONSTRAINT "article_snapshots_identity_key" UNIQUE("article_id","source_revision","content_sha256"),
	CONSTRAINT "article_snapshots_source_revision_check" CHECK (source_revision > 0),
	CONSTRAINT "article_snapshots_completeness_check" CHECK (completeness IN ('complete','partial')),
	CONSTRAINT "article_snapshots_source_check" CHECK (source IN ('feed','page')),
	CONSTRAINT "article_snapshots_size_check" CHECK (coalesce(octet_length(body_text), 0) + coalesce(octet_length(body_html), 0) <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "article_translations" (
	"article_id" bigint NOT NULL,
	"article_revision" bigint NOT NULL,
	"source_sha256" text NOT NULL,
	"target_lang" text DEFAULT 'en' NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"source_lang" text NOT NULL,
	"title" text,
	"excerpt" text,
	"body_lead" text,
	"quality" text NOT NULL,
	"quality_detail" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_translations_pkey" PRIMARY KEY("article_id","target_lang","engine"),
	CONSTRAINT "article_translations_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "article_translations_engine_check" CHECK (engine IN ('libretranslate','ollama')),
	CONSTRAINT "article_translations_quality_check" CHECK (quality IN ('ok','weak','fail'))
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"url" text,
	"canonical_url" text NOT NULL,
	"url_key" text NOT NULL,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"author" text,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"excerpt" text,
	"excerpt_html" text,
	"image_url" text,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lang" text,
	"lang_confidence" real,
	"word_count" integer,
	"content_hash" text NOT NULL,
	"content_revision" bigint DEFAULT 1 NOT NULL,
	"story_cluster_id" bigint,
	"cluster_set_id" bigint,
	"pipeline_state" text DEFAULT 'ingested' NOT NULL,
	"enrich_engine" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_url_key_unique" UNIQUE("url_key"),
	CONSTRAINT "articles_lang_confidence_check" CHECK (lang_confidence BETWEEN 0 AND 1),
	CONSTRAINT "articles_word_count_check" CHECK (word_count >= 0),
	CONSTRAINT "articles_content_revision_check" CHECK (content_revision > 0),
	CONSTRAINT "articles_pipeline_state_check" CHECK (pipeline_state IN ('ingested','stale','extracted','translated','enriched','matched','degraded','failed'))
);
--> statement-breakpoint
CREATE TABLE "feed_items" (
	"feed_id" bigint NOT NULL,
	"article_id" bigint NOT NULL,
	"guid" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_items_pkey" PRIMARY KEY("feed_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "feeds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feeds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"url" text NOT NULL,
	"fetch_url" text NOT NULL,
	"merged_into_id" bigint,
	"site_url" text,
	"title" text,
	"description" text,
	"icon_url" text,
	"lang_hint" text,
	"status" text DEFAULT 'active' NOT NULL,
	"etag" text,
	"last_modified" text,
	"fetch_interval_s" integer DEFAULT 900 NOT NULL,
	"min_interval_s" integer DEFAULT 900 NOT NULL,
	"next_fetch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fetch_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_new_item_at" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"consecutive_empty" integer DEFAULT 0 NOT NULL,
	"quarantine_count" integer DEFAULT 0 NOT NULL,
	"total_fetches" integer DEFAULT 0 NOT NULL,
	"total_errors" integer DEFAULT 0 NOT NULL,
	"total_empty" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"first_error_at" timestamp with time zone,
	"quarantined_until" timestamp with time zone,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"unsubscribed_at" timestamp with time zone DEFAULT now(),
	"publish_stats" jsonb DEFAULT '{}' NOT NULL,
	"fetch_options" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feeds_url_unique" UNIQUE("url"),
	CONSTRAINT "feeds_status_check" CHECK (status IN ('active','quarantined','dead','paused')),
	CONSTRAINT "feeds_fetch_interval_s_check" CHECK (fetch_interval_s > 0),
	CONSTRAINT "feeds_min_interval_s_check" CHECK (min_interval_s > 0),
	CONSTRAINT "feeds_subscriber_count_check" CHECK (subscriber_count >= 0),
	CONSTRAINT "feeds_merged_check" CHECK (merged_into_id IS NULL OR (merged_into_id <> id AND status = 'dead'))
);
--> statement-breakpoint
CREATE TABLE "origin_fetch_state" (
	"origin" text PRIMARY KEY NOT NULL,
	"next_start_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone,
	"leases" jsonb DEFAULT '[]' NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "origin_fetch_state_leases_check" CHECK (jsonb_typeof(leases) = 'array' AND jsonb_array_length(leases) <= 2)
);
--> statement-breakpoint
CREATE TABLE "story_clusters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "story_clusters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"representative_article_id" bigint,
	"size" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_clusters_size_check" CHECK (size >= 0)
);
--> statement-breakpoint
CREATE TABLE "article_facets" (
	"article_id" bigint NOT NULL,
	"question_set_id" bigint NOT NULL,
	"article_revision" bigint NOT NULL,
	"state_sha256" text NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"state_variant" text NOT NULL,
	"answers" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_facets_pkey" PRIMARY KEY("article_id","question_set_id"),
	CONSTRAINT "article_facets_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "article_facets_state_variant_check" CHECK (state_variant IN ('native','translated'))
);
--> statement-breakpoint
CREATE TABLE "article_topics_l2" (
	"article_id" bigint NOT NULL,
	"l1_id" text NOT NULL,
	"article_revision" bigint NOT NULL,
	"question_set_sha" text NOT NULL,
	"state_sha256" text NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"state_variant" text NOT NULL,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_topics_l2_pkey" PRIMARY KEY("article_id","l1_id"),
	CONSTRAINT "article_topics_l2_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "article_topics_l2_state_variant_check" CHECK (state_variant IN ('native','translated'))
);
--> statement-breakpoint
CREATE TABLE "card_answers" (
	"article_id" bigint NOT NULL,
	"card_id" bigint NOT NULL,
	"p" real NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"question_set_sha" text NOT NULL,
	"article_revision" bigint NOT NULL,
	"state_sha256" text NOT NULL,
	"card_input_sha256" text NOT NULL,
	"state_variant" text NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_answers_pkey" PRIMARY KEY("article_id","card_id"),
	CONSTRAINT "card_answers_p_check" CHECK (p >= 0 AND p <= 1),
	CONSTRAINT "card_answers_engine_check" CHECK (engine IN ('typesafe','llm','laya','prefilter')),
	CONSTRAINT "card_answers_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "card_answers_state_variant_check" CHECK (state_variant IN ('native','translated'))
);
--> statement-breakpoint
CREATE TABLE "engine_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "engine_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"engine" text NOT NULL,
	"kind" text NOT NULL,
	"model" text,
	"article_id" bigint,
	"question_set_id" bigint,
	"reservation_id" uuid,
	"logical_request_id" uuid NOT NULL,
	"credential_version" bigint,
	"article_revision" bigint,
	"state_sha256" text,
	"card_ids" bigint[],
	"user_id" uuid,
	"n_questions" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 8) DEFAULT 0 NOT NULL,
	"billing" text DEFAULT 'known' NOT NULL,
	"latency_ms" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_calls_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "engine_calls_engine_check" CHECK (engine IN ('typesafe','llm','laya','libretranslate')),
	CONSTRAINT "engine_calls_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval')),
	CONSTRAINT "engine_calls_credential_version_check" CHECK (credential_version > 0),
	CONSTRAINT "engine_calls_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "engine_calls_n_questions_check" CHECK (n_questions >= 0),
	CONSTRAINT "engine_calls_input_tokens_check" CHECK (input_tokens >= 0),
	CONSTRAINT "engine_calls_output_tokens_check" CHECK (output_tokens >= 0),
	CONSTRAINT "engine_calls_cost_usd_check" CHECK (cost_usd >= 0),
	CONSTRAINT "engine_calls_billing_check" CHECK (billing IN ('known','uncertain')),
	CONSTRAINT "engine_calls_latency_ms_check" CHECK (latency_ms >= 0),
	CONSTRAINT "engine_calls_attempts_check" CHECK (attempts > 0),
	CONSTRAINT "engine_calls_status_check" CHECK (status IN ('ok','error','timeout','rate_limited','invalid_request','invalid_response','auth_error'))
);
--> statement-breakpoint
CREATE TABLE "engine_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"engine" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"reserved_usd" numeric(14, 8) NOT NULL,
	"reserved_calls" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"actual_usd" numeric(14, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "engine_reservations_reserved_usd_check" CHECK (reserved_usd >= 0),
	CONSTRAINT "engine_reservations_reserved_calls_check" CHECK (reserved_calls > 0),
	CONSTRAINT "engine_reservations_status_check" CHECK (status IN ('reserved','settled','uncertain')),
	CONSTRAINT "engine_reservations_actual_usd_check" CHECK (actual_usd >= 0),
	CONSTRAINT "engine_reservations_settled_check" CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "feed_cards" (
	"feed_id" bigint NOT NULL,
	"card_id" bigint NOT NULL,
	"holders" integer NOT NULL,
	CONSTRAINT "feed_cards_pkey" PRIMARY KEY("feed_id","card_id"),
	CONSTRAINT "feed_cards_holders_check" CHECK (holders > 0)
);
--> statement-breakpoint
CREATE TABLE "interest_cards" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "interest_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"slug" text,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"text_hash" text NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"topic_ids" text[] DEFAULT '{}' NOT NULL,
	"origin" text NOT NULL,
	"visibility" text NOT NULL,
	"parent_card_id" bigint,
	"owner_user_id" uuid,
	"creator_user_id" uuid,
	"publication_veto_at" timestamp with time zone,
	"i18n" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "interest_cards_slug_unique" UNIQUE("slug"),
	CONSTRAINT "interest_cards_text_hash_unique" UNIQUE("text_hash"),
	CONSTRAINT "interest_cards_kind_check" CHECK (kind IN ('interest','label')),
	CONSTRAINT "interest_cards_origin_check" CHECK (origin IN ('library','user','fork')),
	CONSTRAINT "interest_cards_visibility_check" CHECK (visibility IN ('public','shared','private')),
	CONSTRAINT "interest_cards_private_owner_check" CHECK ((visibility = 'private') = (owner_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "library_card_versions" (
	"library_slug" text NOT NULL,
	"version" integer NOT NULL,
	"card_id" bigint NOT NULL,
	"previous_card_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_card_versions_pkey" PRIMARY KEY("library_slug","version"),
	CONSTRAINT "library_card_versions_card_id_unique" UNIQUE("card_id"),
	CONSTRAINT "library_card_versions_version_check" CHECK (version > 0),
	CONSTRAINT "library_card_versions_previous_check" CHECK (previous_card_id IS NULL OR previous_card_id <> card_id)
);
--> statement-breakpoint
CREATE TABLE "match_queue" (
	"article_id" bigint NOT NULL,
	"card_id" bigint NOT NULL,
	"article_revision" bigint NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"priority" smallint DEFAULT 5 NOT NULL,
	"user_id" uuid,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_queue_pkey" PRIMARY KEY("article_id","card_id"),
	CONSTRAINT "match_queue_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "match_queue_priority_check" CHECK (priority BETWEEN 1 AND 9),
	CONSTRAINT "match_queue_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "match_queue_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
--> statement-breakpoint
CREATE TABLE "question_sets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_sets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_sets_version_unique" UNIQUE("version"),
	CONSTRAINT "question_sets_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "question_sets_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest'))
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"level" smallint NOT NULL,
	"name_en" text NOT NULL,
	"name_sk" text NOT NULL,
	"description" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "topics_level_check" CHECK (level IN (1,2)),
	CONSTRAINT "topics_level_parent_check" CHECK ((level = 1 AND parent_id IS NULL) OR (level = 2 AND parent_id IS NOT NULL)),
	CONSTRAINT "topics_parent_not_self_check" CHECK (parent_id IS NULL OR parent_id <> id)
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"kind" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_pkey" PRIMARY KEY("day","user_id","engine","kind"),
	CONSTRAINT "usage_daily_calls_check" CHECK (calls >= 0),
	CONSTRAINT "usage_daily_input_tokens_check" CHECK (input_tokens >= 0),
	CONSTRAINT "usage_daily_output_tokens_check" CHECK (output_tokens >= 0),
	CONSTRAINT "usage_daily_cost_usd_check" CHECK (cost_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"queue" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "job_outbox_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "job_outbox_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
	CONSTRAINT "job_outbox_payload_check" CHECK (jsonb_typeof(payload) = 'object')
);
--> statement-breakpoint
CREATE TABLE "analysis_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"feed_id" bigint NOT NULL,
	"article_id" bigint NOT NULL,
	"article_revision" bigint NOT NULL,
	"inference_version" bigint NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_sha" text NOT NULL,
	"result_snapshot" jsonb,
	"result_sha" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "analysis_requests_article_revision_check" CHECK (article_revision > 0),
	CONSTRAINT "analysis_requests_inference_version_check" CHECK (inference_version >= 0),
	CONSTRAINT "analysis_requests_status_check" CHECK (status IN ('pending','running','complete','failed','cancelled')),
	CONSTRAINT "analysis_requests_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "analysis_requests_result_pair" CHECK ((result_snapshot IS NULL) = (result_sha IS NULL)),
	CONSTRAINT "analysis_requests_complete_result" CHECK (status <> 'complete' OR result_snapshot IS NOT NULL),
	CONSTRAINT "analysis_requests_lease_pair" CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
	CONSTRAINT "analysis_requests_running_lease" CHECK ((status = 'running') = (lease_token IS NOT NULL)),
	CONSTRAINT "analysis_requests_completed_at" CHECK ((status IN ('complete','failed','cancelled')) = (completed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "api_mutations" (
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb NOT NULL,
	"undo" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_mutations_pkey" PRIMARY KEY("user_id","id"),
	CONSTRAINT "api_mutations_status_check" CHECK (status BETWEEN 200 AND 499),
	CONSTRAINT "api_mutations_retention_check" CHECK (expires_at >= created_at + interval '7 days')
);
--> statement-breakpoint
CREATE TABLE "bookmark_snapshot_pins" (
	"user_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"snapshot_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bookmark_snapshot_pins_pkey" PRIMARY KEY("user_id","mutation_id","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "card_publication_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "card_publication_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid,
	"card_id" bigint NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"card_text_hash" text NOT NULL,
	"publication_payload" jsonb NOT NULL,
	"publication_sha" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"authorization_kind" text,
	"authorization_evidence" jsonb,
	"promoted_at" timestamp with time zone,
	"promoted_by" uuid,
	CONSTRAINT "card_publication_requests_status_check" CHECK (status IN ('pending','approved','rejected','expired','promoted')),
	CONSTRAINT "card_publication_requests_version_check" CHECK (version > 0),
	CONSTRAINT "card_publication_requests_authorization_kind_check" CHECK (authorization_kind IN ('creator_approval','creator_inactive_30d')),
	CONSTRAINT "card_publication_requests_expiry" CHECK (expires_at IS NULL OR expires_at > requested_at),
	CONSTRAINT "card_publication_requests_authorization_pair" CHECK ((authorization_kind IS NULL) = (authorization_evidence IS NULL)),
	CONSTRAINT "card_publication_requests_promoted_at" CHECK ((status = 'promoted') = (promoted_at IS NOT NULL)),
	CONSTRAINT "card_publication_requests_promoted_kind" CHECK ((status = 'promoted') = (authorization_kind IS NOT NULL)),
	CONSTRAINT "card_publication_requests_response" CHECK (status NOT IN ('approved','rejected') OR responded_at IS NOT NULL),
	CONSTRAINT "card_publication_requests_approval_response" CHECK (authorization_kind <> 'creator_approval' OR responded_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "card_suggestions" (
	"user_id" uuid NOT NULL,
	"card_id" bigint NOT NULL,
	"question_set_id" bigint NOT NULL,
	"model_pin" text NOT NULL,
	"score" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "card_suggestions_pkey" PRIMARY KEY("user_id","card_id"),
	CONSTRAINT "card_suggestions_score_check" CHECK (score BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "feedback_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"article_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"value" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_events_kind_check" CHECK (kind IN ('rate','unrate','open','read','unread','dwell','prompt_answer','bookmark','unbookmark','label','unlabel','mark_read','hide','unhide','undo'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" uuid NOT NULL,
	"feed_id" bigint NOT NULL,
	"title_override" text,
	"folder" text,
	"allow_duplicates" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"inference_mode" text DEFAULT 'off' NOT NULL,
	"inference_version" bigint DEFAULT 0 NOT NULL,
	"inference_activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_pkey" PRIMARY KEY("user_id","feed_id"),
	CONSTRAINT "subscriptions_inference_mode_check" CHECK (inference_mode IN ('off','training','active')),
	CONSTRAINT "subscriptions_inference_version_check" CHECK (inference_version >= 0),
	CONSTRAINT "subscriptions_activation_check" CHECK ((inference_mode = 'active') = (inference_activated_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_article" (
	"user_id" uuid NOT NULL,
	"article_id" bigint NOT NULL,
	"lane" text DEFAULT 'new' NOT NULL,
	"tier" smallint,
	"p_like" real,
	"score_source" text DEFAULT 'none' NOT NULL,
	"rules_fired" text[] DEFAULT '{}' NOT NULL,
	"explain" jsonb,
	"label_suggestions" bigint[] DEFAULT '{}' NOT NULL,
	"score_version" text DEFAULT '0:0' NOT NULL,
	"rank_revision" bigint DEFAULT 0 NOT NULL,
	"next_rank_at" timestamp with time zone,
	"scored_at" timestamp with time zone,
	"state_version" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"rating" smallint,
	"reason" text,
	"rated_at" timestamp with time zone,
	"dwell_ms" integer,
	"bookmarked_at" timestamp with time zone,
	"bookmark_snapshot_id" bigint,
	"bookmark_origin_feed_id" bigint,
	"bookmark_capture_generation" bigint DEFAULT 0 NOT NULL,
	"bookmark_capture_status" text,
	"bookmark_capture_error_code" text,
	"archived_at" timestamp with time zone,
	"label_ids" bigint[] DEFAULT '{}' NOT NULL,
	"feedback_prompted_at" timestamp with time zone,
	CONSTRAINT "user_article_pkey" PRIMARY KEY("user_id","article_id"),
	CONSTRAINT "user_article_lane_check" CHECK (lane IN ('new','for_you','maybe','everything','hidden')),
	CONSTRAINT "user_article_tier_check" CHECK (tier BETWEEN 1 AND 5),
	CONSTRAINT "user_article_p_like_check" CHECK (p_like BETWEEN 0 AND 1),
	CONSTRAINT "user_article_score_source_check" CHECK (score_source IN ('none','cards','model','degraded')),
	CONSTRAINT "user_article_rank_revision_check" CHECK (rank_revision >= 0),
	CONSTRAINT "user_article_state_version_check" CHECK (state_version >= 0),
	CONSTRAINT "user_article_rating_check" CHECK (rating IN (-1, 1)),
	CONSTRAINT "user_article_reason_check" CHECK (reason IN ('off_topic','clickbait','seen','shallow','promo','other')),
	CONSTRAINT "user_article_dwell_ms_check" CHECK (dwell_ms >= 0),
	CONSTRAINT "user_article_capture_generation_check" CHECK (bookmark_capture_generation >= 0),
	CONSTRAINT "user_article_capture_status_check" CHECK (bookmark_capture_status IN ('pending','saved','partial','failed')),
	CONSTRAINT "user_article_bookmark_status_pair" CHECK ((bookmarked_at IS NULL) = (bookmark_capture_status IS NULL)),
	CONSTRAINT "user_article_unbookmarked_clear" CHECK (bookmarked_at IS NOT NULL OR (bookmark_snapshot_id IS NULL AND bookmark_capture_status IS NULL AND bookmark_origin_feed_id IS NULL)),
	CONSTRAINT "user_article_saved_snapshot" CHECK (bookmark_capture_status NOT IN ('saved','partial') OR bookmark_snapshot_id IS NOT NULL),
	CONSTRAINT "user_article_rating_pair" CHECK ((rating IS NULL) = (rated_at IS NULL)),
	CONSTRAINT "user_article_reason_negative" CHECK (reason IS NULL OR (rating IS NOT NULL AND rating = -1))
);
--> statement-breakpoint
CREATE TABLE "user_cards" (
	"user_id" uuid NOT NULL,
	"card_id" bigint NOT NULL,
	"strength" text NOT NULL,
	"scope_feed_id" bigint,
	"title_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_cards_pkey" PRIMARY KEY("user_id","card_id"),
	CONSTRAINT "user_cards_strength_check" CHECK (strength IN ('must','love','like','never'))
);
--> statement-breakpoint
CREATE TABLE "user_feed_preferences" (
	"user_id" uuid NOT NULL,
	"feed_id" bigint NOT NULL,
	"image_policy" text DEFAULT 'inherit' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_feed_preferences_pkey" PRIMARY KEY("user_id","feed_id"),
	CONSTRAINT "user_feed_preferences_image_policy_check" CHECK (image_policy IN ('inherit','allow','block'))
);
--> statement-breakpoint
CREATE TABLE "user_labels" (
	"user_id" uuid NOT NULL,
	"card_id" bigint NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'slate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_labels_pkey" PRIMARY KEY("user_id","card_id")
);
--> statement-breakpoint
CREATE TABLE "user_models" (
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"feature_spec_sha" text NOT NULL,
	"n_labels" integer NOT NULL,
	"n_pos" integer NOT NULL,
	"n_neg" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"intercept" real NOT NULL,
	"scaler" jsonb NOT NULL,
	"calibration" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_models_pkey" PRIMARY KEY("user_id","version")
);
--> statement-breakpoint
CREATE TABLE "user_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "user_rules_kind_check" CHECK (kind IN ('mute_keyword','mute_story','block_feed','block_domain','block_author','boost_feed','boost_domain')),
	CONSTRAINT "user_rules_mute_story_expiry" CHECK (kind <> 'mute_story' OR expires_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_codes" ADD CONSTRAINT "login_codes_login_user_id_users_id_fk" FOREIGN KEY ("login_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_invite_code_invites_code_fk" FOREIGN KEY ("invite_code") REFERENCES "public"."invites"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_aliases" ADD CONSTRAINT "article_aliases_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_bodies" ADD CONSTRAINT "article_bodies_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_snapshots" ADD CONSTRAINT "article_snapshots_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_story_cluster_id_story_clusters_id_fk" FOREIGN KEY ("story_cluster_id") REFERENCES "public"."story_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_cluster_set_fk" FOREIGN KEY ("cluster_set_id") REFERENCES "public"."question_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_merged_into_id_feeds_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."feeds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_clusters" ADD CONSTRAINT "story_clusters_rep_fk" FOREIGN KEY ("representative_article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_facets" ADD CONSTRAINT "article_facets_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_facets" ADD CONSTRAINT "article_facets_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_topics_l2" ADD CONSTRAINT "article_topics_l2_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_topics_l2" ADD CONSTRAINT "article_topics_l2_l1_id_topics_id_fk" FOREIGN KEY ("l1_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_topics_l2" ADD CONSTRAINT "article_topics_l2_question_set_sha_question_sets_sha256_fk" FOREIGN KEY ("question_set_sha") REFERENCES "public"."question_sets"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_answers" ADD CONSTRAINT "card_answers_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_answers" ADD CONSTRAINT "card_answers_card_id_interest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."interest_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_answers" ADD CONSTRAINT "card_answers_question_set_sha_question_sets_sha256_fk" FOREIGN KEY ("question_set_sha") REFERENCES "public"."question_sets"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_reservation_id_engine_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."engine_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_reservations" ADD CONSTRAINT "engine_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_cards" ADD CONSTRAINT "feed_cards_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_cards" ADD CONSTRAINT "feed_cards_card_id_interest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."interest_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_cards" ADD CONSTRAINT "interest_cards_parent_card_id_interest_cards_id_fk" FOREIGN KEY ("parent_card_id") REFERENCES "public"."interest_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_cards" ADD CONSTRAINT "interest_cards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_cards" ADD CONSTRAINT "interest_cards_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_card_versions" ADD CONSTRAINT "library_card_versions_card_id_interest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."interest_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_card_versions" ADD CONSTRAINT "library_card_versions_previous_card_id_interest_cards_id_fk" FOREIGN KEY ("previous_card_id") REFERENCES "public"."interest_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_queue" ADD CONSTRAINT "match_queue_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_queue" ADD CONSTRAINT "match_queue_card_id_interest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."interest_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_queue" ADD CONSTRAINT "match_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_requests" ADD CONSTRAINT "analysis_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_requests" ADD CONSTRAINT "analysis_requests_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_requests" ADD CONSTRAINT "analysis_requests_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_mutations" ADD CONSTRAINT "api_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_snapshot_pins" ADD CONSTRAINT "bookmark_snapshot_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_snapshot_pins" ADD CONSTRAINT "bookmark_snapshot_pins_snapshot_id_article_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."article_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_snapshot_pins" ADD CONSTRAINT "bookmark_snapshot_pins_mutation_fk" FOREIGN KEY ("user_id","mutation_id") REFERENCES "public"."api_mutations"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_publication_requests" ADD CONSTRAINT "card_publication_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_publication_requests" ADD CONSTRAINT "card_publication_requests_card_id_interest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."interest_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_publication_requests" ADD CONSTRAINT "card_publication_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_publication_requests" ADD CONSTRAINT "card_publication_requests_promoted_by_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_suggestions" ADD CONSTRAINT "card_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_suggestions" ADD CONSTRAINT "card_suggestions_card_id_interest_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."interest_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_suggestions" ADD CONSTRAINT "card_suggestions_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article" ADD CONSTRAINT "user_article_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article" ADD CONSTRAINT "user_article_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article" ADD CONSTRAINT "user_article_bookmark_snapshot_id_article_snapshots_id_fk" FOREIGN KEY ("bookmark_snapshot_id") REFERENCES "public"."article_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article" ADD CONSTRAINT "user_article_bookmark_origin_feed_id_feeds_id_fk" FOREIGN KEY ("bookmark_origin_feed_id") REFERENCES "public"."feeds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cards" ADD CONSTRAINT "user_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cards" ADD CONSTRAINT "user_cards_scope_fk" FOREIGN KEY ("user_id","scope_feed_id") REFERENCES "public"."subscriptions"("user_id","feed_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ADD CONSTRAINT "user_feed_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ADD CONSTRAINT "user_feed_preferences_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labels" ADD CONSTRAINT "user_labels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_models" ADD CONSTRAINT "user_models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rules" ADD CONSTRAINT "user_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_codes_email_idx" ON "login_codes" USING btree ("email","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "login_codes_active_email_idx" ON "login_codes" USING btree ("email") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "articles_first_seen_idx" ON "articles" USING btree ("first_seen_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "articles_title_trgm_idx" ON "articles" USING gin ("title_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "articles_cluster_idx" ON "articles" USING btree ("story_cluster_id") WHERE story_cluster_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "articles_state_idx" ON "articles" USING btree ("pipeline_state","first_seen_at");--> statement-breakpoint
CREATE INDEX "feed_items_article_idx" ON "feed_items" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "feed_items_feed_time_idx" ON "feed_items" USING btree ("feed_id","first_seen_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "feed_items_guid_idx" ON "feed_items" USING btree ("feed_id","guid") WHERE guid IS NOT NULL;--> statement-breakpoint
CREATE INDEX "feeds_due_idx" ON "feeds" USING btree ("next_fetch_at") WHERE subscriber_count > 0 AND status IN ('active','quarantined');--> statement-breakpoint
CREATE INDEX "card_answers_card_idx" ON "card_answers" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "engine_calls_created_idx" ON "engine_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "engine_calls_article_idx" ON "engine_calls" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "engine_calls_attempt_idx" ON "engine_calls" USING btree ("logical_request_id","engine","attempts");--> statement-breakpoint
CREATE INDEX "engine_reservations_day_idx" ON "engine_reservations" USING btree ("day","status");--> statement-breakpoint
CREATE INDEX "interest_cards_topics_idx" ON "interest_cards" USING gin ("topic_ids");--> statement-breakpoint
CREATE INDEX "match_queue_order_idx" ON "match_queue" USING btree ("priority","enqueued_at");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("available_at","id") WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_dedupe_idx" ON "job_outbox" USING btree ("queue","dedupe_key") WHERE delivered_at IS NULL AND dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "analysis_requests_pending_idx" ON "analysis_requests" USING btree ("next_attempt_at","created_at") WHERE status IN ('pending','running');--> statement-breakpoint
CREATE INDEX "analysis_requests_user_article_idx" ON "analysis_requests" USING btree ("user_id","article_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "api_mutations_expiry_idx" ON "api_mutations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bookmark_snapshot_pins_expiry_idx" ON "bookmark_snapshot_pins" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_publication_pending_idx" ON "card_publication_requests" USING btree ("card_id") WHERE status IN ('pending','approved');--> statement-breakpoint
CREATE INDEX "feedback_events_user_idx" ON "feedback_events" USING btree ("user_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "subscriptions_feed_idx" ON "subscriptions" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "user_article_lane_idx" ON "user_article" USING btree ("user_id","lane","p_like" DESC NULLS LAST,"article_id" DESC NULLS FIRST) WHERE archived_at IS NULL AND read_at IS NULL;--> statement-breakpoint
CREATE INDEX "user_article_bookmarks_idx" ON "user_article" USING btree ("user_id","bookmarked_at" DESC NULLS FIRST) WHERE bookmarked_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_cards_card_idx" ON "user_cards" USING btree ("card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_models_active_idx" ON "user_models" USING btree ("user_id") WHERE active;--> statement-breakpoint
CREATE INDEX "user_rules_user_idx" ON "user_rules" USING btree ("user_id");