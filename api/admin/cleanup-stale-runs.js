// /api/admin/cleanup-stale-runs.js
// One-shot admin endpoint for the "Clean up stale runs" button on
// /admin/system. Same core logic as the hourly cron, but admin-only (no
// CRON_SECRET fallback) and NOT wrapped in withTracking — operator-initiated
// cleanups should not create synthetic rows in cron_runs.
//
// If you change STALE_CUTOFF_MS here, change it in the cron too.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

var STALE_CUTOFF_MS = 60 * 60 * 1000; // 1 hour — matches api/cron/cleanup-stale-runs.js

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  var cutoff = new Date(Date.now() - STALE_CUTOFF_MS).toISOString();

  try {
    var updated = await sb.mutate(
      'cron_runs?status=eq.running&started_at=lt.' + encodeURIComponent(cutoff),
      'PATCH',
      {
        status: 'error',
        error: 'manual cleanup: still marked running more than 1h after start',
        completed_at: new Date().toISOString()
      },
      'return=representation'
    );
    var count = Array.isArray(updated) ? updated.length : 0;
    console.log('[admin/cleanup-stale-runs] expired', count, 'stale rows (cutoff:', cutoff, ') by', user.email || user.sub);

    return res.status(200).json({
      ok: true,
      cleaned: count,
      cutoff: cutoff
    });
  } catch (e) {
    console.error('[admin/cleanup-stale-runs] error:', e.message);
    monitor.logError('admin/cleanup-stale-runs', e, {
      detail: { stage: 'patch', cutoff: cutoff }
    });
    return res.status(500).json({ error: 'Stale run cleanup failed' });
  }
};
