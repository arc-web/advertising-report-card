// api/admin/clients-directory.js
// Server-side aggregation endpoint for the clients directory view.
// Replaces 5 direct browser-to-Supabase requests with 1 API call.
// Uses service_role (no RLS overhead) and runs all queries in parallel.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  try {
    var results = await Promise.all([
      // 1. All contacts with directory fields (GET)
      sb.query('contacts?select=id,slug,status,practice_name,email,first_name,last_name,campaign_start,website_url,phone,state_province,city,team_size,lost,follow_up_date,audit_tier,referral_source,referral_code&order=practice_name'),

      // 2. Onboarding summary (POST RPC - replaces 738+ raw rows)
      sb.mutate('rpc/get_onboarding_summary', 'POST', {}),

      // 3. Checklist summary (POST RPC)
      sb.mutate('rpc/get_checklist_summary', 'POST', {}),

      // 4. Intro call summary (POST RPC - replaces 1,106+ raw rows)
      sb.mutate('rpc/get_intro_call_summary', 'POST', {}),

      // 5. Deliverable summary (POST RPC)
      sb.mutate('rpc/get_deliverable_summary', 'POST', {})
    ]);

    res.status(200).json({
      contacts: results[0] || [],
      onboarding: results[1] || [],
      checklist: results[2] || [],
      introCalls: results[3] || [],
      deliverables: results[4] || []
    });
  } catch (e) {
    console.error('[clients-directory] Error:', e.message);
    res.status(500).json({ error: 'Failed to load directory data' });
  }
};
