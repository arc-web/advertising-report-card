// /shared/content-chatbot.js
// Self-contained chatbot widget for content preview pages.
// Floating button (bottom-right), streaming Sonnet 4.6 chat.
// Handles <content_update> tags: extracts new HTML, updates preview iframe, saves to Supabase.
// Include via <script src="/shared/content-chatbot.js"></script>
// Page must set window.__CONTENT_PAGE_ID and window.__CLIENT_SLUG before loading.

(function() {
  'use strict';

  var CHAT_API = '/api/content-chat';
  var SB = 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var SK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbW13Y2poZHJodnh4a2hjdXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjM1NTcsImV4cCI6MjA4OTg5OTU1N30.zMMHW0Fk9ixWjORngyxJTIoPOfx7GFsD4wBV4Foqqms';
  var TOOLTIP_KEY = 'moonraker-content-tooltip-dismissed';

  // Inject CSS
  var style = document.createElement('style');
  style.textContent = `
    .mcc-btn {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,212,126,.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, box-shadow .15s;
    }
    .mcc-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,212,126,.45); }
    .mcc-btn svg { width: 24px; height: 24px; fill: #fff; }

    .mcc-tooltip {
      position: fixed; bottom: 6.5rem; right: 1.5rem; z-index: 9998;
      background: var(--color-surface, #fff); border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 12px; padding: .85rem 1rem; max-width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,.1); animation: mccFadeIn .4s ease;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .mcc-tooltip::after {
      content: ''; position: absolute; bottom: -8px; right: 24px;
      width: 16px; height: 16px; background: var(--color-surface, #fff);
      border-right: 1px solid var(--color-border, #E2E8F0);
      border-bottom: 1px solid var(--color-border, #E2E8F0);
      transform: rotate(45deg);
    }
    .mcc-tooltip.hidden { display: none; }
    .mcc-tooltip-text { font-size: .82rem; color: var(--color-body, #333F70); line-height: 1.5; }
    .mcc-tooltip-text strong { color: var(--color-heading, #1E2A5E); font-weight: 600; }
    .mcc-tooltip-close {
      position: absolute; top: .5rem; right: .5rem;
      background: none; border: none; cursor: pointer;
      color: var(--color-muted, #6B7599); font-size: 1rem; padding: .15rem;
    }

    .mcc-panel {
      position: fixed; bottom: 5rem; right: 1.5rem; z-index: 9998;
      width: 400px; height: 520px; max-height: calc(100vh - 7rem);
      background: var(--color-surface, #fff);
      border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,.12);
      display: none; flex-direction: column;
      animation: mccSlideUp .25s ease;
      font-family: 'Inter', -apple-system, sans-serif; overflow: hidden;
    }
    .mcc-panel.open { display: flex; }

    .mcc-header {
      padding: .75rem 1rem; display: flex; align-items: center; gap: .6rem;
      border-bottom: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .mcc-header-icon {
      width: 32px; height: 32px; border-radius: 8px;
      background: var(--color-primary-subtle, #DDF8F2);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .mcc-header-info { flex: 1; }
    .mcc-header-title { font-size: .85rem; font-weight: 600; color: var(--color-heading, #1E2A5E); }
    .mcc-header-sub { font-size: .7rem; color: var(--color-muted, #6B7599); margin-top: .1rem; }
    .mcc-close { background: none; border: none; cursor: pointer; color: var(--color-muted); font-size: 1.2rem; padding: .25rem; }

    .mcc-messages {
      flex: 1; overflow-y: auto; padding: .75rem; display: flex; flex-direction: column; gap: .5rem;
    }
    .mcc-msg { display: flex; }
    .mcc-msg-user { justify-content: flex-end; }
    .mcc-msg-ai { justify-content: flex-start; }
    .mcc-msg-bubble {
      max-width: 85%; padding: .6rem .85rem; border-radius: 12px;
      font-size: .84rem; line-height: 1.55;
    }
    .mcc-msg-user .mcc-msg-bubble {
      background: var(--color-primary, #00D47E); color: #fff; border-bottom-right-radius: 4px;
    }
    .mcc-msg-ai .mcc-msg-bubble {
      background: var(--color-bg, #F0F4F8); color: var(--color-body, #333F70); border-bottom-left-radius: 4px;
    }
    .mcc-msg-bubble p { margin: .4rem 0; }
    .mcc-msg-bubble p:first-child { margin-top: 0; }
    .mcc-msg-bubble p:last-child { margin-bottom: 0; }
    .mcc-update-badge {
      display: inline-block; font-size: .68rem; font-weight: 600; padding: .15rem .45rem;
      border-radius: 4px; background: rgba(0,212,126,.12); color: #00b86c;
      margin-top: .35rem;
    }

    .mcc-welcome {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 1.5rem; text-align: center;
    }
    .mcc-welcome-icon { font-size: 2rem; margin-bottom: .75rem; }
    .mcc-welcome h3 { font-size: .95rem; font-weight: 600; color: var(--color-heading, #1E2A5E); margin: 0 0 .35rem; }
    .mcc-welcome p { font-size: .82rem; color: var(--color-muted, #6B7599); line-height: 1.5; margin: 0; }
    .mcc-suggestions { display: flex; flex-direction: column; gap: .35rem; margin-top: .75rem; width: 100%; }
    .mcc-suggestion {
      padding: .5rem .75rem; border-radius: 8px; font-size: .78rem; text-align: left;
      border: 1px solid var(--color-border, #E2E8F0); background: transparent;
      color: var(--color-body, #333F70); cursor: pointer; font-family: inherit;
      transition: all .15s;
    }
    .mcc-suggestion:hover { border-color: var(--color-primary, #00D47E); background: rgba(0,212,126,.04); }

    .mcc-input-area {
      padding: .65rem; border-top: 1px solid var(--color-border, #E2E8F0);
      display: flex; gap: .5rem; align-items: flex-end; flex-shrink: 0;
    }
    .mcc-input {
      flex: 1; border: 1px solid var(--color-border, #E2E8F0); border-radius: 10px;
      padding: .5rem .75rem; font-size: .84rem; font-family: inherit;
      color: var(--color-body, #333F70); background: var(--color-bg, #F0F4F8);
      resize: none; max-height: 100px; line-height: 1.4; outline: none;
    }
    .mcc-input:focus { border-color: var(--color-primary, #00D47E); }
    .mcc-send {
      width: 36px; height: 36px; border-radius: 50%; border: none;
      background: var(--color-primary, #00D47E); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .15s; flex-shrink: 0;
    }
    .mcc-send:disabled { opacity: .4; cursor: not-allowed; }
    .mcc-send svg { width: 16px; height: 16px; fill: #fff; }

    .mcc-msg.streaming .mcc-msg-bubble::after {
      content: ''; display: inline-block; width: 4px; height: 14px;
      background: var(--color-primary, #00D47E); border-radius: 1px;
      margin-left: 2px; animation: mccBlink .6s infinite;
    }

    @keyframes mccFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes mccSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes mccBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    @media (max-width: 480px) {
      .mcc-panel { width: calc(100vw - 1.5rem); right: .75rem; bottom: 4.5rem; height: calc(100vh - 6rem); }
      .mcc-btn { bottom: 1rem; right: 1rem; }
      .mcc-tooltip { right: 1rem; bottom: 5.5rem; max-width: 240px; }
    }
  `;
  document.head.appendChild(style);

  var messages = [];
  var isStreaming = false;
  var isOpen = false;
  var contentPageId = window.__CONTENT_PAGE_ID || '';
  var clientSlug = window.__CLIENT_SLUG || '';

  // Build DOM
  var chatBtn = document.createElement('button');
  chatBtn.className = 'mcc-btn';
  chatBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
  chatBtn.onclick = togglePanel;
  document.body.appendChild(chatBtn);

  // Tooltip
  var dismissed = false;
  try { dismissed = localStorage.getItem(TOOLTIP_KEY) === '1'; } catch(e) {}
  if (!dismissed) {
    var tooltip = document.createElement('div');
    tooltip.className = 'mcc-tooltip';
    tooltip.innerHTML = '<button class="mcc-tooltip-close" onclick="this.parentNode.classList.add(\'hidden\'); try{localStorage.setItem(\'' + TOOLTIP_KEY + '\',\'1\')}catch(e){}">&times;</button>' +
      '<div class="mcc-tooltip-text"><strong>Review your new page!</strong><br>Ask me to make any changes to the content, and you\'ll see them update in real time.</div>';
    document.body.appendChild(tooltip);
  }

  // Panel
  var panel = document.createElement('div');
  panel.className = 'mcc-panel';
  panel.innerHTML = `
    <div class="mcc-header">
      <div class="mcc-header-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00D47E" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
      <div class="mcc-header-info">
        <div class="mcc-header-title">Content Review</div>
        <div class="mcc-header-sub">Ask me to update anything on this page</div>
      </div>
      <button class="mcc-close" onclick="document.querySelector('.mcc-panel').classList.remove('open')">&times;</button>
    </div>
    <div class="mcc-messages" id="mccMessages">
      <div class="mcc-welcome" id="mccWelcome">
        <div class="mcc-welcome-icon">&#128196;</div>
        <h3>Your page is ready for review</h3>
        <p>Take a look at the content below and let me know if you'd like any changes.</p>
        <div class="mcc-suggestions" id="mccSuggestions">
          <button class="mcc-suggestion" data-msg="Can you walk me through what's on this page?">Walk me through this page</button>
          <button class="mcc-suggestion" data-msg="I'd like to update my insurance information.">Update insurance info</button>
          <button class="mcc-suggestion" data-msg="Can you adjust the tone to feel warmer and more personal?">Make it warmer</button>
        </div>
      </div>
    </div>
    <div class="mcc-input-area">
      <textarea class="mcc-input" id="mccInput" placeholder="Ask a question or request a change..." rows="1"></textarea>
      <button class="mcc-send" id="mccSend"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
    </div>
  `;
  document.body.appendChild(panel);

  // Events
  document.getElementById('mccSend').addEventListener('click', sendMessage);
  document.getElementById('mccInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('mccInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
  document.querySelectorAll('.mcc-suggestion').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.getElementById('mccInput').value = this.dataset.msg;
      sendMessage();
    });
  });

  function togglePanel() {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    var tt = document.querySelector('.mcc-tooltip');
    if (tt && isOpen) {
      tt.classList.add('hidden');
      try { localStorage.setItem(TOOLTIP_KEY, '1'); } catch(e) {}
    }
    if (isOpen) document.getElementById('mccInput').focus();
  }

  function sendMessage() {
    var input = document.getElementById('mccInput');
    var text = input.value.trim();
    if (!text || isStreaming) return;
    input.value = '';
    input.style.height = 'auto';

    var welcome = document.getElementById('mccWelcome');
    if (welcome) welcome.style.display = 'none';

    addMessage('user', text);
    messages.push({ role: 'user', content: text });
    streamResponse();
  }

  function addMessage(role, content, extra) {
    var container = document.getElementById('mccMessages');
    var div = document.createElement('div');
    div.className = 'mcc-msg mcc-msg-' + (role === 'user' ? 'user' : 'ai');
    var html = '<div class="mcc-msg-bubble">' + formatContent(content) + '</div>';
    if (extra) html += extra;
    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function formatContent(text) {
    if (!text) return '';
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    var paras = text.split(/\n\n+/);
    if (paras.length > 1) {
      text = paras.map(function(p) { return '<p>' + p.trim() + '</p>'; }).join('');
    }
    return text;
  }

  async function streamResponse() {
    isStreaming = true;
    document.getElementById('mccSend').disabled = true;

    var container = document.getElementById('mccMessages');
    var aiDiv = document.createElement('div');
    aiDiv.className = 'mcc-msg mcc-msg-ai streaming';
    aiDiv.innerHTML = '<div class="mcc-msg-bubble"></div>';
    container.appendChild(aiDiv);
    container.scrollTop = container.scrollHeight;

    var bubble = aiDiv.querySelector('.mcc-msg-bubble');
    var fullText = '';
    var displayedLen = 0;
    var renderTimer = null;

    function startTypewriter() {
      if (renderTimer) return;
      renderTimer = setInterval(function() {
        if (displayedLen < fullText.length) {
          var backlog = fullText.length - displayedLen;
          var step = backlog > 200 ? 8 : backlog > 80 ? 5 : backlog > 30 ? 3 : backlog > 10 ? 2 : 1;
          displayedLen += step;
          if (displayedLen > fullText.length) displayedLen = fullText.length;
          // Strip content_update tags from display
          var displayText = fullText.substring(0, displayedLen).replace(/<content_update>[\s\S]*?<\/content_update>/g, '').replace(/<content_update>[\s\S]*/g, '');
          bubble.innerHTML = formatContent(displayText);
        } else {
          clearInterval(renderTimer);
          renderTimer = null;
        }
      }, 16);
    }

    try {
      var resp = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages,
          context: { content_page_id: contentPageId, slug: clientSlug }
        })
      });

      if (!resp.ok) {
        bubble.textContent = 'Sorry, I had trouble connecting. Please try again.';
        aiDiv.classList.remove('streaming');
        isStreaming = false;
        document.getElementById('mccSend').disabled = false;
        return;
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var lines = buffer.split('\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          var data = line.substring(6);
          if (data === '[DONE]') continue;

          try {
            var evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
              fullText += evt.delta.text;
              startTypewriter();
            }
          } catch(e) { /* ignore */ }
        }
      }

      // Wait for typewriter to finish
      await new Promise(function(resolve) {
        var wait = setInterval(function() {
          if (displayedLen >= fullText.length) { clearInterval(wait); resolve(); }
        }, 50);
      });

    } catch(e) {
      bubble.textContent = 'Connection error. Please try again.';
    }

    aiDiv.classList.remove('streaming');
    isStreaming = false;
    document.getElementById('mccSend').disabled = false;

    // Store assistant message (clean of content_update tags)
    var cleanText = fullText.replace(/<content_update>[\s\S]*?<\/content_update>/g, '').trim();
    messages.push({ role: 'assistant', content: cleanText });

    // Check for content update
    var updateMatch = fullText.match(/<content_update>([\s\S]*?)<\/content_update>/);
    if (updateMatch && updateMatch[1]) {
      var newHtml = updateMatch[1].trim();
      applyContentUpdate(newHtml, aiDiv);
    }

    container.scrollTop = container.scrollHeight;
  }

  function applyContentUpdate(newHtml, aiDiv) {
    // Update the iframe
    var iframe = document.getElementById('contentPreviewFrame');
    if (iframe) {
      iframe.srcdoc = newHtml;
    }

    // Show update badge
    var badge = document.createElement('div');
    badge.className = 'mcc-update-badge';
    badge.textContent = 'Page updated';
    aiDiv.appendChild(badge);

    // Save to Supabase via action API
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_record',
        table: 'content_pages',
        id: contentPageId,
        data: { generated_html: newHtml }
      })
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res.success) {
        // Create version record
        fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create_record',
            table: 'content_page_versions',
            data: {
              content_page_id: contentPageId,
              html: newHtml,
              change_summary: messages[messages.length - 2] ? messages[messages.length - 2].content : 'Client edit',
              changed_by: 'client'
            }
          })
        });
      }
    }).catch(function() { /* silent */ });

    // Also save chat message
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_record',
        table: 'content_chat_messages',
        data: { content_page_id: contentPageId, role: 'user', content: messages[messages.length - 2] ? messages[messages.length - 2].content : '' }
      })
    });
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_record',
        table: 'content_chat_messages',
        data: { content_page_id: contentPageId, role: 'assistant', content: messages[messages.length - 1] ? messages[messages.length - 1].content : '' }
      })
    });
  }

})();
