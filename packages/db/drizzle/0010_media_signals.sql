-- Hand-written (M1-T7, design revision R2; spec 02 §3 `articles`, spec 03 §6.4): the media signals of
-- an article, read at ingestion and extraction before sanitizing removes the media.
--
-- - `has_video`: null while unknown; true on video evidence from any carrier or the page; false only
--   once a feed or page body was examined without evidence. Monotonic: nothing sets it from true
--   back to false (spec 03 §7 step 6).
-- - `body_image_count`: the distinct in-body images of the body currently stored in
--   `article_bodies` (the same text `word_count` counts), written in the same transaction as that
--   body; null while no body with content is stored, so an excerpt never passes for a body without
--   images (spec 03 §6.4, §7 step 6, §8.1 step 6).
-- - `media_revision`: +1 for every write that changes either value (IS DISTINCT FROM), which also
--   records an incremental rank for the subscribers of every current carrier; a rank run records
--   the revision it read, so a run that read the old values leaves its row dirty (spec 06 §6.2, §7).
--
-- Existing rows start unknown (null) at media revision 0: the signals cannot be recomputed from the
-- sanitized stored HTML (spec 03 §6.3).
ALTER TABLE "articles"
  ADD COLUMN "has_video" boolean,
  ADD COLUMN "body_image_count" integer
    CONSTRAINT "articles_body_image_count_check" CHECK (body_image_count >= 0),
  ADD COLUMN "media_revision" bigint DEFAULT 0 NOT NULL
    CONSTRAINT "articles_media_revision_check" CHECK (media_revision >= 0);
