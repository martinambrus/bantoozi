-- Hand-written (D-240, spec 08 §7): card drafts the API records for the worker's `card.draft` job,
-- and `card_draft` as an engine call kind. The worker role holds table-level grants (default
-- privileges); the API inserts, reads and removes only its tenant's drafts.
CREATE TABLE "card_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"article_ids" bigint[] NOT NULL,
	"locale" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"interest" text,
	"source" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "card_drafts_status_check" CHECK (status IN ('pending','complete','failed')),
	CONSTRAINT "card_drafts_source_check" CHECK (source IN ('llm','fallback')),
	CONSTRAINT "card_drafts_articles_check" CHECK (cardinality(article_ids) BETWEEN 1 AND 5),
	CONSTRAINT "card_drafts_completed_at" CHECK ((status IN ('complete','failed')) = (completed_at IS NOT NULL)),
	CONSTRAINT "card_drafts_complete_result" CHECK (status <> 'complete' OR (interest IS NOT NULL AND source IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "card_drafts" ADD CONSTRAINT "card_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "card_drafts_user_created_idx" ON "card_drafts" USING btree ("user_id","created_at");
--> statement-breakpoint
ALTER TABLE card_drafts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_drafts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY card_drafts_tenant ON card_drafts
  USING      (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, DELETE ON card_drafts TO bantoozi_app;
--> statement-breakpoint
GRANT INSERT (id, user_id, article_ids, locale) ON card_drafts TO bantoozi_app;
--> statement-breakpoint
ALTER TABLE "engine_calls" DROP CONSTRAINT "engine_calls_kind_check";
--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft'));
