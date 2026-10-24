-- Application writers have only used current CALL_KINDS; audit both ledgers before deploy.
-- Add then validate so unexpected historical kinds abort this migration, before they can
-- break settlement or account erasure. The ADD locks remain held during validation.
ALTER TABLE "engine_reservations" ADD CONSTRAINT "engine_reservations_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "engine_reservations" VALIDATE CONSTRAINT "engine_reservations_kind_check";
--> statement-breakpoint
ALTER TABLE "usage_daily" VALIDATE CONSTRAINT "usage_daily_kind_check";

--> statement-breakpoint
-- The API has no direct reservation grant. Expose only the same aggregate used by
-- the worker's guard, with an active administrator/operational context check.
-- Exempt kinds come from CALL_KIND_PROFILES at both call sites.
CREATE FUNCTION admin_committed_spend(p_day date, p_exclude_kinds text[]) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT admin_context_allowed() THEN
    RAISE EXCEPTION 'administrator session required' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'p_day must not be NULL' USING ERRCODE = '22004';
  END IF;
  RETURN (
    SELECT coalesce(sum(CASE WHEN r.status = 'settled' THEN r.actual_usd ELSE r.reserved_usd END), 0)
      FROM engine_reservations r
     WHERE r.day = p_day AND NOT (r.kind = ANY(coalesce(p_exclude_kinds, '{}'::text[])))
  );
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION admin_committed_spend(date, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_committed_spend(date, text[]) TO bantoozi_app, bantoozi_worker;
