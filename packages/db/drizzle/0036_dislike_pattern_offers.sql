CREATE TABLE "dislike_pattern_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" bigint NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_ids" bigint[] NOT NULL,
	"seen_at" timestamp with time zone,
	"answer" text,
	"answered_at" timestamp with time zone,
	CONSTRAINT "dislike_pattern_offers_scope_check" CHECK (scope IN ('card','feed')),
	CONSTRAINT "dislike_pattern_offers_articles_check" CHECK (cardinality(article_ids) BETWEEN 1 AND 3),
	CONSTRAINT "dislike_pattern_offers_answer_check" CHECK (answer IN ('accepted','dismissed')),
	CONSTRAINT "dislike_pattern_offers_answered_check" CHECK ((answer IS NULL) = (answered_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "dislike_pattern_offers" ADD CONSTRAINT "dislike_pattern_offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dislike_pattern_offers_scope_idx" ON "dislike_pattern_offers" USING btree ("user_id","scope","scope_id","seen_at");
--> statement-breakpoint
ALTER TABLE dislike_pattern_offers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dislike_pattern_offers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY dislike_pattern_offers_tenant ON dislike_pattern_offers
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dislike_pattern_offers TO bantoozi_app;
