'use strict';

const crypto = require('crypto');
const { encryptTokens, decryptTokens, encryptionKey } = require('./google-token-crypto');
const { redactOAuthText, requestSecrets } = require('./oauth-diagnostics');

const PLATFORMS = Object.freeze(['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube']);
const META_DEFAULT_VERSION = 'v23.0';
const SCOPES = Object.freeze({
  facebook: ['public_profile', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  instagram: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'],
  linkedin: ['openid', 'profile', 'email', 'w_member_social'],
  tiktok: ['user.info.basic', 'video.publish'],
  youtube: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.upload']
});

const configByPlatform = (platform, env) => {
  if (!PLATFORMS.includes(platform)) throw Object.assign(new Error('Unsupported social platform.'), { status: 400 });
  if (platform === 'facebook' || platform === 'instagram') {
    const version = env.META_GRAPH_API_VERSION || META_DEFAULT_VERSION;
    if (!/^v\d+\.\d+$/.test(version)) throw Object.assign(new Error('META_GRAPH_API_VERSION must look like vNN.N.'), { status: 503 });
    return {
      platform, provider: 'meta', clientId: env.META_APP_ID, clientSecret: env.META_APP_SECRET,
      redirectUri: env.META_REDIRECT_URI, authUrl: `https://www.facebook.com/${version}/dialog/oauth`,
      tokenUrl: `https://graph.facebook.com/${version}/oauth/access_token`,
      graphUrl: `https://graph.facebook.com/${version}`,
      scopes: SCOPES[platform], pkce: false
    };
  }
  const entries = {
    linkedin: { clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET, redirectUri: env.LINKEDIN_REDIRECT_URI, authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', scopes: SCOPES.linkedin, pkce: false },
    tiktok: { clientId: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET, redirectUri: env.TIKTOK_REDIRECT_URI, authUrl: 'https://www.tiktok.com/v2/auth/authorize/', tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/', scopes: SCOPES.tiktok, pkce: false },
    youtube: { clientId: env.YOUTUBE_CLIENT_ID, clientSecret: env.YOUTUBE_CLIENT_SECRET, redirectUri: env.YOUTUBE_REDIRECT_URI, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: SCOPES.youtube, pkce: true }
  };
  return { platform, provider: platform, ...entries[platform] };
};

function expirationFrom(tokens) {
  if (Number.isFinite(Number(tokens.expiry_date))) return new Date(Number(tokens.expiry_date)).toISOString();
  if (Number.isFinite(Number(tokens.expires_in))) return new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString();
  return null;
}

function cleanAccountText(value, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

class SocialOAuthService {
  constructor({ socialStore, env = process.env, fetcher = fetch } = {}) {
    this.socialStore = socialStore;
    this.env = env;
    this.fetcher = fetcher;
  }

  isConfigured(platform) {
    try { this.getConfig(platform); return true; } catch { return false; }
  }

  getConfig(platform) {
    const config = configByPlatform(platform, this.env);
    if (!config.clientId || !config.clientSecret || !config.redirectUri || !this.env.SOCIAL_TOKEN_ENCRYPTION_KEY) {
      throw Object.assign(new Error(`OAuth credentials and SOCIAL_TOKEN_ENCRYPTION_KEY are not configured for ${platform}.`), { status: 503 });
    }
    try { encryptionKey(this.env.SOCIAL_TOKEN_ENCRYPTION_KEY); }
    catch { throw Object.assign(new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must encode exactly 32 random bytes.'), { status: 503 }); }
    let redirect;
    try { redirect = new URL(config.redirectUri); } catch { throw Object.assign(new Error('OAuth redirect URI is invalid.'), { status: 503 }); }
    if (!['https:', 'http:'].includes(redirect.protocol) || redirect.pathname !== '/api/social-accounts/oauth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) {
      throw Object.assign(new Error('OAuth redirect URI must point to /api/social-accounts/oauth/callback.'), { status: 503 });
    }
    return config;
  }

  buildAuthorizationUrl(platform, state, verifier) {
    const config = this.getConfig(platform);
    const url = new URL(config.authUrl);
    const scope = config.provider === 'meta' || platform === 'tiktok' ? config.scopes.join(',') : config.scopes.join(' ');
    const values = config.provider === 'meta'
      ? { client_id: config.clientId, redirect_uri: config.redirectUri, state, response_type: 'code', scope }
      : config.platform === 'tiktok'
        ? { client_key: config.clientId, redirect_uri: config.redirectUri, state, response_type: 'code', scope }
        : { client_id: config.clientId, redirect_uri: config.redirectUri, state, response_type: 'code', scope };
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    if (config.provider === 'youtube') {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('include_granted_scopes', 'true');
      url.searchParams.set('prompt', 'select_account consent');
    }
    if (platform === 'tiktok') url.searchParams.set('disable_auto_auth', '1');
    if (config.provider === 'meta') url.searchParams.set('auth_type', 'rerequest');
    if (config.pkce) {
      if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) throw new Error('A valid PKCE verifier is required.');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async fetchJson(url, options = {}, context = {}) {
    let response;
    try { response = await this.fetcher(url, { ...options, signal: AbortSignal.timeout(25000) }); }
    catch { throw Object.assign(new Error('Could not reach the OAuth provider.'), { status: 502, oauthStage: context.stage, oauthErrorCode: 'provider_connection_failed' }); }
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    const hasProviderError = data.error && !(typeof data.error === 'object' && data.error.code === 'ok');
    if (!response.ok || hasProviderError || data.error_description) {
      const providerError = data.error && typeof data.error === 'object' ? data.error : {};
      const secrets = requestSecrets(url, options, data, context.secrets);
      throw Object.assign(new Error(`Social provider request failed (HTTP ${response.status}).`), {
        status: 502,
        upstreamStatus: response.status, oauthStage: context.stage,
        oauthErrorCode: redactOAuthText(typeof data.error === 'string' ? data.error : String(providerError.code || data.serviceErrorCode || 'provider_error'), secrets),
        providerDescription: redactOAuthText(data.error_description || providerError.message || data.message || `Provider returned HTTP ${response.status}.`, secrets),
        providerCode: Number.isInteger(providerError.code) ? providerError.code : undefined,
        providerSubcode: Number.isInteger(providerError.error_subcode) ? providerError.error_subcode : undefined
      });
    }
    return data;
  }

  async exchangeCode(platform, code, verifier) {
    const config = this.getConfig(platform);
    const fields = config.provider === 'meta'
      ? { client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, code }
      : config.platform === 'tiktok'
        ? { client_key: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, code, grant_type: 'authorization_code' }
        : { client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, code, grant_type: 'authorization_code' };
    if (config.pkce) fields.code_verifier = verifier;
    let url = config.tokenUrl;
    const options = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) };
    if (config.provider === 'meta') {
      const tokenUrl = new URL(config.tokenUrl);
      for (const [key, value] of Object.entries(fields)) tokenUrl.searchParams.set(key, value);
      url = tokenUrl.toString();
      Object.assign(options, { method: 'GET', headers: {}, body: undefined });
    }
    const response = await this.fetchJson(url, options, { stage: 'token_exchange', secrets: [code, verifier, config.clientSecret] });
    const tokens = config.platform === 'tiktok' ? (response.access_token ? response : response.data) : response;
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) throw Object.assign(new Error('Social provider did not return an access token.'), { status: 502 });
    return { config, tokens: { ...tokens, expiry_date: Number.isFinite(Number(tokens.expires_in)) ? Date.now() + Number(tokens.expires_in) * 1000 : undefined } };
  }

  async fetchMetaAccounts(config, tokens) {
    let userToken = tokens.access_token;
    let userExpiry = expirationFrom(tokens);
    // Meta short-lived user tokens can be exchanged for long-lived tokens. If this exchange is unavailable,
    // use the valid OAuth token returned by the initial code exchange.
    try {
      const longUrl = new URL(config.tokenUrl);
      longUrl.searchParams.set('grant_type', 'fb_exchange_token');
      longUrl.searchParams.set('client_id', config.clientId);
      longUrl.searchParams.set('client_secret', config.clientSecret);
      longUrl.searchParams.set('fb_exchange_token', userToken);
      const extended = await this.fetchJson(longUrl.toString());
      if (typeof extended.access_token === 'string') {
        userToken = extended.access_token;
        userExpiry = expirationFrom(extended);
      }
    } catch { /* The original OAuth token remains the fallback. */ }

    const pages = [];
    let after = '';
    let hasNextPage = true;
    const seenCursors = new Set();
    for (let pageNumber = 0; hasNextPage && pageNumber < 1000; pageNumber += 1) {
      const url = new URL(`${config.graphUrl}/me/accounts`);
      url.searchParams.set('fields', 'id,name,picture{url},access_token,tasks,instagram_business_account{id,username,profile_picture_url}');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const response = await this.fetchJson(url.toString(), { headers: { Authorization: `Bearer ${userToken}` } });
      if (Array.isArray(response.data)) pages.push(...response.data);
      hasNextPage = Boolean(response.paging?.next);
      const nextCursor = response.paging?.cursors?.after;
      if (!hasNextPage) break;
      if (typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
        throw Object.assign(new Error('Facebook Page list pagination could not be completed safely.'), { status: 502 });
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
    }
    if (hasNextPage) throw Object.assign(new Error('Facebook returned more Pages than the connection flow can safely retrieve.'), { status: 502 });
    const accounts = [];
    for (const page of pages) {
      if (config.platform === 'facebook' && page.id) {
        const hasPageToken = typeof page.access_token === 'string' && page.access_token;
        const pageToken = hasPageToken ? page.access_token : userToken;
        accounts.push({
          platformUserId: String(page.id), accountName: cleanAccountText(page.name), accountUsername: '',
          profileImage: cleanAccountText(page.picture?.data?.url || page.picture?.url || '', 1000),
          tokens: { access_token: pageToken, ...(!hasPageToken && userExpiry ? { expiry_date: Date.parse(userExpiry) } : {}) },
          providerData: { pageId: String(page.id), tasks: Array.isArray(page.tasks) ? page.tasks.slice(0, 20) : [] }
        });
      }
      const instagram = page.instagram_business_account;
      if (config.platform === 'instagram' && instagram?.id) {
        accounts.push({
          platformUserId: String(instagram.id), accountName: cleanAccountText(instagram.username || page.name),
          accountUsername: cleanAccountText(instagram.username), profileImage: cleanAccountText(instagram.profile_picture_url),
          tokens: { access_token: typeof page.access_token === 'string' ? page.access_token : userToken, expiry_date: userExpiry ? Date.parse(userExpiry) : undefined },
          providerData: { pageId: String(page.id), instagramAccountId: String(instagram.id) }
        });
      }
    }
    return accounts;
  }

  async fetchProviderAccounts(config, tokens) {
    if (config.provider === 'meta') return this.fetchMetaAccounts(config, tokens);
    if (config.platform === 'linkedin') {
      const data = await this.fetchJson('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } }, { stage: 'userinfo' });
      if (!data.sub) throw Object.assign(new Error('LinkedIn did not return an account identifier.'), { status: 502, oauthStage: 'userinfo', oauthErrorCode: 'missing_subject' });
      return [{ platformUserId: String(data.sub), accountName: cleanAccountText(data.name || data.given_name || data.sub), accountUsername: cleanAccountText(data.email), profileImage: cleanAccountText(data.picture), tokens, providerData: { subject: String(data.sub) } }];
    }
    if (config.platform === 'tiktok') {
      const url = new URL('https://open.tiktokapis.com/v2/user/info/');
      url.searchParams.set('fields', 'open_id,display_name,avatar_url');
      const data = await this.fetchJson(url.toString(), { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const user = data.data?.user;
      if (!user?.open_id) throw Object.assign(new Error('TikTok did not return an account identifier.'), { status: 502 });
      return [{ platformUserId: String(user.open_id), accountName: cleanAccountText(user.display_name || user.open_id), accountUsername: '', profileImage: cleanAccountText(user.avatar_url), tokens, providerData: { openId: String(user.open_id) } }];
    }
    if (config.platform === 'youtube') {
      const url = new URL('https://youtube.googleapis.com/youtube/v3/channels');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('mine', 'true');
      const data = await this.fetchJson(url.toString(), { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const channels = Array.isArray(data.items) ? data.items : [];
      return channels.filter((channel) => channel.id).map((channel) => ({
        platformUserId: String(channel.id), accountName: cleanAccountText(channel.snippet?.title || channel.id),
        accountUsername: cleanAccountText(channel.snippet?.customUrl),
        profileImage: cleanAccountText(channel.snippet?.thumbnails?.default?.url), tokens,
        providerData: { channelId: String(channel.id) }
      }));
    }
    return [];
  }

  async connect(platform, userId, code, verifier) {
    let stage = 'token_exchange';
    try {
    const { config, tokens } = await this.exchangeCode(platform, code, verifier);
    stage = platform === 'linkedin' ? 'userinfo' : 'account_discovery';
    const accounts = await this.fetchProviderAccounts(config, tokens);
    if (!accounts.length) throw Object.assign(new Error(`No eligible ${platform} publishing accounts were returned by the provider.`), { status: 409 });
    const saved = [];
    let added = 0;
    stage = 'account_storage';
    for (const account of accounts) {
      const accountTokens = { ...account.tokens, scope: tokens.scope || SCOPES[platform].join(' ') };
      const existing = this.socialStore.getSocialAccountByProviderId(userId, platform, account.platformUserId);
      if (!existing) added += 1;
      if (!accountTokens.refresh_token && existing?.encrypted_tokens) {
        const previous = decryptTokens(existing.encrypted_tokens, this.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
        if (previous.refresh_token) accountTokens.refresh_token = previous.refresh_token;
      }
      saved.push(this.socialStore.saveSocialAccount({
        userId, platform, platformUserId: account.platformUserId,
        accountName: account.accountName, accountUsername: account.accountUsername,
        profileImage: account.profileImage,
        encryptedTokens: encryptTokens(accountTokens, this.env.SOCIAL_TOKEN_ENCRYPTION_KEY),
        tokenExpiresAt: expirationFrom(accountTokens), scopes: accountTokens.scope,
        providerData: account.providerData
      }));
    }
    return { accounts: saved.length, added, updated: saved.length - added };
    } catch (error) {
      if (!error.oauthStage) error.oauthStage = stage;
      throw error;
    }
  }

  async refreshAccountTokens(userId, accountId) {
    const account = this.socialStore.getSocialAccount(userId, accountId);
    if (!account || account.connection_status !== 'connected' || !account.encrypted_tokens) throw Object.assign(new Error('Social account is not connected.'), { status: 404 });
    const tokens = decryptTokens(account.encrypted_tokens, this.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
    if (!tokens.expiry_date || Number(tokens.expiry_date) > Date.now() + 5 * 60 * 1000) return tokens;
    const config = this.getConfig(account.platform);
    if (!tokens.refresh_token || config.provider === 'meta') {
      this.socialStore.updateSocialToken(userId, accountId, { encryptedTokens: account.encrypted_tokens, tokenExpiresAt: account.token_expires_at, scopes: account.scopes, connectionStatus: 'reauthorization_required' });
      throw Object.assign(new Error('This social account needs to be reconnected before it can be used.'), { status: 409 });
    }
    const fields = config.platform === 'tiktok'
      ? { client_key: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refresh_token }
      : { client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
    const refreshed = await this.fetchJson(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const latest = config.platform === 'tiktok' ? (refreshed.access_token ? refreshed : refreshed.data) : refreshed;
    const merged = { ...tokens, ...latest, expiry_date: Date.now() + Number(latest.expires_in || 3600) * 1000 };
    this.socialStore.updateSocialToken(userId, accountId, { encryptedTokens: encryptTokens(merged, this.env.SOCIAL_TOKEN_ENCRYPTION_KEY), tokenExpiresAt: expirationFrom(merged), scopes: merged.scope || account.scopes });
    return merged;
  }
}

module.exports = { SocialOAuthService, PLATFORMS, SCOPES, configByPlatform };
