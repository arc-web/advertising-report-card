-- migrations/2026-04-17-templatize-campaign-summary.sql
--
-- Makes the campaign-summary template engagement-length agnostic by moving
-- per-client forward-looking copy out of the template HTML and into
-- report_configs. Works for engagements of any length (3 months, 6 months,
-- 12 months, etc.) since the labels and "what's next" content come from
-- the database rather than being hardcoded for Bridges.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the Bridges UPDATE only runs
-- when next_period_heading is currently null.

ALTER TABLE report_configs
  ADD COLUMN IF NOT EXISTS next_period_heading text,
  ADD COLUMN IF NOT EXISTS next_period_body    text;

COMMENT ON COLUMN report_configs.next_period_heading
  IS 'Heading for the forward-looking callout on the campaign-summary page. Per-client (e.g. "Year two: where the foundation pays off", "Quarter two: scaling what works"). When null, the callout section is hidden.';
COMMENT ON COLUMN report_configs.next_period_body
  IS 'Body copy for the forward-looking callout. Plain text; paragraphs separated by blank lines. Supports any engagement length.';

-- Seed Bridges (erika-frieze) with the previously-hardcoded copy so its
-- campaign summary keeps the same content after the template templatizes.
UPDATE report_configs
SET
  next_period_heading = 'Year two: where the foundation pays off',
  next_period_body = $body$The site and entity audit completed in March is ready to deploy. That work alone sharpens on-page and off-page signals across your service pages and homepage, giving the queries already sitting on page two the support they need to land on page one. Alongside that, we're rebuilding the bio pages to better reflect your team's depth, adding a comprehensive FAQ to capture the long-tail questions patients are already searching, and upgrading the Sacramento page with advanced location schema that strengthens local relevance.

On the authority side, year two adds three things that compound visibility. We'll gather and publish clinician endorsements that signal expertise and trust to both patients and search engines. Your social channels go active with regular posts that reinforce topical authority. The entity veracity hub gets activated, giving Google more confirmed signals about who Bridges of the Mind is and what it does. NEO image distribution rounds out the off-page picture.

And we'll close a measurement gap that's quietly costing you visibility into your own results. Today, your admin team relies on patients self-reporting their source at intake, which captures roughly one in fifty bookings. Year two adds UTM tracking on every link, an intake-form prompt asking how patients found you, and admin training to enter source consistently. By next year's renewal, you'll have the full picture of which channels are filling your calendar.$body$
WHERE client_slug = 'erika-frieze'
  AND next_period_heading IS NULL;
