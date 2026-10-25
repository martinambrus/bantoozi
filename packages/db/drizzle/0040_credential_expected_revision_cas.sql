-- Reject NULL expected revisions as stale for every credential CAS writer (D-338).
-- CREATE OR REPLACE preserves existing signatures, owner, grants and security settings.
CREATE OR REPLACE FUNCTION admin_stage_provider_credential(p_provider text, p_expected_revision bigint, p_envelope jsonb)
RETURNS TABLE (revision bigint, candidate_version bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
BEGIN
  PERFORM check_credential_provider(p_provider);
  IF NOT valid_credential_envelope(p_envelope) THEN
    RAISE EXCEPTION 'invalid credential envelope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO provider_credentials (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF v_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'BZ409';
  END IF;
  UPDATE provider_credentials c
     SET revision = c.revision + 1, candidate_version = c.revision + 1, candidate_envelope = p_envelope,
         candidate_status = 'pending', candidate_validation = '{}', validation_token = NULL,
         validation_until = NULL, validated_at = NULL, last_error_code = NULL,
         updated_at = now(), updated_by = v_admin
   WHERE c.provider = p_provider
  RETURNING c.revision, c.candidate_version INTO revision, candidate_version;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
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
  IF v_row.revision IS DISTINCT FROM p_expected_revision OR v_row.candidate_version IS DISTINCT FROM p_candidate_version
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_set_provider_enabled(p_provider text, p_expected_revision bigint, p_enabled boolean)
RETURNS TABLE (revision bigint, enabled boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin uuid := require_admin_session();
  v_row provider_credentials%ROWTYPE;
BEGIN
  PERFORM check_credential_provider(p_provider);
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled flag required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO provider_credentials (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO v_row FROM provider_credentials c WHERE c.provider = p_provider FOR UPDATE;
  IF v_row.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'BZ409';
  END IF;
  IF p_enabled THEN
    IF v_row.active_version IS NULL THEN
      RAISE EXCEPTION 'no active credential to enable' USING ERRCODE = 'BZ409';
    END IF;
    UPDATE provider_credentials c SET enabled = true, revision = c.revision + 1, updated_at = now(),
           updated_by = v_admin
     WHERE c.provider = p_provider RETURNING c.revision, c.enabled INTO revision, enabled;
  ELSE
    UPDATE provider_credentials c
       SET enabled = false, revision = c.revision + 1, active_version = NULL, active_envelope = NULL,
           candidate_version = NULL, candidate_envelope = NULL, candidate_status = NULL,
           candidate_validation = '{}', validation_token = NULL, validation_until = NULL,
           updated_at = now(), updated_by = v_admin
     WHERE c.provider = p_provider RETURNING c.revision, c.enabled INTO revision, enabled;
  END IF;
  RETURN NEXT;
END;
$$;
