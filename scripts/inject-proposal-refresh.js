#!/usr/bin/env node
// scripts/inject-proposal-refresh.js
//
// One-shot migration: inject the /shared/proposal-pricing-refresh.js script
// tag into every already-deployed <slug>/proposal/index.html that doesn't
// already reference it. Existing proposal pages were generated before the
// runtime price-refresh pattern existed, so they show baked-in prices that
// can drift from the pricing_tiers table.
//
// USAGE:
//   node scripts/inject-proposal-refresh.js [--dry-run]

var fs = require('fs');
var path = require('path');

var REPO = path.resolve(__dirname, '..');
var NON_SLUG = new Set(['admin','api','assets','agreement','checkout','entity-audit','_templates','shared','scripts','migrations','docs','node_modules','results','.git','.claude','.vercel','.github']);

var dryRun = process.argv.includes('--dry-run');

var INJECT_TAG = '<script src="/shared/proposal-pricing-refresh.js" defer></script>';
var ALREADY_MARKER = 'shared/proposal-pricing-refresh.js';

var slugs = fs.readdirSync(REPO, { withFileTypes: true })
  .filter(function(d) { return d.isDirectory() && !d.name.startsWith('.') && !NON_SLUG.has(d.name); })
  .map(function(d) { return d.name; });

var stats = { scanned: 0, missing: 0, already: 0, injected: 0 };
var changes = [];

slugs.forEach(function(slug) {
  var fp = path.join(REPO, slug, 'proposal', 'index.html');
  if (!fs.existsSync(fp)) { stats.missing++; return; }
  stats.scanned++;
  var html = fs.readFileSync(fp, 'utf8');
  if (html.indexOf(ALREADY_MARKER) !== -1) { stats.already++; return; }

  var replaced;
  // Prefer to insert right after the proposal-chatbot script include (matches
  // the order in _templates/proposal.html).
  var chatbotLine = '<script src="/shared/proposal-chatbot.js"></script>';
  if (html.indexOf(chatbotLine) !== -1) {
    replaced = html.replace(chatbotLine, chatbotLine + '\n' + INJECT_TAG);
  } else {
    // Fallback: inject before closing body tag.
    replaced = html.replace('</body>', INJECT_TAG + '\n</body>');
  }

  if (replaced === html) return;
  stats.injected++;
  changes.push(slug);
  if (!dryRun) fs.writeFileSync(fp, replaced);
});

console.log('[inject-proposal-refresh] ' + (dryRun ? 'DRY-RUN' : 'APPLIED'));
console.log('  slugs scanned:           ' + stats.scanned);
console.log('  no proposal page:        ' + stats.missing);
console.log('  already has refresh tag: ' + stats.already);
console.log('  ' + (dryRun ? 'would inject' : 'injected') + ':            ' + stats.injected);
if (changes.length) {
  console.log('');
  console.log('Sample:');
  changes.slice(0, 10).forEach(function(s) { console.log('  - ' + s); });
  if (changes.length > 10) console.log('  ... and ' + (changes.length - 10) + ' more');
}
