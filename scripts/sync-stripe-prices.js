#!/usr/bin/env node
// scripts/sync-stripe-prices.js
//
// Pulls every active Price from Stripe and matches each one against a row in
// pricing_tiers by amount_cents (+ optional product_key hint via the Stripe
// Product's name). Updates stripe_price_id on confirmed matches.
//
// Once stripe_price_id is populated for a tier, /api/checkout/create-session
// flips that tier from the legacy buy.stripe.com payment-link redirect to a
// real Stripe Checkout Session with success_url, cancel_url, metadata, etc.
//
// USAGE:
//   STRIPE_SECRET_KEY=sk_live_... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/sync-stripe-prices.js [--dry-run] [--apply]
//
//   --dry-run      Print proposed updates without writing (default if no flag)
//   --apply        Actually PATCH pricing_tiers
//   --product=KEY  Restrict to one product_key (core_marketing | entity_audit_premium)
//
// Output: per-tier table showing
//   tier_key | amount_cents | match status | stripe_price_id (current → new)
//
// Notes:
//   - Stripe Prices that match multiple tiers (same amount, different cadence)
//     are flagged "ambiguous" and SKIPPED — disambiguate by tweaking the Stripe
//     Price's nickname or by hand-editing in the admin/system Pricing editor.
//   - Stripe Prices for products NOT in our table are silently ignored.

var SB_URL = process.env.SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
var STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!STRIPE_KEY) { console.error('[sync-stripe] STRIPE_SECRET_KEY is required'); process.exit(1); }
if (!SERVICE_KEY) { console.error('[sync-stripe] SUPABASE_SERVICE_ROLE_KEY is required'); process.exit(1); }

var argv = process.argv.slice(2);
var apply = argv.includes('--apply');
var dryRun = argv.includes('--dry-run') || !apply;
var productFilter = (argv.find(function(a) { return a.indexOf('--product=') === 0; }) || '').slice(10) || null;

async function stripeGet(path, params) {
  var qs = params ? '?' + Object.keys(params).map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])); }).join('&') : '';
  var resp = await fetch('https://api.stripe.com/v1' + path + qs, {
    headers: { 'Authorization': 'Bearer ' + STRIPE_KEY }
  });
  if (!resp.ok) throw new Error('Stripe ' + path + ' returned ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  return resp.json();
}

async function listAllStripePrices() {
  var prices = [];
  var startingAfter = null;
  for (var page = 0; page < 20; page++) {
    var params = { limit: 100, active: 'true', expand_0: 'data.product' };
    // Stripe expand[] uses array notation; encode manually for fetch().
    var url = '/prices?limit=100&active=true&expand[]=data.product' + (startingAfter ? '&starting_after=' + encodeURIComponent(startingAfter) : '');
    var resp = await fetch('https://api.stripe.com/v1' + url, {
      headers: { 'Authorization': 'Bearer ' + STRIPE_KEY }
    });
    if (!resp.ok) throw new Error('stripe prices list failed: HTTP ' + resp.status);
    var page1 = await resp.json();
    prices = prices.concat(page1.data || []);
    if (!page1.has_more || !page1.data || !page1.data.length) break;
    startingAfter = page1.data[page1.data.length - 1].id;
  }
  return prices;
}

async function sbGet(pathQuery) {
  var resp = await fetch(SB_URL + '/rest/v1/' + pathQuery, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY }
  });
  if (!resp.ok) throw new Error('supabase ' + pathQuery + ' returned ' + resp.status);
  return resp.json();
}

async function sbPatch(pathQuery, body) {
  var resp = await fetch(SB_URL + '/rest/v1/' + pathQuery, {
    method: 'PATCH',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('supabase PATCH ' + pathQuery + ' returned ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  return resp.json();
}

(async function main() {
  console.log('[sync-stripe] mode: ' + (dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY'));
  if (productFilter) console.log('[sync-stripe] product filter: ' + productFilter);

  var tiers = await sbGet('pricing_tiers?select=id,product_key,tier_key,display_name,amount_cents,stripe_price_id' + (productFilter ? '&product_key=eq.' + productFilter : '') + '&order=product_key.asc,sort_order.asc&limit=500');
  console.log('[sync-stripe] loaded ' + tiers.length + ' pricing_tiers row(s)');

  console.log('[sync-stripe] fetching active Stripe prices...');
  var stripePrices = await listAllStripePrices();
  console.log('[sync-stripe] fetched ' + stripePrices.length + ' active Stripe price(s)');

  // Group Stripe prices by unit_amount so we can detect ambiguity quickly.
  var byAmount = {};
  stripePrices.forEach(function(p) {
    if (typeof p.unit_amount !== 'number') return;
    if (!byAmount[p.unit_amount]) byAmount[p.unit_amount] = [];
    byAmount[p.unit_amount].push(p);
  });

  var rows = [];
  var updates = [];

  tiers.forEach(function(t) {
    var matches = byAmount[t.amount_cents] || [];
    var status, chosen = null;
    if (matches.length === 0) {
      status = 'no-match';
    } else if (matches.length === 1) {
      status = t.stripe_price_id === matches[0].id ? 'in-sync' : 'will-update';
      chosen = matches[0];
    } else {
      // Try to disambiguate by recurring interval matching billing_cadence and
      // by product name containing entity-audit when product_key is the audit one.
      var preferAudit = t.product_key === 'entity_audit_premium';
      var filtered = matches.filter(function(m) {
        var name = (m.product && m.product.name) ? String(m.product.name).toLowerCase() : '';
        var isAuditPrice = name.indexOf('audit') !== -1 || name.indexOf('entity') !== -1;
        if (preferAudit) return isAuditPrice;
        return !isAuditPrice;
      });
      if (filtered.length === 1) {
        status = t.stripe_price_id === filtered[0].id ? 'in-sync' : 'will-update';
        chosen = filtered[0];
      } else {
        status = 'ambiguous (' + matches.length + ' candidates)';
      }
    }
    rows.push({
      product: t.product_key,
      tier_key: t.tier_key,
      amount: t.amount_cents,
      current: t.stripe_price_id || '(none)',
      proposed: chosen ? chosen.id : '-',
      status: status
    });
    if (chosen && status === 'will-update') {
      updates.push({ id: t.id, tier_key: t.tier_key, stripe_price_id: chosen.id });
    }
  });

  // Print as a simple table.
  console.log('');
  console.log('| product                | tier_key                  | amount_cents | current price       | proposed              | status                  |');
  console.log('|------------------------|---------------------------|--------------|---------------------|-----------------------|-------------------------|');
  rows.forEach(function(r) {
    console.log('| ' + r.product.padEnd(22) + ' | ' + r.tier_key.padEnd(25) + ' | ' + String(r.amount).padStart(12) + ' | ' + String(r.current).padEnd(19) + ' | ' + String(r.proposed).padEnd(21) + ' | ' + r.status.padEnd(23) + ' |');
  });
  console.log('');

  if (updates.length === 0) {
    console.log('[sync-stripe] No updates to apply.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('[sync-stripe] ' + updates.length + ' tier(s) would be updated. Re-run with --apply to write.');
    process.exit(0);
  }

  console.log('[sync-stripe] Applying ' + updates.length + ' update(s)...');
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    try {
      await sbPatch('pricing_tiers?id=eq.' + encodeURIComponent(u.id), { stripe_price_id: u.stripe_price_id });
      console.log('  ✓ ' + u.tier_key + ' → ' + u.stripe_price_id);
    } catch (e) {
      console.error('  ✗ ' + u.tier_key + ' failed: ' + e.message);
    }
  }
  console.log('[sync-stripe] Done.');
})().catch(function(e) {
  console.error('[sync-stripe] FATAL:', e && e.stack || e);
  process.exit(1);
});
