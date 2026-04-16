// api/newsletter-webhook.js
// Resend webhook handler for newsletter event tracking.
// Receives: email.delivered, email.opened, email.clicked,
//           email.bounced, email.complained
// Updates newsletter_sends and newsletter_subscribers tables.
// Configure in Resend dashboard: POST https://clients.moonraker.ai/api/newsletter-webhook

var crypto = require('crypto');
var sb = require('./_lib/supabase');

function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Fail closed: webhook must be configured. Missing secret means we cannot
  // verify signatures, which means we cannot trust the payload.
  var webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[newsletter-webhook] RESEND_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'webhook not configured' });
  }

  // Read the raw request body as a Buffer.
  var rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  // Verify svix signature headers.
  var svixId = req.headers['svix-id'];
  var svixTimestamp = req.headers['svix-timestamp'];
  var svixSignature = req.headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(401).json({ error: 'Missing webhook signature headers' });
  }

  var ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) {
    return res.status(401).json({ error: 'Invalid webhook timestamp' });
  }
  var age = Math.abs(Date.now() / 1000 - ts);
  if (age > 300) {
    return res.status(401).json({ error: 'Webhook timestamp too old' });
  }

  var toSign = svixId + '.' + svixTimestamp + '.' + rawBody.toString('utf8');
  var secretBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
  var expected = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');
  var expectedBuf = Buffer.from(expected, 'base64');

  // svix-signature can contain multiple space-separated versioned signatures:
  // "v1,abc... v1,def..."
  var signatures = svixSignature.split(' ').map(function(s) { return s.replace(/^v1,/, ''); });
  var valid = signatures.some(function(sig) {
    var sigBuf;
    try {
      sigBuf = Buffer.from(sig, 'base64');
    } catch (e) {
      return false;
    }
    // timingSafeEqual throws on length mismatch — guard first.
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
  if (!valid) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Parse the verified payload from the raw buffer (req.body is undefined
  // now that we've disabled Vercel's body parser).
  var body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  try {
    if (!body || !body.type) return res.status(400).json({ error: 'Invalid webhook payload' });

    var type = body.type;
    var data = body.data || {};
    var messageId = data.email_id || '';
    var now = new Date().toISOString();

    if (!messageId) return res.status(200).json({ ok: true, skipped: 'no message id' });

    // Find the send record by Resend message ID
    var sends = await sb.query('newsletter_sends?resend_message_id=eq.' + encodeURIComponent(messageId) + '&select=id,subscriber_id,newsletter_id,status,bounce_count');
    if (!sends.length) return res.status(200).json({ ok: true, skipped: 'send record not found' });

    var send = sends[0];
    var updates = {};
    var subUpdates = {};

    switch (type) {
      case 'email.delivered':
        updates.status = 'delivered';
        updates.delivered_at = now;
        subUpdates.last_engaged_at = now;
        break;

      case 'email.opened':
        updates.status = 'opened';
        updates.opened_at = now;
        subUpdates.last_engaged_at = now;
        // Increment newsletter stats
        await incrementStat(send.newsletter_id, 'stats_opened');
        break;

      case 'email.clicked':
        updates.status = 'clicked';
        updates.clicked_at = now;
        subUpdates.last_engaged_at = now;
        await incrementStat(send.newsletter_id, 'stats_clicked');
        break;

      case 'email.bounced':
        updates.status = 'bounced';
        subUpdates.status = 'bounced';
        subUpdates.bounce_count = (send.bounce_count || 0) + 1;
        await incrementStat(send.newsletter_id, 'stats_bounced');
        break;

      case 'email.complained':
        updates.status = 'complained';
        subUpdates.status = 'complained';
        await incrementStat(send.newsletter_id, 'stats_complained');
        break;

      default:
        return res.status(200).json({ ok: true, skipped: 'unhandled type: ' + type });
    }

    // Update send record
    if (Object.keys(updates).length) {
      await sb.mutate('newsletter_sends?id=eq.' + encodeURIComponent(send.id), 'PATCH', updates);
    }

    // Update subscriber record
    if (Object.keys(subUpdates).length) {
      await sb.mutate('newsletter_subscribers?id=eq.' + encodeURIComponent(send.subscriber_id), 'PATCH', subUpdates);
    }

    // Auto-upgrade engagement tier on opens/clicks
    if (type === 'email.opened' || type === 'email.clicked') {
      await sb.mutate('newsletter_subscribers?id=eq.' + encodeURIComponent(send.subscriber_id) + '&engagement_tier=neq.hot', 'PATCH', {
        engagement_tier: 'hot'
      });
    }

    return res.status(200).json({ ok: true, type: type, send_id: send.id });

  } catch (e) {
    console.error('newsletter-webhook error:', e);
    // Always return 200 to prevent Resend retries on our errors
    return res.status(200).json({ ok: false, error: e.message });
  }
};

// Disable Vercel's default body parser so we can read the raw bytes that
// svix/Resend actually signed. Reconstructing via JSON.stringify(req.body)
// doesn't preserve key order, whitespace, or numeric formatting.
// NOTE: This must be assigned AFTER `module.exports = handler` above,
// otherwise the handler reassignment wipes it out.
module.exports.config = { api: { bodyParser: false } };

// Increment a stats column on the newsletters table using RPC
// Since we can't do atomic increments via REST easily, we fetch + update
async function incrementStat(newsletterId, column) {
  try {
    var newsletters = await sb.query('newsletters?id=eq.' + encodeURIComponent(newsletterId) + '&select=id,' + encodeURIComponent(column));
    if (!newsletters.length) return;
    var current = newsletters[0][column] || 0;
    var patch = {};
    patch[column] = current + 1;
    await sb.mutate('newsletters?id=eq.' + encodeURIComponent(newsletterId), 'PATCH', patch);
  } catch (e) {
    console.error('incrementStat error:', e);
  }
}
