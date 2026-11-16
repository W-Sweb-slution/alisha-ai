'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const databasePath = path.join(__dirname, '..', 'data', `multi-test-${crypto.randomUUID()}.sqlite`);
process.env.AUTH_DB_PATH = databasePath;
process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
for (const key of ['META_APP_ID', 'META_APP_SECRET', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']) process.env[key] = `fixture-${key}`;
for (const key of ['META_REDIRECT_URI', 'LINKEDIN_REDIRECT_URI', 'TIKTOK_REDIRECT_URI', 'YOUTUBE_REDIRECT_URI']) process.env[key] = 'https://alisha.example.test/api/social-accounts/oauth/callback';
const { app, authStore, socialStore, socialOAuth } = require('../server');
const { decryptTokens } = require('../google-token-crypto');
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('each platform connects two identities independently, reconnects safely, and starts fresh OAuth', async (t) => {
  await authStore.ready;
  t.after(() => { authStore.database.close(); fs.rmSync(databasePath, { force: true }); });
  async function register(email) {
    const agent = request.agent(app);
    const csrf = (await agent.get('/api/csrf')).body.csrfToken;
    const result = await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ fullName: 'OAuth Tester', email, password: 'TestAccount123!', confirmPassword: 'TestAccount123!' }).expect(201);
    return { agent, user: result.body.user, csrf: result.body.csrfToken };
  }
  const owner = await register('multi@example.test');
  const other = await register('isolated@example.test');
  const allPlatforms = ['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube'];
  for (const [platformIndex, platform] of allPlatforms.entries()) {
    let identity = 1;
    let reconnect = false;
    const token = () => `${platform}-private-${identity}-${reconnect ? 'new' : 'original'}`;
    const id = () => `${platformIndex + 1}00000000000${identity}`;
    socialOAuth.fetcher = async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/oauth/access_token')) return json({ access_token: token(), expires_in: 3600 });
      if (u.pathname.endsWith('/me/accounts')) return json({ data: [{ id: id(), name: `${platform} ${identity}`, access_token: token(), picture: { data: { url: `https://images.example.test/${id()}` } }, instagram_business_account: { id: id(), username: `instagram${identity}`, profile_picture_url: `https://images.example.test/${id()}` } }] });
      if (u.pathname.endsWith('/accessToken') || u.pathname.endsWith('/oauth/token/') || u.pathname.endsWith('/token')) return json({ access_token: token(), expires_in: 3600, ...(!reconnect ? { refresh_token: `refresh-${platform}-${identity}` } : {}) });
      if (u.pathname.endsWith('/userinfo')) return json({ sub: id(), name: `LinkedIn ${identity}`, picture: `https://images.example.test/${id()}` });
      if (u.pathname.endsWith('/user/info/')) return json({ data: { user: { open_id: id(), display_name: `TikTok ${identity}`, avatar_url: `https://images.example.test/${id()}` } }, error: { code: 'ok', message: '' } });
      if (u.pathname.endsWith('/channels')) return json({ items: [{ id: id(), snippet: { title: `Channel ${identity}`, thumbnails: { default: { url: `https://images.example.test/${id()}` } } } }] });
      throw new Error('Unexpected mock provider request.');
    };
    async function start() {
      const response = await owner.agent.get(`/api/social-accounts/${platform}/oauth/start`).set('X-Alisha-Origin', 'https://alisha.example.test').expect(200);
      assert.match(response.headers['cache-control'], /no-store/);
      return new URL(response.body.authorizationUrl);
    }
    async function callback(url) {
      return owner.agent.get('/api/social-accounts/oauth/callback').query({ state: url.searchParams.get('state'), code: 'fixture-code' }).expect(302);
    }
    const first = await start();
    const second = await start();
    assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
    if (platform === 'youtube') assert.equal(first.searchParams.get('prompt'), 'select_account consent');
    if (platform === 'tiktok') { assert.equal(first.searchParams.get('disable_auto_auth'), '1'); assert.equal(first.searchParams.get('scope'), 'user.info.basic,video.publish'); }
    const firstResult = await callback(first);
    assert.match(firstResult.headers.location, /added=1&updated=0/);
    const firstRow = socialStore.listSocialAccounts(owner.user.id).find((a) => a.platform === platform);
    identity = 2;
    await callback(second);
    let rows = socialStore.listSocialAccounts(owner.user.id).filter((a) => a.platform === platform);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((a) => a.profileImage && a.connectionStatus === 'connected'));
    const secondRow = rows.find((a) => a.id !== firstRow.id);
    const firstEncrypted = socialStore.getSocialAccount(owner.user.id, firstRow.id).encrypted_tokens;
    reconnect = true;
    const repeated = await callback(await start());
    assert.match(repeated.headers.location, /added=0&updated=1/);
    rows = socialStore.listSocialAccounts(owner.user.id).filter((a) => a.platform === platform);
    assert.equal(rows.length, 2);
    assert.equal(socialStore.getSocialAccount(owner.user.id, firstRow.id).encrypted_tokens, firstEncrypted, 'authorizing another identity never changes the earlier identity');
    const secondStored = socialStore.getSocialAccount(owner.user.id, secondRow.id);
    assert.equal(decryptTokens(secondStored.encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).access_token, token());
    if (!['facebook', 'instagram'].includes(platform)) assert.equal(decryptTokens(secondStored.encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).refresh_token, `refresh-${platform}-2`);
    const listed = (await owner.agent.get(`/api/social-accounts/${platform}`).expect(200)).body.accounts;
    assert.equal(listed.length, 2);
    assert.equal(JSON.stringify(listed).includes(token()), false);
    await other.agent.post(`/api/social-accounts/${firstRow.id}/disconnect`).set('X-CSRF-Token', other.csrf).send({}).expect(404);
    await other.agent.post(`/api/social-accounts/${firstRow.id}/set-default`).set('X-CSRF-Token', other.csrf).send({}).expect(404);
    await owner.agent.post(`/api/social-accounts/${firstRow.id}/set-default`).set('X-CSRF-Token', owner.csrf).send({}).expect(200);
    const publishing = socialStore.createPublishingRequest({ id: crypto.randomUUID(), userId: owner.user.id, idempotencyKey: crypto.randomUUID(), status: 'pending', request: { caption: 'Fixture only' }, targets: rows.map((a) => ({ accountId: a.id, platform })) });
    assert.equal(publishing.request.targets.length, 2);
    await owner.agent.post(`/api/social-accounts/${secondRow.id}/disconnect`).set('X-CSRF-Token', owner.csrf).send({}).expect(200);
    await callback(await start());
    assert.equal(socialStore.listSocialAccounts(owner.user.id).filter((a) => a.platform === platform && a.connectionStatus === 'connected').length, 2);
    await owner.agent.get(`/api/social-accounts/${platform}/oauth/start`).set('X-Alisha-Origin', 'http://localhost:3000').expect(409);
    if (platform === 'linkedin') {
      const preserved = socialStore.listSocialAccounts(owner.user.id).filter((a) => a.platform === 'linkedin')
        .map((a) => socialStore.getSocialAccount(owner.user.id, a.id).encrypted_tokens);
      const logs = [];
      const originalError = console.error;
      console.error = (...args) => logs.push(args.join(' '));
      try {
        const tokenFailureStart = await start();
        socialOAuth.fetcher = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Authorization code expired. client_secret=fixture-LINKEDIN_CLIENT_SECRET code=fixture-code' }), { status: 400 });
        const failure = await callback(tokenFailureStart);
        assert.match(failure.headers.location, /social=failed/);
        let diagnostic = (await owner.agent.get('/api/social-accounts/oauth/diagnostic').expect(200)).body.diagnostic;
        assert.equal(diagnostic.stage, 'token_exchange');
        assert.equal(diagnostic.errorCode, 'invalid_grant');
        assert.equal(diagnostic.httpStatus, 400);
        assert.match(diagnostic.message, /Authorization code expired/);
        assert.equal(JSON.stringify(diagnostic).includes('fixture-LINKEDIN_CLIENT_SECRET'), false);
        assert.equal(JSON.stringify(diagnostic).includes('fixture-code'), false);
        assert.equal((await other.agent.get('/api/social-accounts/oauth/diagnostic')).body.diagnostic, null);

        const userinfoStart = await start();
        socialOAuth.fetcher = async (url) => String(url).includes('/accessToken')
          ? json({ access_token: 'linkedin-private-diagnostic-token', expires_in: 3600 })
          : new Response(JSON.stringify({ status: 403, serviceErrorCode: 100, message: 'Not enough permissions. Bearer linkedin-private-diagnostic-token' }), { status: 403 });
        await callback(userinfoStart);
        diagnostic = (await owner.agent.get('/api/social-accounts/oauth/diagnostic')).body.diagnostic;
        assert.equal(diagnostic.stage, 'userinfo');
        assert.equal(diagnostic.errorCode, '100');
        assert.equal(diagnostic.httpStatus, 403);
        assert.match(diagnostic.message, /Not enough permissions/);
        assert.equal(JSON.stringify(diagnostic).includes('linkedin-private-diagnostic-token'), false);

        const scopeStart = await start();
        await owner.agent.get('/api/social-accounts/oauth/callback').query({ state: scopeStart.searchParams.get('state'), error: 'unauthorized_scope_error', error_description: 'Scope w_member_social is not authorized for this application.' }).expect(302);
        diagnostic = (await owner.agent.get('/api/social-accounts/oauth/diagnostic')).body.diagnostic;
        assert.equal(diagnostic.stage, 'authorization');
        assert.equal(diagnostic.errorCode, 'unauthorized_scope_error');
        assert.match(diagnostic.message, /w_member_social/);
        assert.ok(logs.every((line) => !line.includes('linkedin-private-diagnostic-token') && !line.includes('fixture-LINKEDIN_CLIENT_SECRET') && !line.includes('fixture-code')));
        assert.deepEqual(socialStore.listSocialAccounts(owner.user.id).filter((a) => a.platform === 'linkedin').map((a) => socialStore.getSocialAccount(owner.user.id, a.id).encrypted_tokens), preserved, 'failed OAuth attempts preserve both existing LinkedIn tokens');
      } finally { console.error = originalError; }
    }
  }
  assert.deepEqual((await other.agent.get('/api/social-accounts')).body.accounts, []);
});
