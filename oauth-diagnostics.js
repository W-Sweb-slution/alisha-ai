'use strict';
const crypto = require('crypto');

function redactOAuthText(value, secrets = []) {
  let text = typeof value === 'string' ? value : '';
  for (const secret of secrets.filter((s) => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length)) {
    for (const candidate of [secret, encodeURIComponent(secret)]) text = text.split(candidate).join('[redacted]');
  }
  return text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/((?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization_code|code)\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1[redacted]')
    .replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 1500);
}

function requestSecrets(url, options, response, extra = []) {
  const values = [...extra];
  const secretKey = /^(?:code|state|client_secret|access_token|refresh_token|id_token|code_verifier|fb_exchange_token)$/i;
  try { for (const [key, value] of new URL(String(url)).searchParams) if (secretKey.test(key)) values.push(value); } catch {}
  if (options.body instanceof URLSearchParams) for (const [key, value] of options.body) if (secretKey.test(key)) values.push(value);
  const authorization = new Headers(options.headers || {}).get('Authorization');
  if (authorization) values.push(authorization.replace(/^Bearer\s+/i, ''));
  for (const [key, value] of Object.entries(response || {})) if (secretKey.test(key) && typeof value === 'string') values.push(value);
  return values;
}

function oauthDiagnostic(error, platform, secrets = []) {
  return {
    reference: crypto.randomUUID(), platform, stage: error.oauthStage || 'callback',
    httpStatus: error.upstreamStatus || error.status || 500,
    errorCode: redactOAuthText(String(error.oauthErrorCode || error.providerCode || error.code || error.name || 'oauth_error'), secrets),
    message: redactOAuthText(error.providerDescription || error.message || 'OAuth failed.', secrets),
    createdAt: Date.now()
  };
}
module.exports = { redactOAuthText, requestSecrets, oauthDiagnostic };
