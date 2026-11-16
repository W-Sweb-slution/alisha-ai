'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { deploymentConfig } = require('../deployment-config');
const { AuthStore } = require('../auth-store');
const { encryptTokens, decryptTokens } = require('../google-token-crypto');
const { installDatabase } = require('../scripts/install-database');
const { startMaintenanceServer } = require('../scripts/render-start');

test('Render configuration requires persistent path, secure cookies and explicit proxy trust', () => {
  const local = deploymentConfig({});
  assert.equal(local.port, 3000); assert.equal(local.trustProxy, 0); assert.equal(local.isProduction, false);
  const env = { RENDER: 'true', NODE_ENV: 'production', TRUST_PROXY: '1', AUTH_DB_PATH: path.resolve('data/fixture.sqlite'), PORT: '10000' };
  const config = deploymentConfig(env);
  assert.equal(config.host, '0.0.0.0'); assert.equal(config.requireExisting, true);
  assert.throws(() => deploymentConfig({ ...env, AUTH_DB_PATH: '' }), /AUTH_DB_PATH/);
  assert.throws(() => deploymentConfig({ ...env, TRUST_PROXY: '0' }), /TRUST_PROXY/);
  assert.throws(() => deploymentConfig({ ...env, NODE_ENV: '' }), /NODE_ENV/);
  assert.throws(() => deploymentConfig({ ...env, HOST: 'localhost' }), /0.0.0.0/);
});

test('Render startup, HTTPS sessions, safe database transfer and reopen preserve users and encrypted accounts', async (t) => {
  const directory = fs.mkdtempSync(path.join(__dirname, '..', 'data', 'deployment-test-'));
  const databasePath = path.join(directory, 'fixture.sqlite');
  const missing = path.join(directory, 'not-created', 'missing.sqlite');
  await assert.rejects(new AuthStore(missing, { requireExisting: true }).ready, /missing/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  const seed = new AuthStore(databasePath); await seed.ready; seed.database.close();
  process.env.AUTH_DB_PATH = databasePath;
  process.env.AUTH_DB_REQUIRE_EXISTING = 'true';
  process.env.NODE_ENV = 'production'; process.env.RENDER = 'true'; process.env.TRUST_PROXY = '1';
  process.env.PORT = '10000'; process.env.HOST = '0.0.0.0';
  process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const { app, authStore, socialStore, startServer } = require('../server');
  await authStore.ready;
  let live;
  t.after(async () => {
    if (live?.listening) await new Promise((resolve) => live.close(resolve));
    try { authStore.database.close(); } catch {}
    // Only remove the specifically created fixture files; never touch application data.
    for (const name of fs.readdirSync(directory)) if (fs.statSync(path.join(directory, name)).isFile()) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const health = await request(app).get('/healthz').expect(200);
  assert.deepEqual(health.body, { status: 'ok' }); assert.equal(health.headers['set-cookie'], undefined);
  const insecure = await request(app).get('/api/csrf').expect(200);
  assert.equal(insecure.headers['set-cookie'], undefined);
  const csrf = await request(app).get('/api/csrf').set('X-Forwarded-Proto', 'https').expect(200);
  assert.match(csrf.headers['set-cookie'][0], /Secure/); assert.match(csrf.headers['set-cookie'][0], /HttpOnly/); assert.match(csrf.headers['set-cookie'][0], /SameSite=Lax/);
  const cookie = (response) => response.headers['set-cookie'][0].split(';')[0];
  const registration = await request(app).post('/api/auth/register').set('X-Forwarded-Proto', 'https').set('Cookie', cookie(csrf)).set('X-CSRF-Token', csrf.body.csrfToken)
    .send({ fullName: 'Deployment Test', email: 'render-fixture@example.test', password: 'DeployTest123!', confirmPassword: 'DeployTest123!' }).expect(201);
  await request(app).get('/api/auth/me').set('X-Forwarded-Proto', 'https').set('Cookie', cookie(registration)).expect(200);
  const userId = registration.body.user.id;
  const account = socialStore.saveSocialAccount({ userId, platform: 'facebook', platformUserId: '123456789', accountName: 'Fixture Page', encryptedTokens: encryptTokens({ access_token: 'fixture-page-token' }, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY) });
  const signed = decodeURIComponent(cookie(registration).slice('alisha.sid='.length));
  const sid = require('cookie-signature').unsign(signed.slice(2), process.env.SESSION_SECRET);
  assert.ok(sid);
  live = await startServer(0);
  assert.equal(live.address().address, '0.0.0.0');
  await request(live).get('/healthz').expect(200);
  await new Promise((resolve) => live.close(resolve));
  authStore.database.close();

  const installedPath = path.join(directory, 'installed.sqlite');
  const bytes = fs.readFileSync(databasePath);
  await installDatabase(databasePath, installedPath);
  assert.deepEqual(fs.readFileSync(installedPath), bytes);
  await assert.rejects(installDatabase(databasePath, installedPath), /Refusing to overwrite/);
  assert.deepEqual(fs.readFileSync(installedPath), bytes);
  const reopened = new AuthStore(installedPath, { requireExisting: true }); await reopened.ready;
  assert.equal(reopened.getUserById(userId).email_normalized, 'render-fixture@example.test');
  const session = await new Promise((resolve, reject) => reopened.get(sid, (err, value) => err ? reject(err) : resolve(value)));
  assert.equal(session.userId, userId);
  const encrypted = reopened.queryOne('SELECT encrypted_tokens FROM social_accounts WHERE id = ?', [account.id]).encrypted_tokens;
  assert.equal(encrypted.includes('fixture-page-token'), false);
  assert.equal(decryptTokens(encrypted, process.env.SOCIAL_TOKEN_ENCRYPTION_KEY).access_token, 'fixture-page-token');
  reopened.database.close();

  const beforeMaintenance = fs.readFileSync(installedPath);
  live = await startMaintenanceServer(0);
  await request(live).get('/healthz').expect(200).expect({ status: 'maintenance' });
  await request(live).post('/api/auth/register').send({}).expect(503);
  await request(live).get('/api/social-accounts/youtube/oauth/start').expect(503);
  await new Promise((resolve) => live.close(resolve));
  assert.deepEqual(fs.readFileSync(installedPath), beforeMaintenance, 'maintenance does not open or change SQLite');
});
