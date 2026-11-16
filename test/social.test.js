'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const databasePath = path.join(__dirname, '..', 'data', `social-test-${crypto.randomUUID()}.sqlite`);
process.env.AUTH_DB_PATH = databasePath;
process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.META_APP_ID = 'meta-test-app';
process.env.META_APP_SECRET = 'meta-test-secret';
process.env.META_REDIRECT_URI = 'http://localhost:3000/api/social-accounts/oauth/callback';
process.env.LINKEDIN_CLIENT_ID = 'linkedin-test-app';
process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-test-secret';
process.env.LINKEDIN_REDIRECT_URI = 'http://localhost:3000/api/social-accounts/oauth/callback';
process.env.TIKTOK_CLIENT_KEY = 'tiktok-test-app';
process.env.TIKTOK_CLIENT_SECRET = 'tiktok-test-secret';
process.env.TIKTOK_REDIRECT_URI = 'https://localhost.test/api/social-accounts/oauth/callback';
process.env.YOUTUBE_CLIENT_ID = 'youtube-test-app';
process.env.YOUTUBE_CLIENT_SECRET = 'youtube-test-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:3000/api/social-accounts/oauth/callback';
process.env.N8N_WEBHOOK_URL = 'https://workflow.test/webhook/publish';
process.env.N8N_PUBLISHING_CALLBACK_SECRET = 'test-only-callback-secret-with-over-thirty-two-characters';
process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED = 'true';

const request = require('supertest');
const { app, authStore, socialStore, socialOAuth, facebookPublisher } = require('../server');
const { encryptTokens, decryptTokens } = require('../google-token-crypto');

async function register(email) {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/csrf').expect(200)).body.csrfToken;
  const result = await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({
    fullName: email.split('@')[0], email, password: 'SocialPass123!', confirmPassword: 'SocialPass123!'
  }).expect(201);
  return { agent, csrfToken: result.body.csrfToken, user: result.body.user };
}

test('social OAuth, encrypted account ownership, account-aware publishing and status callbacks', async (t) => {
  await authStore.ready;
  t.after(() => {
    try { authStore.database.close(); } catch {}
    for (const suffix of ['', `.${process.pid}.tmp`]) try { fs.rmSync(databasePath + suffix, { force: true }); } catch {}
  });

  const owner = await register('owner@example.test');
  const other = await register('other@example.test');
  await request(app).get('/api/social-accounts').expect(401);

  const startUrls = {};
  for (const platform of ['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube']) {
    const response = await owner.agent.get(`/api/social-accounts/${platform}/oauth/start`).expect(200);
    startUrls[platform] = new URL(response.body.authorizationUrl);
    assert.equal(response.body.platform, platform);
    assert.equal(response.body.pkce, platform === 'youtube');
    assert.equal(startUrls[platform].searchParams.has('client_secret'), false);
  }
  assert.ok(startUrls.youtube.searchParams.get('code_challenge'));
  assert.equal(startUrls.youtube.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(startUrls.facebook.searchParams.get('scope').split(',').sort(), ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'public_profile'].sort());

  const previousSocialFetcher = socialOAuth.fetcher;
  const facebookGraphRequests = [];
  const facebookPages = [
    { id: '100000000000001', name: 'First Test Page', access_token: 'page-token-one', picture: { data: { url: 'https://images.example.test/page-one.jpg' } }, tasks: ['CREATE_CONTENT'] },
    { id: '100000000000002', name: 'Second Test Page', access_token: 'page-token-two', picture: { data: { url: 'https://images.example.test/page-two.jpg' } }, tasks: ['CREATE_CONTENT'] },
    { id: '100000000000003', name: 'Third Test Page', access_token: 'page-token-three', picture: { data: { url: 'https://images.example.test/page-three.jpg' } }, tasks: ['CREATE_CONTENT'] }
  ];
  let facebookTokenGeneration = 1;
  socialOAuth.fetcher = async (url, options = {}) => {
    const parsed = new URL(String(url));
    facebookGraphRequests.push({ url: parsed, options });
    if (parsed.pathname.endsWith('/oauth/access_token') && parsed.searchParams.get('grant_type') === 'fb_exchange_token') {
      return new Response(JSON.stringify({ access_token: `long-user-token-${facebookTokenGeneration}`, expires_in: 5184000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (parsed.pathname.endsWith('/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: `short-user-token-${facebookTokenGeneration}`, expires_in: 3600, scope: 'pages_show_list,pages_read_engagement,pages_manage_posts' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (parsed.pathname.endsWith('/me/accounts')) {
      assert.equal(options.headers.Authorization, `Bearer long-user-token-${facebookTokenGeneration}`);
      assert.equal(parsed.searchParams.has('access_token'), false);
      if (parsed.searchParams.get('after')) return new Response(JSON.stringify({ data: facebookPages.slice(2) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ data: facebookPages.slice(0, 2), paging: { next: 'https://graph.facebook.com/next-page', cursors: { after: 'cursor-page-two' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected mocked Facebook OAuth request.');
  };
  try {
    const state = startUrls.facebook.searchParams.get('state');
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state: 'invalid-facebook-state', code: 'unused' }).expect(400);
    await other.agent.get('/api/social-accounts/oauth/callback').query({ state, code: 'cross-user-code' }).expect(400);
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state, code: 'facebook-test-code' }).expect(302).expect('Location', /social=connected&platform=facebook/);
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state, code: 'replayed-code' }).expect(400);
  } finally { socialOAuth.fetcher = previousSocialFetcher; }
  const facebookAccounts = (await owner.agent.get('/api/social-accounts').expect(200)).body.accounts.filter((item) => item.platform === 'facebook');
  assert.equal(facebookAccounts.length, 3, 'all Pages across Graph API cursor pages are stored');
  assert.deepEqual(facebookAccounts.map((item) => item.accountName).sort(), ['First Test Page', 'Second Test Page', 'Third Test Page']);
  assert.equal(facebookAccounts.find((item) => item.accountName === 'First Test Page').profileImage, 'https://images.example.test/page-one.jpg');
  assert.equal(JSON.stringify(facebookAccounts).includes('page-token-one'), false);
  assert.ok(facebookGraphRequests.every(({ url }) => url.searchParams.has('fields') || !url.pathname.endsWith('/me/accounts')));
  const firstFacebook = facebookAccounts.find((item) => item.accountName === 'First Test Page');
  const firstFacebookRecord = socialStore.getSocialAccount(owner.user.id, firstFacebook.id);
  assert.ok(firstFacebookRecord.encrypted_tokens);
  assert.equal(firstFacebookRecord.encrypted_tokens.includes('page-token-one'), false);
  assert.equal(decryptTokens(firstFacebookRecord.encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).access_token, 'page-token-one');
  assert.equal((await other.agent.get('/api/social-accounts').expect(200)).body.accounts.some((item) => item.platform === 'facebook'), false);

  const reconnectStart = await owner.agent.get('/api/social-accounts/facebook/oauth/start').expect(200);
  facebookTokenGeneration = 2;
  const previousReconnectFetcher = socialOAuth.fetcher;
  socialOAuth.fetcher = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/oauth/access_token') && parsed.searchParams.get('grant_type') === 'fb_exchange_token') return new Response(JSON.stringify({ access_token: 'long-user-token-reconnect', expires_in: 5184000 }), { status: 200 });
    if (parsed.pathname.endsWith('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'short-user-token-reconnect', expires_in: 3600, scope: 'pages_show_list,pages_read_engagement,pages_manage_posts' }), { status: 200 });
    if (parsed.pathname.endsWith('/me/accounts')) return new Response(JSON.stringify({ data: facebookPages }), { status: 200 });
    throw new Error('Unexpected mocked Facebook reconnect request.');
  };
  try {
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state: new URL(reconnectStart.body.authorizationUrl).searchParams.get('state'), code: 'facebook-reconnect-code' }).expect(302);
  } finally { socialOAuth.fetcher = previousReconnectFetcher; }
  const reconnectedFacebook = (await owner.agent.get('/api/social-accounts').expect(200)).body.accounts.filter((item) => item.platform === 'facebook');
  assert.equal(reconnectedFacebook.length, 3, 'reconnecting updates existing Page rows instead of creating duplicates');
  assert.equal(socialStore.getSocialAccount(owner.user.id, firstFacebook.id).id, firstFacebook.id);
  assert.equal(decryptTokens(socialStore.getSocialAccount(owner.user.id, firstFacebook.id).encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).access_token, 'page-token-one');

  const deniedStart = await owner.agent.get('/api/social-accounts/facebook/oauth/start').expect(200);
  const deniedState = new URL(deniedStart.body.authorizationUrl).searchParams.get('state');
  const previousDeniedFetcher = socialOAuth.fetcher;
  socialOAuth.fetcher = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/oauth/access_token') && parsed.searchParams.get('grant_type') === 'fb_exchange_token') return new Response(JSON.stringify({ access_token: 'long-user-token', expires_in: 5184000 }), { status: 200 });
    if (parsed.pathname.endsWith('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'short-user-token', expires_in: 3600 }), { status: 200 });
    if (parsed.pathname.endsWith('/me/accounts')) return new Response(JSON.stringify({ error: { message: 'Permission denied', type: 'OAuthException', code: 200 } }), { status: 400 });
    throw new Error('Unexpected mocked Facebook permissions request.');
  };
  try {
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state: deniedState, code: 'facebook-permission-denied-code' })
      .expect(302).expect('Location', /social=failed&platform=facebook&reason=permissions/);
  } finally { socialOAuth.fetcher = previousDeniedFetcher; }
  assert.equal((await owner.agent.get('/api/social-accounts').expect(200)).body.accounts.filter((item) => item.platform === 'facebook').length, 3);

  socialOAuth.fetcher = async (url) => {
    if (String(url).includes('/oauth/v2/accessToken')) return new Response(JSON.stringify({ access_token: 'access-value-not-for-client', refresh_token: 'refresh-value-not-for-client', expires_in: 3600, scope: 'openid profile email w_member_social' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('/v2/userinfo')) return new Response(JSON.stringify({ sub: 'linkedin-subject-1', name: 'Example Publisher', email: 'publisher@example.test', picture: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error('Unexpected mocked OAuth request.');
  };
  try {
    const state = startUrls.linkedin.searchParams.get('state');
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state: 'wrong-state', code: 'unused' }).expect(400);
    await owner.agent.get('/api/social-accounts/oauth/callback').query({ state, code: 'one-time-test-code' }).expect(302).expect('Location', /social=connected/);
  } finally { socialOAuth.fetcher = previousSocialFetcher; }

  const accountResponse = await owner.agent.get('/api/social-accounts').expect(200);
  assert.equal(accountResponse.body.accounts.length, 4);
  const account = accountResponse.body.accounts.find((item) => item.platform === 'linkedin');
  assert.equal(account.platform, 'linkedin');
  assert.equal(account.connectionStatus, 'connected');
  assert.equal(JSON.stringify(accountResponse.body).includes('access-value-not-for-client'), false);
  assert.equal(JSON.stringify(accountResponse.body).includes('refresh-value-not-for-client'), false);
  const stored = socialStore.getSocialAccount(owner.user.id, account.id);
  assert.ok(stored.encrypted_tokens);
  assert.equal(stored.encrypted_tokens.includes('access-value-not-for-client'), false);
  assert.equal(decryptTokens(stored.encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).access_token, 'access-value-not-for-client');

  const expiringTokens = { ...decryptTokens(stored.encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY), expiry_date: Date.now() - 1000 };
  socialStore.updateSocialToken(owner.user.id, account.id, { encryptedTokens: encryptTokens(expiringTokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY), tokenExpiresAt: new Date(expiringTokens.expiry_date).toISOString(), scopes: stored.scopes });
  const previousRefreshFetcher = socialOAuth.fetcher;
  socialOAuth.fetcher = async () => new Response(JSON.stringify({ access_token: 'rotated-access-private', refresh_token: 'rotated-refresh-private', expires_in: 3600, scope: 'openid profile email w_member_social' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const refreshed = await socialOAuth.refreshAccountTokens(owner.user.id, account.id);
    assert.equal(refreshed.access_token, 'rotated-access-private');
    const refreshedRecord = socialStore.getSocialAccount(owner.user.id, account.id);
    assert.equal(refreshedRecord.encrypted_tokens.includes('rotated-access-private'), false);
    assert.equal(decryptTokens(refreshedRecord.encrypted_tokens, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).refresh_token, 'rotated-refresh-private');
  } finally { socialOAuth.fetcher = previousRefreshFetcher; }

  await other.agent.get('/api/social-accounts').expect(200).expect((response) => assert.deepEqual(response.body.accounts, []));
  await other.agent.post(`/api/social-accounts/${account.id}/set-default`).set('X-CSRF-Token', other.csrfToken).send({}).expect(404);
  await other.agent.post(`/api/social-accounts/${account.id}/disconnect`).set('X-CSRF-Token', other.csrfToken).send({}).expect(404);
  const otherAccount = socialStore.saveSocialAccount({
    userId: other.user.id, platform: 'youtube', platformUserId: 'test-channel-other-user',
    accountName: 'Other test channel', encryptedTokens: encryptTokens({ access_token: 'other-user-secret' }, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY),
    scopes: 'youtube.upload', providerData: { channelId: 'test-channel-other-user' }
  });
  await owner.agent.post(`/api/social-accounts/${otherAccount.id}/set-default`).set('X-CSRF-Token', owner.csrfToken).send({}).expect(404);
  await owner.agent.post(`/api/social-accounts/${otherAccount.id}/disconnect`).set('X-CSRF-Token', owner.csrfToken).send({}).expect(404);
  await owner.agent.post(`/api/social-accounts/${account.id}/set-default`).set('X-CSRF-Token', owner.csrfToken).send({}).expect(200);

  const previousAccountPublishingFlag = process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED;
  delete process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED;
  await owner.agent.post('/api/publishing/submit').set('X-CSRF-Token', owner.csrfToken)
    .field('caption', 'must not be sent to an unprepared workflow').field('socialAccountIds', JSON.stringify([account.id]))
    .field('idempotencyKey', 'disabled-workflow-key-01').expect(503);
  assert.deepEqual(socialStore.listPublishingRequests(owner.user.id), []);
  process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED = previousAccountPublishingFlag;

  const originalFetch = global.fetch;
  const webhookCalls = [];
  global.fetch = async (url, options) => {
    webhookCalls.push({ url, options });
    return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const base = { caption: 'Test caption', scheduleMode: 'now', platforms: 'linkedin', socialAccountIds: JSON.stringify([account.id]), idempotencyKey: 'social-request-key-001' };
    await other.agent.post('/api/publishing/submit').set('X-CSRF-Token', other.csrfToken).field('caption', 'forged').field('socialAccountIds', JSON.stringify([account.id])).field('idempotencyKey', 'foreign-request-key-001').expect(403);
    await owner.agent.post('/api/publishing/submit').set('X-CSRF-Token', owner.csrfToken).field('caption', 'forged').field('socialAccountIds', JSON.stringify([otherAccount.id])).field('idempotencyKey', 'foreign-request-key-002').expect(403);
    const accepted = await owner.agent.post('/api/publishing/submit').set('X-CSRF-Token', owner.csrfToken)
      .field('userId', other.user.id).field('caption', base.caption).field('scheduleMode', base.scheduleMode)
      .field('platforms', base.platforms).field('socialAccountIds', base.socialAccountIds).field('idempotencyKey', base.idempotencyKey).expect(200);
    const requestId = accepted.headers['x-alisha-publishing-request-id'];
    assert.ok(requestId);
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].url, process.env.N8N_WEBHOOK_URL);
    const form = webhookCalls[0].options.body;
    assert.equal(form.get('requestType'), 'publish');
    assert.equal(form.get('userId'), null);
    assert.equal(form.get('socialAccountIds'), null);
    assert.deepEqual(JSON.parse(form.get('accountTargets')), [{ accountId: account.id, platform: 'linkedin', platformUserId: 'linkedin-subject-1' }]);
    assert.equal(JSON.stringify([...form.entries()]).includes('access-value-not-for-client'), false);
    assert.equal(socialStore.getPublishingRequest(owner.user.id, requestId).status, 'processing');

    const duplicate = await owner.agent.post('/api/publishing/submit').set('X-CSRF-Token', owner.csrfToken)
      .field('caption', base.caption).field('scheduleMode', base.scheduleMode).field('platforms', base.platforms)
      .field('socialAccountIds', base.socialAccountIds).field('idempotencyKey', base.idempotencyKey).expect(200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.requestId, requestId);
    assert.equal(webhookCalls.length, 1, 'idempotent retry is not forwarded a second time');
    await other.agent.get('/api/publishing/requests').expect(200).expect((response) => assert.deepEqual(response.body.requests, []));
    await owner.agent.get('/api/publishing/requests').expect(200).expect((response) => assert.equal(response.body.requests.length, 1));

    await request(app).post('/api/internal/n8n/publishing-status').send({ requestId, status: 'published' }).expect(401);
    const callback = await request(app).post('/api/internal/n8n/publishing-status')
      .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
      .send({ requestId, status: 'published', targets: [{ accountId: account.id, status: 'published', platformPostId: 'provider-post-test' }] }).expect(200);
    assert.equal(callback.body.status, 'published');
    assert.equal(socialStore.getPublishingRequest(owner.user.id, requestId).targets[0].status, 'published');
  } finally { global.fetch = originalFetch; }

  await owner.agent.post(`/api/social-accounts/${account.id}/disconnect`).set('X-CSRF-Token', owner.csrfToken).send({}).expect(200);
  assert.equal(socialStore.getSocialAccount(owner.user.id, account.id).encrypted_tokens, null);
  assert.equal(socialStore.listSocialAccounts(owner.user.id).find((item) => item.id === account.id).connectionStatus, 'disconnected');

  const facebookAccount = socialStore.saveSocialAccount({
    userId: owner.user.id, platform: 'facebook', platformUserId: '1234567890123',
    accountName: 'Test Page', encryptedTokens: encryptTokens({ access_token: 'server-only-page-token' }, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY),
    scopes: 'pages_manage_posts', providerData: { pageId: '1234567890123' }
  });
  const otherFacebook = socialStore.saveSocialAccount({
    userId: other.user.id, platform: 'facebook', platformUserId: '9876543210123', accountName: 'Other Page',
    encryptedTokens: encryptTokens({ access_token: 'other-page-secret' }, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY), scopes: 'pages_manage_posts'
  });
  const makeRequest = ({ key, caption = 'A test post', media = null, scheduledAt = null }) => socialStore.createPublishingRequest({
    id: crypto.randomUUID(), userId: owner.user.id, idempotencyKey: key, status: scheduledAt ? 'scheduled' : 'processing',
    request: { caption, scheduleMode: scheduledAt ? 'scheduled' : 'now', mediaMimeType: media?.type, mediaFilename: media?.name },
    scheduledAt, targets: [{ accountId: facebookAccount.id, platform: 'facebook' }]
  }).request;
  const graphCalls = [];
  facebookPublisher.fetcher = async (url, options = {}) => {
    graphCalls.push({ url: String(url), options });
    if (String(url).includes('/facebook_video_3?fields=post_id')) return new Response(JSON.stringify({ post_id: 'facebook_video_post_3' }), { status: 200 });
    if (String(url).endsWith('/feed')) return new Response(JSON.stringify({ id: 'facebook_text_post_1' }), { status: 200 });
    if (String(url).endsWith('/photos')) return new Response(JSON.stringify({ id: 'facebook_photo_2', post_id: 'facebook_photo_post_2' }), { status: 200 });
    if (String(url).endsWith('/videos')) return new Response(JSON.stringify({ id: 'facebook_video_3' }), { status: 200 });
    throw new Error('Unexpected mocked Graph request');
  };

  await request(app).post('/api/internal/n8n/facebook-publish').field('requestId', 'unknown').field('accountId', facebookAccount.id).expect(401);
  const textRequest = makeRequest({ key: 'facebook-text-dispatch-001' });
  const enabledFlag = process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED;
  process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED = 'false';
  await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', textRequest.id).field('accountId', facebookAccount.id).expect(503);
  process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED = enabledFlag;
  await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', textRequest.id).field('accountId', otherFacebook.id).expect(404);
  const textPublish = await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', textRequest.id).field('accountId', facebookAccount.id).expect(200);
  assert.equal(textPublish.body.status, 'published');
  assert.equal(textPublish.body.postId, 'facebook_text_post_1');
  assert.equal(JSON.stringify(textPublish.body).includes('server-only-page-token'), false);
  assert.equal(graphCalls.at(-1).options.body.get('message'), 'A test post');
  assert.equal(graphCalls.at(-1).options.body.get('access_token'), 'server-only-page-token');
  const duplicatePublish = await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', textRequest.id).field('accountId', facebookAccount.id).expect(200);
  assert.equal(duplicatePublish.body.duplicate, true);
  assert.equal(graphCalls.length, 1);

  const imageRequest = makeRequest({ key: 'facebook-image-dispatch-01', media: { type: 'image/jpeg', name: 'sample.jpg' } });
  const imagePublish = await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', imageRequest.id).field('accountId', facebookAccount.id)
    .attach('mediaFile', Buffer.from('test-image-binary'), { filename: 'sample.jpg', contentType: 'image/jpeg' }).expect(200);
  assert.equal(imagePublish.body.postId, 'facebook_photo_post_2');
  assert.equal(graphCalls.at(-1).options.body.get('caption'), 'A test post');
  assert.equal(graphCalls.at(-1).options.body.get('source').type, 'image/jpeg');

  const videoRequest = makeRequest({ key: 'facebook-video-dispatch-01', media: { type: 'video/mp4', name: 'sample.mp4' } });
  const videoPublish = await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', videoRequest.id).field('accountId', facebookAccount.id)
    .attach('mediaFile', Buffer.from('test-video-binary'), { filename: 'sample.mp4', contentType: 'video/mp4' }).expect(200);
  assert.equal(videoPublish.body.postId, 'facebook_video_post_3');
  assert.equal(graphCalls.at(-2).options.body.get('description'), 'A test post');

  const dueScheduled = makeRequest({ key: 'facebook-scheduled-due-01', scheduledAt: new Date(Date.now() - 60000).toISOString() });
  const scheduledPublish = await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', dueScheduled.id).field('accountId', facebookAccount.id).expect(200);
  assert.equal(scheduledPublish.body.status, 'published');

  const retryRequest = makeRequest({ key: 'facebook-retry-definitive-01' });
  facebookPublisher.fetcher = async () => new Response(JSON.stringify({ error: { message: 'Permission denied', code: 200 } }), { status: 400 });
  await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', retryRequest.id).field('accountId', facebookAccount.id).expect(422);
  assert.equal(socialStore.getFacebookDispatch(retryRequest.id, facebookAccount.id).dispatchState, 'failed');
  facebookPublisher.fetcher = async () => new Response(JSON.stringify({ id: 'facebook_retry_post_4' }), { status: 200 });
  const retried = await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', retryRequest.id).field('accountId', facebookAccount.id).field('retry', 'true').expect(200);
  assert.equal(retried.body.postId, 'facebook_retry_post_4');

  const uncertainRequest = makeRequest({ key: 'facebook-uncertain-attempt-01' });
  let uncertainCalls = 0;
  facebookPublisher.fetcher = async () => { uncertainCalls += 1; throw new Error('simulated connection drop'); };
  await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', uncertainRequest.id).field('accountId', facebookAccount.id).expect(502);
  await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', uncertainRequest.id).field('accountId', facebookAccount.id).field('retry', 'true').expect(422);
  assert.equal(uncertainCalls, 1, 'an uncertain publish is never retried blindly');

  const futureScheduled = makeRequest({ key: 'facebook-scheduled-future-1', scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  await request(app).post('/api/internal/n8n/facebook-publish')
    .set('X-N8N-Callback-Secret', process.env.N8N_PUBLISHING_CALLBACK_SECRET)
    .field('requestId', futureScheduled.id).field('accountId', facebookAccount.id).expect(409);
  assert.equal(socialStore.getFacebookDispatch(futureScheduled.id, facebookAccount.id).dispatchState, 'ready');
});
