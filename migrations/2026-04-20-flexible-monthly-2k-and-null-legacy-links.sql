-- Flexible monthly tier bumped to $2,000/mo (+ CC markup to $2,070).
-- This is the only tier that changed; all annual_* and quarterly_* rates
-- remain the same. Rationale: with the new 12-month commitment structure
-- locking in annual_monthly at $1,667/mo + performance guarantee, the
-- flexible "no commitment" tier needs price differentiation to make the
-- upsell conversation concrete. Applied 2026-04-20 via MCP execute_sql.

UPDATE pricing_tiers
   SET amount_cents = 200000, updated_at = NOW()
 WHERE tier_key = 'monthly_ach' AND product_key = 'core_marketing';

UPDATE pricing_tiers
   SET amount_cents = 207000, updated_at = NOW()
 WHERE tier_key = 'monthly_cc'  AND product_key = 'core_marketing';

-- Null out the legacy buy.stripe.com payment links on every tier now that
-- dynamic pricing via api/checkout/create-session.js (inline price_data +
-- persistent Stripe Product via pricing_products.stripe_product_id) is the
-- sole source of truth. The fallback-to-payment-link path in create-session.js
-- was unreachable with amount_cents set on every row anyway — this just
-- removes the stale values so nobody looking at the table gets confused.
UPDATE pricing_tiers
   SET stripe_payment_link = NULL, updated_at = NOW()
 WHERE stripe_payment_link IS NOT NULL;
