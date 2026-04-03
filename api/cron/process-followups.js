// /api/cron/process-followups.js
// Runs daily via Vercel Cron. Finds pending follow-ups where scheduled_for <= now,
// checks if the prospect has signed up or been marked lost, then sends or cancels.
// Processes up to 10 followups per run to stay within function timeout.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var auth = req.headers['authorization'];
    var querySecret = req.query && req.query.secret;
    if (auth !== 'Bearer ' + cronSecret && querySecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  var now = new Date().toISOString();
  var results = { sent: 0, cancelled: 0, failed: 0, skipped: 0 };

  try {
    // Find pending followups where scheduled_for <= now
    var qResp = await fetch(
      sbUrl + '/rest/v1/proposal_followups?status=eq.pending&scheduled_for=lte.' + now
        + '&order=scheduled_for.asc&limit=10'
        + '&select=*,proposals(id,sent_at,status,contacts(id,email,first_name,last_name,practice_name,status,lost))',
      { headers: sbHeaders() }
    );
    var followups = await qResp.json();

    if (!followups || followups.length === 0) {
      return res.status(200).json({ ok: true, message: 'No follow-ups due', results: results });
    }

    for (var i = 0; i < followups.length; i++) {
      var fu = followups[i];
      var proposal = fu.proposals;
      var contact = proposal ? proposal.contacts : null;

      if (!contact || !contact.email) {
        // Skip - no contact or email
        await patchFollowup(sbUrl, sbHeaders, fu.id, {
          status: 'failed',
          error_message: 'No contact email found',
          updated_at: now
        });
        results.failed++;
        continue;
      }

      // Check if prospect has moved past prospect status or is lost
      var cancelStatuses = ['onboarding', 'active'];
      if (cancelStatuses.indexOf(contact.status) !== -1 || contact.lost) {
        // Cancel this and all remaining pending followups for this proposal
        var reason = contact.lost ? 'lost' : 'signed_up';
        await fetch(
          sbUrl + '/rest/v1/proposal_followups?proposal_id=eq.' + proposal.id + '&status=eq.pending',
          {
            method: 'PATCH',
            headers: sbHeaders('return=representation'),
            body: JSON.stringify({
              status: 'cancelled',
              cancelled_at: now,
              cancel_reason: reason,
              updated_at: now
            })
          }
        );
        results.cancelled++;
        continue;
      }

      // Send the email
      try {
        var emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Moonraker AI <proposals@clients.moonraker.ai>',
            to: [contact.email],
            cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
            reply_to: 'scott@moonraker.ai',
            subject: fu.subject,
            html: fu.body_html
          })
        });
        var emailData = await emailResp.json();

        if (emailData.id) {
          await patchFollowup(sbUrl, sbHeaders, fu.id, {
            status: 'sent',
            sent_at: now,
            updated_at: now
          });
          results.sent++;
        } else {
          await patchFollowup(sbUrl, sbHeaders, fu.id, {
            status: 'failed',
            error_message: JSON.stringify(emailData).substring(0, 500),
            updated_at: now
          });
          results.failed++;
        }
      } catch (sendErr) {
        await patchFollowup(sbUrl, sbHeaders, fu.id, {
          status: 'failed',
          error_message: sendErr.message,
          updated_at: now
        });
        results.failed++;
      }
    }

    return res.status(200).json({ ok: true, results: results });
  } catch (e) {
    return res.status(500).json({ error: 'Cron failed: ' + e.message, results: results });
  }
};

async function patchFollowup(sbUrl, sbHeaders, id, data) {
  await fetch(sbUrl + '/rest/v1/proposal_followups?id=eq.' + id, {
    method: 'PATCH',
    headers: sbHeaders('return=representation'),
    body: JSON.stringify(data)
  });
}
