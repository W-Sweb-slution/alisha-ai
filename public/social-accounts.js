(() => {
  'use strict';
  const platforms = [
    { id: 'facebook', name: 'Facebook', connectLabel: 'Connect Facebook', description: 'Connect your Facebook Pages and publish posts, images, and videos.', logo: 'f', color: '#1877F2' },
    { id: 'instagram', name: 'Instagram', description: 'Connect your Instagram professional accounts to publish content.', logo: '◎', color: '#E1306C' },
    { id: 'linkedin', name: 'LinkedIn', description: 'Connect LinkedIn member profiles to publish content.', logo: 'in', color: '#0A66C2' },
    { id: 'tiktok', name: 'TikTok', description: 'Connect your TikTok account to upload and publish videos.', logo: '♪', color: '#EE1D52' },
    { id: 'youtube', name: 'YouTube', description: 'Connect your YouTube channel to upload and manage videos.', logo: '▶', color: '#FF0033' }
  ];
  async function request(url, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    if (options.method && options.method !== 'GET') { await window.alishaCsrfReady; headers['X-CSRF-Token'] = window.alishaCsrfToken(); }
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', ...options, headers });
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('The account API did not return JSON. Reload ALISHA and sign in again.');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || data.message || `Request failed (${response.status})`), { status: response.status, code: data.code });
    return data;
  }
  window.SocialAccountsApi = {
    platforms,
    list: () => request('/api/social-accounts'),
    listByPlatform: (platform) => request(`/api/social-accounts/${encodeURIComponent(platform)}`),
    startOAuth: (platform) => request(`/api/social-accounts/${encodeURIComponent(platform)}/oauth/start`, { headers: { 'X-Alisha-Origin': window.location.origin } }),
    oauthDiagnostic: () => request('/api/social-accounts/oauth/diagnostic'),
    disconnect: (accountId) => request(`/api/social-accounts/${encodeURIComponent(accountId)}/disconnect`, { method: 'POST', body: '{}' }),
    setDefault: (accountId) => request(`/api/social-accounts/${encodeURIComponent(accountId)}/set-default`, { method: 'POST', body: '{}' }),
    submitPublishing: (payload) => request('/api/publishing/submit', { method: 'POST', body: JSON.stringify(payload) }),
    publishingRequests: () => request('/api/publishing/requests')
  };
})();
