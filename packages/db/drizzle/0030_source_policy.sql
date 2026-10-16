ALTER TABLE "origin_fetch_state" ADD COLUMN "feed_next_start_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_fetch_state" ADD COLUMN "learned_interval_s" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_fetch_state" ADD COLUMN "learned_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_fetch_state" ADD COLUMN "crawl_delay_s" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_fetch_state" ADD COLUMN "crawl_delay_updated_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_fetch_state" ADD CONSTRAINT "origin_fetch_state_source_floor_check" CHECK (learned_interval_s BETWEEN 0 AND 86400 AND crawl_delay_s BETWEEN 0 AND 86400);