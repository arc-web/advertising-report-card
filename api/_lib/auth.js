// api/_lib/auth.js
// Shared authentication module for all admin API routes.
// Verifies Supabase Auth tokens by calling the Supabase Auth API,
// then checks admin_profiles membership.
//
// Usage:
//   var auth = require('./_lib/auth');
//   module.exports = async function handler(req, res) {
//     var user = await auth.requireAdmin(req, res);
//     if (!user) return; // 401/403 already sent
//     // user = { id, email, role, name }
//   };

var sb = require('./supabase');

// ── Extract token from request ────────────────────────────────────

function extractToken(req) {
  var auth = req.headers.authorization || req.headers.Authorization || '';
  if (auth.startsWith('Bearer ')) {
    var token = auth.slice(7).trim();
    if (token.length > 0) return token;
  }
  return null;
}

// ── Verify token via Supabase Auth API ────────────────────────────
// Calls /auth/v1/user with the access token. If valid, Supabase returns
// the user object. This works regardless of signing algorithm (HS256/ES256).

async function verifyToken(token) {
  if (!token) return null;

  try {
    var resp = await fetch(sb.url() + '/auth/v1/user', {
      headers: {
        'apikey': sb.key(),
        'Authorization': 'Bearer ' + token
      }
    });

    if (!resp.ok) return null;

    var user = await resp.json();
    if (!user || !user.id) return null;

    return user;
  } catch (e) {
    console.error('[auth] Token verification failed:', e.message);
    return null;
  }
}

// ── Admin profile cache (per-invocation) ──────────────────────────

var _profileCache = {};

async function getAdminProfile(userId) {
  if (_profileCache[userId]) return _profileCache[userId];

  try {
    var profile = await sb.one(
      'admin_profiles?id=eq.' + userId + '&select=id,email,display_name,role&limit=1'
    );
    if (profile) _profileCache[userId] = profile;
    return profile;
  } catch (e) {
    console.error('[auth] Failed to fetch admin profile:', e.message);
    return null;
  }
}

// ── Main middleware: require authenticated admin ───────────────────

async function requireAdmin(req, res) {
  var token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  var user = await verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  // Must be in admin_profiles
  var profile = await getAdminProfile(user.id);
  if (!profile) {
    res.status(403).json({ error: 'Not authorized. Admin access required.' });
    return null;
  }

  // Update last_login_at (fire-and-forget)
  sb.mutate(
    'admin_profiles?id=eq.' + user.id,
    'PATCH',
    { last_login_at: new Date().toISOString() },
    'return=minimal'
  ).catch(function() {});

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    name: profile.display_name
  };
}

module.exports = {
  verifyToken: verifyToken,
  extractToken: extractToken,
  requireAdmin: requireAdmin
};
