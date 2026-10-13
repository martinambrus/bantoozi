-- Hand-written (M8-F6, spec 02 §3, spec 11 §5/§6): `house.archive`'s unread-cap queries filter
-- `user_article` by user and `read_at IS NULL AND archived_at IS NULL` and join on `article_id`.
-- The lane index is keyed by lane and p_like, so it cannot serve them; this partial index holds
-- exactly the unread, unarchived rows in (user_id, article_id) order and stays small.
CREATE INDEX "user_article_unread_cap_idx" ON "user_article" USING btree ("user_id","article_id") WHERE read_at IS NULL AND archived_at IS NULL;
