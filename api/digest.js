// /api/digest.js - Build and send team activity digest via Resend

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  try {
    var body = req.body;
    var from = body.from;
    var to = body.to;
    var recipients = body.recipients;

    if (!from || !to || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'from, to, and recipients required' });
    }

    var headers = {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
      'Content-Type': 'application/json'
    };

    var fromStart = from + 'T00:00:00Z';
    var toEnd = to + 'T23:59:59Z';

    // Fetch activity log and clients in parallel
    var [logsRes, clientsRes] = await Promise.all([
      fetch(supabaseUrl + '/rest/v1/activity_log?select=*&created_at=gte.' + fromStart + '&created_at=lte.' + toEnd + '&order=created_at.desc&limit=500', { headers: headers }),
      fetch(supabaseUrl + '/rest/v1/contacts?select=id,slug,practice_name,status&order=practice_name', { headers: headers })
    ]);

    var logs = await logsRes.json();
    var clients = await clientsRes.json();

    var clientMap = {};
    clients.forEach(function(cl) { clientMap[cl.slug] = cl; clientMap[cl.id] = cl; });

    // Group by client
    var byClient = {};
    logs.forEach(function(log) {
      var slug = log.client_slug || 'unknown';
      if (!byClient[slug]) byClient[slug] = [];
      byClient[slug].push(log);
    });

    // Stats
    var totalChanges = logs.length;
    var delCompleted = logs.filter(function(l) { return l.table_name === 'deliverables' && l.new_value === 'delivered'; }).length;
    var tasksCompleted = logs.filter(function(l) { return l.table_name === 'checklist_items' && l.new_value === 'complete'; }).length;
    var clientsActive = Object.keys(byClient).length;

    // Build HTML email
    var html = buildEmailHtml({
      from: from,
      to: to,
      totalChanges: totalChanges,
      delCompleted: delCompleted,
      tasksCompleted: tasksCompleted,
      clientsActive: clientsActive,
      byClient: byClient,
      clientMap: clientMap
    });

    // Send via Resend
    var sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Client HQ <support@moonraker.ai>',
        to: recipients,
        subject: 'Team Digest: ' + from + ' to ' + to + ' (' + totalChanges + ' changes)',
        html: html
      })
    });

    var sendResult = await sendRes.json();

    if (sendRes.ok) {
      return res.status(200).json({ success: true, emailId: sendResult.id, stats: { totalChanges: totalChanges, delCompleted: delCompleted, tasksCompleted: tasksCompleted, clientsActive: clientsActive } });
    } else {
      return res.status(500).json({ error: 'Resend error', detail: sendResult });
    }

  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};


function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmailHtml(data) {
  var tableNames = { deliverables: 'Deliverable', checklist_items: 'Audit Task', contacts: 'Contact', onboarding_steps: 'Onboarding' };

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#f4f7f5;font-family:Inter,system-ui,sans-serif;">';
  html += '<div style="max-width:640px;margin:0 auto;padding:24px;">';

  // Header
  html += '<div style="background:linear-gradient(135deg,#0A1630,#141C3A);border-radius:16px;padding:32px;margin-bottom:24px;text-align:center;">';
  html += '<img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" height="32" style="margin-bottom:12px;opacity:.7;">';
  html += '<h1 style="color:#E8F5EF;font-family:Outfit,sans-serif;font-size:22px;margin:0 0 8px;">Team Activity Digest</h1>';
  html += '<p style="color:rgba(232,245,239,.6);font-size:14px;margin:0;">' + esc(data.from) + ' through ' + esc(data.to) + '</p>';
  html += '</div>';

  // Stats
  html += '<div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;">';
  var stats = [
    { val: data.totalChanges, label: 'Total Changes' },
    { val: data.delCompleted, label: 'Delivered' },
    { val: data.tasksCompleted, label: 'Tasks Done' },
    { val: data.clientsActive, label: 'Clients Active' }
  ];
  stats.forEach(function(s) {
    html += '<div style="flex:1;min-width:80px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;text-align:center;">';
    html += '<div style="font-size:24px;font-weight:700;color:#1E2A5E;">' + s.val + '</div>';
    html += '<div style="font-size:11px;color:#6B7599;text-transform:uppercase;letter-spacing:.05em;">' + s.label + '</div>';
    html += '</div>';
  });
  html += '</div>';

  // Per-client sections
  var slugs = Object.keys(data.byClient).sort();
  if (slugs.length === 0) {
    html += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:24px;text-align:center;color:#6B7599;">No activity in this period.</div>';
  }

  slugs.forEach(function(slug) {
    var entries = data.byClient[slug];
    var cl = data.clientMap[slug];
    var name = cl ? (cl.practice_name || slug) : slug;

    html += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:20px;margin-bottom:16px;">';
    html += '<h2 style="font-family:Outfit,sans-serif;font-size:16px;color:#1E2A5E;margin:0 0 12px;">' + esc(name) + ' <span style="font-size:12px;font-weight:400;color:#6B7599;">(' + entries.length + ')</span></h2>';

    entries.forEach(function(log) {
      var date = new Date(log.created_at);
      var timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      var typeName = tableNames[log.table_name] || log.table_name;
      var colors = {
        deliverables: { bg: '#E6F9F0', text: '#00b86c' },
        checklist_items: { bg: '#EBF2FF', text: '#3B82F6' },
        contacts: { bg: '#FFF7ED', text: '#D97706' },
        onboarding_steps: { bg: '#F3EEFF', text: '#A855F7' }
      };
      var color = colors[log.table_name] || { bg: '#F1F5F9', text: '#6B7599' };

      html += '<div style="padding:6px 0;border-bottom:1px solid #f0f2f5;display:flex;align-items:center;gap:8px;font-size:13px;">';
      html += '<span style="color:#6B7599;font-size:11px;min-width:90px;">' + timeStr + '</span>';
      html += '<span style="background:' + color.bg + ';color:' + color.text + ';padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;">' + esc(typeName) + '</span>';
      html += '<span style="color:#333F70;">' + esc(log.field_name) + ': ' + esc(log.old_value || '-') + ' &rarr; <strong>' + esc(log.new_value || '-') + '</strong></span>';
      html += '</div>';
    });

    html += '</div>';
  });

  // Footer
  html += '<div style="text-align:center;padding:24px;color:#6B7599;font-size:12px;">';
  html += 'Generated by Client HQ &middot; <a href="https://clients.moonraker.ai/admin/reports" style="color:#00D47E;">View in Admin</a>';
  html += '</div>';

  html += '</div></body></html>';
  return html;
}
