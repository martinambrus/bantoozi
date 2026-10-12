-- Hand-written (M8-F19, PR #26 review; spec 02 §3.1, spec 10 §7 "Engine"):
-- `engine_calls.demand_basis` records why a call was authorized WHEN it was made, so the
-- active / training / other cost split of a past day does not change when the user unsubscribes,
-- switches mode or files a later request. `active` = an automatic witness (active subscription),
-- `training` = only a selected analysis request, `other` = authorized by neither (off feed). NULL =
-- a call without article demand (suggest, credential probe, free translation) or a row written
-- before this migration; the metrics fall back to the live recomputation for NULL rows that carry an
-- article. No backfill: history cannot be reconstructed. The worker role already writes the table.
ALTER TABLE "engine_calls" ADD COLUMN "demand_basis" text;--> statement-breakpoint
ALTER TABLE "engine_calls" ADD CONSTRAINT "engine_calls_demand_basis_check" CHECK (demand_basis IN ('active','training','other'));
