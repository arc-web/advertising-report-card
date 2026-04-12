// api/_lib/newsletter-template.js
// Newsletter email template builder for Moonraker weekly newsletter.
// Produces table-based HTML optimized for email clients (Outlook, Gmail, Apple Mail).
//
// Usage:
//   var nl = require('./_lib/newsletter-template');
//   var html = nl.build(newsletter); // newsletter = row from newsletters table
//   var blogHtml = nl.buildBlog(newsletter); // clean blog version for moonraker.ai
//
// Content JSONB structure expected:
//   {
//     stories: [{ headline, body, action_items, image_url, image_alt }],
//     quick_wins: ["item1", "item2", ...],
//     final_thoughts: "text",
//     partner_logos: [{ src, alt, url }]  // optional
//   }

var LOGO_URL = 'https://clients.moonraker.ai/assets/logo.png';
var UNSUBSCRIBE_BASE = 'https://clients.moonraker.ai/api/newsletter-unsubscribe';

// ---- HTML escape ----
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Color palette (email-safe, matches brand) ----
var C = {
  navy: '#141C3A',
  white: '#FFFFFF',
  bg: '#F7FDFB',
  primary: '#00D47E',
  primaryHover: '#00b86c',
  heading: '#1E2A5E',
  body: '#333F70',
  muted: '#6B7599',
  border: '#E2E8F0',
  subtleBg: '#F0FAF5',
  lightGreen: '#DDF8F2'
};

// ---- Font stacks (email-safe) ----
var F = {
  heading: "Outfit, 'Trebuchet MS', Arial, sans-serif",
  body: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
};

// ---- Reusable email components ----

function storyBlock(story, index) {
  var num = index + 1;
  var imageHtml = '';
  if (story.image_url) {
    imageHtml = '<tr><td style="padding:0 0 16px;">' +
      '<img src="' + esc(story.image_url) + '" alt="' + esc(story.image_alt || story.headline) + '" ' +
      'width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:8px;" />' +
      '</td></tr>';
  }

  // Process action items - support both string and array
  var actionHtml = '';
  if (story.action_items) {
    var items = story.action_items;
    if (typeof items === 'string') {
      actionHtml = '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;">' + items + '</p>';
    } else if (Array.isArray(items)) {
      actionHtml = items.map(function(item) {
        return '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 4px;padding-left:8px;">&bull; ' + item + '</p>';
      }).join('');
    }
  }

  return '<tr><td style="padding:0 0 32px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Story image
    imageHtml +

    // Numbered headline
    '<tr><td style="padding:0 0 12px;">' +
      '<h2 style="font-family:' + F.heading + ';font-size:20px;font-weight:700;color:' + C.heading + ';margin:0;line-height:1.3;">' +
        num + '. ' + esc(story.headline) +
      '</h2>' +
    '</td></tr>' +

    // Body paragraphs
    '<tr><td style="padding:0 0 16px;">' +
      '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' +
        (story.body || '') +
      '</div>' +
    '</td></tr>' +

    // Action section
    (actionHtml ? '<tr><td style="padding:12px 16px;background:' + C.subtleBg + ';border-left:3px solid ' + C.primary + ';border-radius:0 8px 8px 0;">' +
      '<p style="font-family:' + F.body + ';font-size:15px;font-weight:600;color:' + C.heading + ';margin:0 0 8px;">\u{1F449} Action:</p>' +
      actionHtml +
    '</td></tr>' : '') +

    '</table>' +
    // Divider between stories
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function quickWinsBlock(items) {
  if (!items || !items.length) return '';
  var listHtml = items.map(function(item) {
    return '<tr><td style="padding:4px 0 4px 8px;font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.6;">' +
      '&bull; ' + item + '</td></tr>';
  }).join('');

  return '<tr><td style="padding:8px 0 32px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
      '<tr><td style="padding:0 0 12px;">' +
        '<h2 style="font-family:' + F.heading + ';font-size:20px;font-weight:700;color:' + C.heading + ';margin:0;">\u2705 Quick Wins for This Week</h2>' +
      '</td></tr>' +
      listHtml +
    '</table>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function spotlightBlock() {
  return '<tr><td style="padding:8px 0 32px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.lightGreen + ';border-radius:8px;padding:0;">' +
      '<tr><td style="padding:20px 24px;">' +
        '<h2 style="font-family:' + F.heading + ';font-size:20px;font-weight:700;color:' + C.heading + ';margin:0 0 12px;">\u{1F680} Spotlight: Engage (Moonraker\'s New AI Project)</h2>' +
        '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 12px;">' +
          'We\'re building Engage, a HIPAA-compliant AI chatbot designed for therapists to handle FAQs and help you seamlessly book more consultations.' +
        '</p>' +
        '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 12px;">' +
          'It\'s still in early development, but we\'ll be inviting select therapists to test-drive our alpha version in the coming weeks. (This first stage will not be HIPAA-compliant yet; it\'s about usability testing).' +
        '</p>' +
        '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';line-height:1.7;margin:0;font-weight:600;">' +
          '\u{1F449} Interested in being one of the first testers? Just reply to this email with "ENGAGE"' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function finalThoughtsBlock(text) {
  if (!text) return '';
  return '<tr><td style="padding:8px 0 24px;">' +
    '<h2 style="font-family:' + F.heading + ';font-size:20px;font-weight:700;color:' + C.heading + ';margin:0 0 12px;">\u{1F64F} Final Thoughts</h2>' +
    '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' +
      text +
    '</div>' +
  '</td></tr>';
}

function signatureBlock() {
  return '<tr><td style="padding:16px 0 0;">' +
    '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;">See you next week,</p>' +
    '<p style="font-family:' + F.body + ';font-size:15px;font-style:italic;color:' + C.heading + ';margin:4px 0 0;font-weight:600;">The Moonraker Team</p>' +
  '</td></tr>';
}

function partnerLogosBlock(logos) {
  if (!logos || !logos.length) return '';
  var cells = logos.map(function(logo) {
    var img = '<img src="' + esc(logo.src) + '" alt="' + esc(logo.alt || '') + '" height="32" style="display:inline-block;height:32px;width:auto;opacity:.7;" />';
    if (logo.url) img = '<a href="' + esc(logo.url) + '" style="text-decoration:none;">' + img + '</a>';
    return '<td style="padding:0 8px;text-align:center;">' + img + '</td>';
  }).join('');

  return '<tr><td style="padding:16px 0 8px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" align="center"><tr>' + cells + '</tr></table>' +
  '</td></tr>';
}

// ---- Main build function ----

function build(newsletter, subscriberId) {
  var content = newsletter.content || {};
  var stories = content.stories || [];
  var quickWins = content.quick_wins || [];
  var finalThoughts = content.final_thoughts || '';
  var partnerLogos = content.partner_logos || [];
  var year = new Date().getFullYear();

  // Build unsubscribe URL
  var unsubUrl = UNSUBSCRIBE_BASE + (subscriberId ? '?sid=' + subscriberId : '');

  // Stories HTML
  var storiesHtml = stories.map(function(s, i) { return storyBlock(s, i); }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@700&family=Inter:wght@400;500;600&display=swap");</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:' + F.body + ';">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.bg + ';">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">' +

    // ==== HEADER: dark navy bar with logo ====
    '<tr><td style="background:' + C.navy + ';padding:24px 32px;border-radius:14px 14px 0 0;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
        '<td style="text-align:center;"><img src="' + LOGO_URL + '" alt="Moonraker" height="32" style="display:inline-block;" /></td>' +
      '</tr></table>' +
    '</td></tr>' +

    // ==== BODY ====
    '<tr><td style="background:' + C.white + ';padding:32px;border-left:1px solid ' + C.border + ';border-right:1px solid ' + C.border + ';">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Intro text
    '<tr><td style="padding:0 0 24px;">' +
      '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;">' +
        'We know running a therapy practice is more than sessions. It\'s managing visibility, trust, and compliance in a digital-first world. ' +
        'At Moonraker, we\'re here to make that easier, so every week you\'ll get a short, practical update on SEO + AI trends that affect therapists across the U.S. and Canada.' +
      '</p>' +
    '</td></tr>' +

    // Partner logos (if any)
    partnerLogosBlock(partnerLogos) +

    // Divider after intro
    '<tr><td style="padding:0 0 24px;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
        '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
      '</tr></table>' +
    '</td></tr>' +

    // Stories
    storiesHtml +

    // Quick Wins
    quickWinsBlock(quickWins) +

    // Spotlight: Engage
    spotlightBlock() +

    // Final Thoughts
    finalThoughtsBlock(finalThoughts) +

    // Signature
    signatureBlock() +

    '</table></td></tr>' +

    // ==== FOOTER ====
    '<tr><td style="background:' + C.navy + ';padding:24px 32px;border-radius:0 0 14px 14px;text-align:center;">' +
      '<p style="font-family:' + F.body + ';font-size:12px;color:rgba(232,245,239,.55);margin:0 0 8px;line-height:1.6;">' +
        '&copy; ' + year + ' Moonraker.AI<br>119 Oliver St, Easthampton, MA 01027' +
      '</p>' +
      '<p style="font-family:' + F.body + ';font-size:11px;color:rgba(232,245,239,.35);margin:0;line-height:1.6;">' +
        'You\'re receiving this because you attended one of our webinars, signed up for our services, or inquired about working with Moonraker. ' +
        '<a href="' + esc(unsubUrl) + '" style="color:rgba(232,245,239,.55);text-decoration:underline;">Unsubscribe</a>' +
      '</p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// ---- Blog version (for moonraker.ai/blog) ----

function buildBlog(newsletter) {
  var content = newsletter.content || {};
  var stories = content.stories || [];
  var quickWins = content.quick_wins || [];
  var finalThoughts = content.final_thoughts || '';

  var storiesHtml = stories.map(function(s, i) {
    var num = i + 1;
    var img = s.image_url ? '<img src="' + esc(s.image_url) + '" alt="' + esc(s.image_alt || s.headline) + '" style="width:100%;border-radius:8px;margin-bottom:1rem;" />' : '';
    var actionHtml = '';
    if (s.action_items) {
      var items = typeof s.action_items === 'string' ? [s.action_items] : (s.action_items || []);
      actionHtml = '<div class="action-box"><p><strong>\u{1F449} Action:</strong></p>' +
        items.map(function(item) { return '<p>' + item + '</p>'; }).join('') +
        '</div>';
    }
    return '<article class="story">' + img +
      '<h2>' + num + '. ' + esc(s.headline) + '</h2>' +
      '<div class="story-body">' + (s.body || '') + '</div>' +
      actionHtml +
      '</article>';
  }).join('');

  var quickWinsHtml = quickWins.length
    ? '<section class="quick-wins"><h2>\u2705 Quick Wins for This Week</h2><ul>' +
      quickWins.map(function(w) { return '<li>' + w + '</li>'; }).join('') +
      '</ul></section>'
    : '';

  var finalHtml = finalThoughts
    ? '<section class="final-thoughts"><h2>\u{1F64F} Final Thoughts</h2><div>' + finalThoughts + '</div></section>'
    : '';

  return storiesHtml + quickWinsHtml + finalHtml +
    '<p class="signature">See you next week,<br><em>The Moonraker Team</em></p>';
}

// ---- Exports ----

module.exports = {
  build: build,
  buildBlog: buildBlog,
  esc: esc,
  C: C,
  F: F
};
