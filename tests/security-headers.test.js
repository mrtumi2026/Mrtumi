'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CSP_REPORT_ONLY, createSecurityHeaders } = require('../src/middleware/securityHeaders');

function collect(middleware) {
  const headers = {};
  let called = false;
  middleware(
    {},
    {
      setHeader(name, value) { headers[name] = value; },
      removeHeader(name) { delete headers[name]; }
    },
    () => { called = true; }
  );
  return { headers, called };
}

test('security header middleware sets safe baseline and a non-enforcing CSP without unsafe-inline', () => {
  const { headers, called } = collect(createSecurityHeaders());
  assert.equal(called, true);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(headers['Strict-Transport-Security'], undefined);
  assert.equal(headers['X-Frame-Options'], undefined, 'preview iframe compatibility is retained outside production');
  assert.ok(headers['Content-Security-Policy-Report-Only'].includes("object-src 'none'"));
  assert.ok(headers['Content-Security-Policy-Report-Only'].includes('report-uri /api/security/csp-report'));
  assert.doesNotMatch(CSP_REPORT_ONLY, /unsafe-inline|unsafe-eval/);
  assert.equal(headers['Content-Security-Policy'], undefined, 'policy remains report-only during inline asset migration');
});

test('production headers enable HSTS and same-origin frame protection only in production', () => {
  const { headers } = collect(createSecurityHeaders({ isProduction: true }));
  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
});
