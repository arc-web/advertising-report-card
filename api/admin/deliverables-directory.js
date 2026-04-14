// api/admin/deliverables-directory.js
// Server-side aggregation for the deliverables summary page.
// Replaces 2 browser-to-Supabase requests with 1 API call.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  try {
    var results = await Promise.all([
      // Contacts
      sb.query('contacts?select=id,slug,status,practice_name,first_name,last_name,email,website_platform&order=practice_name'),

      // All deliverables
      sb.query('deliverables?select=*&order=created_at.desc&limit=5000')
    ]);

    res.status(200).json({
      contacts: results[0] || [],
      deliverables: results[1] || []
    });
  } catch (e) {
    console.error('[deliverables-directory] Error:', e.message);
    res.status(500).json({ error: 'Failed to load deliverables data' });
  }
};
