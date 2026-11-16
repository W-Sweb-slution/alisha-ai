'use strict';

const crypto = require('crypto');

const REQUEST_STATUSES = new Set(['pending', 'scheduled', 'processing', 'published', 'partially_published', 'failed', 'cancelled']);
const TARGET_STATUSES = new Set(['pending', 'scheduled', 'processing', 'published', 'failed', 'cancelled']);

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

class SocialStore {
  constructor(authStore) {
    this.authStore = authStore;
  }

  get database() { return this.authStore.database; }
  persist() { this.authStore.persist(); }
  one(sql, values = []) { return this.authStore.queryOne(sql, values); }
  all(sql, values = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(values);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  }

  transaction(action) {
    this.database.run('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.run('COMMIT');
      this.persist();
      return result;
    } catch (error) {
      try { this.database.run('ROLLBACK'); } catch {}
      throw error;
    }
  }

  saveSocialAccount(account) {
    const now = new Date().toISOString();
    const id = account.id || crypto.randomUUID();
    this.database.run(`INSERT INTO social_accounts (
      id, user_id, platform, platform_user_id, account_name, account_username,
      profile_image, connection_status, is_default, encrypted_tokens, token_expires_at,
      scopes, provider_data_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, platform, platform_user_id) DO UPDATE SET
      account_name=excluded.account_name,
      account_username=excluded.account_username,
      profile_image=excluded.profile_image,
      connection_status='connected',
      encrypted_tokens=excluded.encrypted_tokens,
      token_expires_at=excluded.token_expires_at,
      scopes=excluded.scopes,
      provider_data_json=excluded.provider_data_json,
      updated_at=excluded.updated_at`, [
      id, account.userId, account.platform, account.platformUserId,
      account.accountName || '', account.accountUsername || '', account.profileImage || '',
      account.encryptedTokens, account.tokenExpiresAt || null, account.scopes || '',
      JSON.stringify(account.providerData || {}), now, now
    ]);
    this.persist();
    return this.getSocialAccountByProviderId(account.userId, account.platform, account.platformUserId);
  }

  getSocialAccountByProviderId(userId, platform, platformUserId) {
    return this.one('SELECT * FROM social_accounts WHERE user_id = ? AND platform = ? AND platform_user_id = ?', [userId, platform, platformUserId]);
  }

  getSocialAccount(userId, accountId) {
    return this.one('SELECT * FROM social_accounts WHERE user_id = ? AND id = ?', [userId, accountId]);
  }

  updateSocialToken(userId, accountId, { encryptedTokens, tokenExpiresAt, scopes, connectionStatus = 'connected' }) {
    this.database.run(`UPDATE social_accounts SET encrypted_tokens = ?, token_expires_at = ?, scopes = ?,
      connection_status = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
    [encryptedTokens, tokenExpiresAt || null, scopes || '', connectionStatus, new Date().toISOString(), userId, accountId]);
    const updated = this.getSocialAccount(userId, accountId);
    if (updated) this.persist();
    return updated;
  }

  listSocialAccounts(userId) {
    return this.all(`SELECT id, user_id, platform, platform_user_id, account_name, account_username,
      profile_image, connection_status, is_default, token_expires_at, scopes, provider_data_json,
      created_at, updated_at FROM social_accounts WHERE user_id = ? ORDER BY platform, account_name`, [userId])
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        accountName: row.account_name,
        accountUsername: row.account_username,
        profileImage: row.profile_image,
        connectionStatus: row.connection_status,
        isDefault: Boolean(row.is_default),
        tokenExpiresAt: row.token_expires_at,
        scopes: row.scopes,
        providerData: parseJson(row.provider_data_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  disconnectSocialAccount(userId, accountId) {
    this.database.run(`UPDATE social_accounts
      SET connection_status = 'disconnected', is_default = 0, encrypted_tokens = NULL,
      token_expires_at = NULL, updated_at = ? WHERE user_id = ? AND id = ?`, [new Date().toISOString(), userId, accountId]);
    const changed = this.database.getRowsModified() > 0;
    this.persist();
    return changed;
  }

  setDefaultSocialAccount(userId, accountId) {
    return this.transaction(() => {
      const account = this.one(`SELECT id, platform FROM social_accounts
        WHERE user_id = ? AND id = ? AND connection_status = 'connected'`, [userId, accountId]);
      if (!account) return false;
      this.database.run('UPDATE social_accounts SET is_default = 0, updated_at = ? WHERE user_id = ? AND platform = ?', [new Date().toISOString(), userId, account.platform]);
      this.database.run('UPDATE social_accounts SET is_default = 1, updated_at = ? WHERE user_id = ? AND id = ?', [new Date().toISOString(), userId, accountId]);
      return true;
    });
  }

  createPublishingRequest({ id, userId, idempotencyKey, status, request, scheduledAt, targets }) {
    if (!REQUEST_STATUSES.has(status)) throw new Error('Invalid publishing request status.');
    if (!Array.isArray(targets) || !targets.length) throw new Error('At least one connected social account is required.');
    return this.transaction(() => {
      const existing = this.one('SELECT * FROM publishing_requests WHERE user_id = ? AND idempotency_key = ?', [userId, idempotencyKey]);
      if (existing) return { duplicate: true, request: this.getPublishingRequest(userId, existing.id) };

      const distinctIds = [...new Set(targets.map((target) => target.accountId))];
      if (distinctIds.length !== targets.length || distinctIds.some((value) => typeof value !== 'string' || !value)) {
        throw Object.assign(new Error('Publishing targets contain invalid or duplicate account IDs.'), { status: 400 });
      }
      const placeholders = distinctIds.map(() => '?').join(',');
      const owned = this.all(`SELECT id, platform FROM social_accounts WHERE user_id = ? AND connection_status = 'connected' AND id IN (${placeholders})`, [userId, ...distinctIds]);
      if (owned.length !== distinctIds.length) throw Object.assign(new Error('One or more selected social accounts are unavailable.'), { status: 403 });
      const ownedById = new Map(owned.map((account) => [account.id, account]));
      for (const target of targets) {
        if (target.platform && target.platform !== ownedById.get(target.accountId)?.platform) {
          throw Object.assign(new Error('A selected account does not match its platform.'), { status: 400 });
        }
      }

      const now = new Date().toISOString();
      this.database.run(`INSERT INTO publishing_requests (id, user_id, idempotency_key, status, request_json, scheduled_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, userId, idempotencyKey, status, JSON.stringify(request), scheduledAt || null, now, now]);
      for (const target of targets) {
        const platform = ownedById.get(target.accountId).platform;
        this.database.run(`INSERT INTO publishing_targets (id, request_id, user_id, social_account_id, platform, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), id, userId, target.accountId, platform, status, now, now]);
      }
      return { duplicate: false, request: this.getPublishingRequest(userId, id) };
    });
  }

  getPublishingRequest(userId, requestId) {
    const row = this.one('SELECT * FROM publishing_requests WHERE user_id = ? AND id = ?', [userId, requestId]);
    if (!row) return null;
    const targets = this.all(`SELECT id, social_account_id, platform, status, result_json, dispatch_state, attempt_count, created_at, updated_at
      FROM publishing_targets WHERE user_id = ? AND request_id = ? ORDER BY created_at`, [userId, requestId])
      .map((target) => ({ id: target.id, accountId: target.social_account_id, platform: target.platform, status: target.status, dispatchState: target.dispatch_state || 'ready', attemptCount: Number(target.attempt_count || 0), result: parseJson(target.result_json), createdAt: target.created_at, updatedAt: target.updated_at }));
    return { id: row.id, userId: row.user_id, idempotencyKey: row.idempotency_key, status: row.status, request: parseJson(row.request_json, {}), response: parseJson(row.response_json), error: row.error_message, scheduledAt: row.scheduled_at, createdAt: row.created_at, updatedAt: row.updated_at, targets };
  }

  getFacebookDispatch(requestId, accountId) {
    const row = this.one(`SELECT r.id AS request_id, r.user_id, r.status AS request_status,
      r.request_json, r.scheduled_at, t.social_account_id, t.platform, t.status AS target_status,
      t.dispatch_state, t.attempt_count, t.result_json, a.connection_status, a.encrypted_tokens,
      a.token_expires_at, a.scopes, a.platform_user_id
      FROM publishing_requests r
      JOIN publishing_targets t ON t.request_id = r.id AND t.user_id = r.user_id
      JOIN social_accounts a ON a.id = t.social_account_id AND a.user_id = t.user_id
      WHERE r.id = ? AND t.social_account_id = ? AND t.platform = 'facebook'`, [requestId, accountId]);
    if (!row) return null;
    return {
      requestId: row.request_id, userId: row.user_id, requestStatus: row.request_status,
      request: parseJson(row.request_json, {}), scheduledAt: row.scheduled_at,
      accountId: row.social_account_id, platform: row.platform, platformUserId: row.platform_user_id,
      targetStatus: row.target_status, dispatchState: row.dispatch_state || 'ready',
      attemptCount: Number(row.attempt_count || 0), result: parseJson(row.result_json),
      connectionStatus: row.connection_status, encryptedTokens: row.encrypted_tokens,
      tokenExpiresAt: row.token_expires_at, scopes: row.scopes
    };
  }

  claimFacebookDispatch(requestId, accountId, { retry = false } = {}) {
    return this.transaction(() => {
      const row = this.one(`SELECT dispatch_state, attempt_count, status, result_json, updated_at
        FROM publishing_targets WHERE request_id = ? AND social_account_id = ? AND platform = 'facebook'`, [requestId, accountId]);
      if (!row) return { missing: true };
      if (row.dispatch_state === 'succeeded') return { duplicate: true, state: 'succeeded', status: row.status, result: parseJson(row.result_json, {}) };
      if (row.dispatch_state === 'running') {
        if (Date.now() - Date.parse(row.updated_at) > 10 * 60 * 1000) {
          const result = { error: 'The previous server attempt stopped before its Facebook result was recorded. Check the Page before retrying.' };
          this.database.run(`UPDATE publishing_targets SET dispatch_state = 'uncertain', status = 'failed', result_json = ?, updated_at = ? WHERE request_id = ? AND social_account_id = ?`, [JSON.stringify(result), new Date().toISOString(), requestId, accountId]);
          return { duplicate: true, state: 'uncertain', result };
        }
        return { duplicate: true, state: 'running' };
      }
      if (row.dispatch_state === 'uncertain') return { duplicate: true, state: 'uncertain', result: parseJson(row.result_json, {}) };
      if (row.dispatch_state === 'failed' && !retry) return { duplicate: true, state: 'failed', result: parseJson(row.result_json, {}) };
      if (row.dispatch_state === 'failed' && Number(row.attempt_count) >= 3) return { duplicate: true, state: 'failed', exhausted: true, result: parseJson(row.result_json, {}) };
      const now = new Date().toISOString();
      this.database.run(`UPDATE publishing_targets SET dispatch_state = 'running', status = 'processing',
        attempt_count = attempt_count + 1, updated_at = ? WHERE request_id = ? AND social_account_id = ?`, [now, requestId, accountId]);
      this.database.run(`UPDATE publishing_requests SET status = 'processing', error_message = NULL, updated_at = ? WHERE id = ?`, [now, requestId]);
      return { claimed: true, attempt: Number(row.attempt_count || 0) + 1 };
    });
  }

  finishFacebookDispatch(requestId, accountId, { state, status, result }) {
    const allowedStates = new Set(['succeeded', 'failed', 'uncertain']);
    if (!allowedStates.has(state) || !TARGET_STATUSES.has(status)) throw new Error('Invalid Facebook dispatch result.');
    return this.transaction(() => {
      this.database.run(`UPDATE publishing_targets SET dispatch_state = ?, status = ?, result_json = ?, updated_at = ?
        WHERE request_id = ? AND social_account_id = ? AND platform = 'facebook' AND dispatch_state = 'running'`,
      [state, status, JSON.stringify(result || {}), new Date().toISOString(), requestId, accountId]);
      if (!this.database.getRowsModified()) return this.getFacebookDispatch(requestId, accountId);
      const rows = this.all('SELECT status FROM publishing_targets WHERE request_id = ?', [requestId]);
      const published = rows.filter((item) => item.status === 'published').length;
      const failed = rows.filter((item) => item.status === 'failed').length;
      const aggregate = published === rows.length ? 'published' : failed === rows.length ? 'failed' : published || failed ? 'partially_published' : 'processing';
      this.database.run('UPDATE publishing_requests SET status = ?, response_json = ?, updated_at = ? WHERE id = ?',
        [aggregate, JSON.stringify({ facebookAccountId: accountId }), new Date().toISOString(), requestId]);
      return this.getFacebookDispatch(requestId, accountId);
    });
  }

  listPublishingRequests(userId) {
    return this.all('SELECT id FROM publishing_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [userId])
      .map((row) => this.getPublishingRequest(userId, row.id));
  }

  updatePublishingRequest(userId, requestId, { status, response = null, error = null }) {
    if (!REQUEST_STATUSES.has(status)) throw new Error('Invalid publishing request status.');
    this.database.run(`UPDATE publishing_requests SET status = ?, response_json = ?, error_message = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`, [status, response === null ? null : JSON.stringify(response), error, new Date().toISOString(), userId, requestId]);
    if (!this.database.getRowsModified()) return null;
    const targetStatus = status === 'published' || status === 'failed' || status === 'cancelled' || status === 'scheduled' || status === 'pending' ? status : 'processing';
    this.database.run(`UPDATE publishing_targets SET status = ?, updated_at = ? WHERE user_id = ? AND request_id = ? AND status IN ('pending', 'scheduled', 'processing')`, [targetStatus, new Date().toISOString(), userId, requestId]);
    this.persist();
    return this.getPublishingRequest(userId, requestId);
  }

  applyN8nStatus({ requestId, status, targets = [], response = null }) {
    if (!REQUEST_STATUSES.has(status)) throw Object.assign(new Error('Unsupported publishing status.'), { status: 400 });
    return this.transaction(() => {
      const request = this.one('SELECT id, user_id, status FROM publishing_requests WHERE id = ?', [requestId]);
      if (!request) return null;
      if (Array.isArray(targets)) {
        for (const target of targets) {
          if (!target || typeof target.accountId !== 'string' || !TARGET_STATUSES.has(target.status)) throw Object.assign(new Error('Invalid publishing target status update.'), { status: 400 });
          const safeResult = {};
          for (const key of ['platformPostId', 'postId', 'mediaId', 'permalink', 'url', 'message', 'error', 'publishedAt']) {
            if (typeof target[key] === 'string') safeResult[key] = target[key].slice(0, 2000);
          }
          this.database.run(`UPDATE publishing_targets SET status = ?, result_json = ?, updated_at = ?
            WHERE user_id = ? AND request_id = ? AND social_account_id = ?`, [target.status, JSON.stringify(safeResult), new Date().toISOString(), request.user_id, requestId, target.accountId]);
          if (!this.database.getRowsModified()) throw Object.assign(new Error('Publishing target does not belong to this request.'), { status: 403 });
          const dispatchState = target.status === 'published' ? 'succeeded' : target.status === 'failed' ? 'failed' : null;
          if (dispatchState) this.database.run(`UPDATE publishing_targets SET dispatch_state = ? WHERE user_id = ? AND request_id = ? AND social_account_id = ?`, [dispatchState, request.user_id, requestId, target.accountId]);
        }
      }
      if (!targets.length && ['published', 'failed', 'cancelled'].includes(status)) {
        this.database.run('UPDATE publishing_targets SET status = ?, updated_at = ? WHERE user_id = ? AND request_id = ?', [status, new Date().toISOString(), request.user_id, requestId]);
      }
      const currentTargets = this.all('SELECT status FROM publishing_targets WHERE user_id = ? AND request_id = ?', [request.user_id, requestId]);
      const published = currentTargets.filter((item) => item.status === 'published').length;
      const failed = currentTargets.filter((item) => item.status === 'failed').length;
      let aggregate = status;
      if (currentTargets.length && published === currentTargets.length) aggregate = 'published';
      else if (currentTargets.length && failed === currentTargets.length) aggregate = 'failed';
      else if (published && failed && published + failed === currentTargets.length) aggregate = 'partially_published';
      else if (status === 'published' || status === 'failed' || status === 'partially_published') aggregate = 'processing';
      this.database.run('UPDATE publishing_requests SET status = ?, response_json = ?, error_message = NULL, updated_at = ? WHERE id = ? AND user_id = ?', [aggregate, response === null ? null : JSON.stringify(response), new Date().toISOString(), requestId, request.user_id]);
      return this.getPublishingRequest(request.user_id, requestId);
    });
  }
}

module.exports = { SocialStore, REQUEST_STATUSES, TARGET_STATUSES };
