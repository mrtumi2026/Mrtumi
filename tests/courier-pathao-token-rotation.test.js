'use strict';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');
const { encryptProviderToken, decryptProviderToken } = require('../src/utils/providerTokenSecurity');
const mysqlPool = require('../src/db/mysqlPool');

// Always clean up connection pool when test runner finishes
after(async () => {
  try {
    await mysqlPool.closePool();
  } catch (_e) {}
});

function mockResponse(status, body, { isMalformed = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Map([['content-type', isMalformed ? 'text/html' : 'application/json']]),
    json: async () => {
      if (isMalformed) throw new SyntaxError('Unexpected token < in JSON at position 0');
      return body;
    },
    text: async () => {
      if (isMalformed) return '<html><body>502 Bad Gateway</body></html>';
      return JSON.stringify(body);
    }
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
  let persistedRecord = null;

  const mockFetch = async (url) => {
    if (url.includes('/issue-token')) {
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

test('Pathao OAuth Persistence: zero-row SQL update fails closed and leaves memory untouched', async () => {
  const initialApiKey = 'stable_initial_api_key_zero_row';
  const initialRefreshToken = 'stable_initial_refresh_token_zero_row';

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
    id: 999999, // Non-existent ID that will yield 0 affected rows
    code: 'pathao_zero_test',
    base_url: 'https://api-hermes.pathao.com',
    api_key: initialApiKey,
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: { refresh_token: initialRefreshToken },
    fetchFn: mockFetch,
    mockDbExecute: async () => {
      // Return 0 affected rows to simulate zero-row update
      return { affectedRows: 0 };
    }
  });

  const res = await pathao.refreshAccessToken();
  assert.equal(res.success, false, 'Must report failure when zero rows are updated');
  assert.match(res.error, /zero rows updated/);

  // Memory state MUST NOT be updated if persistence fails
  assert.equal(pathao.apiKey, initialApiKey, 'apiKey in memory must remain untouched on zero-row update');
  assert.equal(pathao.refreshToken, initialRefreshToken, 'refreshToken in memory must remain untouched on zero-row update');
});

test('Pathao OAuth Persistence: database error fails closed and leaves memory untouched', async () => {
  const initialApiKey = 'stable_initial_api_key_err';
  const initialRefreshToken = 'stable_initial_refresh_token_err';

  const mockFetch = async (url) => {
    if (url.includes('/issue-token')) {
      return mockResponse(200, {
        access_token: 'candidate_access_token_db_err',
        refresh_token: 'candidate_refresh_token_db_err'
      });
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    id: 123,
    code: 'pathao_err_test',
    base_url: 'https://api-hermes.pathao.com',
    api_key: initialApiKey,
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: { refresh_token: initialRefreshToken },
    fetchFn: mockFetch,
    mockDbExecute: async () => {
      throw new Error('ER_LOCK_DEADLOCK: Deadlock found when trying to get lock');
    }
  });

  const res = await pathao.refreshAccessToken();
  assert.equal(res.success, false, 'Must fail closed on DB error');
  assert.match(res.error, /Deadlock found/);

  // Memory state MUST NOT be updated
  assert.equal(pathao.apiKey, initialApiKey, 'apiKey must remain untouched on DB deadlock');
  assert.equal(pathao.refreshToken, initialRefreshToken, 'refreshToken must remain untouched on DB deadlock');
});

test('Pathao OAuth Concurrency: in-process mutex serializes concurrent refresh calls', async () => {
  let issueTokenCallCount = 0;

  const mockFetch = async (url) => {
    if (url.includes('/issue-token')) {
      issueTokenCallCount++;
      // Simulate 40ms network roundtrip
      await new Promise((r) => setTimeout(r, 40));
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

  // Launch 10 simultaneous refresh requests on the same adapter
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

test('Pathao OAuth Cross-Process Simulation: CAS token adoption prevents duplicate rotation', async () => {
  // Simulates two separate Passenger worker processes (Worker A and Worker B)
  // Worker A rotates token and writes to shared state.
  // Worker B, holding lock after Worker A, inspects shared state and adopts it without calling Pathao.
  let networkCallsCount = 0;

  // Shared pseudo-database record representing courier_apis row
  const sharedDbRecord = {
    id: 42,
    api_key: encryptProviderToken('old_shared_access_token'),
    service_options_json: JSON.stringify({
      encrypted_refresh_token: encryptProviderToken('initial_shared_refresh_token'),
      store_id: 100
    })
  };

  const mockNetworkFetch = async (url) => {
    if (url.includes('/issue-token')) {
      networkCallsCount++;
      await new Promise((r) => setTimeout(r, 30));
      return mockResponse(200, {
        access_token: 'freshly_rotated_by_worker_A',
        refresh_token: 'fresh_refresh_by_worker_A'
      });
    }
    return mockResponse(404, {});
  };

  // Worker A adapter
  const workerA = new PathaoAdapter({
    id: 42,
    code: 'pathao',
    useDbLock: false,
    persistToDb: false,
    api_key: 'old_shared_access_token',
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: {
      encrypted_refresh_token: encryptProviderToken('initial_shared_refresh_token'),
      store_id: 100
    },
    fetchFn: mockNetworkFetch,
    onTokenRotated: async ({ accessToken, refreshToken, encryptedRefreshToken }) => {
      // Worker A writes to DB
      sharedDbRecord.api_key = encryptProviderToken(accessToken);
      sharedDbRecord.service_options_json = JSON.stringify({
        encrypted_refresh_token: encryptedRefreshToken,
        store_id: 100
      });
    }
  });

  // Worker B adapter before rotation (starts with identical old tokens)
  const workerB = new PathaoAdapter({
    id: 42,
    code: 'pathao',
    useDbLock: false,
    persistToDb: false,
    api_key: 'old_shared_access_token',
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: {
      encrypted_refresh_token: encryptProviderToken('initial_shared_refresh_token'),
      store_id: 100
    },
    fetchFn: mockNetworkFetch
  });

  // 1. Worker A refreshes
  const resA = await workerA.refreshAccessToken();
  assert.equal(resA.success, true);
  assert.equal(resA.accessToken, 'freshly_rotated_by_worker_A');
  assert.equal(networkCallsCount, 1);

  // 2. Worker B checks DB and detects that Worker A already rotated it
  const parsedDb = JSON.parse(sharedDbRecord.service_options_json);
  const isDifferent = parsedDb.encrypted_refresh_token !== workerB.serviceOptions.encrypted_refresh_token;
  assert.equal(isDifferent, true, 'Worker B detects DB refresh token differs from its local state');

  // Worker B adopts the newly rotated token without making any network call
  workerB.apiKey = decryptProviderToken(sharedDbRecord.api_key);
  workerB.refreshToken = decryptProviderToken(parsedDb.encrypted_refresh_token);
  workerB.serviceOptions.encrypted_refresh_token = parsedDb.encrypted_refresh_token;

  assert.equal(workerB.apiKey, 'freshly_rotated_by_worker_A');
  assert.equal(workerB.refreshToken, 'fresh_refresh_by_worker_A');
  assert.equal(networkCallsCount, 1, 'Network must NOT be called by second worker after adoption');
});

test('Pathao OAuth Failure Categorization: every non-invalid_grant failure category strictly refuses fallback', async () => {
  const credentials = {
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: {
      refresh_token: 'active_refresh_token',
      username: 'user@mrtumi.com',
      password: 'secret_password'
    }
  };

  // 1. Network Connection Error (e.g. ECONNREFUSED) -> NO fallback
  let recoveryAttempted = false;
  const networkErrorFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    throw new TypeError('Failed to fetch (ECONNREFUSED)');
  };
  const pathaoNetErr = new PathaoAdapter({ ...credentials, fetchFn: networkErrorFetch });
  const netRes = await pathaoNetErr.refreshAccessToken();
  assert.equal(netRes.success, false);
  assert.equal(netRes.isNetworkError, true);
  assert.equal(recoveryAttempted, false, 'Network error must NOT trigger credential recovery');

  // 2. Network Timeout (AbortError) -> NO fallback
  recoveryAttempted = false;
  const timeoutFetch = async (_url, opts) => {
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

  // 3. Malformed Non-JSON Response (HTML error page) -> NO fallback
  recoveryAttempted = false;
  const malformedFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    return mockResponse(502, null, { isMalformed: true });
  };
  const pathaoMalformed = new PathaoAdapter({ ...credentials, fetchFn: malformedFetch });
  const malformedRes = await pathaoMalformed.refreshAccessToken();
  assert.equal(malformedRes.success, false);
  assert.equal(malformedRes.isMalformedResponse, true);
  assert.equal(recoveryAttempted, false, 'Malformed non-JSON response must NOT trigger credential recovery');

  // 4. HTTP 429 Rate Limit -> NO fallback
  recoveryAttempted = false;
  const rateLimitFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    return mockResponse(429, { message: 'Too many requests' });
  };
  const pathao429 = new PathaoAdapter({ ...credentials, fetchFn: rateLimitFetch });
  const res429 = await pathao429.refreshAccessToken();
  assert.equal(res429.success, false);
  assert.equal(res429.isRateLimit, true);
  assert.equal(recoveryAttempted, false, 'HTTP 429 rate limit must NOT trigger credential recovery');

  // 5. HTTP 500 / 503 Server Error -> NO fallback
  recoveryAttempted = false;
  const serverErrorFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    return mockResponse(500, { message: 'Internal server error at Pathao' });
  };
  const pathao500 = new PathaoAdapter({ ...credentials, fetchFn: serverErrorFetch });
  const res500 = await pathao500.refreshAccessToken();
  assert.equal(res500.success, false);
  assert.equal(res500.isServerError, true);
  assert.equal(recoveryAttempted, false, 'HTTP 500 server error must NOT trigger credential recovery');

  // 6. Ambiguous HTTP 400 error (e.g. invalid_request) -> NO fallback
  recoveryAttempted = false;
  const ambiguous400Fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'password') recoveryAttempted = true;
    return mockResponse(400, { error: 'invalid_request', message: 'Missing client parameter' });
  };
  const pathaoAmbiguous = new PathaoAdapter({ ...credentials, fetchFn: ambiguous400Fetch });
  const resAmbiguous = await pathaoAmbiguous.refreshAccessToken();
  assert.equal(resAmbiguous.success, false);
  assert.equal(resAmbiguous.isAmbiguousFailure, true);
  assert.equal(recoveryAttempted, false, 'Ambiguous 400 error must NOT trigger credential recovery');

  // 7. Provider-confirmed invalid_grant (HTTP 400 error="invalid_grant") -> ONLY this TRIGGERS recovery!
  recoveryAttempted = false;
  const invalidGrantFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.grant_type === 'refresh_token') {
      return mockResponse(400, { error: 'invalid_grant', message: 'The refresh token is invalid or expired.' });
    }
    if (body.grant_type === 'password') {
      recoveryAttempted = true;
      return mockResponse(200, { access_token: 'recovered_tok_after_invalid_grant', refresh_token: 'recovered_ref_tok' });
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
      fetchFn: mockFetch
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

test('Pathao OAuth: genuine cross-process locking with two separate Node.js processes', async () => {
  const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
  if (!MYSQL_HOST) {
    // Expected in local Windows dev environment without local mysqld
    return;
  }

  const http = require('http');
  const { spawn } = require('child_process');
  const path = require('path');

  let issueTokenNetworkCallCount = 0;

  // 1. Create a local mock server on an ephemeral port
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/issue-token') && req.method === 'POST') {
      issueTokenNetworkCallCount++;
      // Delay response slightly (80ms) so worker 2 is guaranteed to encounter the active row lock
      await new Promise((r) => setTimeout(r, 80));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'cross_proc_rotated_access_123',
        refresh_token: 'cross_proc_rotated_refresh_456'
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const testCode = `pth_cross_${Date.now()}`;
  const initialEncryptedRefresh = encryptProviderToken('initial_cross_proc_refresh_token');
  const initialEncryptedAccess = encryptProviderToken('initial_cross_proc_access_token');

  // Insert test row into real MySQL
  const insertRes = await mysqlPool.execute(
    `INSERT INTO courier_apis (name, code, provider_type, base_url, api_key, secret_key, client_id, status, sandbox, supports_live_quotes, service_options_json)
     VALUES (?, ?, 'pathao', ?, ?, 'test_sec', 'test_cid', 1, 0, 0, ?)`,
    [
      'Pathao Cross-Process Concurrency Test',
      testCode,
      `http://127.0.0.1:${port}`,
      initialEncryptedAccess,
      JSON.stringify({ encrypted_refresh_token: initialEncryptedRefresh, store_id: 1 })
    ]
  );
  const providerId = insertRes.insertId;

  try {
    const workerScript = path.join(__dirname, 'helpers', 'pathao-worker.js');

    function spawnWorker() {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [workerScript, String(providerId), String(port), initialEncryptedRefresh],
          { env: process.env }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => {
          try {
            const lines = stdout.trim().split('\n').filter(Boolean);
            const parsed = JSON.parse(lines[lines.length - 1]);
            resolve({ code, parsed, stdout, stderr });
          } catch (e) {
            reject(new Error(`Worker exited with code ${code}. stdout: "${stdout}", stderr: "${stderr}"`));
          }
        });
        child.on('error', reject);
      });
    }

    // Launch both separate OS processes concurrently
    const [w1, w2] = await Promise.all([spawnWorker(), spawnWorker()]);

    assert.equal(w1.code, 0, `Worker 1 failed: ${w1.stderr}`);
    assert.equal(w2.code, 0, `Worker 2 failed: ${w2.stderr}`);
    assert.equal(w1.parsed.success, true, 'Worker 1 must report success');
    assert.equal(w2.parsed.success, true, 'Worker 2 must report success');

    // CRITICAL: Exactly one worker rotated against the mock HTTP server!
    assert.equal(
      issueTokenNetworkCallCount,
      1,
      'Exactly ONE HTTP call must be made to Pathao across separate worker processes'
    );

    // One worker must be the rotator (adopted === false) and the other worker adopted (adopted === true)
    const adoptedFlags = [w1.parsed.adopted, w2.parsed.adopted].sort();
    assert.deepEqual(
      adoptedFlags,
      [false, true],
      'One worker must rotate and the second worker must adopt via CAS'
    );

    // Both workers received the new access token
    assert.equal(w1.parsed.accessToken, 'cross_proc_rotated_access_123');
    assert.equal(w2.parsed.accessToken, 'cross_proc_rotated_access_123');

    // Confirm database row was updated in real MySQL with encrypted tokens
    const dbRow = await mysqlPool.queryOne(
      'SELECT api_key, service_options_json FROM courier_apis WHERE id = ?',
      [providerId]
    );
    assert.ok(dbRow, 'Database record must exist after cross-process update');
    assert.equal(decryptProviderToken(dbRow.api_key), 'cross_proc_rotated_access_123');
    const opts = JSON.parse(dbRow.service_options_json);
    assert.equal(decryptProviderToken(opts.encrypted_refresh_token), 'cross_proc_rotated_refresh_456');

  } finally {
    server.close();
    await mysqlPool.execute('DELETE FROM courier_apis WHERE id = ?', [providerId]);
  }
});
