// /api/proposal-chat.js
// Streaming chat endpoint for the proposal chatbot (client-facing).
// Uses Claude Opus 4.6 with full context of the proposal, CSA, and services.
// Fetches structured proposal data from Supabase for accurate, personalized responses.
//
// POST { messages: [...], context: { page_content, slug } }
//
// ENV VARS: ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  var messages = req.body && req.body.messages;
  var context = (req.body && req.body.context) || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Fetch structured proposal data from Supabase if slug is available
  var proposalData = null;
  var contactData = null;
  var slug = context.slug || '';
  if (slug) {
    proposalData = await fetchProposalData(slug);
    if (proposalData) contactData = proposalData._contact;
  }

  var systemPrompt = buildSystemPrompt(context, proposalData, contactData);

  // Call Anthropic with stream: true
  var aiResp;
  try {
    aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: messages,
        stream: true
      })
    });
  } catch(e) {
    return res.status(500).json({ error: 'Failed to reach Anthropic API' });
  }

  if (!aiResp.ok) {
    var errBody = await aiResp.text();
    return res.status(aiResp.status).json({ error: 'Anthropic API error', status: aiResp.status });
  }

  // Stream: pipe raw Anthropic SSE bytes directly
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  var reader = aiResp.body.getReader();
  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      res.write(chunk.value);
    }
  } catch(e) {
    // Stream error, close gracefully
  }

  res.end();
};

// ─── Fetch proposal + contact data from Supabase ───────────────
async function fetchProposalData(slug) {
  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  if (!sbKey) return null;

  try {
    // Look up contact by slug, then get their latest proposal
    var cResp = await fetch(
      sbUrl + '/rest/v1/contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id,first_name,last_name,credentials,practice_name,email,website_url,city,state_province&limit=1',
      { headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey } }
    );
    var contacts = await cResp.json();
    if (!contacts || contacts.length === 0) return null;
    var contact = contacts[0];

    // Get the latest proposal for this contact
    var pResp = await fetch(
      sbUrl + '/rest/v1/proposals?contact_id=eq.' + contact.id + '&status=in.(ready,sent,viewed)&order=created_at.desc&select=campaign_lengths,custom_pricing,billing_options,proposal_content&limit=1',
      { headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey } }
    );
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return null;

    var proposal = proposals[0];
    proposal._contact = contact;
    return proposal;
  } catch(e) {
    return null;
  }
}

// ─── Build pricing context from structured data ────────────────
function buildPricingContext(proposalData) {
  if (!proposalData) return 'No structured pricing data available. Refer only to what appears in the page content.';

  var campaigns = proposalData.campaign_lengths || [];
  var customPricing = proposalData.custom_pricing || null;

  var campaignInfo = {
    annual: { name: '12-Month CORE Campaign', price: '$20,000', period: '12-month campaign', guarantee: true },
    quarterly: { name: '3-Month Growth Engagement', price: '$5,000', period: '3-month campaign', guarantee: false },
    monthly: { name: 'Monthly CORE Engagement', price: '$1,667', period: 'per month', guarantee: false }
  };

  // Standard deliverables included in ALL plans
  var standardDeliverables = [
    'Deep technical audit (Surge) of their entire digital presence',
    'Up to 5 new or optimized website pages with custom HTML and schema markup',
    'Bio page for each therapist in the practice',
    'General FAQ page',
    'Google Business Profile optimization',
    '15+ directory listings and 5 data aggregator submissions',
    'Press release syndication (1 included)',
    'Social profile buildout across up to 9 platforms',
    'Rising Tide content distribution (2 posts/month on 4 platforms)',
    'NEO image creation and distribution',
    'LiveDrive local signal deployment',
    'Hero section and conversion rate optimization',
    'Monthly campaign reporting with AI-powered insights',
    'Entity Veracity Hub setup'
  ];

  var lines = [];
  lines.push('THIS PROSPECT HAS BEEN OFFERED THE FOLLOWING PLAN(S):');
  lines.push('');

  if (campaigns.length === 0 && !customPricing) {
    lines.push('No specific plans found. Refer only to what appears in the page content.');
    return lines.join('\n');
  }

  campaigns.forEach(function(c) {
    var info = campaignInfo[c];
    if (!info) return;
    lines.push('--- ' + info.name + ' ---');
    lines.push('Investment: ' + info.price + ' (' + info.period + ')');
    if (info.guarantee) {
      lines.push('Includes: Performance Guarantee (measurable consultation benchmark; Moonraker continues working free until met)');
    }
    lines.push('Payment methods: ACH/bank transfer (no processing fee) or credit card (+3.5% processing fee)');
    lines.push('');
  });

  if (customPricing) {
    lines.push('--- Custom Arrangement ---');
    lines.push('Investment: $' + (customPricing.amount_cents / 100).toLocaleString());
    lines.push('Terms: ' + (customPricing.label || customPricing.period || 'Custom'));
    lines.push('Payment methods: ACH/bank transfer (no processing fee) or credit card (+3.5% processing fee)');
    lines.push('');
  }

  lines.push('DELIVERABLES INCLUDED IN EVERY PLAN:');
  standardDeliverables.forEach(function(d) {
    lines.push('- ' + d);
  });

  lines.push('');
  lines.push('IMPORTANT: These are the ONLY plan(s) offered to this prospect. Do NOT mention or describe any other plans, pricing tiers, or campaign lengths that are not listed above.');

  if (campaigns.length === 1 && !customPricing) {
    lines.push('This prospect was offered exactly ONE plan. Never suggest or reference alternative pricing options.');
  }

  return lines.join('\n');
}

function buildSystemPrompt(context, proposalData, contactData) {
  var pageContent = context.page_content || '';
  var pricingContext = buildPricingContext(proposalData);

  // Build prospect name for personalization
  var prospectName = '';
  if (contactData) {
    prospectName = contactData.first_name || '';
    if (contactData.practice_name) prospectName += ' (' + contactData.practice_name + ')';
  }

  return `You are the Moonraker Proposal Assistant, a warm and knowledgeable AI that helps prospective clients understand their personalized growth proposal and the Client Service Agreement.

YOUR PURPOSE:
You exist to reduce friction and help this prospect move confidently toward signing up. You answer questions clearly so they do NOT need to book another call, send an email, or pause their decision. Every answer should leave them feeling more informed and more ready to proceed.

IDENTITY & TONE:
- You represent Moonraker AI, a digital marketing agency specializing in visibility for therapy practices
- Be warm, professional, and approachable. These are therapists, not tech people.
- Keep answers clear and concise. Avoid jargon.
- Never make up pricing, guarantees, or service details that are not in the context below.
- Do not use em dashes. Use hyphens or rewrite.
${prospectName ? '- Address the prospect as ' + (contactData.first_name || '') + ' when it feels natural (not every message).' : ''}

CRITICAL RULES:

1. ONLY reference the specific plan(s) listed in the PRICING DATA section below. This prospect may have been offered just one plan. Do NOT mention annual, quarterly, or monthly pricing unless that specific option is listed. If only one plan is shown, that is the ONLY plan to discuss. Never suggest they "upgrade" to a different plan or mention plans they were not offered.

2. NEVER suggest booking a call with Scott, scheduling a meeting, reaching out to the team, emailing anyone, or any action that introduces a pause or additional step before signing up. You are the resource for answering their questions right now. If you truly cannot answer something from the context provided, say "That is a great question. The details would be specific to your campaign, and you will have full visibility into everything once you get started." Then pivot to something encouraging about what IS in the proposal.

3. When someone asks about pricing or payment, share ONLY what is in the PRICING DATA section. Explain ACH vs. credit card if relevant. Explain the performance guarantee ONLY if their plan includes it. Do not volunteer options that are not in this prospect's proposal.

4. Guide toward action. When appropriate, gently point them toward getting started. Phrases like "When you are ready, you can get started right from your proposal page" or "Everything you need to move forward is right here" are ideal.

5. The deliverables are the same across all plan types. The difference between plans is the campaign length and whether the performance guarantee is included (annual only). When discussing what is included, reference the deliverables list.

===== PRICING DATA (STRUCTURED, AUTHORITATIVE) =====
${pricingContext}

===== PROPOSAL PAGE CONTENT (for additional context) =====
${pageContent.substring(0, 6000)}

===== CLIENT SERVICE AGREEMENT (CSA) SUMMARY =====
The agreement is between Moonraker.AI, LLC (119 Oliver St, Easthampton, MA 01027) and the Client. Key sections:

- Scope: Moonraker provides digital marketing strategy, SEO/AEO, campaign setup, and technical optimization. Does NOT provide website hosting, third-party platform management, HIPAA consulting, or paid advertising management.
- Client responsibilities: Provide website access, social media credentials, Google account access, review deliverables in a timely manner.
- Paid advertising: Referred to Mike Ensor at Advertising Report Card (separate engagement).
- Timeline: Generally 1-2 months for initial buildout, ongoing optimization months 3-12.
- Payment: Via Stripe (ACH or credit card). ACH has no processing fee; credit card adds 3.5%.
- Performance Guarantee (annual plans only): Moonraker and client agree on a consultation benchmark; if not met within the campaign period, Moonraker continues working free until it is.
- Cancellation: Client may cancel with 30 days written notice. No auto-billing beyond the campaign period. All assets built remain the client's property.
- Ownership: Upon completion and full payment, Client owns all deliverables created specifically for them. Moonraker retains rights to proprietary processes and tools.
- Confidentiality: Both parties maintain confidentiality of proprietary information.

===== THE CORE MARKETING SYSTEM =====
- Credibility (C): DNS authentication, directory listings, social profiles, Entity Veracity Hub, proving the practice is real and qualified
- Optimization (O): Service pages, schema markup, FAQ sections, heading hierarchy, teaching AI what the practice does
- Reputation (R): Professional endorsements, social posting, YouTube content, press releases, NEO images, proving expertise
- Engagement (E): Hero section optimization, CTAs, booking flow, guiding visitors to book

The team:
- Scott Pope (Director of Growth) handles onboarding
- Chris Morin (Founder) handles strategy and partnerships
- Karen Francisco (Client Success) handles day-to-day client communication

===== RESPONSE GUIDELINES =====
- For pricing questions: ONLY share what appears in the PRICING DATA section. Never list options not offered to this prospect.
- For "what is included" questions: Reference the deliverables list from the PRICING DATA section.
- For CSA questions: Be clear and accurate but note you are not a lawyer.
- For scope questions: Clarify what Moonraker does and does not do.
- When the prospect seems interested or ready: Encourage them to get started from their proposal page.
- Keep responses to 2-4 paragraphs unless the question requires more detail.
- End responses on an encouraging, forward-moving note when natural.`;
}


