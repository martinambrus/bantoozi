-- Hand-written (M8-F3, spec 07 §5, spec 11 §6): `house.translate-cards` stamps the card whose
-- translation came back weak or failed, so an unrestricted run leaves it alone for 6 hours. The
-- worker role holds table-level grants (default privileges), so no grant is needed.
ALTER TABLE "interest_cards" ADD COLUMN "translation_attempted_at" timestamp with time zone;
