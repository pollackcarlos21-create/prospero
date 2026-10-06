// Test-only entrypoint. It loads the unchanged production main bundle after replacing only
// HTTPS I/O for three fixture domains. The app/preload never expose this seam to renderer IPC.
const { join } = require('node:path');
const dns = require('node:dns/promises');
const https = require('node:https');
const http = require('node:http');
const port = Number(process.env.PROSPERO_E2E_WEB_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Offline test port required.');
const originalLookup = dns.lookup;
dns.lookup = async (host, options) => {
  if (['api.search.brave.com', 'api.tavily.com', 'research.example.org'].includes(host))
    return options?.all
      ? [{ address: '93.184.216.34', family: 4 }]
      : { address: '93.184.216.34', family: 4 };
  return originalLookup(host, options);
};
const originalRequest = https.request;
https.request = (options, callback) => {
  if (
    !['api.search.brave.com', 'api.tavily.com', 'research.example.org'].includes(options.hostname)
  )
    throw new Error('External HTTPS is forbidden in this offline fixture.');
  const method = options.hostname === 'api.tavily.com' ? 'POST' : 'GET';
  if (
    options.protocol !== 'https:' ||
    options.port !== 443 ||
    options.method !== method ||
    (method === 'POST' && options.path !== '/search') ||
    options.rejectUnauthorized !== true
  )
    throw new Error('Unsafe production request options.');
  return http.request(
    {
      hostname: '127.0.0.1',
      port,
      method,
      path: options.path,
      headers: { ...options.headers, 'x-fixture-origin': options.hostname },
      agent: false,
    },
    callback,
  );
};
process.on('exit', () => {
  dns.lookup = originalLookup;
  https.request = originalRequest;
});
require(join(process.cwd(), 'dist/main.cjs'));
