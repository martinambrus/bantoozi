-- Hand-written (spec 02 §4 `analysis_requests`, spec 03 §2.2): a selection made before the article's
-- extraction waits for it. Its frozen `input_snapshot` carries `awaitingExtraction`; once the page is
-- extracted, `analysis.process` recaptures the article, translation and media context at the same
-- revision and clears the flag. That one rewrite of `input_snapshot` and `input_sha` is allowed here,
-- by the lease holder's running request while the stored snapshot still has the flag, the new one
-- does not and the new hash is the new snapshot's; every other change of the frozen input still raises. `CREATE OR REPLACE` keeps the owner
-- and privileges of the function last defined in 0013.
CREATE OR REPLACE FUNCTION analysis_requests_update_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.article_revision <> OLD.article_revision
     OR NEW.inference_version <> OLD.inference_version OR NEW.created_at <> OLD.created_at
     OR ((NEW.input_snapshot <> OLD.input_snapshot OR NEW.input_sha <> OLD.input_sha)
         AND NOT (OLD.status = 'running'
                  AND OLD.input_snapshot ? 'awaitingExtraction'
                  AND NOT (NEW.input_snapshot ? 'awaitingExtraction')
                  AND NEW.input_sha = encode(sha256(convert_to(NEW.input_snapshot::text, 'UTF8')), 'hex'))) THEN
    RAISE EXCEPTION 'analysis request input is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF (OLD.result_snapshot IS NOT NULL AND (NEW.result_snapshot IS DISTINCT FROM OLD.result_snapshot
                                           OR NEW.result_sha IS DISTINCT FROM OLD.result_sha))
     OR (OLD.status IN ('complete','failed','cancelled')
         AND (NEW.status <> OLD.status OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
              OR NEW.result_snapshot IS DISTINCT FROM OLD.result_snapshot
              OR NEW.lease_token IS NOT NULL OR NEW.attempts <> OLD.attempts
              OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
              OR NEW.stage_results IS DISTINCT FROM OLD.stage_results)) THEN
    RAISE EXCEPTION 'a finished analysis request is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;
