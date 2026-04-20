// /api/cron/cleanup-stale-runs.js
// Hourly cron: finds cron_runs rows still marked status='running' more than
// 1 hour after started_at and flips them to status='error' with a synthetic
// error reason. Prevents "Unfinished Runs" from growing unbounded as Vercel
// functions crash, time out, or OOM without writing completed_at.
//
// 1 hour is a safe ceiling: no Vercel serverless function can run that long
// (Pro plan max is 300s / 5 minutes), so anything older than 1h has
// definitively died without recording completion.
//
// Scheduled in vercel.json: "0 * * * *" (top of every hour).
// Auth: CRON_SECRET / admin JWT / AGENT_API_KEY via requireAdminOrInternal.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

var STALE_CUTOFF_MS = 60 * 60 * 1000; // 1 hour

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdminOrInternal(req, res);
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
        error: 'auto-expired: still marked running more than 1h after start',
        completed_at: new Date().toISOString()
      },
      'return=representation'
    );
    var count = Array.isArray(updated) ? updated.length : 0;
    console.log('[cleanup-stale-runs] expired', count, 'stale rows (cutoff:', cutoff, ')');

    return res.status(200).json({
      ok: true,
      cleaned: count,
      cutoff: cutoff
    });
  } catch (e) {
    console.error('[cleanup-stale-runs] error:', e.message);
    monitor.logError('cron/cleanup-stale-runs', e, {
      detail: { stage: 'patch', cutoff: cutoff }
    });
    return res.status(500).json({ error: 'Stale run cleanup failed' });
  }
}

module.exports = cronRuns.withTracking('cleanup-stale-runs', handler);
