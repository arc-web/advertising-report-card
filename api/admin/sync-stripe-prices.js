// /api/admin/sync-stripe-prices.js
// Admin-triggered sync that pulls active Stripe Prices and populates
// stripe_price_id on matching pricing_tiers rows. Invoked by the "Sync from
// Stripe" button on /admin/pricing. Mirrors scripts/sync-stripe-prices.js
// but runs server-side with the Vercel-stored STRIPE_SECRET_KEY, so no local
// env setup is required.
//
// Match rule:
//   - Stripe Price.unit_amount must equal pricing_tiers.amount_cents
//   - If multiple Stripe Prices share the same unit_amount, disambiguate by
//     inspecting the Product's name:
//       · product_key = 'entity_audit_premium' → prefer name containing
//         "audit" or "entity"
//       · otherwise prefer names NOT containing those
//   - If still ambiguous (>1 candidate) → skip that tier, report it as
//     ambiguous so an admin can hand-pick in the editor.
//   - If no candidate → report no_match.
//
// Auth: admin JWT (cookie or Bearer) via requireAdmin.
// Method: POST. Body: { apply?: boolean } — defaults to dry-run when false.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var body = req.body || {};
  var apply = body.apply === true;

  var tiers;
  try {
    tiers = await sb.query('pricing_tiers?select=id,product_key,tier_key,display_name,amount_cents,stripe_price_id&order=product_key.asc,sort_order.asc&limit=500');
  } catch (e) {
    return res.status(500).json({ error: 'pricing_tiers fetch failed: ' + e.message });
  }

  // Pull every active Stripe Price. Pagination via starting_after.
  var stripePrices = [];
  var startingAfter = null;
  try {
    for (var page = 0; page < 20; page++) {
      var url = 'https://api.stripe.com/v1/prices?limit=100&active=true&expand[]=data.product' +
                (startingAfter ? '&starting_after=' + encodeURIComponent(startingAfter) : '');
      var resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + STRIPE_KEY } });
      if (!resp.ok) {
        return res.status(502).json({ error: 'stripe prices list failed: HTTP ' + resp.status });
      }
      var data = await resp.json();
      stripePrices = stripePrices.concat(data.data || []);
      if (!data.has_more || !data.data || data.data.length === 0) break;
      startingAfter = data.data[data.data.length - 1].id;
    }
  } catch (e) {
    return res.status(502).json({ error: 'stripe request failed: ' + e.message });
  }

  var byAmount = {};
  stripePrices.forEach(function(p) {
    if (typeof p.unit_amount !== 'number') return;
    if (!byAmount[p.unit_amount]) byAmount[p.unit_amount] = [];
    byAmount[p.unit_amount].push(p);
  });

  var updates = [];
  var ambiguous = 0;
  var noMatch = 0;
  var inSync = 0;
  var details = [];

  tiers.forEach(function(t) {
    var candidates = byAmount[t.amount_cents] || [];
    var chosen = null;
    var status;
    if (candidates.length === 0) {
      status = 'no_match';
      noMatch++;
    } else if (candidates.length === 1) {
      chosen = candidates[0];
      status = t.stripe_price_id === chosen.id ? 'in_sync' : 'will_update';
    } else {
      var preferAudit = t.product_key === 'entity_audit_premium';
      var filtered = candidates.filter(function(m) {
        var name = (m.product && m.product.name) ? String(m.product.name).toLowerCase() : '';
        var isAuditPrice = name.indexOf('audit') !== -1 || name.indexOf('entity') !== -1;
        return preferAudit ? isAuditPrice : !isAuditPrice;
      });
      if (filtered.length === 1) {
        chosen = filtered[0];
        status = t.stripe_price_id === chosen.id ? 'in_sync' : 'will_update';
      } else {
        status = 'ambiguous';
        ambiguous++;
      }
    }
    if (status === 'in_sync') inSync++;
    if (status === 'will_update') updates.push({ id: t.id, tier_key: t.tier_key, stripe_price_id: chosen.id });
    details.push({ tier_key: t.tier_key, product: t.product_key, status: status, chosen: chosen ? chosen.id : null });
  });

  if (!apply) {
    return res.status(200).json({
      dry_run: true,
      tiers_total: tiers.length,
      updates: updates,
      ambiguous: ambiguous,
      no_match: noMatch,
      in_sync: inSync,
      details: details
    });
  }

  // Apply — PATCH each update sequentially to keep failure diagnosis simple.
  var written = [];
  var failed = [];
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    try {
      await sb.mutate('pricing_tiers?id=eq.' + encodeURIComponent(u.id), 'PATCH', { stripe_price_id: u.stripe_price_id });
      written.push(u);
    } catch (e) {
      failed.push({ tier_key: u.tier_key, error: e.message });
    }
  }

  return res.status(200).json({
    dry_run: false,
    tiers_total: tiers.length,
    updates: written,
    failed: failed,
    ambiguous: ambiguous,
    no_match: noMatch,
    in_sync: inSync
  });
};
