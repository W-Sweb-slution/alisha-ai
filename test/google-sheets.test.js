const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const databasePath = path.join(__dirname, '..', 'data', `google-test-${crypto.randomUUID()}.sqlite`);
process.env.AUTH_DB_PATH = databasePath;
process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/google/callback';
process.env.GOOGLE_SPREADSHEET_ID = 'test-spreadsheet-id';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.ALISHA_ADMIN_EMAIL = 'sheets-owner@example.com';
const request = require('supertest');
const { app, authStore, googleSheets } = require('../server');
const { decryptTokens } = require('../google-token-crypto');
const { SHEET_SCHEMAS, SHEETS_SCOPE } = require('../google-sheets');

function createFakeGoogle() {
  const tabs = new Set(['Sheet1']);
  const rowsBySheet = new Map();
  const observations = { oauthClientOptions: [], authUrlOptions: [], exchangedCodes: [], revokedTokens: [] };
  const sheetTitle = (range) => range.match(/^'([^']+)'!/)?.[1] || range.split('!')[0];
  class FakeOAuth2 {
    constructor(clientId, clientSecret, redirectUri) { this.options = { clientId, clientSecret, redirectUri }; observations.oauthClientOptions.push(this.options); this.credentials = {}; }
    generateAuthUrl(options) { observations.authUrlOptions.push(options); return `https://accounts.google.test/auth?state=${options.state}`; }
    async getToken(code) {
      observations.exchangedCodes.push(code);
      return { tokens: { access_token: 'ACCESS_TOKEN_PRIVATE', refresh_token: 'REFRESH_TOKEN_PRIVATE', scope: `openid email profile ${SHEETS_SCOPE}`, expiry_date: Date.now() + 3600000 } };
    }
    setCredentials(tokens) { this.credentials = { ...this.credentials, ...tokens }; }
    on() {}
    async revokeToken(token) { observations.revokedTokens.push(token); return { data: {} }; }
  }
  const values = {
    async batchGet({ ranges }) {
      return { data: { valueRanges: ranges.map((range) => ({ values: rowsBySheet.get(sheetTitle(range))?.slice(0, 1) || [] })) } };
    },
    async batchUpdate({ requestBody }) {
      for (const item of requestBody.data) rowsBySheet.set(sheetTitle(item.range), item.values);
      return { data: {} };
    },
    async get({ range }) { return { data: { values: rowsBySheet.get(sheetTitle(range)) || [] } }; },
    async append({ range, requestBody }) {
      const title = sheetTitle(range), rows = rowsBySheet.get(title) || [];
      rows.push(...requestBody.values); rowsBySheet.set(title, rows);
      return { data: { updates: { updatedRows: requestBody.values.length } } };
    },
    async update({ range, requestBody }) {
      const title = sheetTitle(range), rows = rowsBySheet.get(title) || [];
      const rowNumber = Number(range.match(/A(\d+):/)?.[1]);
      rows[rowNumber - 1] = requestBody.values[0]; rowsBySheet.set(title, rows);
      return { data: {} };
    },
    async batchClear({ requestBody }) {
      for (const range of requestBody.ranges) {
        const title = sheetTitle(range), rows = rowsBySheet.get(title) || [];
        const rowNumber = Number(range.match(/A(\d+):/)?.[1]);
        if (rowNumber > 1) rows[rowNumber - 1] = [];
        rowsBySheet.set(title, rows);
      }
      return { data: {} };
    }
  };
  return {
    observations, rowsBySheet,
    auth: { OAuth2: FakeOAuth2 },
    oauth2: () => ({ userinfo: { get: async () => ({ data: { email: 'google-database@example.com' } }) } }),
    sheets: () => ({ spreadsheets: {
      get: async () => ({ data: { sheets: [...tabs].map((title) => ({ properties: { title } })) } }),
      batchUpdate: async ({ requestBody }) => { requestBody.requests.forEach((request) => tabs.add(request.addSheet.properties.title)); return { data: {} }; },
      values
    } })
  };
}

test('Google OAuth, encrypted token storage, sheet setup, and user row isolation', async (t) => {
  await authStore.ready;
  t.after(() => {
    try { authStore.database.close(); } catch {}
    try { fs.rmSync(databasePath, { force: true }); } catch {}
    try { fs.rmSync(`${databasePath}.${process.pid}.tmp`, { force: true }); } catch {}
  });
  const fakeGoogle = createFakeGoogle();
  googleSheets.google = fakeGoogle;
  const owner = request.agent(app);
  const csrf = (await owner.get('/api/csrf').expect(200)).body.csrfToken;
  const registration = await owner.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ fullName: 'Sheets Owner', email: 'sheets-owner@example.com', password: 'GooglePass123!', confirmPassword: 'GooglePass123!' }).expect(201);
  const ownerId = registration.body.user.id;
  const other = request.agent(app);
  const otherCsrf = (await other.get('/api/csrf').expect(200)).body.csrfToken;
  const secondRegistration = await other.post('/api/auth/register').set('X-CSRF-Token', otherCsrf).send({ fullName: 'Other Owner', email: 'other-owner@example.com', password: 'GooglePass123!', confirmPassword: 'GooglePass123!' }).expect(201);
  const otherId = secondRegistration.body.user.id;

  await request(app).get('/api/google/status').expect(401);
  delete process.env.ALISHA_ADMIN_EMAIL;
  await owner.get('/api/google/status').expect(503);
  await other.get('/api/google/connect').expect(503);
  process.env.ALISHA_ADMIN_EMAIL = 'sheets-owner@example.com';
  await other.get('/api/google/status').expect(403);
  await other.get('/api/google/connect').expect(403);
  await other.post('/api/google/sheets/initialize').set('X-CSRF-Token', secondRegistration.body.csrfToken).expect(403);
  await other.post('/api/google/disconnect').set('X-CSRF-Token', secondRegistration.body.csrfToken).expect(403);
  assert.equal((await owner.get('/api/config').expect(200)).body.isGoogleAdmin, true);
  assert.equal((await other.get('/api/config').expect(200)).body.isGoogleAdmin, false);

  // A legacy per-user encrypted connection for the configured administrator is copied to
  // application-level storage on first access; the old row is retained for safe migration.
  googleSheets.saveTokens(ownerId, { access_token: 'LEGACY_ACCESS', refresh_token: 'LEGACY_REFRESH', scope: `openid email profile ${SHEETS_SCOPE}` }, 'google-database@example.com');
  const initialStatus = await owner.get('/api/google/status').expect(200);
  assert.equal(initialStatus.body.configured, true);
  assert.equal(initialStatus.body.connected, true);
  assert.equal(initialStatus.body.email, 'google-database@example.com');
  assert.equal(authStore.getGoogleConnection(ownerId).google_email, 'google-database@example.com', 'legacy credential record remains intact');
  assert.equal(authStore.getCentralGoogleConnection(process.env.ALISHA_ADMIN_EMAIL).google_email, 'google-database@example.com', 'legacy developer connection is migrated to central storage');
  assert.doesNotMatch(authStore.getCentralGoogleConnection(process.env.ALISHA_ADMIN_EMAIL).encrypted_tokens, /LEGACY_ACCESS|LEGACY_REFRESH/);

  // The unfinished platform OAuth service is deliberately independent of Google Sheets OAuth.
  const socialStatus = await owner.get('/api/social-accounts').expect(200);
  assert.deepEqual(socialStatus.body.accounts, []);
  const googleWhileSocialUnavailable = await owner.get('/api/google/connect').expect(200);
  assert.match(googleWhileSocialUnavailable.body.authorizationUrl, /^https:\/\/accounts\.google\.test\/auth\?/);

  const invalidAttempt = await owner.get('/api/google/connect').expect(200);
  const invalidState = new URL(invalidAttempt.body.authorizationUrl).searchParams.get('state');
  await owner.get('/api/google/callback').query({ state: 'wrong-state', code: 'ignored' }).expect(400);
  assert.equal(fakeGoogle.observations.exchangedCodes.length, 0, 'a state mismatch must not exchange the authorization code');

  const connect = await owner.get('/api/google/connect').expect(200);
  const state = new URL(connect.body.authorizationUrl).searchParams.get('state');
  assert.ok(state && state.length >= 32);
  const authOptions = fakeGoogle.observations.authUrlOptions.at(-1);
  assert.equal(fakeGoogle.observations.oauthClientOptions.at(-1).redirectUri, 'http://localhost:3000/api/google/callback');
  assert.equal(authOptions.access_type, 'offline');
  assert.ok(authOptions.scope.includes(SHEETS_SCOPE));
  assert.equal(authOptions.state, state);
  await owner.get('/api/google/callback').query({ state, code: 'valid-test-code' }).expect(302).expect('Location', '/connect-accounts?google=connected');
  assert.deepEqual(fakeGoogle.observations.exchangedCodes, ['valid-test-code']);
  await owner.get('/api/google/callback').query({ state, code: 'replayed-code' }).expect(400);
  assert.deepEqual(fakeGoogle.observations.exchangedCodes, ['valid-test-code'], 'OAuth state is single use');

  const connection = authStore.getCentralGoogleConnection(process.env.ALISHA_ADMIN_EMAIL);
  assert.ok(connection);
  assert.equal(connection.google_email, 'google-database@example.com');
  assert.equal(connection.sheets_ready, 1);
  assert.doesNotMatch(connection.encrypted_tokens, /ACCESS_TOKEN_PRIVATE|REFRESH_TOKEN_PRIVATE/);
  assert.deepEqual(decryptTokens(connection.encrypted_tokens).refresh_token, 'REFRESH_TOKEN_PRIVATE');
  const status = await owner.get('/api/google/status').expect(200);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.sheetsReady, true);
  assert.equal(JSON.stringify(status.body).includes('TOKEN_PRIVATE'), false);
  assert.throws(() => googleSheets.saveCentralTokens({ access_token: 'OTHER_ACCESS', scope: `openid email profile ${SHEETS_SCOPE}` }, 'different-google@example.com'), /refresh token/);
  assert.equal(authStore.getCentralGoogleConnection(process.env.ALISHA_ADMIN_EMAIL).google_email, 'google-database@example.com', 'a different Google account cannot inherit the previous account refresh token');
  for (const [sheetName, headers] of Object.entries(SHEET_SCHEMAS)) {
    assert.deepEqual(fakeGoogle.rowsBySheet.get(sheetName)[0], headers);
    assert.ok(headers.includes('userId'));
  }

  const originalFetch = global.fetch;
  const chatForwarded = [];
  global.fetch = async (url, options) => {
    chatForwarded.push({ url, options });
    return new Response(JSON.stringify({ output: 'Persisted ALISA answer' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const chatPayload = { chatInput: 'Save this message', sessionId: 'conversation-sheets-test', userId: otherId, attachments: [{ name: 'photo.jpg', type: 'image/jpeg', size: 3, data: 'data:image/jpeg;base64,YWJj' }] };
    await owner.post('/api/chat').set('X-CSRF-Token', registration.body.csrfToken).set('X-Message-Idempotency-Key', 'stable-message-key-001').send(chatPayload).expect(200);
    assert.deepEqual(JSON.parse(chatForwarded[0].options.body), chatPayload, 'the original chat payload including attachment data is forwarded unchanged');
    let saved = await googleSheets.readUserRows(ownerId, 'Conversations');
    let conversationRows = saved.filter((row) => row.conversationId === 'conversation-sheets-test');
    assert.deepEqual(conversationRows.map((row) => [row.role, row.content]), [['user', 'Save this message'], ['assistant', 'Persisted ALISA answer']]);
    assert.ok(conversationRows.every((row) => row.userId === ownerId && row.sessionId === 'conversation-sheets-test' && !Number.isNaN(Date.parse(row.createdAt))));
    const userMetadata = JSON.parse(conversationRows[0].metadataJson);
    assert.equal(userMetadata.attachments[0].name, 'photo.jpg');
    assert.equal(userMetadata.attachments[0].size, 3);
    assert.equal(JSON.stringify(conversationRows).includes('YWJj'), false, 'attachment binary data is not copied into the sheet');

    await owner.post('/api/chat').set('X-CSRF-Token', registration.body.csrfToken).set('X-Message-Idempotency-Key', 'stable-message-key-001').send(chatPayload).expect(200);
    saved = await googleSheets.readUserRows(ownerId, 'Conversations');
    assert.equal(saved.filter((row) => row.conversationId === 'conversation-sheets-test').length, 2, 'retries with the same idempotency key do not duplicate either role');

    const appendConversationMessage = googleSheets.appendConversationMessage;
    try {
      googleSheets.appendConversationMessage = async () => { throw new Error('simulated Sheets outage'); };
      await owner.post('/api/chat').set('X-CSRF-Token', registration.body.csrfToken).send({ chatInput: 'Chat remains available', sessionId: 'conversation-sheets-outage', attachments: [] }).expect(200);
    } finally { googleSheets.appendConversationMessage = appendConversationMessage; }
  } finally { global.fetch = originalFetch; }

  const refreshed = googleSheets.saveCentralTokens({ access_token: 'ACCESS_TOKEN_REFRESHED', scope: `openid email profile ${SHEETS_SCOPE}` }, 'google-database@example.com');
  assert.equal(refreshed.refresh_token, 'REFRESH_TOKEN_PRIVATE', 'refresh token is retained when Google omits it from subsequent token refreshes');
  assert.equal(authStore.getGoogleConnection(otherId), null, 'regular users do not get separate Google connections');
  await googleSheets.appendUserRow(ownerId, 'Conversations', { conversationId: 'owner-conversation', sessionId: 'owner-session', role: 'user', content: 'owner row' });
  await googleSheets.appendUserRow(otherId, 'Conversations', { conversationId: 'other-conversation', sessionId: 'other-session', role: 'user', content: 'other row' });
  const sharedTableRecords = {
    SocialAccounts: { accountId: 'account-one', platform: 'facebook' },
    PublishingRequests: { requestId: 'request-one', platform: 'facebook' },
    ScheduledPosts: { scheduledPostId: 'scheduled-one', platform: 'facebook' },
    UserSettings: { settingKey: 'theme', settingValue: 'dark' }
  };
  for (const [sheet, record] of Object.entries(sharedTableRecords)) {
    const key = Object.keys(record)[0];
    const ownerRecord = { ...record, [key]: `${record[key]}-owner` };
    const otherRecord = { ...record, [key]: `${record[key]}-other` };
    await googleSheets.appendUserRow(ownerId, sheet, ownerRecord);
    await googleSheets.appendUserRow(otherId, sheet, otherRecord);
    assert.equal((await googleSheets.readUserRows(ownerId, sheet)).length, 1, `${sheet} reads must exclude other users`);
    assert.equal(await googleSheets.updateUserRow(ownerId, sheet, key, otherRecord[key], { platform: 'modified' }), null, `${sheet} updates must exclude other users`);
    assert.equal(await googleSheets.deleteUserRow(ownerId, sheet, key, otherRecord[key]), false, `${sheet} deletes must exclude other users`);
    assert.equal(await googleSheets.deleteUserRow(otherId, sheet, key, otherRecord[key]), true, `${sheet} owner may delete their own row`);
  }
  const ownerRows = await googleSheets.readUserRows(ownerId, 'Conversations');
  const otherRows = await googleSheets.readUserRows(otherId, 'Conversations');
  assert.deepEqual(ownerRows.filter((row) => row.conversationId === 'owner-conversation').map((row) => row.conversationId), ['owner-conversation']);
  assert.deepEqual(otherRows.map((row) => row.conversationId), ['other-conversation']);
  assert.equal(ownerRows.find((row) => row.conversationId === 'owner-conversation').userId, ownerId);
  await assert.rejects(() => googleSheets.appendUserRow(ownerId, 'Conversations', { userId: otherId, conversationId: 'forged' }), /different user/);
  await assert.rejects(() => googleSheets.appendUserRow(ownerId, 'Conversations', { refresh_token: 'never-in-sheets' }), /never be stored/);
  await assert.rejects(() => googleSheets.appendUserRow(ownerId, 'UserSettings', { settingKey: 'social_access_token', settingValue: 'secret' }), /not allowed/);
  await assert.rejects(() => googleSheets.appendUserRow(ownerId, 'Conversations', { content: 'refresh_token=SECRET_VALUE' }), /Credential-like/);
  assert.equal(await googleSheets.updateUserRow(ownerId, 'Conversations', 'conversationId', 'other-conversation', { content: 'must not update' }), null);
  assert.equal(await googleSheets.deleteUserRow(ownerId, 'Conversations', 'conversationId', 'other-conversation'), false, 'a user cannot delete another user\'s row');
  assert.equal(await googleSheets.deleteUserRow(otherId, 'Conversations', 'conversationId', 'other-conversation'), true);

  // A regular user has no Google OAuth connection of their own, but still writes rows
  // through the central account with ownership derived from the authenticated session.
  const priorFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ output: 'Central account answer' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    await other.post('/api/chat').set('X-CSRF-Token', secondRegistration.body.csrfToken).send({ chatInput: 'Regular user works', sessionId: 'other-central-conversation' }).expect(200);
  } finally { global.fetch = priorFetch; }
  assert.equal(authStore.getGoogleConnection(otherId), null, 'regular users do not need per-user Google connections');
  const otherConversation = await googleSheets.readUserRows(otherId, 'Conversations');
  assert.ok(otherConversation.some((row) => row.conversationId === 'other-central-conversation' && row.role === 'user'));
  assert.ok(otherConversation.every((row) => row.userId === otherId));

  const disconnectToken = registration.body.csrfToken;
  await owner.post('/api/google/disconnect').set('X-CSRF-Token', disconnectToken).expect(200).expect(({ body }) => assert.equal(body.disconnected, true));
  assert.equal(authStore.getCentralGoogleConnection(process.env.ALISHA_ADMIN_EMAIL), null);
  assert.ok(authStore.getGoogleConnection(ownerId), 'disconnecting the central connection does not delete the preserved legacy SQLite row');
  assert.equal(fakeGoogle.observations.revokedTokens.at(-1), 'REFRESH_TOKEN_PRIVATE');
});
