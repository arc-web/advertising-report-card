// /api/newsletter-refresh-image.js
// Swap the image for a specific story. Tries self-hosted stock_images library first,
// falls back to Pexels. Picks randomly from top matches so repeated clicks rotate images.
// POST { story_id?, query? }
// If query not provided, uses the story's image_suggestion or headline.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var PEXELS_KEY = process.env.PEXELS_API_KEY || '';

// Fetch top N stock matches, exclude current URL, random pick from the rest
async function pickStockImage(suggestion, excludeUrl) {
  if (!suggestion) return null;
  try {
    var rows = await sb.mutate('rpc/match_stock_image', 'POST', {
      suggestion: suggestion,
      limit_n: 8
    });
    if (!Array.isArray(rows) || rows.length === 0) return null;

    // Drop the currently-assigned image from candidates so we always rotate
    var candidates = rows;
    if (excludeUrl) {
      candidates = rows.filter(function(r) { return r.hosted_url !== excludeUrl; });
    }
    // If filtering left nothing, fall back to the full pool
    if (candidates.length === 0) candidates = rows;

    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (!pick || !pick.hosted_url) return null;

    var alt = '';
    if (pick.rich_description) {
      alt = pick.rich_description.split(/[.!?]/)[0].trim().substring(0, 200);
    }
    if (!alt) alt = (pick.mood_tags || '').split(',')[0].trim().substring(0, 200);
    if (!alt) alt = suggestion.substring(0, 200);

    return { url: pick.hosted_url, alt: alt, source: 'stock_images' };
  } catch (e) {
    console.error('Stock pick failed:', e.message);
    return null;
  }
}

async function pickPexelsImage(searchTerms) {
  if (!PEXELS_KEY || !searchTerms) return null;
  try {
    var page = Math.floor(Math.random() * 3) + 1;
    var resp = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(searchTerms) + '&per_page=5&page=' + page + '&orientation=landscape', {
      headers: { 'Authorization': PEXELS_KEY }
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    if (!data.photos || data.photos.length === 0) return null;

    var idx = Math.floor(Math.random() * data.photos.length);
    var photo = data.photos[idx];
    var baseUrl = photo.src.original.split('?')[0];
    return {
      url: baseUrl + '?auto=compress&cs=tinysrgb&w=600&h=300&fit=crop',
      alt: photo.alt || searchTerms,
      source: 'pexels',
      page: page
    };
  } catch (e) {
    console.error('Pexels pick failed:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var storyId = (req.body || {}).story_id || null;
  var customQuery = (req.body || {}).query || '';
  if (!storyId && !customQuery) return res.status(400).json({ error: 'query or story_id required' });

  // If we have a story_id, load it for suggestion + current image (so we can exclude it)
  var story = null;
  if (storyId) {
    try {
      story = await sb.one('newsletter_stories?id=eq.' + storyId + '&select=id,headline,image_suggestion,image_url&limit=1');
    } catch (e) { /* non-fatal */ }
  }

  var suggestion = customQuery || (story && story.image_suggestion) || (story && story.headline) || '';
  if (!suggestion) return res.status(400).json({ error: 'No search terms available' });

  var currentUrl = story && story.image_url ? story.image_url : '';

  // 1. Try stock_images FTS
  var img = await pickStockImage(suggestion, currentUrl);

  // 2. Fallback to Pexels
  if (!img) {
    var searchTerms = suggestion.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    img = await pickPexelsImage(searchTerms);
  }

  if (!img) {
    return res.status(404).json({ error: 'No images found for: ' + suggestion.substring(0, 80) });
  }

  // Persist to story row if we have one
  if (storyId) {
    try {
      await sb.mutate('newsletter_stories?id=eq.' + storyId, 'PATCH', {
        image_url: img.url,
        image_alt: img.alt,
        updated_at: new Date().toISOString()
      });
    } catch (e) { /* non-fatal, URL still returned */ }
  }

  return res.status(200).json({
    success: true,
    image_url: img.url,
    image_alt: img.alt,
    source: img.source
  });
};
