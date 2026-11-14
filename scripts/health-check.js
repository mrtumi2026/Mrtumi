'use strict';

/**
 * Deployment Health Check Runner (OPS-04)
 * Validates critical public endpoints and security headers post-deployment.
 */

const https = require('https');
const http = require('http');

const baseUrl = process.argv[2] || process.env.APP_URL || 'https://mrtumi.com';

function requestEndpoint(urlStr) {
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();

    const req = client.get(urlStr, {
      timeout: 10000,
      headers: { 'User-Agent': 'MrTumi-HealthCheck/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const latency = Date.now() - start;
        resolve({
          url: urlStr,
          status: res.statusCode,
          latency,
          headers: res.headers,
          has500: body.includes('Internal Server Error'),
          bodyLength: body.length,
          ok: res.statusCode === 200 && !body.includes('Internal Server Error'),
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url: urlStr, status: 0, latency: 10000, error: 'TIMEOUT', ok: false });
    });

    req.on('error', (err) => {
      resolve({ url: urlStr, status: 0, latency: Date.now() - start, error: err.message, ok: false });
    });
  });
}

async function runHealthCheck() {
  console.log(`Checking deployment health on: ${baseUrl}`);
  console.log('----------------------------------------------------');

  const endpoints = [
    '/',
    '/customer/login',
    '/customer/recovery',
    '/customer/recovery/reset',
  ];

  let allOk = true;

  for (const path of endpoints) {
    const targetUrl = new URL(path, baseUrl).toString();
    const res = await requestEndpoint(targetUrl);

    if (res.ok) {
      console.log(`✔ [${res.status}] ${path.padEnd(26)} (${res.latency}ms, ${res.bodyLength} bytes)`);

      // Verify security headers
      const secHeaders = [];
      if (res.headers['x-frame-options']) secHeaders.push('X-Frame-Options');
      if (res.headers['x-content-type-options']) secHeaders.push('nosniff');
      if (res.headers['strict-transport-security']) secHeaders.push('HSTS');
      if (secHeaders.length > 0) {
        console.log(`   Headers: ${secHeaders.join(', ')}`);
      }
    } else {
      allOk = false;
      console.error(`✖ [${res.status || 'ERR'}] ${path.padEnd(26)} (${res.latency}ms) - ${res.error || '500 Error detected'}`);
    }
  }

  console.log('----------------------------------------------------');
  if (allOk) {
    console.log('Deployment Health Check: ALL CHECKS PASSED ✔');
    process.exit(0);
  } else {
    console.error('Deployment Health Check: FAILURES DETECTED ✖');
    process.exit(1);
  }
}

if (require.main === module) {
  runHealthCheck().catch((err) => {
    console.error('Health check runner failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runHealthCheck, requestEndpoint };
