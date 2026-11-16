const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const argon2 = require('argon2');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');
const { AuthStore } = require('./auth-store');
const { GoogleSheetsIntegration } = require('./google-sheets');
const { SocialStore } = require('./social-store');
const { SocialOAuthService, PLATFORMS, configByPlatform } = require('./social-oauth');
const { FacebookPublisher } = require('./facebook-publisher');
const { oauthDiagnostic } = require('./oauth-diagnostics');
const { deploymentConfig } = require('./deployment-config');
const { google } = require('googleapis');
dotenv.config();
const projectEnvPath = path.join(__dirname, '.env');
if (process.env.NODE_ENV !== 'production' && fs.existsSync(projectEnvPath)) {
  const projectEnv = dotenv.parse(fs.readFileSync(projectEnvPath));
  if (projectEnv.ALISA_CHAT_WEBHOOK) process.env.ALISA_CHAT_WEBHOOK = projectEnv.ALISA_CHAT_WEBHOOK;
}

const app = express();
const deployment = deploymentConfig();
const port = deployment.port;
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters.');
}
const authStore = new AuthStore(deployment.databasePath, { requireExisting: deployment.requireExisting });
const googleSheets = new GoogleSheetsIntegration({ authStore, googleClient: google });
const socialStore = new SocialStore(authStore);
const socialOAuth = new SocialOAuthService({ socialStore });
const facebookPublisher = new FacebookPublisher({ socialStore, socialOAuth });
const isProduction = deployment.isProduction;
app.set('trust proxy', deployment.trustProxy);
const chatWebhookUrl = () => process.env.ALISA_CHAT_WEBHOOK;
const publishingWebhookUrl = () => process.env.N8N_WEBHOOK_URL;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

async function forwardChatMessage(payload, fetcher = fetch) {
  const endpoint = chatWebhookUrl();
  if (!endpoint) {
    const error = new Error('ALISA_CHAT_WEBHOOK is not configured on the server.');
    error.status = 503;
    throw error;
  }
  return fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });
}

// Public readiness probe. No session, credentials or upstream API calls.
app.get('/healthz', (_req, res) => {
  let ready = false;
  try { ready = Boolean(authStore.database && authStore.queryOne('SELECT 1 AS ready')?.ready); } catch {}
  res.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
});
app.use(express.json({ limit: '250mb' }));
app.use(session({
  name: 'alisha.sid',
  secret: sessionSecret,
  store: authStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' }
}));

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many authentication attempts. Please wait and try again.' } });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordIsStrong = (password) => typeof password === 'string' && password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
const dummyPasswordHash = argon2.hash(crypto.randomBytes(32).toString('hex'), { type: argon2.argon2id });
const publicUser = (user) => ({ id: user.id, fullName: user.full_name, email: user.email_normalized, createdAt: user.created_at });
const saveSession = (req) => new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
const regenerateSession = (req) => new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
function csrfMatches(req) {
  const expected = req.session && req.session.csrfToken;
  const supplied = req.get('X-CSRF-Token');
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const left = Buffer.from(expected), right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function requireCsrf(req, res, next) {
  if (!csrfMatches(req)) return res.status(403).json({ error: 'Request security token is invalid or expired. Refresh the page and try again.' });
  next();
}
function requireApiAuth(req, res, next) {
  const user = req.session?.userId ? authStore.getUserById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = publicUser(user);
  next();
}
function isAlishaAdmin(user) {
  const configuredEmail = String(process.env.ALISHA_ADMIN_EMAIL || '').trim().toLowerCase();
  return Boolean(configuredEmail && user?.email && user.email.toLowerCase() === configuredEmail);
}
function requireGoogleAdmin(req, res, next) {
  if (!String(process.env.ALISHA_ADMIN_EMAIL || '').trim()) return res.status(503).json({ error: 'Central Google management is unavailable until ALISHA_ADMIN_EMAIL is configured on the server.' });
  if (!isAlishaAdmin(req.user)) return res.status(403).json({ error: 'Only the configured Alisha administrator can manage the central Google Sheets connection.' });
  next();
}
function requirePageAuth(req, res, next) {
  const user = req.session?.userId ? authStore.getUserById(req.session.userId) : null;
  if (!user) return res.redirect(302, '/login');
  req.user = publicUser(user);
  next();
}

app.get(['/login', '/register'], (req, res) => {
  if (req.session?.userId && authStore.getUserById(req.session.userId)) return res.redirect('/');
  res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'public', 'auth.html'));
});
app.get('/api/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.set('Cache-Control', 'no-store').json({ csrfToken: req.session.csrfToken });
});
app.get('/api/auth/me', requireApiAuth, (req, res) => res.set('Cache-Control', 'no-store').json({ user: req.user }));

app.post('/api/auth/register', authRateLimit, requireCsrf, async (req, res) => {
  const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  const confirmPassword = req.body?.confirmPassword;
  if (fullName.length < 2 || fullName.length > 100) return res.status(400).json({ error: 'Enter your full name (2–100 characters).' });
  if (email.length > 254 || !emailPattern.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!passwordIsStrong(password) || password.length > 1024) return res.status(400).json({ error: 'Password must be at least 10 characters and include uppercase, lowercase, a number, and a symbol.' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
  if (authStore.getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
  try {
    const user = authStore.createUser({ id: crypto.randomUUID(), fullName, email, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), createdAt: new Date().toISOString() });
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    await saveSession(req);
    res.status(201).json({ user: publicUser(user), csrfToken: req.session.csrfToken });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    console.error('Registration failed:', error.message);
    res.status(500).json({ error: 'Registration could not be completed. Please try again.' });
  }
});

app.post('/api/auth/login', authRateLimit, requireCsrf, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = emailPattern.test(email) ? authStore.getUserByEmail(email) : null;
  let valid = false;
  try { valid = await argon2.verify(user?.password_hash || await dummyPasswordHash, password); } catch { valid = false; }
  if (!valid) return res.status(401).json({ error: 'Email or password is incorrect.' });
  try {
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    await saveSession(req);
    res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
  } catch (error) {
    console.error('Login session setup failed:', error.message);
    res.status(500).json({ error: 'Login could not be completed. Please try again.' });
  }
});

app.post('/api/auth/logout', requireApiAuth, requireCsrf, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Logout could not be completed. Please try again.' });
    res.clearCookie('alisha.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    res.status(200).json({ ok: true });
  });
});

// Server-to-server delivery receipts from n8n. This uses a dedicated shared secret,
// not a browser session, and stores only status metadata (never provider tokens).
const n8nCallbackRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
function validateN8nPublishingSecret(req, res) {
  const configured = process.env.N8N_PUBLISHING_CALLBACK_SECRET;
  const supplied = req.get('X-N8N-Callback-Secret');
  if (typeof configured !== 'string' || configured.length < 32 || typeof supplied !== 'string') {
    res.status(401).json({ error: 'Publishing service authentication failed.' });
    return false;
  }
  const expectedBytes = Buffer.from(configured), suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
    res.status(401).json({ error: 'Publishing service authentication failed.' });
    return false;
  }
  return true;
}
app.post('/api/internal/n8n/publishing-status', n8nCallbackRateLimit, (req, res) => {
  if (!validateN8nPublishingSecret(req, res)) return;
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
  const status = typeof req.body?.status === 'string' ? req.body.status : '';
  if (!requestId || !status) return res.status(400).json({ error: 'requestId and status are required.' });
  try {
    const result = socialStore.applyN8nStatus({ requestId, status, targets: Array.isArray(req.body.targets) ? req.body.targets : [], response: { received: true } });
    if (!result) return res.status(404).json({ error: 'Publishing request was not found.' });
    return res.json({ ok: true, requestId: result.id, status: result.status });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.status ? error.message : 'Publishing status could not be applied.' });
  }
});

// n8n calls this after its schedule Wait resumes. It supplies only request and
// account identifiers plus the original binary; Facebook tokens remain here.
app.post('/api/internal/n8n/facebook-publish', n8nCallbackRateLimit, (req, res, next) => {
  if (!validateN8nPublishingSecret(req, res)) return;
  if (process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED !== 'true') {
    res.status(503).json({ error: 'Account-aware Facebook publishing is disabled until end-to-end testing succeeds.' });
    return;
  }
  next();
}, upload.single('mediaFile'), async (req, res) => {
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId.trim() : '';
  if (!requestId || !accountId || requestId.length > 80 || accountId.length > 80) return res.status(400).json({ error: 'requestId and accountId are required.' });
  const dispatch = socialStore.getFacebookDispatch(requestId, accountId);
  if (!dispatch) return res.status(404).json({ error: 'Facebook target was not found for this publishing request.' });
  if (dispatch.connectionStatus !== 'connected' || !dispatch.encryptedTokens) return res.status(409).json({ error: 'The selected Facebook Page needs to be reconnected.' });
  const dueAt = dispatch.scheduledAt ? Date.parse(dispatch.scheduledAt) : NaN;
  if (Number.isFinite(dueAt) && dueAt > Date.now()) return res.status(409).json({ error: 'Scheduled post is not due yet. Invoke publishing after the n8n Wait node resumes.' });
  const storedMime = dispatch.request?.mediaMimeType;
  if (storedMime && !req.file) return res.status(400).json({ error: 'The scheduled media file was not provided by n8n.' });
  if (!storedMime && req.file) return res.status(400).json({ error: 'This publishing request was created without media.' });

  const claim = socialStore.claimFacebookDispatch(requestId, accountId, { retry: req.body?.retry === 'true' });
  if (claim.missing) return res.status(404).json({ error: 'Facebook target was not found for this publishing request.' });
  if (claim.duplicate) {
    if (claim.state === 'succeeded') return res.json({ requestId, accountId, status: 'published', ...claim.result, duplicate: true });
    const stateMessage = claim.state === 'uncertain'
      ? 'Facebook may have accepted the earlier request. Verify the Page before retrying to avoid a duplicate post.'
      : claim.state === 'running' ? 'This account target is already being published.' : 'The previous Facebook attempt failed. An explicit retry is required.';
    return res.status(claim.state === 'running' ? 409 : 422).json({ requestId, accountId, status: claim.state, error: stateMessage, result: claim.result || undefined });
  }

  try {
    const result = await facebookPublisher.publish({ dispatch, file: req.file || null });
    socialStore.finishFacebookDispatch(requestId, accountId, { state: 'succeeded', status: 'published', result });
    return res.status(200).json({ requestId, accountId, ...result });
  } catch (error) {
    const state = error.uncertain ? 'uncertain' : 'failed';
    const result = { error: error.providerError?.message || error.message, ...(error.providerError?.code ? { providerCode: error.providerError.code } : {}) };
    if (error.providerError?.code === 190) {
      const account = socialStore.getSocialAccount(dispatch.userId, dispatch.accountId);
      if (account?.encrypted_tokens) socialStore.updateSocialToken(dispatch.userId, dispatch.accountId, {
        encryptedTokens: account.encrypted_tokens, tokenExpiresAt: account.token_expires_at,
        scopes: account.scopes, connectionStatus: 'reauthorization_required'
      });
    }
    socialStore.finishFacebookDispatch(requestId, accountId, { state, status: 'failed', result });
    const statusCode = error.status || 502;
    return res.status(statusCode).json({ requestId, accountId, status: state, error: error.message, ...(error.providerError ? { provider: error.providerError } : {}) });
  }
});

app.get(['/','/index.html','/connect-accounts'], requirePageAuth, (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.set('Cache-Control', 'no-store').type('html').send(html.replace('__ALISHA_USER_ID__', req.user.id));
});

// All other API endpoints, including chat and multipart publishing, require a
// verified server-side account session and a synchronizer CSRF token.
app.use('/api', requireApiAuth, (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return requireCsrf(req, res, next);
  next();
});

const googleConnectRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
app.get('/api/google/status', requireGoogleAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store').json(googleSheets.getStatus());
});
app.get('/api/google/connect', requireGoogleAdmin, googleConnectRateLimit, async (req, res) => {
  if (!googleSheets.isConfigured()) return res.status(503).json({ error: 'Google Sheets OAuth is not configured on the server.' });
  try {
    const state = crypto.randomBytes(32).toString('hex');
    req.session.googleOAuthState = { state, issuedAt: Date.now(), userId: req.user.id };
    await saveSession(req);
    res.json({ authorizationUrl: googleSheets.getAuthorizationUrl(state) });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status === 503 ? error.message : 'Could not start Google authorization.' });
  }
});
app.get('/api/google/callback', requireGoogleAdmin, async (req, res) => {
  const pending = req.session.googleOAuthState;
  const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
  const expected = pending && typeof pending.state === 'string' ? pending.state : '';
  const validState = expected && returnedState && expected.length === returnedState.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(returnedState));
  const validAttempt = validState && pending.userId === req.user.id && Date.now() - pending.issuedAt <= 10 * 60 * 1000;
  delete req.session.googleOAuthState;
  await saveSession(req);
  if (!validAttempt) return res.status(400).send('Google authorization state validation failed. Restart the connection flow.');
  if (req.query.error) return res.redirect('/connect-accounts?google=cancelled');
  if (typeof req.query.code !== 'string' || !req.query.code) return res.redirect('/connect-accounts?google=failed');
  try {
    const { client, tokens } = await googleSheets.exchangeCode(req.query.code);
    const googleEmail = await googleSheets.getGoogleEmail(client);
    googleSheets.saveCentralTokens(tokens, googleEmail);
    try {
      await googleSheets.initializeSheets(req.user.id);
      return res.redirect('/connect-accounts?google=connected');
    } catch (error) {
      authStore.setCentralGoogleSheetsReady(false);
      console.error('Google Sheets initialization failed after authorization.');
      return res.redirect('/connect-accounts?google=sheets_error');
    }
  } catch (error) {
    console.error('Google OAuth callback failed.');
    return res.redirect('/connect-accounts?google=failed');
  }
});
app.post('/api/google/sheets/initialize', requireGoogleAdmin, async (req, res) => {
  try {
    const result = await googleSheets.initializeSheets(req.user.id);
    res.json({ ok: true, sheetNames: result.sheetNames });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.status ? error.message : 'Could not initialize the configured spreadsheet. Check that this Google account can edit it.' });
  }
});
app.post('/api/google/disconnect', requireGoogleAdmin, async (req, res) => {
  try {
    const disconnected = await googleSheets.revokeCentral();
    res.json({ ok: true, disconnected });
  } catch (error) {
    res.status(502).json({ error: 'Google could not revoke this connection. It remains connected; please retry.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ chatWebhookConfigured: Boolean(chatWebhookUrl()), publishingWebhookConfigured: Boolean(publishingWebhookUrl()), isGoogleAdmin: isAlishaAdmin(_req.user), environment: process.env.N8N_ENVIRONMENT || 'test' });
});

// Preserve ALISA's established Chat Trigger request shape.
app.post('/api/chat', async (req, res) => {
  const payload = req.body;
  const conversationId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const userMessage = typeof payload?.chatInput === 'string' ? payload.chatInput : '';
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.filter((item) => item && typeof item === 'object').map((item) => ({
    name: typeof item.name === 'string' ? item.name : '',
    type: typeof item.type === 'string' ? item.type : '',
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0
  })) : [];
  const suppliedKey = req.get('X-Message-Idempotency-Key');
  const idempotencyKey = typeof suppliedKey === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(suppliedKey) ? suppliedKey : crypto.randomUUID();
  const persistMessage = async (role, content, metadataAttachments = []) => {
    if (!conversationId) return;
    try {
      await googleSheets.appendConversationMessage(req.user.id, {
        conversationId,
        sessionId: conversationId,
        role,
        content,
        createdAt: new Date().toISOString(),
        idempotencyKey,
        attachments: metadataAttachments
      });
    } catch (error) {
      console.warn(`Conversation ${role} message could not be saved to Google Sheets: ${error.message}`);
    }
  };
  await persistMessage('user', userMessage, attachments);
  try {
    const upstream = await forwardChatMessage(payload);
    const body = await upstream.text();
    if (upstream.ok) {
      try {
        const responseData = JSON.parse(body);
        if (typeof responseData?.output === 'string') await persistMessage('assistant', responseData.output);
      } catch (error) {
        if (error instanceof SyntaxError) console.warn('Conversation assistant response was not JSON; skipping Sheets persistence.');
      }
    }
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'text/plain').send(body);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.status === 503 ? error.message : `Could not reach the n8n workflow: ${error.message}` });
  }
});

// Keep AutoPosting's multipart fields and original media binary intact.
app.post('/api/publish', upload.single('mediaFile'), async (req, res) => {
  const endpoint = publishingWebhookUrl();
  if (!endpoint) return res.status(503).json({ error: 'N8N_WEBHOOK_URL is not configured on the server.' });
  try {
    const form = new FormData();
    form.append('requestType', 'publish');
    for (const [key, value] of Object.entries(req.body)) form.append(key, value);
    if (req.file) {
      form.append('mediaFile', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    }
    const upstream = await fetch(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const body = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'text/plain').send(body);
  } catch (error) {
    res.status(502).json({ error: `Could not send the publishing request to n8n: ${error.message}` });
  }
});

app.get('/api/social-accounts', (req, res) => res.set('Cache-Control', 'no-store').json({ accounts: socialStore.listSocialAccounts(req.user.id) }));
async function recordSocialOAuthFailure(req, error, platform, reference) {
  const secrets = [req.query?.code, req.query?.state, ...Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|ENCRYPTION_KEY/.test(key)).map(([, value]) => value)];
  const diagnostic = oauthDiagnostic(error, platform, secrets);
  if (reference) diagnostic.reference = reference;
  req.session.socialOAuthDiagnostic = diagnostic;
  try { await saveSession(req); } catch { diagnostic.sessionSaveFailed = true; }
  console.error('Social OAuth failure:', JSON.stringify(diagnostic));
  return diagnostic;
}
app.get('/api/social-accounts/oauth/diagnostic', (req, res) => {
  const diagnostic = req.session.socialOAuthDiagnostic;
  res.set('Cache-Control', 'no-store').json({ diagnostic: diagnostic && Date.now() - diagnostic.createdAt < 15 * 60 * 1000 ? diagnostic : null });
});
app.get('/api/social-accounts/oauth/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const pendingStates = req.session.socialOAuthStates && typeof req.session.socialOAuthStates === 'object' ? req.session.socialOAuthStates : {};
  const entry = Object.entries(pendingStates).find(([key]) => {
    const a = Buffer.from(key), b = Buffer.from(state);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  const pending = entry?.[1];
  if (entry) delete pendingStates[entry[0]];
  req.session.socialOAuthStates = pendingStates;
  try { await saveSession(req); } catch { return res.status(500).send('Could not validate the social authorization response.'); }
  if (!pending || pending.userId !== req.user.id || Date.now() - pending.issuedAt > 10 * 60 * 1000 || !PLATFORMS.includes(pending.platform)) {
    return res.status(400).send('Social authorization state validation failed. Restart the connection flow.');
  }
  if (req.query.error) {
    const errorCode = typeof req.query.error === 'string' ? req.query.error : 'authorization_error';
    const diagnostic = await recordSocialOAuthFailure(req, { oauthStage: 'authorization', oauthErrorCode: errorCode, providerDescription: typeof req.query.error_description === 'string' ? req.query.error_description : 'Provider rejected authorization.', status: 400 }, pending.platform, pending.attemptId);
    const cancelled = ['access_denied', 'user_cancelled_authorize', 'user_cancelled_login'].includes(errorCode);
    return res.redirect(`/connect-accounts?social=${cancelled ? 'cancelled' : 'failed'}&platform=${encodeURIComponent(pending.platform)}&ref=${diagnostic.reference}`);
  }
  if (typeof req.query.code !== 'string' || !req.query.code) return res.redirect('/connect-accounts?social=failed');
  try {
    if (pending.redirectUri && pending.redirectUri !== socialOAuth.getConfig(pending.platform).redirectUri) {
      throw Object.assign(new Error('The configured redirect URI changed after authorization started. Start a new connection.'), { status: 409, oauthStage: 'configuration', oauthErrorCode: 'redirect_uri_changed' });
    }
    const result = await socialOAuth.connect(pending.platform, req.user.id, req.query.code, pending.verifier || undefined);
    return res.redirect(`/connect-accounts?social=connected&platform=${encodeURIComponent(pending.platform)}&added=${result.added}&updated=${result.updated}`);
  } catch (error) {
    const diagnostic = await recordSocialOAuthFailure(req, error, pending.platform, pending.attemptId);
    const reason = [10, 200, 299].includes(error.providerCode) ? 'permissions' : error.providerCode === 190 ? 'reauthorization' : 'provider';
    return res.redirect(`/connect-accounts?social=failed&platform=${encodeURIComponent(pending.platform)}&reason=${reason}&ref=${diagnostic.reference}`);
  }
});
app.get('/api/social-accounts/:platform/oauth/start', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unsupported social platform.' });
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = platform === 'youtube' ? crypto.randomBytes(48).toString('base64url') : null;
  try {
    const config = socialOAuth.getConfig(platform);
    const browserOrigin = req.get('X-Alisha-Origin');
    if (browserOrigin && browserOrigin !== new URL(config.redirectUri).origin) {
      return res.status(409).set('Cache-Control', 'no-store').json({ code: 'OAUTH_ORIGIN_MISMATCH', error: 'Open ALISHA and sign in using the same hostname as this platform’s configured callback URL, then start authorization again.' });
    }
    const authorizationUrl = socialOAuth.buildAuthorizationUrl(platform, state, verifier);
    const states = req.session.socialOAuthStates && typeof req.session.socialOAuthStates === 'object' ? req.session.socialOAuthStates : {};
    const now = Date.now();
    for (const [key, value] of Object.entries(states)) if (!value || now - value.issuedAt > 10 * 60 * 1000) delete states[key];
    const attemptId = crypto.randomUUID();
    states[state] = { platform, userId: req.user.id, verifier, issuedAt: now, attemptId, redirectUri: config.redirectUri };
    const stateKeys = Object.keys(states);
    while (stateKeys.length > 5) delete states[stateKeys.shift()];
    req.session.socialOAuthStates = states;
    delete req.session.socialOAuthDiagnostic;
    await saveSession(req);
    console.info('Social OAuth authorization started:', JSON.stringify({ platform, reference: attemptId }));
    res.set('Cache-Control', 'no-store').json({ authorizationUrl, platform, pkce: Boolean(config.pkce) });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status === 400 ? error.message : `OAuth is not configured for ${platform}.` });
  }
});
app.get('/api/social-accounts/:platform', (req, res) => {
  if (!PLATFORMS.includes(req.params.platform)) return res.status(400).json({ error: 'Unsupported social platform.' });
  const accounts = socialStore.listSocialAccounts(req.user.id).filter((account) => account.platform === req.params.platform);
  res.set('Cache-Control', 'no-store').json({ accounts });
});
app.post('/api/social-accounts/:id/disconnect', (req, res) => {
  const disconnected = socialStore.disconnectSocialAccount(req.user.id, req.params.id);
  if (!disconnected) return res.status(404).json({ error: 'Social account was not found.' });
  res.json({ ok: true, disconnected: true });
});
app.post('/api/social-accounts/:id/set-default', (req, res) => {
  const updated = socialStore.setDefaultSocialAccount(req.user.id, req.params.id);
  if (!updated) return res.status(404).json({ error: 'Connected social account was not found.' });
  res.json({ ok: true });
});
app.get('/api/publishing/requests', (req, res) => res.set('Cache-Control', 'no-store').json({ requests: socialStore.listPublishingRequests(req.user.id) }));

app.post('/api/publishing/submit', upload.single('mediaFile'), async (req, res) => {
  if (process.env.N8N_ACCOUNT_AWARE_PUBLISHING_ENABLED !== 'true') return res.status(503).json({ error: 'Account-aware publishing is disabled until the n8n workflow is configured for accountTargets and status callbacks.' });
  const endpoint = publishingWebhookUrl();
  if (!endpoint) return res.status(503).json({ error: 'N8N_WEBHOOK_URL is not configured on the server.' });
  let selectedIds = req.body?.socialAccountIds;
  if (typeof selectedIds === 'string') {
    try { selectedIds = JSON.parse(selectedIds); } catch { selectedIds = [selectedIds]; }
  }
  if (!Array.isArray(selectedIds)) selectedIds = selectedIds ? [selectedIds] : [];
  selectedIds = selectedIds.map((id) => String(id).trim()).filter(Boolean);
  if (!selectedIds.length || selectedIds.length > 20) return res.status(400).json({ error: 'Select between 1 and 20 connected social accounts.' });
  const accounts = socialStore.listSocialAccounts(req.user.id).filter((account) => selectedIds.includes(account.id) && account.connectionStatus === 'connected');
  if (accounts.length !== new Set(selectedIds).size) return res.status(403).json({ error: 'One or more selected social accounts are unavailable.' });

  const body = { ...req.body };
  delete body.userId;
  delete body.socialAccountIds;
  const mode = body.scheduleMode === 'scheduled' ? 'scheduled' : 'now';
  const scheduledAt = typeof body.scheduledAt === 'string' && body.scheduledAt ? body.scheduledAt : '';
  if (mode === 'scheduled' && (!Number.isFinite(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now())) return res.status(400).json({ error: 'A future scheduledAt time is required.' });
  if (typeof body.caption !== 'string' || !body.caption.trim()) return res.status(400).json({ error: 'A caption is required.' });
  const clientKey = req.get('Idempotency-Key') || body.idempotencyKey;
  if (clientKey !== undefined && (typeof clientKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(clientKey))) return res.status(400).json({ error: 'The publishing idempotency key has an invalid format.' });
  const idempotencyKey = clientKey || crypto.randomUUID();
  const publishingRequestId = crypto.randomUUID();
  const safeRequest = {
    ...body, scheduleMode: mode, scheduledAt,
    platforms: [...new Set(accounts.map((account) => account.platform))],
    ...(req.file ? { mediaMimeType: req.file.mimetype, mediaFilename: req.file.originalname, mediaSize: req.file.size } : {})
  };
  let created;
  try {
    created = socialStore.createPublishingRequest({
      id: publishingRequestId, userId: req.user.id, idempotencyKey, status: mode === 'scheduled' ? 'scheduled' : 'processing',
      request: safeRequest, scheduledAt, targets: accounts.map((account) => ({ accountId: account.id, platform: account.platform }))
    });
  } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  if (created.duplicate) return res.status(200).json({ requestId: created.request.id, status: created.request.status, duplicate: true });

  try {
    const form = new FormData();
    form.append('requestType', 'publish');
    form.append('publishingRequestId', publishingRequestId);
    form.append('accountTargets', JSON.stringify(accounts.map(({ id, platform, platformUserId }) => ({ accountId: id, platform, platformUserId }))));
    for (const [key, value] of Object.entries(body)) {
      if (key === 'userId' || key === 'socialAccountIds' || key === 'accountTargets') continue;
      if (Array.isArray(value)) value.forEach((item) => form.append(key, String(item)));
      else if (value !== undefined && value !== null) form.append(key, String(value));
    }
    if (req.file) form.append('mediaFile', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    const upstream = await fetch(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const responseBody = await upstream.text();
    const nextStatus = upstream.ok ? (mode === 'scheduled' ? 'scheduled' : 'processing') : 'failed';
    socialStore.updatePublishingRequest(req.user.id, publishingRequestId, { status: nextStatus, response: { httpStatus: upstream.status }, error: upstream.ok ? null : `Publishing workflow returned HTTP ${upstream.status}.` });
    res.set('X-Alisha-Publishing-Request-Id', publishingRequestId).status(upstream.status).type(upstream.headers.get('content-type') || 'text/plain').send(responseBody);
  } catch (error) {
    socialStore.updatePublishingRequest(req.user.id, publishingRequestId, { status: 'failed', error: 'Could not send the publishing request to the workflow.' });
    res.status(502).json({ error: 'Could not send the publishing request to n8n.', requestId: publishingRequestId });
  }
});

app.get('*', requirePageAuth, (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.set('Cache-Control', 'no-store').type('html').send(html.replace('__ALISHA_USER_ID__', req.user.id));
});

async function startServer(listenPort = port) {
  await authStore.ready;
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, deployment.host, () => {
      console.log(`ALISHA listening on ${deployment.host}:${server.address().port} · authentication enabled · chat endpoint ${chatWebhookUrl() ? 'configured' : 'not configured'}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}
async function runServer() {
  const server = await startServer();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    server.close(() => {
      try { authStore.persist(); authStore.database.close(); process.exitCode = 0; }
      catch { console.error('Database flush failed during shutdown.'); process.exitCode = 1; }
      clearTimeout(deadline);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}
if (require.main === module) runServer().catch((error) => { console.error('ALISHA startup failed:', error.message); process.exitCode = 1; });

module.exports = { app, startServer, runServer, authStore, googleSheets, socialStore, socialOAuth, facebookPublisher, forwardChatMessage, chatWebhookUrl, publishingWebhookUrl };
