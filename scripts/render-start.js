'use strict';
const http = require('http');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// First deployment runs without opening SQLite, allowing an existing database
// to be transferred safely to the mounted disk before the app accepts users.
function startMaintenanceServer(port = Number(process.env.PORT || 3000)) {
  const server = http.createServer((req, res) => {
    const health = req.method === 'GET' && req.url === '/healthz';
    res.writeHead(health ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(health ? {} : { 'Retry-After': '300' }) });
    res.end(JSON.stringify({ status: 'maintenance' }));
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => resolve(server));
    server.once('error', reject);
  });
}
async function main() {
  if (process.env.RENDER_MAINTENANCE_MODE === 'true') {
    const server = await startMaintenanceServer();
    console.log('ALISHA maintenance mode: database unopened; user requests disabled.');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  } else await require('../server').runServer();
}
if (require.main === module) main().catch((error) => {
  console.error('ALISHA startup failed:', error.message);
  process.exitCode = 1;
});
module.exports = { startMaintenanceServer };
