// api/backfill-progress-pages.js
//
// One-shot admin endpoint to redeploy /<slug>/audits/progress/index.html for
// every client that already has one, injecting a scope='progress' page token.
//
// Needed after security audit H4 landed: the legacy deployed copies of
// progress.html PATCHed /rest/v1/checklist_items directly via the anon key.
// The anon_update_status policy has been dropped, so those copies now 403
// on every toggle until they're replaced with the new template that
// routes through /api/progress-update with a signed page token.
//
// Auth: Bearer CRON_SECRET.
//
// POST /api/backfill-progress-pages
// Optional body: { "dry_run": true, "limit": 5 }
//
// Returns:
//   {
//     scanned:          number,  // candidates considered
//     already_deployed: number,  // (only if force=false, which is the default)
//     deployed:         number,  // pushed with signed token
//     failed:           number,  // sign or push errored
//     results:          [{ slug, status, ... }]
//   }
//
// Security:
//   - Fails closed on missing CRON_SECRET
//   - Constant-time token comparison via auth.requireCronSecret
//   - Paces pushes with a 700ms delay to avoid GitHub secondary-rate-limits
//   - Skip + log (don't deploy a broken page) on sign failure.

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var gh = require('./_lib/github');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var user = await auth.requireCronSecret(req, res);
  if (!user) return;

  var body = req.body || {};
  var dryRun = !!body.dry_run;
  var force = body.force !== false; // default true for this backfill — every
                                    // existing page carries the legacy anon-PATCH
                                    // code path and MUST be replaced.
  var limit = Math.min(Number(body.limit || 200), 200);

  var t0 = Date.now();

  try {
    // 1. Pull template once
    var template = await gh.readTemplate('progress.html');

    // 2. List candidate clients. The progress page ships to leads, prospects,
    //    onboarding, and active — any contact that has a campaign audit suite.
    var contacts = await sb.query(
      'contacts?status=in.(lead,prospect,onboarding,active)'
      + '&select=id,slug'
      + '&slug=not.is.null'
      + '&order=slug.asc'
    );

    var scanned = 0;
    var alreadyDeployed = 0;
    var deployed = 0;
    var failed = 0;
    var results = [];

    for (var c of contacts) {
      if (deployed >= limit) {
        results.push({ slug: c.slug, status: 'skipped_limit_reached' });
        continue;
      }
      scanned++;
      var destPath = c.slug + '/audits/progress/index.html';

      try {
        var existingSha = await gh.fileSha(destPath);
        if (!existingSha) {
          // No prior progress page — skip (we only redeploy what's already
          // shipped; initial deploys go through setup-audit-schedule.js or
          // process-entity-audit.js with the token injected inline).
          results.push({ slug: c.slug, status: 'no_existing_page' });
          continue;
        }
        if (existingSha && !force) {
          alreadyDeployed++;
          results.push({ slug: c.slug, status: 'already_deployed' });
          continue;
        }

        if (dryRun) {
          results.push({ slug: c.slug, status: 'would_update' });
          deployed++;
          continue;
        }

        var signedToken;
        try {
          signedToken = pageToken.sign({ scope: 'progress', contact_id: c.id });
        } catch (e) {
          failed++;
          monitor.logError('backfill-progress-pages', e, {
            client_slug: c.slug,
            detail: { stage: 'sign_token' }
          });
          results.push({ slug: c.slug, status: 'failed', error: 'Token sign failed' });
          continue;
        }
        var html = template.split('{{PAGE_TOKEN}}').join(signedToken);

        await gh.pushFile(
          destPath,
          html,
          'Backfill progress token for ' + c.slug,
          existingSha
        );
        deployed++;
        results.push({ slug: c.slug, status: 'updated' });

        // Pace to avoid GitHub secondary-rate-limits.
        await sleep(700);
      } catch (e) {
        failed++;
        monitor.logError('backfill-progress-pages', e, {
          client_slug: c.slug,
          detail: { stage: 'backfill_per_client' }
        });
        results.push({ slug: c.slug, status: 'failed', error: 'Backfill failed' });
      }
    }

    res.status(200).json({
      scanned: scanned,
      already_deployed: alreadyDeployed,
      deployed: deployed,
      failed: failed,
      total_candidates: contacts.length,
      duration_ms: Date.now() - t0,
      results: results
    });
  } catch (e) {
    monitor.logError('backfill-progress-pages', e, {
      detail: { stage: 'backfill_handler' }
    });
    res.status(500).json({
      error: 'Backfill failed',
      duration_ms: Date.now() - t0
    });
  }
};
