const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const databasePath = path.join(__dirname, '..', 'data', `auth-test-${crypto.randomUUID()}.sqlite`);
process.env.AUTH_DB_PATH = databasePath;
process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
const request = require('supertest');
const { AuthStore } = require('../auth-store');
const { app, authStore, chatWebhookUrl } = require('../server');

test('registration, login, protected routes, chat/publish compatibility, and logout', async (t) => {
  await authStore.ready;
  t.after(() => {
    try { authStore.database.close(); } catch {}
    for (const suffix of ['', `.${process.pid}.tmp`]) try { fs.rmSync(databasePath + suffix, { force: true }); } catch {}
  });

  const anonymous = request.agent(app);
  await request(app).get('/register').expect(200).expect(/confirmPassword/);
  await request(app).get('/login').expect(200).expect(/data-toggle-password/);
  const loginPage = await anonymous.get('/').expect(302);
  assert.equal(loginPage.headers.location, '/login');
  await anonymous.get('/connect-accounts').expect(302).expect('Location', '/login');
  await anonymous.get('/api/config').expect(401);
  await anonymous.get('/api/google/status').expect(401);
  await anonymous.get('/api/google/connect').expect(401);
  await anonymous.get('/api/google/callback').expect(401);
  await anonymous.post('/api/google/sheets/initialize').expect(401);
  await anonymous.post('/api/google/disconnect').expect(401);
  await request(app).post('/api/chat').send({ chatInput: 'blocked' }).expect(401);
  await request(app).post('/api/publish').field('caption', 'blocked').expect(401);

  const csrfResponse = await anonymous.get('/api/csrf').expect(200);
  const registrationToken = csrfResponse.body.csrfToken;
  const anonymousCookie = csrfResponse.headers['set-cookie'].find((cookie) => cookie.startsWith('alisha.sid=')).split(';')[0];
  await anonymous.post('/api/auth/register').send({ fullName: 'Test User' }).expect(403);
  await anonymous.post('/api/auth/register').set('X-CSRF-Token', registrationToken).send({
    fullName: 'Test User', email: 'test@example.com', password: 'weak', confirmPassword: 'weak'
  }).expect(400);
  await anonymous.post('/api/auth/register').set('X-CSRF-Token', registrationToken).send({
    fullName: 'Test User', email: 'test@example.com', password: 'SecurePass123!', confirmPassword: 'DifferentPass123!'
  }).expect(400);
  await anonymous.post('/api/auth/register').set('X-CSRF-Token', registrationToken).send({
    fullName: 'Test User', email: 'not-an-email', password: 'SecurePass123!', confirmPassword: 'SecurePass123!'
  }).expect(400);
  const registration = await anonymous.post('/api/auth/register').set('X-CSRF-Token', registrationToken).send({
    fullName: 'Test User', email: 'TEST@example.com', password: 'SecurePass123!', confirmPassword: 'SecurePass123!'
  }).expect(201);
  assert.equal(registration.body.user.email, 'test@example.com');
  assert.equal(registration.body.password, undefined);
  assert.equal(registration.body.user.password_hash, undefined);
  const authenticatedCookie = registration.headers['set-cookie'].find((cookie) => cookie.startsWith('alisha.sid=')).split(';')[0];
  assert.notEqual(authenticatedCookie, anonymousCookie, 'registration regenerates the session identifier');
  assert.match(registration.headers['set-cookie'].find((cookie) => cookie.startsWith('alisha.sid=')), /HttpOnly/i);
  assert.match(registration.headers['set-cookie'].find((cookie) => cookie.startsWith('alisha.sid=')), /SameSite=Lax/i);
  const csrfToken = registration.body.csrfToken;
  assert.match(authStore.getUserByEmail('test@example.com').password_hash, /^\$argon2id\$/);

  await anonymous.post('/api/auth/register').set('X-CSRF-Token', csrfToken).send({
    fullName: 'Another User', email: 'test@EXAMPLE.com', password: 'SecurePass123!', confirmPassword: 'SecurePass123!'
  }).expect(409);

  const loginAgent = request.agent(app);
  const loginCsrfResponse = await loginAgent.get('/api/csrf').expect(200);
  const loginCsrf = loginCsrfResponse.body.csrfToken;
  const preLoginCookie = loginCsrfResponse.headers['set-cookie'].find((cookie) => cookie.startsWith('alisha.sid=')).split(';')[0];
  const invalidCredentials = await loginAgent.post('/api/auth/login').set('X-CSRF-Token', loginCsrf).send({ email: 'nobody@example.com', password: 'WrongPass123!' }).expect(401);
  assert.equal(invalidCredentials.body.error, 'Email or password is incorrect.');
  const invalidPassword = await loginAgent.post('/api/auth/login').set('X-CSRF-Token', loginCsrf).send({ email: 'test@example.com', password: 'WrongPass123!' }).expect(401);
  assert.equal(invalidPassword.body.error, invalidCredentials.body.error, 'credential errors do not disclose whether an email exists');
  const login = await loginAgent.post('/api/auth/login').set('X-CSRF-Token', loginCsrf).send({ email: 'TEST@example.com', password: 'SecurePass123!' }).expect(200);
  assert.equal(login.body.user.fullName, 'Test User');
  assert.equal(login.body.user.password_hash, undefined);
  const postLoginCookie = login.headers['set-cookie'].find((cookie) => cookie.startsWith('alisha.sid=')).split(';')[0];
  assert.notEqual(postLoginCookie, preLoginCookie, 'login regenerates the session identifier');
  await loginAgent.get('/api/auth/me').expect(200);
  assert.ok(authStore.queryOne('SELECT sid, expire FROM sessions WHERE expire > ?', [Date.now()]), 'session is stored persistently in SQLite');
  const reopenedStore = new AuthStore(databasePath);
  await reopenedStore.ready;
  assert.ok(reopenedStore.queryOne('SELECT sid FROM sessions WHERE expire > ?', [Date.now()]), 'session survives reopening the SQLite database');
  reopenedStore.database.close();
  const dashboard = await loginAgent.get('/').expect(200);
  await loginAgent.get('/connect-accounts').expect(200);
  assert.match(dashboard.text, /data-user-id="[0-9a-f-]+"/i);
  assert.doesNotMatch(dashboard.text, /__ALISHA_USER_ID__/);

  const originalFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push({ url, options });
    return new Response(JSON.stringify({ output: 'ALISA test response' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const chatBody = { chatInput: 'Test chat payload', sessionId: 'session-test', attachments: [{ name: 'test.jpg', type: 'image/jpeg', size: 4, data: 'data:image/jpeg;base64,MTIzNA==' }] };
    await loginAgent.post('/api/chat').send(chatBody).expect(403);
    const chat = await loginAgent.post('/api/chat').set('X-CSRF-Token', login.body.csrfToken).send(chatBody).expect(200);
    assert.equal(chat.body.output, 'ALISA test response');
    assert.equal(sent[0].url, chatWebhookUrl());
    assert.deepEqual(JSON.parse(sent[0].options.body), chatBody);

    await loginAgent.post('/api/publish').set('X-CSRF-Token', login.body.csrfToken)
      .field('postId', 'post-test').field('scheduleMode', 'scheduled').field('scheduledAt', '2030-01-01T10:00:00.000Z')
      .field('caption', 'Scheduled caption').field('platforms', 'facebook')
      .attach('mediaFile', Buffer.from('original-media'), { filename: 'test.jpg', contentType: 'image/jpeg' }).expect(200);
    const multipart = sent[1].options.body;
    assert.equal(multipart.get('requestType'), 'publish');
    assert.equal(multipart.get('postId'), 'post-test');
    assert.equal(multipart.get('scheduleMode'), 'scheduled');
    assert.equal(multipart.get('scheduledAt'), '2030-01-01T10:00:00.000Z');
    assert.equal(multipart.get('caption'), 'Scheduled caption');
    assert.equal(multipart.get('platforms'), 'facebook');
    assert.equal(Buffer.from(await multipart.get('mediaFile').arrayBuffer()).toString(), 'original-media');

    await loginAgent.post('/api/publish').set('X-CSRF-Token', login.body.csrfToken)
      .field('postId', 'post-now-test').field('scheduleMode', 'now').field('scheduledAt', '')
      .field('caption', 'Post now caption').field('platforms', 'youtube').expect(200);
    const postNow = sent[2].options.body;
    assert.equal(postNow.get('requestType'), 'publish');
    assert.equal(postNow.get('postId'), 'post-now-test');
    assert.equal(postNow.get('scheduleMode'), 'now');
    assert.equal(postNow.get('caption'), 'Post now caption');
    assert.equal(postNow.get('platforms'), 'youtube');
    assert.equal(postNow.get('mediaFile'), null);
  } finally { global.fetch = originalFetch; }

  await anonymous.post('/api/auth/logout').set('X-CSRF-Token', csrfToken).expect(200);
  await anonymous.get('/api/auth/me').expect(401);
  await anonymous.get('/').expect(302).expect('Location', '/login');
  await anonymous.post('/api/chat').send({ chatInput: 'after logout' }).expect(401);

  const secondUser = request.agent(app);
  const secondCsrf = (await secondUser.get('/api/csrf').expect(200)).body.csrfToken;
  await secondUser.post('/api/auth/register').set('X-CSRF-Token', secondCsrf).send({
    fullName: 'Second User', email: 'second@example.com', password: 'AnotherPass123!', confirmPassword: 'AnotherPass123!'
  }).expect(201);
  const firstWorkspace = await loginAgent.get('/').expect(200);
  const secondWorkspace = await secondUser.get('/').expect(200);
  const firstId = firstWorkspace.text.match(/data-user-id="([^"]+)"/)[1];
  const secondId = secondWorkspace.text.match(/data-user-id="([^"]+)"/)[1];
  assert.notEqual(firstId, secondId, 'each authenticated user receives a distinct server-derived browser namespace');
});
