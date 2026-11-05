'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');
const { encryptProviderToken, decryptProviderToken } = require('../src/utils/providerTokenSecurity');

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Map([['content-type', 'application/json']]),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test('Pathao OAuth: sandbox token refresh and persistence', async () => {
  let rotatedHook = null;
  const pathao = new PathaoAdapter({
    code: 'pathao',
    sandbox: 1,
    onTokenRotated: async (payload) => {
      rotatedHook = payload;
    }
  });

  const res = await pathao.refreshAccessToken();
  assert.equal(res.success, true);
  assert.equal(res.accessToken, 'pathao_sandbox_refreshed_token');
  assert.equal(res.refreshToken, 'pathao_sandbox_refresh_token');
  assert.equal(res.recovered, false);
  assert.equal(pathao.apiKey, 'pathao_sandbox_refreshed_token');
  assert.equal(pathao.refreshToken, 'pathao_sandbox_refresh_token');
  assert.ok(pathao.serviceOptions.encrypted_refresh_token, 'Must store encrypted_refresh_token');
  assert.equal(pathao.serviceOptions.refresh_token, undefined, 'Must not store plaintext refresh_token');
  assert.ok(rotatedHook, 'onTokenRotated callback must have fired');
});

test('Pathao OAuth: successful refresh-token rotation with encrypted storage and persistence', async () => {
  let issueTokenPayload = null;
  let persistedRecord = null;

  const mockFetch = async (url, options = {}) => {
    if (url.includes('/issue-token')) {
      issueTokenPayload = JSON.parse(options.body);
      return mockResponse(200, {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'new_rotated_access_token_123',
        refresh_token: 'new_rotated_refresh_token_456'
      });
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'old_expired_access_token',
    client_id: 'cid_test',
    client_secret: 'csec_test',
    service_options_json: { refresh_token: 'old_active_refresh_token', store_id: 1 },
    fetchFn: mockFetch,
    onTokenRotated: async (data) => {
      persistedRecord = data;
    }
  });

  const result = await pathao.refreshAccessToken();
  assert.equal(result.success, true);
  assert.equal(result.recovered, false);
  assert.equal(result.accessToken, 'new_rotated_access_token_123');
  assert.equal(result.refreshToken, 'new_rotated_refresh_token_456');

  // Verify internal memory was updated only after persistence
  assert.equal(pathao.apiKey, 'new_rotated_access_token_123');
  assert.equal(pathao.refreshToken, 'new_rotated_refresh_token_456');
  assert.equal(pathao.serviceOptions.refresh_token, undefined, 'Plaintext refresh token must be removed from JSON');
  assert.ok(pathao.serviceOptions.encrypted_refresh_token.startsWith('enc:v1:'), 'Token must be encrypted with AES-256-GCM');
  assert.equal(decryptProviderToken(pathao.serviceOptions.encrypted_refresh_token), 'new_rotated_refresh_token_456');

  // Verify persistence callback received encrypted and plaintext tokens
  assert.ok(persistedRecord);
  assert.equal(persistedRecord.accessToken, 'new_rotated_access_token_123');
  assert.equal(persistedRecord.refreshToken, 'new_rotated_refresh_token_456');
  assert.ok(persistedRecord.encryptedRefreshToken.startsWith('enc:v1:'));
});

test('Pathao OAuth Persistence Failure: rotation must fail closed if DB persistence throws and leave memory untouched', async () => {
  const initialApiKey = 'stable_initial_api_key';
  const initialRefreshToken = 'stable_initial_refresh_token';

  const mockFetch = async (url) => {
    if (url.includes('/issue-token')) {
      return mockResponse(200, {
        access_token: 'candidate_access_token_that_should_not_persist',
        refresh_token: 'candidate_refresh_token_that_should_not_persist'
      });
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    id: 999,
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: initialApiKey,
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: { refresh_token: initialRefreshToken },
    fetchFn: mockFetch,
    requirePersistence: true,
    onTokenRotated: async () => {
      throw new Error('Simulated database deadlock during token write');
    }
  });

  const res = await pathao.refreshAccessToken();
  assert.equal(res.success, false, 'Must report failure when durable persistence fails');
  assert.match(res.error, /Simulated database deadlock/);

  // CRITICAL AUDIT ASSERTION: Memory state MUST NOT be updated if persistence fails
  assert.equal(pathao.apiKey, initialApiKey, 'apiKey in memory must remain initial value');
  assert.equal(pathao.refreshToken, initialRefreshToken, 'refreshToken in memory must remain initial value');
});

test('Pathao OAuth Concurrency: simultaneous refresh requests share single in-flight rotation lock', async () => {
  let issueTokenCallCount = 0;

  const mockFetch = async (url) => {
    if (url.includes('/issue-token')) {
      issueTokenCallCount++;
      // Simulate 50ms network roundtrip to ensure concurrent callers overlap
      await new Promise((r) => setTimeout(r, 50));
      return mockResponse(200, {
        access_token: `rotated_token_${issueTokenCallCount}`,
        refresh_token: `rotated_refresh_${issueTokenCallCount}`
      });
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'shared_expired_key',
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: { refresh_token: 'shared_initial_refresh' },
    fetchFn: mockFetch
  });

  // Launch 10 simultaneous refresh requests
  const concurrentCalls = Array.from({ length: 10 }, () => pathao.refreshAccessToken());
  const results = await Promise.all(concurrentCalls);

  // CRITICAL AUDIT ASSERTION: Exactly ONE HTTP call must be made to Pathao
  assert.equal(issueTokenCallCount, 1, 'Only one HTTP request must be made across concurrent refresh calls');

  // All 10 results must succeed and have the exact same access token
  for (const r of results) {
    assert.equal(r.success, true);
    assert.equal(r.accessToken, 'rotated_token_1');
    assert.equal(r.refreshToken, 'rotated_refresh_1');
  }
});

test('Pathao OAuth Failure Categorization: network errors, timeouts, 429 and 5xx MUST NOT trigger fallback recovery', async () => {
  const credentials = {
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: {
      refresh_token: 'active_refresh_token',
      username: 'user@mrtumi.com',
      password: 'secret_password'
    }
  };

  // 1. Network Error -> no recovery
  let recoveryAttempted = false;
  const networkErrorFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    throw new TypeError('Failed to fetch (ECONNREFUSED)');
  };
  const pathaoNetErr = new PathaoAdapter({ ...credentials, fetchFn: networkErrorFetch });
  const netRes = await pathaoNetErr.refreshAccessToken();
  assert.equal(netRes.success, false);
  assert.equal(recoveryAttempted, false, 'Network error must NOT trigger credential recovery');

  // 2. Network Timeout -> no recovery
  recoveryAttempted = false;
  const timeoutFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  const pathaoTimeout = new PathaoAdapter({ ...credentials, fetchFn: timeoutFetch });
  const timeoutRes = await pathaoTimeout.refreshAccessToken();
  assert.equal(timeoutRes.success, false);
  assert.equal(timeoutRes.isTimeout, true);
  assert.equal(recoveryAttempted, false, 'Timeout must NOT trigger credential recovery');

  // 3. HTTP 429 Rate Limit -> no recovery
  recoveryAttempted = false;
  const rateLimitFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    return mockResponse(429, { message: 'Too many requests' });
  };
  const pathao429 = new PathaoAdapter({ ...credentials, fetchFn: rateLimitFetch });
  const res429 = await pathao429.refreshAccessToken();
  assert.equal(res429.success, false);
  assert.equal(res429.isRateLimit, true);
  assert.equal(recoveryAttempted, false, 'HTTP 429 rate limit must NOT trigger credential recovery');

  // 4. HTTP 500 Server Error -> no recovery
  recoveryAttempted = false;
  const serverErrorFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    return mockResponse(500, { message: 'Internal server error at Pathao' });
  };
  const pathao500 = new PathaoAdapter({ ...credentials, fetchFn: serverErrorFetch });
  const res500 = await pathao500.refreshAccessToken();
  assert.equal(res500.success, false);
  assert.equal(res500.isServerError, true);
  assert.equal(recoveryAttempted, false, 'HTTP 500 server error must NOT trigger credential recovery');

  // 5. Provider-confirmed invalid_grant (HTTP 400) -> TRIGGERS credential recovery
  recoveryAttempted = false;
  const invalidGrantFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'refresh_token') {
      return mockResponse(400, { error: 'invalid_grant', message: 'The refresh token is invalid or expired.' });
    }
    if (body.grant_type === 'password') {
      recoveryAttempted = true;
      return mockResponse(200, { access_token: 'recovered_tok', refresh_token: 'recovered_ref' });
    }
    return mockResponse(404, {});
  };
  const pathaoInvalid = new PathaoAdapter({ ...credentials, fetchFn: invalidGrantFetch });
  const resInvalid = await pathaoInvalid.refreshAccessToken();
  assert.equal(resInvalid.success, true);
  assert.equal(resInvalid.recovered, true, 'invalid_grant must trigger credential recovery');
  assert.equal(recoveryAttempted, true);
});

test('Pathao OAuth Database Persistence: real disposable MySQL/MariaDB integration test', async () => {
  const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
  if (!MYSQL_HOST) {
    // Expected in local Windows dev environment without local mysqld
    return;
  }

  const mysqlPool = require('../src/db/mysqlPool');
  // Insert a temporary courier provider record in courier_apis
  const testCode = `pth_test_${Date.now()}`;
  const insertRes = await mysqlPool.execute(
    `INSERT INTO courier_apis (name, code, provider_type, base_url, api_key, secret_key, client_id, status, sandbox, supports_live_quotes, service_options_json)
     VALUES (?, ?, 'pathao', 'https://api-hermes.pathao.com', 'initial_key', 'test_sec', 'test_cid', 1, 0, 0, ?)`,
    ['Pathao CI Integration Test', testCode, JSON.stringify({ refresh_token: 'initial_refresh_token_ci', store_id: 1 })]
  );
  const providerId = insertRes.insertId;

  try {
    const mockFetch = async (url) => {
      if (url.includes('/issue-token')) {
        return mockResponse(200, {
          access_token: 'ci_live_persisted_access_token',
          refresh_token: 'ci_live_persisted_refresh_token'
        });
      }
      return mockResponse(404, {});
    };

    const pathao = new PathaoAdapter({
      id: providerId,
      code: testCode,
      base_url: 'https://api-hermes.pathao.com',
      api_key: 'initial_key',
      client_id: 'test_cid',
      client_secret: 'test_sec',
      service_options_json: { refresh_token: 'initial_refresh_token_ci', store_id: 1 },
      fetchFn: mockFetch,
      requirePersistence: true
    });

    const refreshResult = await pathao.refreshAccessToken();
    assert.equal(refreshResult.success, true);

    // Query database directly to confirm durable persistence
    const dbRow = await mysqlPool.queryOne('SELECT api_key, service_options_json FROM courier_apis WHERE id = ?', [providerId]);
    assert.ok(dbRow, 'DB row must exist');

    // Decrypt DB api_key and verify
    assert.equal(decryptProviderToken(dbRow.api_key), 'ci_live_persisted_access_token');

    // Parse service_options_json from DB
    const dbOpts = JSON.parse(dbRow.service_options_json);
    assert.equal(dbOpts.refresh_token, undefined, 'Plaintext refresh_token must never exist in database');
    assert.ok(dbOpts.encrypted_refresh_token, 'Encrypted refresh token must be stored in database');
    assert.equal(decryptProviderToken(dbOpts.encrypted_refresh_token), 'ci_live_persisted_refresh_token');

  } finally {
    await mysqlPool.execute('DELETE FROM courier_apis WHERE id = ?', [providerId]);
  }
});
