-- D-265: card drafts record the kind of card they propose; "Not now" on a feed's card hints.
ALTER TABLE "card_drafts" ADD COLUMN "kind" text DEFAULT 'interest' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ADD COLUMN "interest_hint_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ADD COLUMN "never_hint_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "card_drafts" ADD CONSTRAINT "card_drafts_kind_check" CHECK (kind IN ('interest','never'));--> statement-breakpoint
-- The API records the kind of a new draft (column-level grants, as in 0025).
GRANT INSERT (kind) ON card_drafts TO bantoozi_app;
