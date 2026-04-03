// /api/approve-followups.js
// Approves a proposal's follow-up sequence and schedules send dates.
// Calculates scheduled_for based on proposal.sent_at + day_offset.
//
// POST { proposal_id }
// Moves all 'draft' followups to 'pending' with scheduled dates.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  // Load proposal to get sent_at
  try {
    var pResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId + '&select=id,sent_at,status&limit=1', { headers: sbHeaders() });
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return res.status(404).json({ error: 'Proposal not found' });

    var proposal = proposals[0];
    if (!proposal.sent_at) return res.status(400).json({ error: 'Proposal has not been sent yet. Cannot schedule follow-ups.' });

    var sentAt = new Date(proposal.sent_at);

    // Load draft followups
    var fResp = await fetch(
      sbUrl + '/rest/v1/proposal_followups?proposal_id=eq.' + proposalId + '&status=eq.draft&order=sequence_number.asc',
      { headers: sbHeaders() }
    );
    var followups = await fResp.json();

    if (!followups || followups.length === 0) {
      return res.status(400).json({ error: 'No draft follow-ups found. Generate them first.' });
    }

    // Schedule each one: sent_at + day_offset days, at 10:00 AM ET
    var updated = 0;
    for (var i = 0; i < followups.length; i++) {
      var fu = followups[i];
      var scheduledDate = new Date(sentAt);
      scheduledDate.setDate(scheduledDate.getDate() + fu.day_offset);
      // Set to 10:00 AM Eastern (UTC-4 or UTC-5 depending on DST)
      // Use 14:00 UTC as a safe approximation (10 AM ET during EDT)
      scheduledDate.setUTCHours(14, 0, 0, 0);

      // If the scheduled date is in the past, skip to avoid sending immediately
      var now = new Date();
      if (scheduledDate <= now) {
        // Push to tomorrow at 10 AM ET
        scheduledDate = new Date(now);
        scheduledDate.setDate(scheduledDate.getDate() + 1);
        scheduledDate.setUTCHours(14, 0, 0, 0);
      }

      await fetch(sbUrl + '/rest/v1/proposal_followups?id=eq.' + fu.id, {
        method: 'PATCH',
        headers: sbHeaders('return=representation'),
        body: JSON.stringify({
          status: 'pending',
          scheduled_for: scheduledDate.toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      updated++;
    }

    return res.status(200).json({
      ok: true,
      scheduled: updated,
      message: 'Approved and scheduled ' + updated + ' follow-up emails.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to approve followups: ' + e.message });
  }
};
