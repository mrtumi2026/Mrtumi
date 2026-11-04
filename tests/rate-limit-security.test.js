'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginRateLimiters, normalizeLoginIdentifier } = require('../src/middleware/rateLimit');

function request(ip, body, sessionID) {
  return { ip, body, sessionID };
}
function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; } }; }
function invoke(middleware, req) {
  let error = null;
  middleware(req, response(), (nextError) => { error = nextError || null; });
  return error;
}

test('login throttling keys accounts independently of attacker-controlled session IDs and normalizes phone aliases', () => {
  const [ipLimiter, accountLimiter, pairLimiter] = createLoginRateLimiters({
    keyPrefix: 'test-login', identifierFields: ['identifier'], windowMs: 60_000,
    maxPerIp: 100, maxPerAccount: 2, maxPerIpAccount: 2,
  });
  const first = request('203.0.113.10', { identifier: '+880 1712-345-678' }, 'attacker-session-a');
  const second = request('203.0.113.10', { identifier: '01712345678' }, 'attacker-session-b');
  for (const req of [first, second]) {
    assert.equal(invoke(ipLimiter, req), null);
    assert.equal(invoke(accountLimiter, req), null);
    assert.equal(invoke(pairLimiter, req), null);
  }
  const third = request('198.51.100.25', { identifier: '01712345678' }, 'attacker-session-c');
  assert.equal(invoke(ipLimiter, third), null);
  assert.ok(invoke(accountLimiter, third), 'account budget is shared across source IPs');
  assert.equal(invoke(pairLimiter, third), null, 'per-IP account budget remains separate');
  assert.equal(accountLimiter._buckets.size, 1, 'raw identifiers are not used as limiter map keys');
  assert.equal(normalizeLoginIdentifier('+880 (1712) 345-678'), '01712345678');
});

test('login IP ceiling prevents identifier rotation from bypassing all throttling', () => {
  const [ipLimiter] = createLoginRateLimiters({ keyPrefix: 'test-ip-ceiling', identifierFields: ['email'], windowMs: 60_000, maxPerIp: 1 });
  assert.equal(invoke(ipLimiter, request('203.0.113.11', { email: 'one@example.test' }, 'sid-a')), null);
  assert.ok(invoke(ipLimiter, request('203.0.113.11', { email: 'two@example.test' }, 'sid-b')));
});
