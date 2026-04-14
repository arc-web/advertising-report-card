// /api/import-stock-images.js
// ONE-TIME import route: reads stock image metadata from Google Sheet CSV
// and inserts into stock_images + stock_image_keywords tables.
// DELETE THIS FILE after import is complete.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var SHEET_ID = '1fmuVF8N7ZrjetgSWmXlvTYJQMDWArXo7T79Yzurory4';

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  try {
    // Streaming response for progress
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    // 1. Fetch images CSV (rows 1-2190)
    var imgResp = await fetch('https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv&range=A1:I2190');
    var imgCsv = await imgResp.text();
    var imgRows = parseCsv(imgCsv);
    res.write(JSON.stringify({ step: 'parsed', images: imgRows.length }) + '\n');

    // 2. Fetch keywords CSV (rows 1-151)
    var kwResp = await fetch('https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&sheet=keywords_For_Images_Search&range=A1:C151');
    var kwCsv = await kwResp.text();
    var kwRows = parseCsv(kwCsv);
    res.write(JSON.stringify({ step: 'parsed_keywords', keywords: kwRows.length }) + '\n');

    // 3. Insert images in batches of 100
    var headers = sb.headers('return=minimal,resolution=ignore-duplicates');
    var inserted = 0;
    var errors = 0;
    var batchSize = 100;

    for (var i = 0; i < imgRows.length; i += batchSize) {
      var batch = imgRows.slice(i, i + batchSize).map(function(r) {
        return {
          asset_id: parseInt(r.asset_id) || 0,
          asset_type: r.asset_type || 'Image',
          file_url: r.file_url || null,
          source: r.source || 'Pexels',
          rich_description: r.rich_description || null,
          mood_tags: r.mood_tags || null,
          drive_download_url: r['Google-drive-Link-download'] || null,
          drive_view_url: r['Google-drive-Link-view'] || null
        };
      }).filter(function(r) { return r.asset_id > 0; });

      var resp = await fetch(sb.url() + '/rest/v1/stock_images', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(batch)
      });

      if (resp.ok) {
        inserted += batch.length;
      } else {
        var err = await resp.text();
        errors += batch.length;
        res.write(JSON.stringify({ step: 'batch_error', offset: i, error: err.substring(0, 200) }) + '\n');
      }
    }

    res.write(JSON.stringify({ step: 'images_done', inserted: inserted, errors: errors }) + '\n');

    // 4. Insert keywords
    var kwData = kwRows.filter(function(r) { return r.KEYWORDS; }).map(function(r) {
      return { keyword: r.KEYWORDS.trim(), scraped: true };
    });

    if (kwData.length > 0) {
      var kwResp2 = await fetch(sb.url() + '/rest/v1/stock_image_keywords', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(kwData)
      });
      if (kwResp2.ok) {
        res.write(JSON.stringify({ step: 'keywords_done', count: kwData.length }) + '\n');
      } else {
        var kwErr = await kwResp2.text();
        res.write(JSON.stringify({ step: 'keywords_error', error: kwErr.substring(0, 200) }) + '\n');
      }
    }

    res.end(JSON.stringify({ success: true, total_images: inserted, total_keywords: kwData.length }));

  } catch (err) {
    console.error('Import error:', err);
    res.end(JSON.stringify({ error: err.message }));
  }
};

function parseCsv(text) {
  var lines = text.split('\n');
  if (lines.length < 2) return [];
  // Parse header
  var headers = parseCsvLine(lines[0]);
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var vals = parseCsvLine(line);
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j].trim().replace(/^\uFEFF/, '')] = (vals[j] || '').trim();
    }
    rows.push(obj);
  }
  return rows;
}

function parseCsvLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else if (ch === '\r') {
      // skip
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
