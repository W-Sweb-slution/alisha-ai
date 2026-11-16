(() => {
  'use strict';
  const page = document.querySelector('#accountsPage');
  if (!page) return;
  const onAccountsPage = window.location.pathname.replace(/\/$/, '') === '/connect-accounts';
  if (!onAccountsPage) return;
  document.querySelector('.app')?.classList.add('hidden');
  document.querySelector('#historyDrawer')?.classList.add('hidden');
  document.querySelector('#publishDrawer')?.classList.add('hidden');
  page.classList.remove('hidden');

  const api = window.SocialAccountsApi;
  const grid = document.querySelector('#accountGrid');
  const notice = document.querySelector('#accountsNotice');
  const connecting = new Set();
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const showNotice = (message, isError = false) => { notice.textContent = message; notice.classList.toggle('account-alert', isError); };

  function render(accounts = []) {
    const list = Array.isArray(accounts) ? accounts : [];
    grid.innerHTML = api.platforms.map((platform) => {
      const platformAccounts = list.filter((account) => account.platform === platform.id);
      const connected = platformAccounts.filter((account) => account.connectionStatus === 'connected');
      const reconnect = platformAccounts.filter((account) => account.connectionStatus === 'reauthorization_required');
      const visibleAccounts = [...connected, ...reconnect];
      const status = connected.length ? `Connected · ${connected.length} account${connected.length === 1 ? '' : 's'}${reconnect.length ? ` · ${reconnect.length} need reconnect` : ''}` : reconnect.length ? 'Reconnect required' : 'Not Connected';
      const accountsMarkup = visibleAccounts.length ? `<div class="connected-list">${visibleAccounts.map((account) => {
        const needsReconnect = account.connectionStatus === 'reauthorization_required';
        return `<div class="connected-account">${account.profileImage ? `<img src="${escape(account.profileImage)}" alt="">` : ''}<div><strong>${escape(account.accountName || account.accountUsername || platform.name)}</strong><div class="account-empty">${needsReconnect ? 'Reconnect required' : 'Connected'}${account.isDefault ? ' · Default' : ''}</div></div><div style="margin-left:auto;display:flex;gap:5px">${needsReconnect ? `<button class="button" data-reconnect="${platform.id}" type="button">Reconnect</button>` : `<button class="button" data-default="${escape(account.id)}" type="button">Default</button>`}<button class="button" data-disconnect="${escape(account.id)}" type="button">Disconnect</button></div></div>`;
      }).join('')}</div>` : '<div class="account-empty">No connected accounts found. Connect your account to continue.</div>';
      const connectLabel = connected.length ? 'Connect Another Account' : (platform.connectLabel || 'Connect Account');
      return `<article class="account-card" data-platform="${platform.id}"><div class="account-card-head"><span class="platform-logo" style="background:${platform.color}" aria-hidden="true">${platform.logo}</span><div><h2>${platform.name}</h2><span class="account-status">${status}</span></div></div><p>${platform.description}</p>${accountsMarkup}<div class="account-actions"><button class="button primary" data-connect="${platform.id}" type="button">${connectLabel}</button>${connected.length > 1 ? '<button class="button" type="button" data-manage="' + platform.id + '">Manage Accounts</button>' : ''}</div></article>`;
    }).join('');
    grid.querySelectorAll('[data-connect], [data-reconnect]').forEach((button) => {
      const platform = button.dataset.connect || button.dataset.reconnect;
      button.disabled = connecting.has(platform);
      button.onclick = () => connect(platform);
    });
    grid.querySelectorAll('[data-disconnect]').forEach((button) => button.onclick = () => disconnect(button.dataset.disconnect));
    grid.querySelectorAll('[data-default]').forEach((button) => button.onclick = () => setDefault(button.dataset.default));
    grid.querySelectorAll('[data-manage]').forEach((button) => button.onclick = () => grid.querySelector(`[data-platform="${button.dataset.manage}"]`)?.scrollIntoView({ behavior: 'smooth' }));
  }

  async function loadAccounts() {
    try {
      const result = await api.list();
      render(result.accounts || []);
      showNotice('Your connected social accounts are loaded from your account.');
      showOAuthResult();
    } catch (error) {
      render([]);
      if (error.code === 'SOCIAL_ACCOUNT_BACKEND_REQUIRED') {
        showNotice('Social platform connections are not configured yet. Google Sheets connection is managed separately below.');
      } else {
        showNotice(`Could not load social accounts: ${error.message}`, true);
      }
    }
  }
  async function connect(platform) {
    if (connecting.has(platform)) return;
    connecting.add(platform);
    const buttons = [...grid.querySelectorAll(`[data-connect="${platform}"], [data-reconnect="${platform}"]`)];
    const labels = buttons.map((button) => button.textContent);
    buttons.forEach((button) => { button.disabled = true; button.textContent = 'Connecting…'; });
    showNotice(`Starting ${platform} authorization…`);
    try {
      const result = await api.startOAuth(platform);
      const authorization = new URL(result.authorizationUrl);
      const hosts = { facebook: 'www.facebook.com', instagram: 'www.facebook.com', linkedin: 'www.linkedin.com', tiktok: 'www.tiktok.com', youtube: 'accounts.google.com' };
      if (authorization.protocol !== 'https:' || authorization.hostname !== hosts[platform]) throw new Error('The server returned an invalid provider authorization URL.');
      window.location.assign(authorization.href);
    } catch (error) {
      showNotice(error.message, true);
      connecting.delete(platform);
      buttons.forEach((button, index) => { button.disabled = false; button.textContent = labels[index]; });
    }
  }
  async function disconnect(id) {
    if (!window.confirm('Disconnect this social account?')) return;
    try { await api.disconnect(id); showNotice('Account disconnected.'); await loadAccounts(); }
    catch (error) { showNotice(error.message, true); }
  }
  async function setDefault(id) {
    try { await api.setDefault(id); showNotice('Default account updated.'); await loadAccounts(); }
    catch (error) { showNotice(error.message, true); }
  }

  render();
  loadAccounts();

  const googleStatus = document.querySelector('#googleSheetStatus');
  const googleNotice = document.querySelector('#googleSheetNotice');
  const googleConnect = document.querySelector('#googleConnect');
  const googleInitialize = document.querySelector('#googleInitialize');
  const googleDisconnect = document.querySelector('#googleDisconnect');
  const showGoogleNotice = (message, kind = '') => { googleNotice.textContent = message; googleNotice.className = `google-sheet-notice ${kind}`.trim(); };
  async function loadGoogleStatus() {
    try {
      const response = await fetch('/api/google/status', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load Google Sheets connection status.');
      // Keep Connect available so users can retry after server configuration changes;
      // the connect endpoint remains authoritative and returns a clear error if unconfigured.
      googleConnect.disabled = false;
      googleConnect.classList.toggle('hidden', data.connected);
      googleDisconnect.classList.toggle('hidden', !data.connected);
      googleInitialize.classList.toggle('hidden', !data.connected || data.sheetsReady);
      googleStatus.textContent = data.connected
        ? `Connected${data.email ? ` as ${data.email}` : ''} · ${data.sheetsReady ? 'Sheets ready' : 'Sheets need setup'}`
        : data.configured ? 'Not connected' : 'Server setup required';
      if (!data.configured) showGoogleNotice('Set the Google OAuth and spreadsheet environment variables on the server to enable connection.');
      else if (data.connected && !data.sheetsReady) showGoogleNotice('The Google account is connected, but the required sheet tabs are not ready. Prepare Sheets to retry.');
    } catch (error) { googleStatus.textContent = 'Status unavailable'; showGoogleNotice(error.message, 'error'); }
  }
  googleConnect.onclick = async () => {
    googleConnect.disabled = true;
    try {
      const response = await fetch('/api/google/connect', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start Google authorization.');
      window.location.assign(data.authorizationUrl);
    } catch (error) { showGoogleNotice(error.message, 'error'); googleConnect.disabled = false; }
  };
  googleInitialize.onclick = async () => {
    googleInitialize.disabled = true;
    try {
      await window.alishaCsrfReady;
      const response = await fetch('/api/google/sheets/initialize', { method: 'POST', headers: { 'X-CSRF-Token': window.alishaCsrfToken() } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not prepare Google Sheets.');
      showGoogleNotice(`Prepared ${data.sheetNames.length} Alisha data sheets.`, 'success');
      await loadGoogleStatus();
    } catch (error) { showGoogleNotice(error.message, 'error'); }
    finally { googleInitialize.disabled = false; }
  };
  googleDisconnect.onclick = async () => {
    if (!window.confirm('Disconnect Google Sheets? Alisha will revoke this authorization and remove its encrypted tokens.')) return;
    googleDisconnect.disabled = true;
    try {
      await window.alishaCsrfReady;
      const response = await fetch('/api/google/disconnect', { method: 'POST', headers: { 'X-CSRF-Token': window.alishaCsrfToken() } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not disconnect Google Sheets.');
      showGoogleNotice('Google Sheets disconnected.', 'success');
      await loadGoogleStatus();
    } catch (error) { showGoogleNotice(error.message, 'error'); }
    finally { googleDisconnect.disabled = false; }
  };
  function showOAuthResult() {
  const socialParams = new URLSearchParams(window.location.search);
  const socialResult = socialParams.get('social');
  const socialPlatform = socialParams.get('platform');
  if (socialResult === 'connected') {
    const added = Number(socialParams.get('added') || 0);
    showNotice(added > 0 ? `${added} ${socialPlatform || 'social'} account${added === 1 ? '' : 's'} added.` : `The provider returned an account already connected to ALISHA. Its authorization was refreshed. To add a different ${socialPlatform || 'social'} account, switch accounts on the provider’s website, then click Connect Another Account.`);
  }
  else if (socialResult === 'cancelled') showNotice('Social authorization was cancelled. No account was connected.');
  else if (socialResult === 'failed' && socialParams.get('reason') === 'permissions') showNotice('Meta did not grant the requested Page permissions. Check the existing Meta app’s pages_show_list, pages_read_engagement, and pages_manage_posts permissions, then reconnect.', true);
  else if (socialResult === 'failed' && socialParams.get('reason') === 'reauthorization') showNotice('Meta rejected the authorization token. Reconnect Facebook and grant the requested Page permissions again.', true);
  else if (socialResult === 'failed') showNotice('Social authorization could not be completed. Check the provider app setup and try again.', true);
  if ((socialResult === 'failed' || socialResult === 'cancelled') && api.oauthDiagnostic) {
    api.oauthDiagnostic().then(({ diagnostic }) => {
      if (!diagnostic || diagnostic.reference !== socialParams.get('ref')) {
        showNotice('No provider diagnostic was saved for this attempt. Stop the existing ALISHA server, start npm start from the updated project folder, reload this page, and retry the connection.', true);
        return;
      }
      showNotice(`${diagnostic.platform} OAuth failed during ${diagnostic.stage}: ${diagnostic.errorCode} — ${diagnostic.message} (reference ${diagnostic.reference})`, true);
    }).catch(() => showNotice('Could not load the OAuth failure details. Check the server terminal using the connection reference.', true));
  }
  }
  const googleResult = new URLSearchParams(window.location.search).get('google');
  const resultMessages = { connected: ['Google Sheets connected and prepared.', 'success'], cancelled: ['Google authorization was cancelled.', 'error'], failed: ['Google authorization could not be completed.', 'error'], sheets_error: ['Google is connected, but Alisha could not prepare the spreadsheet. Check sheet access and retry.', 'error'] };
  if (resultMessages[googleResult]) showGoogleNotice(...resultMessages[googleResult]);
  fetch('/api/config', { cache: 'no-store' }).then((response) => response.json()).then((config) => {
    if (!config.isGoogleAdmin) return;
    document.querySelector('#googleSheetCard').classList.remove('hidden');
    loadGoogleStatus();
  }).catch(() => {});
})();
