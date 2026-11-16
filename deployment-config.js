'use strict';
const path = require('path');

function deploymentConfig(env = process.env) {
  const onRender = env.RENDER === 'true';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (onRender && (port === 0 || (env.HOST && env.HOST !== '0.0.0.0'))) throw new Error('Render requires a nonzero PORT and HOST=0.0.0.0.');
  if (onRender && env.NODE_ENV !== 'production') throw new Error('Set NODE_ENV=production on Render for secure session cookies.');
  if (onRender && env.TRUST_PROXY !== '1') throw new Error('Set TRUST_PROXY=1 for the Render HTTPS reverse proxy.');
  if (onRender && (!env.AUTH_DB_PATH || !path.isAbsolute(env.AUTH_DB_PATH))) throw new Error('Set AUTH_DB_PATH to an absolute path on the Render persistent disk.');
  return {
    port, host: env.HOST || '0.0.0.0', isProduction: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === '1' ? 1 : 0,
    databasePath: env.AUTH_DB_PATH || path.join(__dirname, 'data', 'alisha-auth.sqlite'),
    requireExisting: env.AUTH_DB_REQUIRE_EXISTING === 'true' || (onRender && env.AUTH_DB_REQUIRE_EXISTING !== 'false')
  };
}
module.exports = { deploymentConfig };
