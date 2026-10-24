-- These ledgers previously accepted arbitrary kinds, including legacy values.
-- Preserve historical rows; enforce the current CALL_KINDS list on new/updated rows.
-- NOT VALID avoids scanning either ledger under the ADD CONSTRAINT lock.
ALTER TABLE "engine_reservations" ADD CONSTRAINT "engine_reservations_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_kind_check" CHECK (kind IN ('enrich','match','cluster','suggest','translate','credential_probe','eval','card_draft','model_probe')) NOT VALID;

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
  RETURN (
    SELECT coalesce(sum(CASE WHEN r.status = 'settled' THEN r.actual_usd ELSE r.reserved_usd END), 0)
      FROM engine_reservations r
     WHERE r.day = p_day AND NOT (r.kind = ANY(p_exclude_kinds))
  );
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION admin_committed_spend(date, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_committed_spend(date, text[]) TO bantoozi_app, bantoozi_worker;
