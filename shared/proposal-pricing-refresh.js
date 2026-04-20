// /shared/proposal-pricing-refresh.js
// Runtime price-refresh for proposal pages.
//
// Problem: generate-proposal.js hardcodes tier prices into the HTML at
// generate time. Pricing lives in the pricing_tiers table now, so any edit
// in /admin/pricing would leave every already-deployed proposal showing a
// stale number next to a checkout button that would charge the current
// number — a bad customer experience.
//
// Solution: on page load, fetch /api/pricing?product=core_marketing and
// overwrite the .investment-price text inside each .investment-card based
// on the card's CTA href (?plan=annual|quarterly|monthly maps to the
// upfront ACH tier for that cadence, which is the flagship display price).
//
// Silent on failure — if /api/pricing 500s, page keeps showing baked-in
// prices. No alert, no layout shift, no DOM teardown.

(function() {
  function plan2tier(plan) {
    // Proposal cards use cadence-only plan keys (annual / quarterly / monthly).
    // Display the upfront-ACH flagship amount for each cadence.
    if (plan === 'annual')    return 'annual_upfront_ach';
    if (plan === 'quarterly') return 'quarterly_upfront_ach';
    if (plan === 'monthly')   return 'monthly_ach';
    return null;
  }

  function currentPlanFromCard(card) {
    var cta = card.querySelector('a.cta-btn, a.cta-btn-outline');
    if (!cta) return null;
    try {
      var u = new URL(cta.getAttribute('href'), location.href);
      return u.searchParams.get('plan');
    } catch (_) { return null; }
  }

  function applyPricing(tiersByKey) {
    var cards = document.querySelectorAll('.investment-card');
    cards.forEach(function(card) {
      var plan = currentPlanFromCard(card);
      if (!plan) return;
      var tierKey = plan2tier(plan);
      if (!tierKey) return;
      var tier = tiersByKey[tierKey];
      if (!tier) return;
      var priceEl = card.querySelector('.investment-price');
      if (!priceEl) return;
      priceEl.textContent = '$' + tier.amount_display;
    });
  }

  function run() {
    fetch('/api/pricing?product=core_marketing')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(data) {
        if (!data || !data.tiers) return;
        var map = {};
        data.tiers.forEach(function(t) { map[t.tier_key] = t; });
        applyPricing(map);
      })
      .catch(function(e) { console.error('[proposal-pricing-refresh] failed:', e && e.message); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
