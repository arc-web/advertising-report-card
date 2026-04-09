// /api/deploy-content-preview.js
// Deploys a content preview page for client review.
// Reads _templates/content-preview.html, fills placeholders, pushes to /{slug}/content/{page-slug}/index.html
// Updates content_pages status to client_review.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var ghToken = process.env.GITHUB_PAT;
  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var contentPageId = body.content_page_id;
  if (!contentPageId) return res.status(400).json({ error: 'content_page_id required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var sbHeaders = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey };

  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github+json' };
  }

  try {
    // 1. Fetch the content page
    var cpResp = await fetch(sbUrl + '/rest/v1/content_pages?id=eq.' + contentPageId + '&limit=1', { headers: sbHeaders });
    var cpArr = await cpResp.json();
    var cp = cpArr && cpArr[0];
    if (!cp) return res.status(404).json({ error: 'Content page not found' });
    if (!cp.generated_html) return res.status(400).json({ error: 'No generated HTML to deploy. Generate the page first.' });

    var clientSlug = cp.client_slug;
    var pageSlug = cp.page_slug;
    var pageName = cp.page_name;

    // 2. Read template from GitHub
    var tResp = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/_templates/content-preview.html?ref=' + BRANCH,
      { headers: ghHeaders() }
    );
    if (!tResp.ok) {
      return res.status(500).json({ error: 'Failed to read template: ' + tResp.status });
    }
    var tData = await tResp.json();
    var templateHtml = Buffer.from(tData.content, 'base64').toString('utf-8');

    // 3. Fill template placeholders
    var html = templateHtml
      .replace(/\{\{CONTENT_PAGE_ID\}\}/g, contentPageId)
      .replace(/\{\{CLIENT_SLUG\}\}/g, clientSlug)
      .replace(/\{\{PAGE_NAME\}\}/g, escHtml(pageName))
      .replace(/\{\{PAGE_SLUG\}\}/g, pageSlug);

    // 4. Push to GitHub
    var destPath = clientSlug + '/content/' + pageSlug + '/index.html';

    // Check if file already exists (to get SHA for update)
    var existResp = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/' + destPath + '?ref=' + BRANCH,
      { headers: ghHeaders() }
    );
    var existSha = null;
    if (existResp.ok) {
      var existData = await existResp.json();
      existSha = existData.sha;
    }

    var pushBody = {
      message: 'Deploy content preview: ' + pageName + ' for ' + clientSlug,
      content: Buffer.from(html, 'utf-8').toString('base64'),
      branch: BRANCH
    };
    if (existSha) pushBody.sha = existSha;

    var pushResp = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/' + destPath,
      {
        method: 'PUT',
        headers: Object.assign({}, ghHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify(pushBody)
      }
    );

    if (!pushResp.ok) {
      var pushErr = await pushResp.text();
      return res.status(500).json({ error: 'GitHub push failed', status: pushResp.status, detail: pushErr.substring(0, 500) });
    }

    // 5. Update content_pages status and set preview_url on linked deliverable
    var previewUrl = '/' + clientSlug + '/content/' + pageSlug + '/';

    await fetch(sbUrl + '/rest/v1/content_pages?id=eq.' + contentPageId, {
      method: 'PATCH',
      headers: Object.assign({}, sbHeaders, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'client_review' })
    });

    // Update linked deliverable preview_url if exists
    await fetch(sbUrl + '/rest/v1/deliverables?content_page_id=eq.' + contentPageId, {
      method: 'PATCH',
      headers: Object.assign({}, sbHeaders, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ preview_url: previewUrl })
    });

    return res.status(200).json({
      success: true,
      preview_url: previewUrl,
      full_url: 'https://clients.moonraker.ai' + previewUrl,
      dest_path: destPath
    });

  } catch (err) {
    console.error('Deploy content preview error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
