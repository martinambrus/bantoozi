-- These ledgers previously accepted arbitrary kinds, including legacy values.
-- Preserve historical rows; enforce the current CALL_KINDS list on new/updated rows.
-- NOT VALID avoids scanning either ledger under the ADD CONSTRAINT lock.
ALTER TABLE "engine_reservations" ADD CONSTRAINT "engine_reservations_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe')) NOT VALID;
