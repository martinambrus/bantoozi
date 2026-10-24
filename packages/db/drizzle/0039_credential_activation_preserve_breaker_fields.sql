CREATE OR REPLACE FUNCTION admin_activate_provider_credential(p_provider text, p_expected_revision bigint,
                                                   p_candidate_version bigint)
RETURNS TABLE (revision bigint, active_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
  v_breaker text;
BEGIN
  PERFORM check_credential_provider(p_provider);
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no credential staged' USING ERRCODE = 'BZ404';
  END IF;
  IF v_row.revision <> p_expected_revision OR v_row.candidate_version IS DISTINCT FROM p_candidate_version
     OR v_row.candidate_status IS DISTINCT FROM 'valid' OR v_row.validated_at IS NULL
     OR v_row.validated_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'candidate is not a current valid validation' USING ERRCODE = 'BZ409';
  END IF;
  UPDATE provider_credentials c
     SET revision = c.revision + 1, enabled = true,
         active_version = c.candidate_version, active_envelope = c.candidate_envelope,
         candidate_version = NULL, candidate_envelope = NULL, candidate_status = NULL,
         candidate_validation = '{}', validation_token = NULL, validation_until = NULL,
         activated_at = now(), last_error_code = NULL, updated_at = now(), updated_by = v_admin
   WHERE c.provider = p_provider
  RETURNING c.revision, c.active_version INTO revision, active_version;
  v_breaker := CASE p_provider WHEN 'typesafe' THEN 'typesafe' ELSE 'llm' END;
  UPDATE settings s
     SET value = jsonb_set(s.value, ARRAY[v_breaker],
           ((s.value -> v_breaker) - ARRAY['openedAt', 'failingSince', 'openUntil', 'probeToken', 'probeUntil']::text[])
           || '{"state":"closed","reopenCount":0}'::jsonb),
         updated_at = now(), updated_by = v_admin
   WHERE s.key = 'engine.circuit' AND s.value #>> ARRAY[v_breaker, 'state'] = 'auth';
  RETURN NEXT;
END;
$$;
