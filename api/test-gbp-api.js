// api/test-gbp-api.js — temporary probe to test Business Information API access
// Tests: mybusinessaccountmanagement + mybusinessbusinessinformation via SA delegation

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!googleSA) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

  var results = { timestamp: new Date().toISOString(), tests: {} };

  try {
    // Test 1: Get token with business.manage scope (already in domain-wide delegation)
    var token = await getDelegatedToken(googleSA, 'support@moonraker.ai', 'https://www.googleapis.com/auth/business.manage');
    if (typeof token !== 'string') {
      results.tests.token = { status: 'FAIL', error: token.error };
      return res.status(200).json(results);
    }
    results.tests.token = { status: 'OK', note: 'Got delegated token for business.manage scope' };

    // Test 2: List accounts via Account Management API
    var acctResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var acctData = await acctResp.json();
    results.tests.accounts = {
      status: acctResp.ok ? 'OK' : 'FAIL',
      httpStatus: acctResp.status,
      accountCount: acctData.accounts ? acctData.accounts.length : 0,
      accounts: (acctData.accounts || []).map(function(a) {
        return { name: a.name, accountName: a.accountName, type: a.type, role: a.role };
      }),
      error: acctResp.ok ? null : (acctData.error ? acctData.error.message : JSON.stringify(acctData))
    };

    // Test 3: For each account, try listing locations via Business Information API
    if (acctData.accounts && acctData.accounts.length > 0) {
      results.tests.locations = [];

      for (var i = 0; i < Math.min(acctData.accounts.length, 5); i++) {
        var acct = acctData.accounts[i];
        var locResp = await fetch(
          'https://mybusinessbusinessinformation.googleapis.com/v1/' + acct.name + '/locations?pageSize=5&readMask=name,title,storefrontAddress,metadata',
          { headers: { 'Authorization': 'Bearer ' + token } }
        );
        var locData = await locResp.json();
        results.tests.locations.push({
          account: acct.accountName,
          accountName: acct.name,
          status: locResp.ok ? 'OK' : 'FAIL',
          httpStatus: locResp.status,
          locationCount: locData.locations ? locData.locations.length : 0,
          totalLocations: locData.totalSize || null,
          sampleLocations: (locData.locations || []).slice(0, 3).map(function(l) {
            return {
              name: l.name,
              title: l.title,
              placeId: l.metadata ? l.metadata.placeId : null,
              address: l.storefrontAddress ? (l.storefrontAddress.locality + ', ' + l.storefrontAddress.administrativeArea) : null
            };
          }),
          error: locResp.ok ? null : (locData.error ? locData.error.message : JSON.stringify(locData))
        });
      }
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
      iss: sa.client_email,
      sub: impersonateEmail,
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
