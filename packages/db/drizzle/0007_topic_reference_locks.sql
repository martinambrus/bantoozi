-- Hand-written (spec 02 §5.2, D-9): the topic reference checks of 0004 lock the rows they read, as a
-- foreign-key check does, so two concurrent transactions can no longer both pass them and commit a
-- dangling reference. A topic DELETE or id change locks its row (FOR UPDATE) and a level or parent
-- change locks it (FOR NO KEY UPDATE) before its own check runs; each lock below conflicts with the
-- relevant one, so the later transaction waits and then checks against the committed state
-- (READ COMMITTED gives every statement of these functions a fresh snapshot).

-- Cards take FOR KEY SHARE on every referenced topic: a concurrent delete or id change of one waits
-- for this transaction, and its topics_reference_check then sees the card; a card written after an
-- uncommitted delete waits for it and then finds the topic gone.
CREATE OR REPLACE FUNCTION interest_cards_content_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF card_en_pair_state(NEW.body) = 'invalid' THEN
    RAISE EXCEPTION 'card translation pair is incomplete'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  PERFORM 1 FROM topics x WHERE x.id = ANY (NEW.topic_ids) ORDER BY x.id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM unnest(NEW.topic_ids) AS t(id)
              WHERE t.id IS NULL OR NOT EXISTS (SELECT 1 FROM topics x WHERE x.id = t.id)) THEN
    RAISE EXCEPTION 'card references an unknown topic'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- A level-2 topic takes FOR SHARE on its parent (its foreign key only takes FOR KEY SHARE, which a
-- level change does not wait for): a concurrent level change of the parent waits for this
-- transaction and then sees the child; a child written after an uncommitted level change waits for
-- it and then sees the parent's new level.
CREATE OR REPLACE FUNCTION topics_parent_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.level = 2 THEN
    PERFORM 1 FROM topics p WHERE p.id = NEW.parent_id FOR SHARE;
  END IF;
  IF NEW.level = 2 AND NOT EXISTS (SELECT 1 FROM topics p WHERE p.id = NEW.parent_id AND p.level = 1) THEN
    RAISE EXCEPTION 'a level-2 topic needs a level-1 parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF NEW.level <> 1 AND EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'a topic with children must stay level 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;
