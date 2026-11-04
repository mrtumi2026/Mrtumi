'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginRateLimiters, normalizeLoginIdentifier } = require('../src/middleware/rateLimit');

function request(ip, body, sessionID = 'session-is-not-a-throttle-signal') { return { ip, body, sessionID }; }
function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; } }; }
async function invoke(middleware, req) {
  let error = null;
  await middleware(req, response(), (nextError) => { error = nextError || null; });
  return error;
}
function fakeStore(clock = () => Date.now()) {
  const buckets = new Map();
  return async ({ bucketKey, max, windowMs }) => {
    const now = clock();
    let b = buckets.get(bucketKey);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(bucketKey, b); }
    const allowed = b.count < max;
    if (allowed) b.count += 1;
    return { allowed, count: b.count, limit: max, remaining: Math.max(0, max - b.count), retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  };
}

test('login limiter uses IP and normalized IP-account buckets, not session identifiers or raw account values', async () => {
  const consume = fakeStore();
  const [ipLimiter, pairLimiter] = createLoginRateLimiters({
    keyPrefix: 'test-login', identifierFields: ['identifier'], windowMs: 60_000,
    maxPerIp: 100, maxPerIpAccount: 2, consume, sharedStore: false,
  });
  const first = request('203.0.113.10', { identifier: '+880 1712-345-678' }, 'attacker-session-a');
  const second = request('203.0.113.10', { identifier: '01712345678' }, 'attacker-session-b');
  for (const req of [first, second]) {
    assert.equal(await invoke(ipLimiter, req), null);
    assert.equal(await invoke(pairLimiter, req), null);
  }
  const third = request('198.51.100.25', { identifier: '01712345678' }, 'attacker-session-c');
  assert.equal(await invoke(ipLimiter, third), null);
  assert.equal(await invoke(pairLimiter, third), null, 'another source IP cannot lock this account out');
  assert.equal(normalizeLoginIdentifier('+880 (1712) 345-678'), '01712345678');
  assert.equal(normalizeLoginIdentifier('Agent-1@example.test'), 'agent-1@example.test');
  assert.notEqual(normalizeLoginIdentifier('a-b@example.test'), normalizeLoginIdentifier('ab@example.test'));
  assert.equal(JSON.stringify(first.loginThrottle).includes('01712345678'), false);
});

test('distributed attempts against one identifier do not trigger an account-wide denial; same-IP pair still throttles', async () => {
  const consume = fakeStore();
  const [ipLimiter, pairLimiter] = createLoginRateLimiters({
    keyPrefix: 'distributed', identifierFields: ['email'], windowMs: 900_000,
    maxPerIp: 2000, maxPerIpAccount: 8, consume, sharedStore: false,
  });
  for (let i = 0; i < 100; i += 1) {
    const req = request(`198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`, { email: 'customer@example.test' });
    assert.equal(await invoke(ipLimiter, req), null);
    assert.equal(await invoke(pairLimiter, req), null);
  }
  const legitimate = request('203.0.113.90', { email: 'customer@example.test' });
  assert.equal(await invoke(ipLimiter, legitimate), null);
  assert.equal(await invoke(pairLimiter, legitimate), null);

  const repeated = request('203.0.113.91', { email: 'one@example.test' });
  for (let i = 0; i < 8; i += 1) {
    assert.equal(await invoke(ipLimiter, repeated), null);
    assert.equal(await invoke(pairLimiter, repeated), null);
  }
  assert.equal((await invoke(pairLimiter, repeated)).statusCode, 429);
});

test('shared limiter buckets expire and a production store outage fails closed with 503', async () => {
  let now = 1000;
  const consume = fakeStore(() => now);
  const [ipLimiter] = createLoginRateLimiters({ keyPrefix: 'expiry', identifierFields: ['email'], windowMs: 5000, maxPerIp: 1, consume, sharedStore: false });
  const req = request('192.0.2.2', { email: 'x@example.test' });
  assert.equal(await invoke(ipLimiter, req), null);
  assert.equal((await invoke(ipLimiter, req)).statusCode, 429);
  now += 5001;
  assert.equal(await invoke(ipLimiter, req), null);

  const [failing] = createLoginRateLimiters({
    sharedStore: true, consume: async () => { throw new Error('database credentials must not leak'); },
  });
  const error = await invoke(failing, request('192.0.2.3', { email: 'x@example.test' }));
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, 'LOGIN_RATE_LIMIT_UNAVAILABLE');
  assert.equal(error.message, 'Login protection is temporarily unavailable.');
});
