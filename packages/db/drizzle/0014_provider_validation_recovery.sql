-- Hand-written (M2-T3, D-87; spec 04 §1.2 step 2): Validate can be requested again for a candidate
-- whose validator stopped without a result. `provider.validate` has no queue retries, so a worker
-- that exits after claiming the validation lease leaves the candidate `validating`; once that lease
-- has expired the worker's claim reclaims it, and Validate now queues that probe instead of refusing
-- the candidate as busy until its key is staged again. A live lease is still refused.
--
-- Only that condition changes in the function defined in 0003, now NULL-safe so that a row without
-- a candidate always conflicts; `CREATE OR REPLACE` keeps its owner and privileges.
CREATE OR REPLACE FUNCTION admin_validate_provider_credential(p_provider text, p_candidate_version bigint,
                                                              p_expected_revision bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
BEGIN
  PERFORM check_credential_provider(p_provider);
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no credential staged' USING ERRCODE = 'BZ404';
  END IF;
  IF v_row.revision <> p_expected_revision OR v_row.candidate_version IS DISTINCT FROM p_candidate_version
     OR NOT coalesce(v_row.candidate_status IN ('pending','valid','invalid')
                     OR (v_row.candidate_status = 'validating' AND v_row.validation_until <= now()), false) THEN
    RAISE EXCEPTION 'stale or busy credential candidate' USING ERRCODE = 'BZ409';
  END IF;
  INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
  VALUES ('provider.validate',
          jsonb_build_object('provider', p_provider, 'candidateVersion', p_candidate_version::text),
          format('{"payload":{"candidateVersion":"%s","provider":"%s"},"revision":null}', p_candidate_version, p_provider),
          v_admin)
  ON CONFLICT (queue, dedupe_key) WHERE delivered_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING;
END;
$$;
