(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const userScope = document.body.dataset.userId || 'legacy';
  const sessionKey = `alisa-session-id:${userScope}`;
  const conversationsKey = `alisa-conversations:${userScope}`;
  const historyStorageKey = (id) => `alisa-chat-history:${userScope}:${id}`;
  if (!localStorage.getItem(sessionKey) && localStorage.getItem('alisa-session-id')) {
    try {
      const legacyIndex = JSON.parse(localStorage.getItem('alisa-conversations') || '[]');
      const legacyIds = new Set([localStorage.getItem('alisa-session-id'), ...legacyIndex.map((item) => item.sessionId)]);
      for (const id of legacyIds) {
        const saved = localStorage.getItem(`alisa-chat-history:${id}`);
        if (saved) localStorage.setItem(`alisa-chat-history:${userScope}:${id}`, saved);
      }
      if (localStorage.getItem('alisa-conversations')) localStorage.setItem(conversationsKey, localStorage.getItem('alisa-conversations'));
      localStorage.setItem(sessionKey, localStorage.getItem('alisa-session-id'));
      for (const id of legacyIds) localStorage.removeItem(`alisa-chat-history:${id}`);
      localStorage.removeItem('alisa-session-id');
      localStorage.removeItem('alisa-conversations');
    } catch { /* Keep existing chat data if migration storage is unavailable. */ }
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let sessionId = localStorage.getItem(sessionKey) || crypto.randomUUID();
  let historyKey = historyStorageKey(sessionId);
  let history = loadHistory(sessionId);
  let conversations = loadConversations();
  let pendingFiles = [];
  let postFile = null;
  let busy = false;
  const welcomeMarkup = $('#welcome').outerHTML;

  function loadHistory(id) {
    try { const saved = JSON.parse(localStorage.getItem(historyStorageKey(id)) || '[]'); return Array.isArray(saved) ? saved : []; }
    catch { return []; }
  }
  function loadConversations() {
    try { const saved = JSON.parse(localStorage.getItem(conversationsKey) || '[]'); return Array.isArray(saved) ? saved : []; }
    catch { return []; }
  }
  function titleFromMessages(messages) {
    const first = messages.find((message) => message.role === 'user');
    if (!first) return 'New chat';
    const title = String(first.text || '').replace(/\s+/g, ' ').trim();
    if (!title) return (first.attachments || []).length ? 'Media conversation' : 'New chat';
    return title.length > 38 ? `${title.slice(0, 37).trimEnd()}…` : title;
  }
  function persistConversationIndex() {
    try { localStorage.setItem(conversationsKey, JSON.stringify(conversations)); } catch { /* Session remains usable in memory. */ }
  }
  function updateConversation() {
    const now = new Date().toISOString();
    let conversation = conversations.find((item) => item.sessionId === sessionId);
    if (!conversation) {
      conversation = { sessionId, title: 'New chat', updatedAt: now, createdAt: now };
      conversations.unshift(conversation);
    }
    conversation.title = titleFromMessages(history);
    conversation.updatedAt = now;
    try { localStorage.setItem(sessionKey, sessionId); } catch { /* The current in-memory session can still be sent. */ }
    persistConversationIndex();
    renderConversationList();
    renderConversationLabel();
  }
  function saveHistory() {
    try { localStorage.setItem(historyKey, JSON.stringify(history.slice(-100))); }
    catch {
      try { localStorage.setItem(historyKey, JSON.stringify(history.slice(-100).map((message) => ({ ...message, attachments: [] })))); }
      catch { /* The active conversation can still continue in memory. */ }
    }
    updateConversation();
  }
  function renderConversationLabel() {
    $('#conversationName').textContent = conversations.find((item) => item.sessionId === sessionId)?.title || 'New chat';
  }
  function renderConversationList() {
    const box = $('#conversationList');
    if (!conversations.length) {
      box.innerHTML = '<div class="history-empty">Your conversations will appear here.</div>';
      return;
    }
    const ordered = [...conversations].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    box.innerHTML = ordered.map((conversation) => {
      const date = conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      return `<div class="conversation-row ${conversation.sessionId === sessionId ? 'active' : ''}"><button class="conversation-open" type="button" data-open-session="${escape(conversation.sessionId)}"><span class="conversation-title">${escape(conversation.title || 'New chat')}</span><span class="conversation-date">${escape(date)}</span></button><button class="conversation-delete" type="button" data-delete-session="${escape(conversation.sessionId)}" aria-label="Delete ${escape(conversation.title || 'conversation')}" title="Delete conversation">×</button></div>`;
    }).join('');
    box.querySelectorAll('[data-open-session]').forEach((button) => button.onclick = () => activateConversation(button.dataset.openSession));
    box.querySelectorAll('[data-delete-session]').forEach((button) => button.onclick = () => deleteConversation(button.dataset.deleteSession));
  }
  function closeHistory() {
    $('#historyDrawer').classList.remove('open');
    $('#historyBackdrop').classList.remove('open');
    $('#historyDrawer').setAttribute('aria-hidden', 'true');
  }
  function openHistory() {
    renderConversationList();
    $('#historyDrawer').classList.add('open');
    $('#historyBackdrop').classList.add('open');
    $('#historyDrawer').setAttribute('aria-hidden', 'false');
  }
  function showWelcome() {
    $('#transcript').innerHTML = welcomeMarkup;
  }
  function renderTranscript() {
    $('#transcript').replaceChildren();
    if (!history.length) showWelcome();
    else history.forEach((message) => renderMessage(message, false));
  }
  function activateConversation(id) {
    if (busy || id === sessionId) { closeHistory(); return; }
    sessionId = id;
    historyKey = historyStorageKey(sessionId);
    history = loadHistory(sessionId);
    localStorage.setItem(sessionKey, sessionId);
    renderTranscript();
    renderConversationList();
    renderConversationLabel();
    $('#chatStatus').textContent = 'Conversation restored';
    $('#chatStatus').classList.remove('error');
    closeHistory();
  }
  function newChat() {
    if (busy) return;
    sessionId = crypto.randomUUID();
    historyKey = historyStorageKey(sessionId);
    history = [];
    localStorage.setItem(sessionKey, sessionId);
    const now = new Date().toISOString();
    conversations.unshift({ sessionId, title: 'New chat', updatedAt: now, createdAt: now });
    persistConversationIndex();
    renderTranscript();
    renderConversationList();
    renderConversationLabel();
    $('#chatStatus').textContent = 'New conversation';
    $('#chatStatus').classList.remove('error');
    closeHistory();
    $('#message').focus();
  }
  function deleteConversation(id) {
    const item = conversations.find((conversation) => conversation.sessionId === id);
    if (!item || !window.confirm(`Delete “${item.title || 'New chat'}”? This removes its saved messages from this browser.`)) return;
    conversations = conversations.filter((conversation) => conversation.sessionId !== id);
    localStorage.removeItem(historyStorageKey(id));
    persistConversationIndex();
    if (id === sessionId) {
      const next = [...conversations].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
      if (next) activateConversation(next.sessionId);
      else newChat();
    }
    renderConversationList();
  }

  // Migrate the existing single-session chat without changing its ID or transcript.
  if (!conversations.some((conversation) => conversation.sessionId === sessionId)) {
    const now = new Date().toISOString();
    conversations.unshift({ sessionId, title: titleFromMessages(history), updatedAt: now, createdAt: now });
    persistConversationIndex();
  }
  localStorage.setItem(sessionKey, sessionId);
  renderConversationLabel();
  renderConversationList();
  history.forEach((message) => renderMessage(message, false));

  function safeAssistant(text) {
    return escape(text).replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/g, (_, alt, url) => `<img src="${url}" alt="${alt}">`).replace(/\n/g, '<br>');
  }
  function renderMessage(message, save = true) {
    $('#welcome')?.remove();
    const row = document.createElement('article');
    row.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
    const time = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const attachments = (message.attachments || []).map((file) => file.type?.startsWith('image/')
      ? `<img src="${escape(file.preview || '')}" alt="${escape(file.name || 'Attached image')}">`
      : `<span>📎 ${escape(file.name || 'Attached file')}</span>`).join('');
    row.innerHTML = `${message.role === 'assistant' ? '<div class="ai-avatar" aria-hidden="true">✦</div>' : ''}<div><div class="bubble">${attachments}${message.role === 'assistant' ? safeAssistant(message.text) : escape(message.text).replace(/\n/g, '<br>')}</div><div class="meta">${message.role === 'assistant' ? 'ALISA · ' : ''}${time}</div></div>`;
    $('#transcript').append(row);
    $('#transcript').scrollTop = $('#transcript').scrollHeight;
    if (save) { history.push(message); saveHistory(); }
  }
  function renderPending() {
    const box = $('#filePreviews');
    box.replaceChildren();
    pendingFiles.forEach((file, index) => {
      const chip = document.createElement('div'); chip.className = 'file-chip';
      if (file.type.startsWith('image/')) { const img = document.createElement('img'); img.src = URL.createObjectURL(file); chip.append(img); }
      const label = document.createElement('span'); label.textContent = file.name;
      const remove = document.createElement('button'); remove.className = 'remove'; remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.onclick = () => { pendingFiles.splice(index, 1); renderPending(); };
      chip.append(label, remove); box.append(chip);
    });
  }
  function fileData(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  }
  function typing() {
    const row = document.createElement('div'); row.className = 'message assistant'; row.id = 'typing';
    row.innerHTML = '<div class="ai-avatar">✦</div><div><div class="bubble typing"><i></i><i></i><i></i></div><div class="meta">ALISA is thinking</div></div>';
    $('#transcript').append(row); $('#transcript').scrollTop = $('#transcript').scrollHeight; return row;
  }
  function setBusy(value) {
    busy = value;
    $('#send').disabled = value;
    $('#newChat').disabled = value;
    $('#refreshChat').disabled = value;
    $('#newChatHistory').disabled = value;
    $('#conversationList').querySelectorAll('button').forEach((button) => { button.disabled = value; });
  }

  $('#chatForm').onsubmit = async (event) => {
    event.preventDefault();
    const text = $('#message').value.trim(), files = pendingFiles.slice();
    if ((!text && !files.length) || busy) return;
    setBusy(true); $('#chatStatus').textContent = 'Connecting to ALISA…'; $('#chatStatus').classList.remove('error');
    const userAttachments = [];
    try {
      const payloadAttachments = await Promise.all(files.map(async (file) => {
        const data = await fileData(file);
        userAttachments.push({ name: file.name, type: file.type || 'application/octet-stream', preview: file.type.startsWith('image/') ? data : '' });
        return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data };
      }));
      renderMessage({ role: 'user', text, attachments: userAttachments, timestamp: new Date().toISOString() });
      const loader = typing();
      await window.alishaCsrfReady;
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.alishaCsrfToken(), 'X-Message-Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ chatInput: text, sessionId, attachments: payloadAttachments }) });
      let data;
      try { data = await response.json(); }
      catch { throw Error(`n8n returned an invalid JSON response (HTTP ${response.status}).`); }
      loader.remove();
      if (!response.ok) throw Error(data?.error || data?.message || `n8n returned ${response.status}`);
      const aiMessage = data.output;
      if (typeof aiMessage !== 'string' || !aiMessage.trim()) throw Error('n8n response is missing a valid output message.');
      renderMessage({ role: 'assistant', text: aiMessage, timestamp: new Date().toISOString() });
      pendingFiles = []; $('#chatFiles').value = ''; renderPending(); $('#message').value = ''; $('#message').style.height = 'auto';
      $('#chatStatus').textContent = 'Connected · response received'; $('#chatStatus').classList.remove('error');
    } catch (error) {
      $('#typing')?.remove(); $('#chatStatus').textContent = error.message || 'Could not reach the n8n workflow.'; $('#chatStatus').classList.add('error');
    } finally { setBusy(false); $('#message').focus(); }
  };
  $('#message').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chatForm').requestSubmit(); } };
  $('#message').oninput = () => { const field = $('#message'); field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 160)}px`; };
  $('#chatFiles').onchange = () => { pendingFiles = [...pendingFiles, ...$('#chatFiles').files]; $('#chatFiles').value = ''; renderPending(); };
  $('#transcript').addEventListener('click', (event) => { const prompt = event.target.closest('.prompt'); if (prompt) { $('#message').value = prompt.textContent; $('#message').focus(); } });

  $('#historyToggle').onclick = openHistory;
  $('#historyBackdrop').onclick = closeHistory;
  $('#closeHistory').onclick = closeHistory;
  $('#newChat').onclick = newChat;
  $('#newChatHistory').onclick = newChat;
  $('#refreshChat').onclick = () => {
    history = loadHistory(sessionId);
    renderTranscript();
    renderConversationList();
    renderConversationLabel();
    $('#chatStatus').textContent = 'Current conversation refreshed';
    $('#chatStatus').classList.remove('error');
  };

  $('#openPublish').onclick = () => { $('#publishDrawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); $('#publishDrawer').setAttribute('aria-hidden', 'false'); };
  function closeDrawer() { $('#publishDrawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); $('#publishDrawer').setAttribute('aria-hidden', 'true'); }
  $('#closePublish').onclick = closeDrawer;
  $('#drawerBackdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeDrawer(); closeHistory(); } });
  $('#postMedia').onchange = () => { postFile = $('#postMedia').files[0] || null; $('#mediaInfo').textContent = postFile ? `${postFile.name} · ${(postFile.size / 1048576).toFixed(2)} MB` : ''; };
  $$('[name="scheduleMode"]').forEach((radio) => radio.onchange = () => $('#dateTime').classList.toggle('hidden', radio.value !== 'scheduled' || !radio.checked));
  function localScheduleIso(date, time) {
    const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number), wall = Date.UTC(year, month - 1, day, hour, minute);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(wall)), value = {};
    parts.forEach((part) => value[part.type] = Number(part.value));
    return new Date(wall - (Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute) - wall)).toISOString();
  }
  $('#publishForm').onsubmit = async (event) => {
    event.preventDefault();
    const status = $('#publishStatus'), button = $('#publish'), caption = $('#postCaption').value.trim(), hashtags = $('#postHashtags').value.trim(), selectedInputs = $$('#platforms input:checked'), accountInputs = selectedInputs.filter((item) => item.dataset.accountId), accountAware = accountInputs.length > 0, selected = accountAware ? [...new Set(accountInputs.map((item) => item.dataset.platform))] : selectedInputs.map((item) => item.value), mode = $('[name="scheduleMode"]:checked').value, date = $('#scheduledDate').value, time = $('#scheduledTime').value;
    status.className = 'drawer-status';
    if (!caption) { status.textContent = 'Add a caption before sending.'; status.classList.add('error'); return; }
    if (!selected.length) { status.textContent = 'Choose at least one platform.'; status.classList.add('error'); return; }
    let scheduledAt = '';
    if (mode === 'scheduled') {
      if (!date || !time) { status.textContent = 'Choose a date and time.'; status.classList.add('error'); return; }
      scheduledAt = localScheduleIso(date, time);
      if (Date.parse(scheduledAt) <= Date.now()) { status.textContent = 'Choose a future date and time.'; status.classList.add('error'); return; }
    }
    const combinedCaption = [caption, hashtags].filter(Boolean).join('\n\n');
    const body = { postId: crypto.randomUUID(), currentType: postFile ? (postFile.type.startsWith('video/') ? '2' : '1') : '0', scheduleMode: mode, scheduledAt, scheduleTimeZone: timezone, title: '', caption: combinedCaption, hashtags, platforms: selected, mediaFileName: postFile?.name || '', mediaFileSize: postFile?.size || '', mediaMimeType: postFile?.type || '', idempotencyKey: crypto.randomUUID() };
    const form = new FormData(); Object.entries(body).forEach(([key, value]) => form.append(key, String(value))); if (postFile) form.append('mediaFile', postFile, postFile.name);
    button.disabled = true; status.textContent = accountAware ? 'Sending approved request for connected accounts…' : 'Sending approved request to the unified workflow…';
    try {
      await window.alishaCsrfReady;
      if (accountAware) form.append('socialAccountIds', JSON.stringify(accountInputs.map((item) => item.dataset.accountId)));
      const response = await fetch(accountAware ? '/api/publishing/submit' : '/api/publish', { method: 'POST', headers: { 'X-CSRF-Token': window.alishaCsrfToken() }, body: form }), raw = await response.text();
      let result; try { result = raw ? JSON.parse(raw) : ''; } catch { result = raw; }
      if (!response.ok) throw Error(typeof result === 'object' ? (result.error || result.message || `n8n returned ${response.status}`) : (result || `n8n returned ${response.status}`));
      status.className = 'drawer-status success'; status.textContent = `Workflow response received${typeof result === 'string' && result ? `: ${result.slice(0, 400)}` : '.'} This does not confirm platform publication.`;
    } catch (error) { status.className = 'drawer-status error'; status.textContent = error.message || 'Could not send the publishing request.'; }
    finally { button.disabled = false; }
  };
  $('#tzLabel').textContent = `Scheduling timezone: ${timezone}`;
  $('#scheduledDate').min = new Date().toISOString().slice(0, 10);
  function renderPlatformChoices(accounts = []) {
    const available = Array.isArray(accounts) ? accounts.filter((account) => account.connectionStatus === 'connected') : [];
    if (available.length) {
      $('#platforms').innerHTML = available.map((account) => {
        const label = `${account.platform[0].toUpperCase()}${account.platform.slice(1)} · ${account.accountName || account.accountUsername || 'Connected account'}`;
        return `<label class="platform"><input type="checkbox" value="${escape(account.id)}" data-account-id="${escape(account.id)}" data-platform="${escape(account.platform)}">${escape(label)}</label>`;
      }).join('');
      return;
    }
    $('#platforms').innerHTML = ['Facebook', 'Instagram', 'LinkedIn', 'TikTok', 'YouTube'].map((platform) => `<label class="platform"><input type="checkbox" value="${platform.toLowerCase()}">${platform}</label>`).join('');
  }
  window.SocialAccountsApi.list().then((result) => renderPlatformChoices(result.accounts)).catch(() => renderPlatformChoices());
  fetch('/api/config', { cache: 'no-store' }).then((response) => response.json()).then((config) => {
    const status = $('#connection');
    status.innerHTML = `<i class="dot ${config.chatWebhookConfigured ? 'ready' : ''}"></i><span>${config.chatWebhookConfigured ? 'Chat webhook configured' : 'Chat webhook not configured'}</span>`;
  }).catch(() => { $('#connection').innerHTML = '<i class="dot"></i><span>Server unavailable</span>'; });
})();
