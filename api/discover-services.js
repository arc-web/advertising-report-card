// /api/discover-services.js
// Auto-discovers GSC properties and LBM locations for a client
// Called from admin UI when Intro Call steps are marked complete
//
// POST { client_slug, service: "gsc" | "lbm" }
// Returns discovered properties/locations and saves to contact + report_configs

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var lbmKey = process.env.LBM_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var clientSlug = body.client_slug;
  var service = body.service; // "gsc" or "lbm"

  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });
  if (!service || !['gsc', 'lbm'].includes(service)) return res.status(400).json({ error: 'service must be "gsc" or "lbm"' });

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  try {
    // Fetch contact
    var contactResp = await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + clientSlug + '&limit=1', {
      headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
    });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found: ' + clientSlug });
    var contact = contacts[0];

    // ─── GSC DISCOVERY ───
    if (service === 'gsc') {
      if (!googleSA) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

      // Get access token
      var token = await getGoogleAccessToken(googleSA);
      if (token && token.error) return res.status(500).json({ error: 'Google auth failed: ' + token.error });

      // List all sites the service account has access to
      var sitesResp = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var sitesData = await sitesResp.json();
      var allSites = (sitesData.siteEntry || []).map(function(s) {
        return { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel };
      });

      if (allSites.length === 0) {
        return res.status(200).json({ success: true, service: 'gsc', found: false, message: 'Service account has no GSC sites', all_sites: [] });
      }

      // Try to match against client's website domain
      var websiteUrl = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
      var matched = null;

      for (var i = 0; i < allSites.length; i++) {
        var siteUrl = allSites[i].siteUrl;
        var normalizedSite = siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
        if (normalizedSite === websiteUrl || websiteUrl.indexOf(normalizedSite) >= 0 || normalizedSite.indexOf(websiteUrl) >= 0) {
          matched = siteUrl;
          break;
        }
      }

      if (matched) {
        // Save to contact record
        await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + clientSlug, {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ gsc_property: matched })
        });

        // Upsert report_configs
        await upsertReportConfig(sbUrl, sbHeaders(), clientSlug, { gsc_property: matched });

        return res.status(200).json({
          success: true,
          service: 'gsc',
          found: true,
          property: matched,
          saved: true,
          message: 'Matched and saved GSC property: ' + matched,
          all_sites: allSites.map(function(s) { return s.siteUrl; })
        });
      } else {
        return res.status(200).json({
          success: true,
          service: 'gsc',
          found: false,
          message: 'No matching site found for domain "' + websiteUrl + '". Service account has access to ' + allSites.length + ' sites.',
          all_sites: allSites.map(function(s) { return s.siteUrl; }),
          client_domain: websiteUrl
        });
      }
    }

    // ─── LBM DISCOVERY ───
    if (service === 'lbm') {
      if (!lbmKey) return res.status(500).json({ error: 'LBM_API_KEY not configured' });

      // Fetch all LBM locations
      var lbmResp = await fetch('https://api.localbrandmanager.com/locations', {
        headers: { 'Authorization': lbmKey }
      });
      var lbmData = await lbmResp.json();
      var allLocations = Array.isArray(lbmData) ? lbmData : (lbmData.data || lbmData.locations || []);

      if (allLocations.length === 0) {
        return res.status(200).json({ success: true, service: 'lbm', found: false, message: 'No LBM locations found', all_locations: [] });
      }

      // Try to match by practice name or website
      var practiceName = (contact.practice_name || '').toLowerCase().trim();
      var websiteDomain = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
      var matched = null;

      for (var i = 0; i < allLocations.length; i++) {
        var loc = allLocations[i];
        var locName = (loc.name || loc.business_name || loc.title || '').toLowerCase().trim();
        var locWebsite = (loc.website || loc.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

        // Match by name (fuzzy - check if practice name appears in location name or vice versa)
        if (practiceName && locName && (locName.indexOf(practiceName) >= 0 || practiceName.indexOf(locName) >= 0)) {
          matched = loc;
          break;
        }
        // Match by website domain
        if (websiteDomain && locWebsite && (locWebsite.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(locWebsite) >= 0)) {
          matched = loc;
          break;
        }
      }

      var locId = matched ? (matched.id || matched.location_id || matched.slug || null) : null;

      if (matched && locId) {
        // Save to report_configs
        await upsertReportConfig(sbUrl, sbHeaders(), clientSlug, { lbm_location_id: String(locId) });

        return res.status(200).json({
          success: true,
          service: 'lbm',
          found: true,
          location_id: locId,
          location_name: matched.name || matched.business_name || matched.title,
          saved: true,
          message: 'Matched and saved LBM location: ' + (matched.name || locId),
          all_locations: allLocations.map(function(l) { return { id: l.id || l.location_id || l.slug, name: l.name || l.business_name || l.title }; })
        });
      } else {
        return res.status(200).json({
          success: true,
          service: 'lbm',
          found: false,
          message: 'No matching LBM location found for "' + practiceName + '".',
          client_name: practiceName,
          client_domain: websiteDomain,
          all_locations: allLocations.map(function(l) { return { id: l.id || l.location_id || l.slug, name: l.name || l.business_name || l.title }; })
        });
      }
    }

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


// ─── Helpers ───

async function upsertReportConfig(sbUrl, headers, clientSlug, data) {
  // Check if config exists
  var checkResp = await fetch(sbUrl + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&limit=1', {
    headers: { 'apikey': headers['apikey'], 'Authorization': headers['Authorization'] }
  });
  var existing = await checkResp.json();

  data.active = true;
  if (existing && existing.length > 0) {
    // Update
    await fetch(sbUrl + '/rest/v1/report_configs?client_slug=eq.' + clientSlug, {
      method: 'PATCH', headers: headers, body: JSON.stringify(data)
    });
  } else {
    // Create
    data.client_slug = clientSlug;
    await fetch(sbUrl + '/rest/v1/report_configs', {
      method: 'POST', headers: headers, body: JSON.stringify(data)
    });
  }
}

async function getGoogleAccessToken(saJson) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('Service account JSON missing private_key or client_email');
    }
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })).toString('base64url');

    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');

    var jwt = signable + '.' + signature;

    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      throw new Error('Google OAuth error: ' + (tokenData.error_description || tokenData.error || JSON.stringify(tokenData)));
    }
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}
