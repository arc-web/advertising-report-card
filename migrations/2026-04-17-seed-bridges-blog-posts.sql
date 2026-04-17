-- migrations/2026-04-17-seed-bridges-blog-posts.sql
--
-- Seeds 40 blog posts as individual deliverable rows for Bridges, so
-- the campaign-summary "Content & SEO Pages" category card displays
-- volume ("40 \u00d7 Blog post") in the rolled-up type list.
--
-- Title is intentionally generic ("Blog Post") so the client-facing
-- view doesn't surface specific timing detail. Internal notes on each
-- row carry the actual delivery window for our records.
--
-- Idempotent: skips entirely if any blog_post deliverable already exists
-- for this contact, so re-running is safe.

DO $$
DECLARE
  bridges_id uuid := 'd5bc5581-fcf4-41f2-9914-6f1de671afdc';
BEGIN
  IF EXISTS (
    SELECT 1 FROM deliverables
    WHERE contact_id = bridges_id
      AND deliverable_type = 'blog_post'
  ) THEN
    RAISE NOTICE 'Bridges blog posts already seeded; skipping.';
    RETURN;
  END IF;

  INSERT INTO deliverables (contact_id, deliverable_type, title, status, delivered_at, notes)
  SELECT
    bridges_id,
    'blog_post',
    'Blog Post',
    'delivered',
    '2025-10-15T00:00:00Z'::timestamptz,
    'Year 1 ongoing blog content program. INTERNAL: 40 posts published Sep 2025 to Dec 2025 as part of broader topical authority build-out.'
  FROM generate_series(1, 40);

  RAISE NOTICE 'Seeded 40 blog post deliverables for Bridges.';
END $$;
