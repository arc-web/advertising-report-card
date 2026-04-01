// /api/bootstrap-access.js
// Automates post-Leadsie access setup for a client.
// Once support@moonraker.ai has been granted access to a client's GBP, GA4, and GTM
// via Leadsie, this endpoint uses domain-wide delegation to impersonate support@
// and add the service account directly as a manager/viewer on each platform.
//
// Also adds the client location to LocalFalcon.
//
// POST { client_slug, services: ["gbp", "ga4", "gtm", "localfalcon"] }
// If services not specified, runs all.
//
// Prerequisites:
//   - Domain-wide delegation enabled for the SA (Client ID: 106093913482389210528)
//   - Scopes: business.manage, analytics.manage.users, tagmanager.manage.users
//   - support@moonraker.ai must already have access (via Leadsie)
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, LOCALFALCON_API_KEY

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var lfKey = process.env.LOCALFALCON_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var clientSlug = body.client_slug;
  var services = body.services || ['gbp', 'ga4', 'gtm', 'localfalcon'];

  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

  var SA_EMAIL = 'reporting@moonraker-client-hq.iam.gserviceaccount.com';
  var IMPERSONATE_USER = 'support@moonraker.ai';

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  var results = {};
  var errors = [];

  // ─── Load contact ──────────────────────────────────────────────
  var contact;
  try {
    var cResp = await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + clientSlug + '&select=*&limit=1', { headers: sbHeaders() });
    var contacts = await cResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found: ' + clientSlug });
    contact = contacts[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load contact: ' + e.message });
  }

  // ─── Load or create report_configs ─────────────────────────────
  var config;
  try {
    var cfResp = await fetch(sbUrl + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&limit=1', { headers: sbHeaders() });
    var configs = await cfResp.json();
    if (configs && configs.length > 0) {
      config = configs[0];
    } else {
      var insertResp = await fetch(sbUrl + '/rest/v1/report_configs', {
        method: 'POST', headers: sbHeaders(),
        body: JSON.stringify({ client_slug: clientSlug, active: true })
      });
      var inserted = await insertResp.json();
      config = Array.isArray(inserted) ? inserted[0] : inserted;
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load/create report_config: ' + e.message });
  }

  var configUpdates = {};
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();

  // ═══════════════════════════════════════════════════════════════
  // GBP: Find location, add SA as manager, extract location ID
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('gbp')) {
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      // Get token impersonating support@ with business.manage scope
      var gbpToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/business.manage');
      if (gbpToken.error) throw new Error('Token failed: ' + gbpToken.error);

      // Step 1: List all GBP accounts accessible by support@
      var acctResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
        headers: { 'Authorization': 'Bearer ' + gbpToken }
      });
      var acctData = await acctResp.json();
      var accounts = acctData.accounts || [];

      if (accounts.length === 0) throw new Error('No GBP accounts accessible by ' + IMPERSONATE_USER);

      // Step 2: Search across accounts for the matching location
      var matchedLocation = null;
      var matchedAccount = null;
      var websiteDomain = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

      for (var ai = 0; ai < accounts.length && !matchedLocation; ai++) {
        var acct = accounts[ai];
        var locResp = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/' + acct.name + '/locations?readMask=name,title,websiteUri,storefrontAddress', {
          headers: { 'Authorization': 'Bearer ' + gbpToken }
        });
        var locData = await locResp.json();
        var locations = locData.locations || [];

        for (var li = 0; li < locations.length; li++) {
          var loc = locations[li];
          var locTitle = (loc.title || '').toLowerCase();
          var locWebsite = (loc.websiteUri || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

          // Match by practice name or website domain
          if (practiceName && locTitle.indexOf(practiceName.toLowerCase()) >= 0) {
            matchedLocation = loc;
            matchedAccount = acct;
            break;
          }
          if (websiteDomain && locWebsite && (locWebsite.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(locWebsite) >= 0)) {
            matchedLocation = loc;
            matchedAccount = acct;
            break;
          }
        }
      }

      if (!matchedLocation) throw new Error('No GBP location matching "' + practiceName + '" found across ' + accounts.length + ' accounts');

      // Extract numeric location ID from name (format: "accounts/123/locations/456" or "locations/456")
      var locName = matchedLocation.name;
      var gbpLocationId = locName.split('/').pop();

      // Step 3: Add SA as MANAGER on the location
      var adminResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + gbpToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin: SA_EMAIL, role: 'MANAGER' })
      });
      var adminData = await adminResp.json();

      var gbpAdded = false;
      if (adminResp.ok) {
        gbpAdded = true;
      } else if (adminData.error && adminData.error.status === 'ALREADY_EXISTS') {
        gbpAdded = true; // Already a manager, that's fine
      } else {
        throw new Error('Failed to add SA as GBP admin: ' + JSON.stringify(adminData).substring(0, 300));
      }

      configUpdates.gbp_location_id = gbpLocationId;
      results.gbp = {
        success: true,
        location_name: locName,
        location_title: matchedLocation.title,
        gbp_location_id: gbpLocationId,
        sa_added: gbpAdded,
        account: matchedAccount.name
      };
    } catch (e) {
      errors.push('GBP: ' + e.message);
      results.gbp = { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GA4: Find property, add SA as viewer
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('ga4')) {
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var ga4Token = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/analytics.manage.users');
      if (ga4Token.error) throw new Error('Token failed: ' + ga4Token.error);

      // List GA4 account summaries to find matching property
      var summResp = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {
        headers: { 'Authorization': 'Bearer ' + ga4Token }
      });
      var summData = await summResp.json();
      var accountSummaries = summData.accountSummaries || [];

      var matchedProperty = null;
      var websiteDomain = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

      for (var si = 0; si < accountSummaries.length && !matchedProperty; si++) {
        var propSummaries = accountSummaries[si].propertySummaries || [];
        for (var pi = 0; pi < propSummaries.length; pi++) {
          var ps = propSummaries[pi];
          var propName = (ps.displayName || '').toLowerCase();
          // Match by practice name or property display name containing the domain
          if (practiceName && propName.indexOf(practiceName.toLowerCase()) >= 0) {
            matchedProperty = ps;
            break;
          }
          if (websiteDomain && propName.indexOf(websiteDomain) >= 0) {
            matchedProperty = ps;
            break;
          }
        }
      }

      if (!matchedProperty) {
        // Fallback: if config already has ga4_property, use that
        if (config.ga4_property) {
          matchedProperty = { property: config.ga4_property.replace('properties/', ''), displayName: config.ga4_property };
        } else {
          throw new Error('No GA4 property matching "' + practiceName + '" or "' + websiteDomain + '" found');
        }
      }

      // Property name format: "properties/123456789"
      var propertyResource = matchedProperty.property;
      if (!propertyResource.startsWith('properties/')) propertyResource = 'properties/' + propertyResource;

      // Add SA as VIEWER on the property
      var bindResp = await fetch('https://analyticsadmin.googleapis.com/v1beta/' + propertyResource + '/accessBindings', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ga4Token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: SA_EMAIL,
          roles: ['predefinedRoles/viewer']
        })
      });
      var bindData = await bindResp.json();

      var ga4Added = false;
      if (bindResp.ok) {
        ga4Added = true;
      } else if (bindData.error && (bindData.error.status === 'ALREADY_EXISTS' || bindData.error.message.indexOf('already exists') >= 0)) {
        ga4Added = true;
      } else {
        throw new Error('Failed to add SA to GA4: ' + JSON.stringify(bindData).substring(0, 300));
      }

      configUpdates.ga4_property = propertyResource;
      results.ga4 = {
        success: true,
        property: propertyResource,
        display_name: matchedProperty.displayName,
        sa_added: ga4Added
      };
    } catch (e) {
      errors.push('GA4: ' + e.message);
      results.ga4 = { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GTM: Find container, add SA as viewer
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('gtm')) {
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var gtmToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/tagmanager.manage.users');
      if (gtmToken.error) throw new Error('Token failed: ' + gtmToken.error);

      // List GTM accounts
      var gtmAcctResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/accounts', {
        headers: { 'Authorization': 'Bearer ' + gtmToken }
      });
      var gtmAcctData = await gtmAcctResp.json();
      var gtmAccounts = gtmAcctData.account || [];

      var matchedContainer = null;
      var matchedGtmAccount = null;
      var websiteDomain = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

      for (var gi = 0; gi < gtmAccounts.length && !matchedContainer; gi++) {
        var gtmAcct = gtmAccounts[gi];
        var contResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + gtmAcct.path + '/containers', {
          headers: { 'Authorization': 'Bearer ' + gtmToken }
        });
        var contData = await contResp.json();
        var containers = contData.container || [];

        for (var ci = 0; ci < containers.length; ci++) {
          var cont = containers[ci];
          var contDomains = (cont.domainName || []);
          if (typeof contDomains === 'string') contDomains = [contDomains];
          var contName = (cont.name || '').toLowerCase();

          // Match by domain or container name
          for (var di = 0; di < contDomains.length; di++) {
            var d = contDomains[di].replace(/^www\./, '').toLowerCase();
            if (websiteDomain && (d.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(d) >= 0)) {
              matchedContainer = cont;
              matchedGtmAccount = gtmAcct;
              break;
            }
          }
          if (!matchedContainer && practiceName && contName.indexOf(practiceName.toLowerCase()) >= 0) {
            matchedContainer = cont;
            matchedGtmAccount = gtmAcct;
          }
          if (matchedContainer) break;
        }
      }

      if (!matchedContainer) throw new Error('No GTM container matching "' + websiteDomain + '" or "' + practiceName + '" found');

      // Add SA as read-only user on the container
      var permResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + matchedGtmAccount.path + '/user_permissions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + gtmToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress: SA_EMAIL,
          accountAccess: { permission: 'NO_ACCESS' },
          containerAccess: [{
            containerId: matchedContainer.containerId,
            permission: 'READ'
          }]
        })
      });
      var permData = await permResp.json();

      var gtmAdded = false;
      if (permResp.ok) {
        gtmAdded = true;
      } else if (permData.error && (permData.error.status === 'ALREADY_EXISTS' || (permData.error.message || '').indexOf('already') >= 0)) {
        gtmAdded = true;
      } else {
        throw new Error('Failed to add SA to GTM: ' + JSON.stringify(permData).substring(0, 300));
      }

      results.gtm = {
        success: true,
        container_name: matchedContainer.name,
        container_id: matchedContainer.containerId,
        account: matchedGtmAccount.name,
        sa_added: gtmAdded
      };
    } catch (e) {
      errors.push('GTM: ' + e.message);
      results.gtm = { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LocalFalcon: Search + add location
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('localfalcon')) {
    try {
      if (!lfKey) throw new Error('LOCALFALCON_API_KEY not configured');

      // Check if already configured
      if (config.localfalcon_place_id) {
        results.localfalcon = { success: true, place_id: config.localfalcon_place_id, already_configured: true, message: 'Already configured' };
      } else {
        var city = contact.city || '';
        var state = contact.state || contact.province || '';
        var proximity = [city, state].filter(Boolean).join(', ');

        // Search
        var lfSearchResp = await fetch('https://api.localfalcon.com/v2/locations/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'api_key=' + lfKey + '&name=' + encodeURIComponent(practiceName) + (proximity ? '&proximity=' + encodeURIComponent(proximity) : '')
        });
        var lfSearchData = await lfSearchResp.json();
        var lfResults = (lfSearchData.data && lfSearchData.data.results) || [];

        if (lfResults.length === 0) {
          // Might already be saved - check saved locations
          var lfSavedResp = await fetch('https://api.localfalcon.com/v1/locations/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(practiceName) + '&limit=5'
          });
          var lfSavedData = await lfSavedResp.json();
          var savedLocs = (lfSavedData.data && lfSavedData.data.locations) || [];
          var nameMatch = savedLocs.find(function(l) {
            return (l.name || '').toLowerCase().indexOf(practiceName.toLowerCase()) >= 0;
          });
          if (nameMatch) {
            configUpdates.localfalcon_place_id = nameMatch.place_id;
            results.localfalcon = { success: true, place_id: nameMatch.place_id, location_name: nameMatch.name, already_saved: true };
          } else {
            throw new Error('No LocalFalcon results for "' + practiceName + '"' + (proximity ? ' near ' + proximity : ''));
          }
        } else {
          // Add the best match
          var best = lfResults[0];
          var lfAddResp = await fetch('https://api.localfalcon.com/v2/locations/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&platform=google&place_id=' + encodeURIComponent(best.place_id)
          });
          var lfAddData = await lfAddResp.json();
          if (!lfAddData.success) throw new Error('Add failed: ' + (lfAddData.message || 'unknown'));

          configUpdates.localfalcon_place_id = best.place_id;
          results.localfalcon = { success: true, place_id: best.place_id, location_name: best.name, address: best.address, added: true };
        }
      }
    } catch (e) {
      errors.push('LocalFalcon: ' + e.message);
      results.localfalcon = { success: false, error: e.message };
    }
  }

  // ─── Save config updates ───────────────────────────────────────
  if (Object.keys(configUpdates).length > 0) {
    try {
      configUpdates.updated_at = new Date().toISOString();
      await fetch(sbUrl + '/rest/v1/report_configs?id=eq.' + config.id, {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(configUpdates)
      });
    } catch (e) {
      errors.push('Config save: ' + e.message);
    }
  }

  // ─── Update deliverable statuses ───────────────────────────────
  try {
    if (results.localfalcon && results.localfalcon.success) {
      await fetch(sbUrl + '/rest/v1/deliverables?contact_id=eq.' + contact.id + '&deliverable_type=eq.localfalcon_setup&status=eq.not_started', {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'delivered', delivered_at: new Date().toISOString(), notes: 'Auto-configured by bootstrap-access', updated_at: new Date().toISOString() })
      });
    }
    if (results.gbp && results.gbp.success) {
      await fetch(sbUrl + '/rest/v1/deliverables?contact_id=eq.' + contact.id + '&deliverable_type=eq.gbp_service_account&status=eq.not_started', {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'delivered', delivered_at: new Date().toISOString(), notes: 'Auto-configured by bootstrap-access. GBP Location ID: ' + (results.gbp.gbp_location_id || ''), updated_at: new Date().toISOString() })
      });
    }
    if (results.ga4 && results.ga4.success) {
      await fetch(sbUrl + '/rest/v1/deliverables?contact_id=eq.' + contact.id + '&deliverable_type=eq.ga4_setup&status=eq.not_started', {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'delivered', delivered_at: new Date().toISOString(), notes: 'SA auto-added by bootstrap-access', updated_at: new Date().toISOString() })
      });
    }
  } catch (e) {
    errors.push('Deliverable update: ' + e.message);
  }

  return res.status(200).json({
    success: errors.length === 0,
    client_slug: clientSlug,
    practice_name: practiceName,
    results: results,
    config_updates: configUpdates,
    errors: errors
  });
};


// ═══════════════════════════════════════════════════════════════════
// Helper: Get access token via domain-wide delegation
// SA impersonates a Workspace user to inherit their access
// ═══════════════════════════════════════════════════════════════════
async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('SA JSON missing private_key or client_email');
    }
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: impersonateEmail,  // This is the key - impersonate this user
      scope: scope,
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
      throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    }
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}
