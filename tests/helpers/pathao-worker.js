'use strict';

const mysqlPool = require('../../src/db/mysqlPool');
const PathaoAdapter = require('../../src/services/courier/adapters/PathaoAdapter');

async function run() {
  const providerId = Number(process.argv[2]);
  const mockPort = Number(process.argv[3]);
  const initialRefresh = process.argv[4] || null;

  if (!providerId || !mockPort) {
    console.error(JSON.stringify({ error: 'Missing providerId or mockPort' }));
    process.exit(1);
  }

  try {
    const adapter = new PathaoAdapter({
      id: providerId,
      code: 'pathao_worker_test',
      base_url: `http://127.0.0.1:${mockPort}`,
      client_id: 'cid_worker',
      client_secret: 'csec_worker',
      service_options_json: {
        encrypted_refresh_token: initialRefresh,
        store_id: 1
      }
    });

    const result = await adapter.refreshAccessToken();

    console.log(JSON.stringify({
      pid: process.pid,
      success: Boolean(result.success),
      accessToken: result.accessToken || null,
      adopted: Boolean(result.adopted || result.adoptedFromConcurrentProcess),
      error: result.error || null
    }));

    try {
      await mysqlPool.closePool();
    } catch (_e) {}

    process.exit(result.success ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ pid: process.pid, error: err.message }));
    try {
      await mysqlPool.closePool();
    } catch (_e) {}
    process.exit(1);
  }
}

run();
