// /api/cron/process-audit-queue.js
// Runs every 15 minutes. Picks the oldest queued entity audit and triggers the agent.
// Processes one at a time to avoid overwhelming the agent service.
//
// Vercel cron: every 15 minutes

var sb = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  // Auth: verify cron secret
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var authH = req.headers['authorization'];
    var qSecret = req.query && req.query.secret;
    if (authH !== 'Bearer ' + cronSecret && qSecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: 'Agent service not configured' });
  }

  try {
    // Find the oldest queued audit
    var queued = await sb.query(
      'entity_audits?status=eq.queued' +
      '&select=id,contact_id,client_slug,brand_query,homepage_url,geo_target,gbp_share_link' +
      '&order=created_at.asc&limit=1'
    );

    if (!queued || queued.length === 0) {
      return res.status(200).json({ message: 'No queued audits.', remaining: 0 });
    }

    var audit = queued[0];

    // Get contact details for the agent
    var contact = await sb.one('contacts?id=eq.' + audit.contact_id + '&select=city,state_province,website_url&limit=1');

    // Trigger the agent
    var agentResp = await fetch(AGENT_URL + '/tasks/surge-audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify({
        audit_id: audit.id,
        practice_name: audit.brand_query,
        website_url: audit.homepage_url || (contact && contact.website_url) || '',
        city: (contact && contact.city) || '',
        state: (contact && contact.state_province) || '',
        geo_target: audit.geo_target || '',
        gbp_link: audit.gbp_share_link || '',
        client_slug: audit.client_slug
      })
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch (e) {}
      // Mark as error so it doesn't block the queue
      await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
        status: 'agent_error'
      }, 'return=minimal');
      return res.status(200).json({
        error: 'Agent returned ' + agentResp.status,
        detail: errText.substring(0, 300),
        audit_id: audit.id,
        slug: audit.client_slug
      });
    }

    var agentResult = await agentResp.json();

    // Update audit status
    await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
      status: 'agent_running',
      agent_task_id: agentResult.task_id
    }, 'return=minimal');

    // Count remaining
    var remaining = await sb.query('entity_audits?status=eq.queued&select=id');
    var remainCount = remaining ? remaining.length : 0;

    return res.status(200).json({
      success: true,
      triggered: audit.client_slug,
      audit_id: audit.id,
      task_id: agentResult.task_id,
      remaining: remainCount,
      message: 'Triggered audit for ' + audit.client_slug + '. ' + remainCount + ' remaining in queue.'
    });

  } catch (err) {
    console.error('process-audit-queue error:', err);
    return res.status(500).json({ error: err.message });
  }
};
