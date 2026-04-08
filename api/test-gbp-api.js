// api/test-gbp-api.js — temporary probe to test Business Information API access
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!googleSA) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

  var results = { timestamp: new Date().toISOString(), tests: {} };

  try {
    var token = await getDelegatedToken(googleSA, 'support@moonraker.ai', 'https://www.googleapis.com/auth/business.manage');
    if (typeof token !== 'string') {
      results.tests.token = { status: 'FAIL', error: token.error };
      return res.status(200).json(results);
    }
    results.tests.token = { status: 'OK' };

    var authH = { 'Authorization': 'Bearer ' + token };

    // Wildcard account location listing (same as bootstrap-access.js Approach A)
    var locResp = await fetch(
      'https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations?readMask=name,title,websiteUri,storefrontAddress,metadata&pageSize=100',
      { headers: authH }
    );
    var locData = await locResp.json();

    if (locResp.ok) {
      var locs = locData.locations || [];
      results.tests.locations = {
        status: 'OK',
        httpStatus: locResp.status,
        totalLocations: locs.length,
        hasNextPage: !!locData.nextPageToken,
        sample: locs.slice(0, 10).map(function(l) {
          return {
            name: l.name,
            title: l.title,
            placeId: l.metadata ? l.metadata.placeId : null,
            mapsUri: l.metadata ? l.metadata.mapsUri : null,
            city: l.storefrontAddress ? l.storefrontAddress.locality : null,
            state: l.storefrontAddress ? l.storefrontAddress.administrativeArea : null,
            website: l.websiteUri || null
          };
        })
      };
    } else {
      results.tests.locations = {
        status: 'FAIL',
        httpStatus: locResp.status,
        error: locData.error ? locData.error.message : JSON.stringify(locData)
      };
    }

  } catch (e) {
    results.tests.exception = { status: 'FAIL', error: e.message || String(e) };
  }

  return res.status(200).json(results);
};

async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) throw new Error('SA JSON missing private_key or client_email');
    var crypto = require('crypto');
    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email, sub: impersonateEmail, scope: scope,
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    })).toString('base64url');
    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');
    var jwt = signable + '.' + signature;
    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}
