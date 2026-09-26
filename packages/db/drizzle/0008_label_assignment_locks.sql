-- Hand-written (spec 02 §5.2, D-10): both deferred label checks of 0004 first lock the owning users
-- row FOR NO KEY UPDATE, the row spec 02 §5.2 serializes label changes and assignments on. They run
-- at COMMIT, so of two transactions that assign and remove the same label, the one committing second
-- waits for the first and then validates against its committed state (READ COMMITTED gives every
-- statement a fresh snapshot), instead of both passing against their own snapshots. The lock does
-- not block foreign-key checks (FOR KEY SHARE) on users. A purged user's row is already gone, so
-- there is nothing to lock and the checks run unchanged.

CREATE OR REPLACE FUNCTION user_article_labels_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_labels bigint[];
  v_suggestions bigint[];
BEGIN
  PERFORM 1 FROM users u WHERE u.id = NEW.user_id FOR NO KEY UPDATE;
  SELECT ua.label_ids, ua.label_suggestions INTO v_labels, v_suggestions
    FROM user_article ua WHERE ua.user_id = NEW.user_id AND ua.article_id = NEW.article_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF array_position(v_labels, NULL) IS NOT NULL OR array_position(v_suggestions, NULL) IS NOT NULL
     OR cardinality(v_labels) <> (SELECT count(DISTINCT x) FROM unnest(v_labels) AS x)
     OR cardinality(v_suggestions) <> (SELECT count(DISTINCT x) FROM unnest(v_suggestions) AS x)
     OR v_labels && v_suggestions
     OR EXISTS (SELECT 1 FROM unnest(v_labels || v_suggestions) AS l(card_id)
                 WHERE NOT EXISTS (SELECT 1 FROM user_labels ul
                                    WHERE ul.user_id = NEW.user_id AND ul.card_id = l.card_id)) THEN
    RAISE EXCEPTION 'article labels must be distinct labels the user holds'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION user_labels_removal_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM users u WHERE u.id = OLD.user_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM user_labels ul WHERE ul.user_id = OLD.user_id AND ul.card_id = OLD.card_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM user_article ua
              WHERE ua.user_id = OLD.user_id
                AND (OLD.card_id = ANY (ua.label_ids) OR OLD.card_id = ANY (ua.label_suggestions))) THEN
    RAISE EXCEPTION 'a removed label is still assigned'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;
