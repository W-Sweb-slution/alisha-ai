'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'accounts-page.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const element = () => ({ textContent: '', disabled: false, classList: { add() {}, remove() {}, toggle() {} } });

async function load(accounts, startOAuth, options = {}) {
  const elements = new Map();
  const grid = element();
  let markup = '', buttons = [];
  Object.defineProperty(grid, 'innerHTML', { get: () => markup, set: (value) => {
    markup = value;
    buttons = [...value.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => {
      const button = element(); button.textContent = m[2]; button.dataset = {};
      for (const attr of m[1].matchAll(/data-([a-z]+)="([^"]*)"/g)) button.dataset[attr[1]] = attr[2];
      return button;
    });
  } });
  grid.querySelectorAll = (selector) => buttons.filter((b) => selector.split(',').some((s) => {
    const match = s.trim().match(/^\[data-([a-z]+)(?:="([^"]+)")?\]$/);
    return match && b.dataset[match[1]] !== undefined && (!match[2] || b.dataset[match[1]] === match[2]);
  }));
  elements.set('#accountGrid', grid);
  const document = { querySelector: (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  } };
  const navigations = [];
  const window = { location: { pathname: '/connect-accounts', search: options.search || '', assign: (url) => navigations.push(url) }, SocialAccountsApi: {
    platforms: ['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube'].map((id) => ({ id, name: id, logo: id, color: '#123' })),
    list: async () => ({ accounts }), startOAuth, ...(options.diagnostic !== undefined ? { oauthDiagnostic: async () => ({ diagnostic: options.diagnostic }) } : {})
  } };
  vm.runInNewContext(script, { window, document, URL, URLSearchParams, fetch: async () => ({ json: async () => ({ isGoogleAdmin: false }) }) });
  await tick();
  return { grid, navigations, notice: elements.get('#accountsNotice') };
}

test('all platform buttons keep Connect Another Account and navigate to the provider after a recoverable failure', async () => {
  const hosts = { facebook: 'www.facebook.com', instagram: 'www.facebook.com', linkedin: 'www.linkedin.com', tiktok: 'www.tiktok.com', youtube: 'accounts.google.com' };
  for (const [platform, host] of Object.entries(hosts)) {
    let attempts = 0;
    const accounts = [1, 2].map((i) => ({ id: `${platform}-${i}`, platform, accountName: `Account ${i}`, connectionStatus: 'connected', profileImage: `https://images.example.test/${i}`, isDefault: i === 1 }));
    const page = await load(accounts, async (requested) => { assert.equal(requested, platform); attempts += 1; if (attempts === 1) throw new Error('Temporary connection failure'); return { authorizationUrl: `https://${host}/authorize?state=fresh-state` }; });
    const button = page.grid.querySelectorAll(`[data-connect="${platform}"]`)[0];
    assert.equal(button.textContent, 'Connect Another Account');
    assert.match(page.grid.innerHTML, /Account 1/); assert.match(page.grid.innerHTML, /Account 2/);
    assert.equal(page.grid.querySelectorAll('[data-disconnect]').length, 2);
    assert.equal(page.grid.querySelectorAll('[data-default]').length, 2);
    await button.onclick();
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Connect Another Account');
    assert.equal(page.notice.textContent, 'Temporary connection failure');
    await button.onclick();
    assert.equal(attempts, 2);
    assert.equal(new URL(page.navigations[0]).hostname, host);
  }
});

test('a local callback returned as an authorization URL is rejected instead of refreshing the accounts page', async () => {
  const page = await load([], async () => ({ authorizationUrl: 'https://alisha.example.test/api/social-accounts/oauth/callback' }));
  await page.grid.querySelectorAll('[data-connect="linkedin"]')[0].onclick();
  assert.equal(page.navigations.length, 0);
  assert.match(page.notice.textContent, /invalid provider authorization URL/);
});

test('OAuth failure displays the saved provider stage and error rather than the generic callback message', async () => {
  const page = await load([], async () => ({}), { search: '?social=failed&platform=linkedin&ref=test-reference', diagnostic: { reference: 'test-reference', platform: 'linkedin', stage: 'token_exchange', errorCode: 'invalid_grant', message: 'Authorization code expired.' } });
  assert.match(page.notice.textContent, /token_exchange: invalid_grant/);
  assert.match(page.notice.textContent, /Authorization code expired/);
  const oldPage = await load([], async () => ({}), { search: '?social=failed&platform=linkedin', diagnostic: null });
  assert.match(oldPage.notice.textContent, /No provider diagnostic was saved/);
});
