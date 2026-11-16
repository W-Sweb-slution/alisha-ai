'use strict';

const { google } = require('googleapis');
const { encryptTokens, decryptTokens } = require('./google-token-crypto');

const SHEET_SCHEMAS = Object.freeze({
  Conversations: ['userId', 'conversationId', 'sessionId', 'role', 'content', 'createdAt', 'metadataJson'],
  SocialAccounts: ['userId', 'accountId', 'platform', 'platformUserId', 'accountName', 'accountUsername', 'profileImage', 'connectionStatus', 'isDefault', 'createdAt', 'updatedAt'],
  PublishingRequests: ['userId', 'requestId', 'socialAccountId', 'platform', 'mediaType', 'caption', 'mediaReference', 'publishingStatus', 'scheduledAt', 'createdAt'],
  ScheduledPosts: ['userId', 'scheduledPostId', 'requestId', 'socialAccountId', 'platform', 'mediaType', 'caption', 'mediaReference', 'scheduledAt', 'publishingStatus', 'createdAt', 'updatedAt'],
  UserSettings: ['userId', 'settingKey', 'settingValue', 'updatedAt']
});
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const OAUTH_SCOPES = ['openid', 'email', 'profile', SHEETS_SCOPE];
const secretKeyPattern = /password|passwd|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|oauth[ _-]?token|social[ _-]?token|authorization|api[ _-]?key/i;
const secretValuePattern = /(?:ya29\.[A-Za-z0-9_-]{16,}|1\/\/[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,}|-----BEGIN (?:RSA )?PRIVATE KEY-----|(?:access_token|refresh_token|client_secret|password)\s*[:=]\s*[^\s,]+)/i;

function rejectSecretMaterial(value, key = '') {
  if (secretKeyPattern.test(key)) throw new Error('Passwords, OAuth tokens, and credentials must never be stored in Google Sheets.');
  if (typeof value === 'string' && secretValuePattern.test(value)) throw new Error('Credential-like values must never be stored in Google Sheets.');
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) rejectSecretMaterial(childValue, childKey);
  }
}

class GoogleSheetsIntegration {
  constructor({ authStore, env = process.env, googleClient = google } = {}) {
    this.authStore = authStore;
    this.env = env;
    this.google = googleClient;
    this.conversationWriteQueues = new Map();
  }

  isConfigured() {
    return Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET && this.env.GOOGLE_REDIRECT_URI && this.env.GOOGLE_SPREADSHEET_ID && this.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  }

  createOAuthClient() {
    if (!this.isConfigured()) throw Object.assign(new Error('Google Sheets OAuth is not configured on the server.'), { status: 503 });
    return new this.google.auth.OAuth2(this.env.GOOGLE_CLIENT_ID, this.env.GOOGLE_CLIENT_SECRET, this.env.GOOGLE_REDIRECT_URI);
  }

  getAuthorizationUrl(state) {
    const client = this.createOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      state
    });
  }

  async exchangeCode(code) {
    const client = this.createOAuthClient();
    const result = await client.getToken(code);
    const tokens = result.tokens || result;
    client.setCredentials(tokens);
    return { client, tokens };
  }

  async getGoogleEmail(client) {
    const response = await this.google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    const email = response.data && response.data.email;
    if (!email) throw new Error('Google did not provide an email for the connected account.');
    return email;
  }

  saveTokens(userId, tokens, googleEmail) {
    if (!userId) throw new Error('A verified application user is required to store Google tokens.');
    const previous = this.authStore.getGoogleConnection(userId);
    const sameGoogleAccount = previous && googleEmail && previous.google_email.toLowerCase() === googleEmail.toLowerCase();
    const oldTokens = sameGoogleAccount ? decryptTokens(previous.encrypted_tokens, this.env.GOOGLE_TOKEN_ENCRYPTION_KEY) : {};
    const merged = { ...oldTokens, ...tokens };
    if (!tokens.refresh_token && sameGoogleAccount && oldTokens.refresh_token) merged.refresh_token = oldTokens.refresh_token;
    if (!merged.refresh_token) throw new Error('Google did not issue a refresh token. Reconnect and approve offline access.');
    const scopes = merged.scope || (sameGoogleAccount && previous.scopes) || '';
    if (!scopes.split(/\s+/).includes(SHEETS_SCOPE)) throw new Error('Google Sheets permission was not granted.');
    this.authStore.saveGoogleConnection({
      userId,
      encryptedTokens: encryptTokens(merged, this.env.GOOGLE_TOKEN_ENCRYPTION_KEY),
      googleEmail: googleEmail || (sameGoogleAccount && previous.google_email) || '',
      scopes,
      connectedAt: sameGoogleAccount ? previous.connected_at : new Date().toISOString(),
      sheetsReady: sameGoogleAccount ? Boolean(previous.sheets_ready) : false
    });
    return merged;
  }

  saveCentralTokens(tokens, googleEmail) {
    const previous = this.authStore.getCentralGoogleConnection(this.env.ALISHA_ADMIN_EMAIL);
    const sameGoogleAccount = previous && googleEmail && previous.google_email.toLowerCase() === googleEmail.toLowerCase();
    const oldTokens = sameGoogleAccount ? decryptTokens(previous.encrypted_tokens, this.env.GOOGLE_TOKEN_ENCRYPTION_KEY) : {};
    const merged = { ...oldTokens, ...tokens };
    if (!tokens.refresh_token && sameGoogleAccount && oldTokens.refresh_token) merged.refresh_token = oldTokens.refresh_token;
    if (!merged.refresh_token) throw new Error('Google did not issue a refresh token. Reconnect and approve offline access.');
    const scopes = merged.scope || (sameGoogleAccount && previous.scopes) || '';
    if (!scopes.split(/\s+/).includes(SHEETS_SCOPE)) throw new Error('Google Sheets permission was not granted.');
    this.authStore.saveCentralGoogleConnection({
      encryptedTokens: encryptTokens(merged, this.env.GOOGLE_TOKEN_ENCRYPTION_KEY),
      googleEmail: googleEmail || (sameGoogleAccount && previous.google_email) || '',
      scopes,
      connectedAt: sameGoogleAccount ? previous.connected_at : new Date().toISOString(),
      sheetsReady: sameGoogleAccount ? Boolean(previous.sheets_ready) : false
    });
    return merged;
  }

  async getAuthorizedClient(userId) {
    if (!userId) throw new Error('An authenticated application user is required to access database rows.');
    const record = this.authStore.getCentralGoogleConnection(this.env.ALISHA_ADMIN_EMAIL);
    if (!record) throw Object.assign(new Error('The central Google Sheets database is not connected by the administrator.'), { status: 409 });
    const tokens = decryptTokens(record.encrypted_tokens, this.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    const client = this.createOAuthClient();
    client.setCredentials(tokens);
    if (typeof client.on === 'function') {
      client.on('tokens', (freshTokens) => {
        try {
          const merged = this.saveCentralTokens(freshTokens, record.google_email);
          Object.assign(tokens, merged);
        } catch (error) { console.error('Could not persist refreshed Google tokens:', error.message); }
      });
    }
    return client;
  }

  getStatus() {
    const record = this.authStore.getCentralGoogleConnection(this.env.ALISHA_ADMIN_EMAIL);
    return {
      configured: this.isConfigured(),
      connected: Boolean(record),
      email: record ? record.google_email : null,
      sheetsReady: record ? Boolean(record.sheets_ready) : false,
      connectedAt: record ? record.connected_at : null
    };
  }

  async ensureInitialized(userId) {
    if (!this.getStatus().sheetsReady) await this.initializeSheets(userId);
  }

  async initializeSheets(userId) {
    const client = await this.getAuthorizedClient(userId);
    const sheetsApi = this.google.sheets({ version: 'v4', auth: client });
    const spreadsheetId = this.env.GOOGLE_SPREADSHEET_ID;
    const current = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    const present = new Set((current.data.sheets || []).map((sheet) => sheet.properties.title));
    const missing = Object.keys(SHEET_SCHEMAS).filter((title) => !present.has(title));
    if (missing.length) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }
      });
    }
    const titles = Object.keys(SHEET_SCHEMAS);
    const headers = await sheetsApi.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: titles.map((title) => `'${title}'!1:1`),
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const data = [];
    titles.forEach((title, index) => {
      const actual = headers.data.valueRanges?.[index]?.values?.[0] || [];
      const expected = SHEET_SCHEMAS[title];
      if (!actual.length) data.push({ range: `'${title}'!A1`, values: [expected] });
      else if (actual.length !== expected.length || actual.some((value, column) => value !== expected[column])) {
        throw new Error(`The ${title} sheet has headers that do not match Alisha's required schema.`);
      }
    });
    if (data.length) {
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data }
      });
    }
    this.authStore.setCentralGoogleSheetsReady(true);
    return { sheetNames: titles };
  }

  async readUserRows(userId, sheetName) {
    const schema = SHEET_SCHEMAS[sheetName];
    if (!schema) throw new Error('Unsupported Google Sheets table.');
    if (!userId) throw new Error('A verified application user is required.');
    await this.ensureInitialized(userId);
    const client = await this.getAuthorizedClient(userId);
    const result = await this.google.sheets({ version: 'v4', auth: client }).spreadsheets.values.get({
      spreadsheetId: this.env.GOOGLE_SPREADSHEET_ID,
      range: `'${sheetName}'!A:Z`,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rows = result.data.values || [];
    if (!rows.length || schema.some((header, index) => rows[0][index] !== header)) throw new Error(`The ${sheetName} sheet has not been initialized with the required headers.`);
    return rows.slice(1).filter((row) => row[0] === userId).map((row) => Object.fromEntries(schema.map((header, index) => [header, row[index] ?? ''])));
  }

  validateRecord(userId, sheetName, record) {
    const schema = SHEET_SCHEMAS[sheetName];
    if (!schema) throw new Error('Unsupported Google Sheets table.');
    if (!userId || !record || typeof record !== 'object' || Array.isArray(record)) throw new Error('A verified user and row object are required.');
    if (record.userId !== undefined && record.userId !== userId) throw new Error('A row cannot be written for a different user.');
    rejectSecretMaterial(record);
    for (const key of Object.keys(record)) if (!schema.includes(key)) throw new Error(`Unsupported ${sheetName} field: ${key}`);
    if (sheetName === 'UserSettings' && /password|secret|token|credential/i.test(String(record.settingKey || ''))) throw new Error('Secret and credential values are not allowed in UserSettings.');
    const values = schema.map((key) => {
      if (key === 'userId') return userId;
      const value = record[key];
      if (value === undefined || value === null) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });
    return { schema, values };
  }

  async appendUserRow(userId, sheetName, record) {
    const { values } = this.validateRecord(userId, sheetName, record);
    await this.ensureInitialized(userId);
    const client = await this.getAuthorizedClient(userId);
    return this.google.sheets({ version: 'v4', auth: client }).spreadsheets.values.append({
      spreadsheetId: this.env.GOOGLE_SPREADSHEET_ID,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] }
    });
  }

  async appendConversationMessage(userId, { conversationId, sessionId, role, content, createdAt, idempotencyKey, attachments = [] }) {
    if (!['user', 'assistant'].includes(role)) throw new Error('Unsupported conversation message role.');
    if (typeof conversationId !== 'string' || !conversationId || typeof sessionId !== 'string' || !sessionId) throw new Error('Conversation and session identifiers are required.');
    if (typeof content !== 'string') throw new Error('Conversation message content must be text.');
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new Error('A valid message idempotency key is required.');

    const eventId = `${idempotencyKey}:${role}`;
    const queueKey = `${userId}:${eventId}`;
    const previous = this.conversationWriteQueues.get(queueKey) || Promise.resolve();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => hold);
    this.conversationWriteQueues.set(queueKey, queued);
    await previous;
    try {
      const existingRows = await this.readUserRows(userId, 'Conversations');
      const duplicate = existingRows.some((row) => {
        if (row.conversationId !== conversationId || row.role !== role) return false;
        try { return JSON.parse(row.metadataJson || '{}').eventId === eventId; } catch { return false; }
      });
      if (duplicate) return { duplicate: true };
      const metadata = { eventId };
      if (role === 'user' && attachments.length) metadata.attachments = attachments.map(({ name, type, size }) => ({ name, type, size }));
      await this.appendUserRow(userId, 'Conversations', {
        conversationId,
        sessionId,
        role,
        content,
        createdAt: createdAt || new Date().toISOString(),
        metadataJson: metadata
      });
      return { duplicate: false };
    } finally {
      release();
      if (this.conversationWriteQueues.get(queueKey) === queued) this.conversationWriteQueues.delete(queueKey);
    }
  }

  async updateUserRow(userId, sheetName, keyName, keyValue, changes) {
    const schema = SHEET_SCHEMAS[sheetName];
    if (!schema || !schema.includes(keyName) || keyName === 'userId') throw new Error('Invalid row ownership key.');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('A row update object is required.');
    if (changes.userId !== undefined && changes.userId !== userId) throw new Error('A row cannot be updated for a different user.');
    await this.ensureInitialized(userId);
    const result = await this.google.sheets({ version: 'v4', auth: await this.getAuthorizedClient(userId) }).spreadsheets.values.get({
      spreadsheetId: this.env.GOOGLE_SPREADSHEET_ID, range: `'${sheetName}'!A:Z`, majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rows = result.data.values || [];
    if (!rows.length || schema.some((header, index) => rows[0][index] !== header)) throw new Error(`The ${sheetName} sheet has not been initialized with the required headers.`);
    const keyIndex = schema.indexOf(keyName);
    const rowIndex = rows.slice(1).findIndex((row) => row[0] === userId && row[keyIndex] === keyValue);
    if (rowIndex < 0) return null;
    const current = Object.fromEntries(schema.map((header, index) => [header, rows[rowIndex + 1][index] ?? '']));
    const { values } = this.validateRecord(userId, sheetName, { ...current, ...changes, userId });
    const lastColumn = String.fromCharCode(64 + schema.length);
    const rowNumber = rowIndex + 2;
    return this.google.sheets({ version: 'v4', auth: await this.getAuthorizedClient(userId) }).spreadsheets.values.update({
      spreadsheetId: this.env.GOOGLE_SPREADSHEET_ID,
      range: `'${sheetName}'!A${rowNumber}:${lastColumn}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] }
    });
  }

  async deleteUserRow(userId, sheetName, keyName, keyValue) {
    const schema = SHEET_SCHEMAS[sheetName];
    if (!schema || !schema.includes(keyName) || keyName === 'userId') throw new Error('Invalid row ownership key.');
    if (!userId) throw new Error('A verified user is required.');
    await this.ensureInitialized(userId);
    const api = this.google.sheets({ version: 'v4', auth: await this.getAuthorizedClient(userId) }).spreadsheets.values;
    const result = await api.get({ spreadsheetId: this.env.GOOGLE_SPREADSHEET_ID, range: `'${sheetName}'!A:Z`, majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE' });
    const rows = result.data.values || [];
    if (!rows.length || schema.some((header, index) => rows[0][index] !== header)) throw new Error(`The ${sheetName} sheet has not been initialized with the required headers.`);
    const rowIndex = rows.slice(1).findIndex((row) => row[0] === userId && row[schema.indexOf(keyName)] === keyValue);
    if (rowIndex < 0) return false;
    const rowNumber = rowIndex + 2;
    await api.batchClear({ spreadsheetId: this.env.GOOGLE_SPREADSHEET_ID, requestBody: { ranges: [`'${sheetName}'!A${rowNumber}:${String.fromCharCode(64 + schema.length)}${rowNumber}`] } });
    return true;
  }

  async revokeCentral() {
    const record = this.authStore.getCentralGoogleConnection(this.env.ALISHA_ADMIN_EMAIL);
    if (!record) return false;
    const tokens = decryptTokens(record.encrypted_tokens, this.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    const client = this.createOAuthClient();
    const token = tokens.refresh_token || tokens.access_token;
    if (token) await client.revokeToken(token);
    this.authStore.deleteCentralGoogleConnection();
    return true;
  }
}

module.exports = { GoogleSheetsIntegration, SHEET_SCHEMAS, OAUTH_SCOPES, SHEETS_SCOPE };
