'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const session = require('express-session');

class AuthStore extends session.Store {
  constructor(databasePath, { requireExisting = false } = {}) {
    super();
    this.databasePath = path.resolve(databasePath);
    this.database = null;
    this.requireExisting = requireExisting;
    this.ready = this.initialize();
  }

  async initialize() {
    if (this.requireExisting && !fs.existsSync(this.databasePath)) {
      throw new Error('The configured existing database is missing. Restore it to the persistent disk before starting ALISHA. No database was created.');
    }
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
    const contents = fs.existsSync(this.databasePath) ? fs.readFileSync(this.databasePath) : undefined;
    this.database = contents ? new SQL.Database(contents) : new SQL.Database();
    this.database.run('PRAGMA foreign_keys = ON');
    this.database.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        email_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
      CREATE TABLE IF NOT EXISTS google_connections (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_tokens TEXT NOT NULL,
        google_email TEXT NOT NULL,
        scopes TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        sheets_ready INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS google_app_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        encrypted_tokens TEXT NOT NULL,
        google_email TEXT NOT NULL,
        scopes TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        sheets_ready INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS google_connection_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS social_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'tiktok', 'youtube')),
        platform_user_id TEXT NOT NULL,
        account_name TEXT NOT NULL DEFAULT '',
        account_username TEXT NOT NULL DEFAULT '',
        profile_image TEXT NOT NULL DEFAULT '',
        connection_status TEXT NOT NULL DEFAULT 'connected' CHECK (connection_status IN ('connected', 'reauthorization_required', 'disconnected')),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        encrypted_tokens TEXT,
        token_expires_at TEXT,
        scopes TEXT NOT NULL DEFAULT '',
        provider_data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (id, user_id),
        UNIQUE (user_id, platform, platform_user_id)
      );
      CREATE INDEX IF NOT EXISTS social_accounts_owner_idx ON social_accounts(user_id, platform, connection_status);
      CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_one_default_idx ON social_accounts(user_id, platform) WHERE is_default = 1 AND connection_status = 'connected';
      CREATE TABLE IF NOT EXISTS publishing_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'scheduled', 'processing', 'published', 'partially_published', 'failed', 'cancelled')),
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_message TEXT,
        scheduled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (id, user_id),
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS publishing_requests_user_created_idx ON publishing_requests(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS publishing_requests_status_schedule_idx ON publishing_requests(status, scheduled_at);
      CREATE TABLE IF NOT EXISTS publishing_targets (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        social_account_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'tiktok', 'youtube')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'scheduled', 'processing', 'published', 'failed', 'cancelled')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (request_id, social_account_id),
        FOREIGN KEY (request_id, user_id) REFERENCES publishing_requests(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (social_account_id, user_id) REFERENCES social_accounts(id, user_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS publishing_targets_request_idx ON publishing_targets(user_id, request_id);
      CREATE INDEX IF NOT EXISTS publishing_targets_account_idx ON publishing_targets(user_id, social_account_id);
    `);
    // Additive migration: existing publishing rows stay intact, and interrupted
    // external publishes can be distinguished from safe-to-retry failures.
    const targetColumns = new Set(this.database.exec('PRAGMA table_info(publishing_targets)')[0]?.values.map((row) => row[1]) || []);
    if (!targetColumns.has('dispatch_state')) this.database.run("ALTER TABLE publishing_targets ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'ready'");
    if (!targetColumns.has('attempt_count')) this.database.run('ALTER TABLE publishing_targets ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
    this.persist();
  }

  persist() {
    const temporaryPath = `${this.databasePath}.${process.pid}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, 'w', 0o600);
      fs.writeFileSync(descriptor, Buffer.from(this.database.export()));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.databasePath);
      // Persist the rename itself on Linux (Render), as well as the file contents.
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(this.databasePath), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  queryOne(sql, values = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(values);
      return statement.step() ? statement.getAsObject() : null;
    } finally { statement.free(); }
  }

  getUserByEmail(email) {
    return this.queryOne('SELECT id, full_name, email_normalized, password_hash, created_at FROM users WHERE email_normalized = ?', [email]);
  }

  getUserById(id) {
    return this.queryOne('SELECT id, full_name, email_normalized, created_at FROM users WHERE id = ?', [id]);
  }

  createUser({ id, fullName, email, passwordHash, createdAt }) {
    this.database.run('INSERT INTO users (id, full_name, email_normalized, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [id, fullName, email, passwordHash, createdAt]);
    this.persist();
    return this.getUserById(id);
  }

  getGoogleConnection(userId) {
    return this.queryOne('SELECT user_id, encrypted_tokens, google_email, scopes, connected_at, sheets_ready, updated_at FROM google_connections WHERE user_id = ?', [userId]);
  }

  getCentralGoogleConnection(adminEmail) {
    const current = this.queryOne('SELECT encrypted_tokens, google_email, scopes, connected_at, sheets_ready, updated_at FROM google_app_connection WHERE id = 1');
    if (current || !adminEmail || this.queryOne('SELECT migration_key FROM google_connection_migrations WHERE migration_key = ?', ['legacy_admin_google_connection'])) return current;
    const legacy = this.queryOne(`SELECT gc.encrypted_tokens, gc.google_email, gc.scopes, gc.connected_at, gc.sheets_ready
      FROM google_connections gc JOIN users u ON u.id = gc.user_id WHERE u.email_normalized = ?`, [adminEmail.trim().toLowerCase()]);
    if (!legacy) return null;
    this.saveCentralGoogleConnection({ encryptedTokens: legacy.encrypted_tokens, googleEmail: legacy.google_email, scopes: legacy.scopes, connectedAt: legacy.connected_at, sheetsReady: Boolean(legacy.sheets_ready) });
    this.database.run('INSERT OR IGNORE INTO google_connection_migrations (migration_key, completed_at) VALUES (?, ?)', ['legacy_admin_google_connection', new Date().toISOString()]);
    this.persist();
    return this.queryOne('SELECT encrypted_tokens, google_email, scopes, connected_at, sheets_ready, updated_at FROM google_app_connection WHERE id = 1');
  }

  saveCentralGoogleConnection({ encryptedTokens, googleEmail, scopes, connectedAt, sheetsReady = false }) {
    const now = new Date().toISOString();
    this.database.run(`INSERT INTO google_app_connection (id, encrypted_tokens, google_email, scopes, connected_at, sheets_ready, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens, google_email=excluded.google_email,
        scopes=excluded.scopes, connected_at=excluded.connected_at, sheets_ready=excluded.sheets_ready, updated_at=excluded.updated_at`,
    [encryptedTokens, googleEmail, scopes, connectedAt, sheetsReady ? 1 : 0, now]);
    this.persist();
  }

  setCentralGoogleSheetsReady(sheetsReady) {
    this.database.run('UPDATE google_app_connection SET sheets_ready = ?, updated_at = ? WHERE id = 1', [sheetsReady ? 1 : 0, new Date().toISOString()]);
    this.persist();
  }

  deleteCentralGoogleConnection() {
    this.database.run('DELETE FROM google_app_connection WHERE id = 1');
    this.persist();
  }

  saveGoogleConnection({ userId, encryptedTokens, googleEmail, scopes, connectedAt, sheetsReady = false }) {
    const now = new Date().toISOString();
    this.database.run(`INSERT INTO google_connections (user_id, encrypted_tokens, google_email, scopes, connected_at, sheets_ready, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens, google_email=excluded.google_email,
        scopes=excluded.scopes, connected_at=excluded.connected_at, sheets_ready=excluded.sheets_ready, updated_at=excluded.updated_at`,
    [userId, encryptedTokens, googleEmail, scopes, connectedAt, sheetsReady ? 1 : 0, now]);
    this.persist();
  }

  setGoogleSheetsReady(userId, sheetsReady) {
    this.database.run('UPDATE google_connections SET sheets_ready = ?, updated_at = ? WHERE user_id = ?', [sheetsReady ? 1 : 0, new Date().toISOString(), userId]);
    this.persist();
  }

  deleteGoogleConnection(userId) {
    this.database.run('DELETE FROM google_connections WHERE user_id = ?', [userId]);
    this.persist();
  }

  get(sid, callback) {
    try {
      const row = this.queryOne('SELECT sess, expire FROM sessions WHERE sid = ?', [sid]);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) {
        this.database.run('DELETE FROM sessions WHERE sid = ?', [sid]);
        this.persist();
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const cookieExpiry = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.database.run('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)', [sid, JSON.stringify(sess), cookieExpiry]);
      this.persist();
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const cookieExpiry = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.database.run('UPDATE sessions SET expire = ?, sess = ? WHERE sid = ?', [cookieExpiry, JSON.stringify(sess), sid]);
      this.persist();
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.database.run('DELETE FROM sessions WHERE sid = ?', [sid]);
      this.persist();
      callback(null);
    } catch (error) { callback(error); }
  }
}

module.exports = { AuthStore };
