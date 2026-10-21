-- Allow engine_calls rows of kind model_probe.
ALTER TABLE "engine_calls" DROP CONSTRAINT "engine_calls_kind_check";--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe'));