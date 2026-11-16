'use strict';

const { configByPlatform } = require('./social-oauth');

function safeGraphError(data, status) {
  const providerError = data && typeof data.error === 'object' ? data.error : {};
  return {
    httpStatus: status,
    code: typeof providerError.code === 'number' ? providerError.code : undefined,
    subcode: typeof providerError.error_subcode === 'number' ? providerError.error_subcode : undefined,
    message: typeof providerError.message === 'string' ? providerError.message.slice(0, 600) : `Facebook returned HTTP ${status}.`
  };
}

class FacebookPublisher {
  constructor({ socialStore, socialOAuth, env = process.env, fetcher = fetch } = {}) {
    this.socialStore = socialStore;
    this.socialOAuth = socialOAuth;
    this.env = env;
    this.fetcher = fetcher;
  }

  async graphRequest(url, form) {
    let response;
    try { response = await this.fetcher(url, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) }); }
    catch (cause) {
      throw Object.assign(new Error('Facebook did not return a publish result. Check the Page before retrying.'), { status: 502, uncertain: true, cause });
    }
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* Error response handled below. */ }
    if (!response.ok || data.error) {
      const error = Object.assign(new Error('Facebook could not publish this post.'), {
        status: response.status >= 500 ? 502 : 422,
        providerError: safeGraphError(data, response.status),
        uncertain: response.status >= 500
      });
      throw error;
    }
    return data;
  }

  async getPublishedPostId(config, mediaId, accessToken) {
    const url = new URL(`${config.graphUrl}/${encodeURIComponent(mediaId)}`);
    url.searchParams.set('fields', 'post_id');
    // Token is sent in an Authorization header, never in the URL.
    let response;
    try { response = await this.fetcher(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) }); }
    catch { return null; }
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { return null; }
    return response.ok && typeof data.post_id === 'string' ? data.post_id : null;
  }

  async publish({ dispatch, file }) {
    if (!dispatch || dispatch.platform !== 'facebook' || dispatch.connectionStatus !== 'connected' || !dispatch.encryptedTokens) {
      throw Object.assign(new Error('The Facebook Page is not connected.'), { status: 409, definitive: true });
    }
    const account = this.socialStore.getSocialAccount(dispatch.userId, dispatch.accountId);
    if (!account || account.platform !== 'facebook' || account.connection_status !== 'connected' || !account.encrypted_tokens) {
      throw Object.assign(new Error('The Facebook Page is not available to this publishing request.'), { status: 404, definitive: true });
    }
    const pageId = String(account.platform_user_id || '');
    if (!/^\d{3,}$/.test(pageId)) throw Object.assign(new Error('The connected Facebook Page identifier is invalid.'), { status: 409, definitive: true });
    const request = dispatch.request || {};
    const caption = typeof request.caption === 'string' ? request.caption.trim() : '';
    if (!caption) throw Object.assign(new Error('The stored publishing request has no caption.'), { status: 409, definitive: true });

    const scheduledAt = dispatch.scheduledAt ? Date.parse(dispatch.scheduledAt) : NaN;
    if (Number.isFinite(scheduledAt) && scheduledAt > Date.now()) {
      throw Object.assign(new Error('This scheduled Facebook post is not due yet. Call the endpoint after the n8n Wait node resumes.'), { status: 409, definitive: true });
    }

    const tokens = await this.socialOAuth.refreshAccountTokens(dispatch.userId, dispatch.accountId);
    const config = configByPlatform('facebook', this.env);
    let data;
    if (file) {
      if (!Buffer.isBuffer(file.buffer) || !file.buffer.length) throw Object.assign(new Error('The uploaded media file is empty.'), { status: 400, definitive: true });
      if (!/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype) && !/^video\/(mp4|quicktime|x-msvideo|webm)$/.test(file.mimetype)) {
        throw Object.assign(new Error('Facebook publishing accepts a supported image or video file.'), { status: 415, definitive: true });
      }
      const isImage = file.mimetype.startsWith('image/');
      const edge = isImage ? 'photos' : 'videos';
      const form = new FormData();
      form.append('access_token', tokens.access_token);
      form.append(isImage ? 'caption' : 'description', caption);
      form.append(isImage ? 'source' : 'source', new Blob([file.buffer], { type: file.mimetype }), file.originalname || (isImage ? 'upload.jpg' : 'upload.mp4'));
      const title = typeof request.title === 'string' ? request.title.trim().slice(0, 255) : '';
      if (!isImage && title) form.append('title', title);
      data = await this.graphRequest(`${config.graphUrl}/${encodeURIComponent(pageId)}/${edge}`, form);
      const mediaId = typeof data.id === 'string' ? data.id : '';
      let postId = typeof data.post_id === 'string' ? data.post_id : '';
      if (!postId && mediaId && !isImage) postId = await this.getPublishedPostId(config, mediaId, tokens.access_token) || '';
      if (!postId && isImage && mediaId) postId = await this.getPublishedPostId(config, mediaId, tokens.access_token) || '';
      if (!postId) {
        throw Object.assign(new Error('Facebook accepted the media upload but did not return a verifiable post ID. Check the Page before retrying.'), {
          status: 502, uncertain: true, providerError: { message: 'Facebook response did not include post_id.' }, mediaId
        });
      }
      return { status: 'published', postId, mediaId, platform: 'facebook', publishedAt: new Date().toISOString() };
    }

    const form = new FormData();
    form.append('access_token', tokens.access_token);
    form.append('message', caption);
    data = await this.graphRequest(`${config.graphUrl}/${encodeURIComponent(pageId)}/feed`, form);
    if (typeof data.id !== 'string' || !data.id) {
      throw Object.assign(new Error('Facebook returned no post ID. Check the Page before retrying.'), { status: 502, uncertain: true, providerError: { message: 'Facebook response did not include id.' } });
    }
    return { status: 'published', postId: data.id, platform: 'facebook', publishedAt: new Date().toISOString() };
  }
}

module.exports = { FacebookPublisher };
