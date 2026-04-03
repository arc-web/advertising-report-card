// /api/send-proposal-email.js
// Sends a proposal email to the prospect via Resend.
// From: proposals@clients.moonraker.ai
// Reply-To: scott@moonraker.ai
// CC: chris@moonraker.ai, scott@moonraker.ai
//
// POST { proposal_id, subject?, body_html?, preview_only? }
//   - If subject/body_html omitted, generates a default email
//   - If preview_only=true, returns the email without sending
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  // Load proposal + contact
  var proposal, contact;
  try {
    var pResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1', { headers: sbHeaders() });
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    proposal = proposals[0];
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load proposal: ' + e.message });
  }

  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });
  if (!proposal.proposal_url) return res.status(400).json({ error: 'Proposal has not been deployed yet' });

  var firstName = contact.first_name || 'there';
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var proposalUrl = proposal.proposal_url;

  // Build default email if not provided
  var subject = body.subject || 'Your Growth Proposal from Moonraker is Ready';
  var bodyHtml = body.body_html || buildDefaultEmail(firstName, practiceName, proposalUrl);

  // Preview mode - return without sending
  if (body.preview_only) {
    return res.status(200).json({
      ok: true,
      preview: true,
      to: contact.email,
      from: 'proposals@clients.moonraker.ai',
      reply_to: 'scott@moonraker.ai',
      cc: 'chris@moonraker.ai, scott@moonraker.ai',
      subject: subject,
      body_html: bodyHtml
    });
  }

  // Send via Resend
  try {
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Moonraker AI <proposals@clients.moonraker.ai>',
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: subject,
        html: bodyHtml
      })
    });
    var emailData = await emailResp.json();

    if (emailData.id) {
      // Update proposal record
      await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId, {
        method: 'PATCH', headers: sbHeaders(),
        body: JSON.stringify({
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_from: 'proposals@clients.moonraker.ai',
          sent_to: contact.email,
          email_subject: subject,
          email_body: bodyHtml
        })
      });

      return res.status(200).json({ ok: true, email_id: emailData.id });
    } else {
      return res.status(500).json({ error: 'Resend error', details: emailData });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
};

function buildDefaultEmail(firstName, practiceName, proposalUrl) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7fdfb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:2rem 1.5rem;">

<div style="text-align:center;margin-bottom:2rem;">
  <img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" alt="Moonraker" style="height:40px;">
</div>

<div style="background:#ffffff;border-radius:12px;padding:2rem;border:1px solid #e2e8f0;">
  <h1 style="font-family:'Outfit',sans-serif;font-size:1.5rem;color:#1E2A5E;margin:0 0 1rem;">Hi ${firstName},</h1>

  <p style="color:#333F70;line-height:1.7;margin-bottom:1rem;">Thank you for taking the time to speak with us about ${practiceName}. We have put together a personalized growth proposal based on our conversation and analysis of your current digital presence.</p>

  <p style="color:#333F70;line-height:1.7;margin-bottom:1.5rem;">Inside, you will find a detailed assessment of where your practice stands today across the four pillars of our CORE framework, along with a concrete strategy and timeline for growing your visibility in both traditional search and AI-powered platforms.</p>

  <div style="text-align:center;margin:2rem 0;">
    <a href="${proposalUrl}" style="display:inline-block;background:#00D47E;color:#ffffff;padding:.75rem 2rem;border-radius:8px;font-weight:600;font-size:1rem;text-decoration:none;">View Your Proposal</a>
  </div>

  <p style="color:#333F70;line-height:1.7;margin-bottom:1rem;">Feel free to take your time reviewing everything. If you have any questions, you can reply to this email and it will go directly to Scott, our Director of Growth, or you can book a follow-up call at a time that works for you.</p>

  <div style="text-align:center;margin:1.5rem 0;">
    <a href="https://msg.moonraker.ai/widget/bookings/scott-pope-calendar" style="display:inline-block;border:1px solid #00D47E;color:#00D47E;padding:.5rem 1.5rem;border-radius:8px;font-weight:500;font-size:.9rem;text-decoration:none;">Book a Call with Scott</a>
  </div>

  <p style="color:#333F70;line-height:1.7;margin-bottom:0;">We are excited about the opportunity to help ${practiceName} grow. Looking forward to hearing your thoughts.</p>
</div>

<div style="text-align:center;padding:1.5rem 0;color:#6B7599;font-size:.8rem;">
  <p style="margin:0;">Moonraker AI - moonraker.ai</p>
  <p style="margin:.25rem 0 0;">This email was sent to you because you expressed interest in our services.</p>
</div>

</div>
</body>
</html>`;
}

