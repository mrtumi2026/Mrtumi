'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { dropDisposableMysqlSchema } = require('../scripts/qa/mysql-test-database');
const { closeBrowser, closeHttpServer, cleanupE2eResources } = require('../scripts/qa/demo-e2e-cleanup');

function setDisposableProfile() {
  const keys = ['NODE_ENV', 'DB_CLIENT', 'MYSQL_TEST_REQUIRED', 'DB_NAME', 'DB_HOST'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_CLIENT: 'mysql', MYSQL_TEST_REQUIRED: 'true',
    DB_NAME: 'mrtumi_test', DB_HOST: '127.0.0.1',
  });
  return () => keys.forEach((key) => {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  });
}

function fakePool({ connectedDatabase = 'mrtumi_test', failDrop = false } = {}) {
  const calls = [];
  let released = false;
  const connection = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'SELECT DATABASE() AS database_name') return [[{ database_name: connectedDatabase }], []];
      if (sql.startsWith('SELECT TABLE_NAME')) return [[{ table_name: 'test_view', table_type: 'VIEW' }, { table_name: 'orders', table_type: 'BASE TABLE' }, { table_name: 'schema_migrations', table_type: 'BASE TABLE' }], []];
      if (failDrop && sql.startsWith('DROP TABLE')) throw new Error('synthetic drop failure');
      return [{ affectedRows: 0 }, []];
    },
    release() { released = true; },
  };
  return { pool: { getConnection: async () => connection }, calls, released: () => released };
}

test('disposable MySQL schema reset refuses any profile outside the required local test database', async () => {
  const restore = setDisposableProfile();
  try {
    process.env.DB_NAME = 'production';
    const fixture = fakePool();
    await assert.rejects(dropDisposableMysqlSchema(fixture.pool), /Refusing destructive MySQL test reset/);
    assert.equal(fixture.calls.length, 0, 'no connection or SQL is issued after the profile guard fails');
  } finally { restore(); }
});

test('disposable reset verifies the actual schema and always restores foreign-key checks and releases its connection', async () => {
  const restore = setDisposableProfile();
  try {
    const fixture = fakePool({ failDrop: true });
    await assert.rejects(dropDisposableMysqlSchema(fixture.pool), /synthetic drop failure/);
    assert.ok(fixture.calls.includes('SET FOREIGN_KEY_CHECKS = 1'));
    assert.ok(fixture.calls.some((sql) => sql.startsWith('DROP VIEW IF EXISTS `test_view`')));
    assert.equal(fixture.released(), true);

    const success = fakePool();
    await dropDisposableMysqlSchema(success.pool);
    assert.ok(success.calls.includes('SET FOREIGN_KEY_CHECKS = 1'));
    assert.ok(success.calls.some((sql) => sql.startsWith('DROP VIEW IF EXISTS `test_view`')));
    assert.ok(success.calls.some((sql) => sql.startsWith('DROP TABLE IF EXISTS `orders`')));
    assert.equal(success.released(), true);

    const wrongSchema = fakePool({ connectedDatabase: 'not_mrtumi_test' });
    await assert.rejects(dropDisposableMysqlSchema(wrongSchema.pool), /connected schema is not mrtumi_test/);
    assert.equal(wrongSchema.released(), true);
    assert.equal(wrongSchema.calls.some((sql) => sql.startsWith('DROP TABLE')), false);
  } finally { restore(); }
});

test('HTTP server closes gracefully without forcing active connections', async () => {
  let forced = 0;
  const server = {
    listening: true,
    close(callback) { callback(); },
    closeAllConnections() { forced += 1; },
  };
  await closeHttpServer(server, 25);
  assert.equal(forced, 0);
});

test('HTTP server shutdown is bounded and force-closes connections only after timeout', async () => {
  let forced = 0;
  const server = {
    listening: true,
    close() {},
    closeAllConnections() { forced += 1; },
  };
  await assert.rejects(closeHttpServer(server, 10), /HTTP server close exceeded 10ms/);
  assert.equal(forced, 1);
});

test('browser shutdown timeout kills the browser process and reports the timeout', async () => {
  const kills = [];
  const browser = {
    close() { return new Promise(() => {}); },
    process() { return { kill(signal) { kills.push(signal); } }; },
  };
  await assert.rejects(closeBrowser(browser, 10), /Browser close exceeded 10ms/);
  assert.deepEqual(kills, ['SIGKILL']);
});

test('cleanup continues through browser and server close errors and still closes the DB pool', async () => {
  let poolClosed = false;
  const server = {
    listening: true,
    close(callback) { callback(new Error('synthetic server close failure')); },
    closeAllConnections() { assert.fail('force close should be reserved for timeout'); },
  };
  const errors = await cleanupE2eResources({
    browser: { async close() { throw new Error('synthetic browser close failure'); } },
    server,
    pool: {},
    async resetDatabase() { throw new Error('synthetic schema reset failure'); },
    async closePool() { poolClosed = true; },
  });
  assert.equal(poolClosed, true);
  assert.deepEqual(errors.map(({ resource }) => resource), ['browser', 'server', 'database-reset']);
});

test('E2E cleanup closes the DB pool even when disposable schema cleanup rejects', async () => {
  let browserClosed = false;
  let poolClosed = false;
  const errors = await cleanupE2eResources({
    browser: { async close() { browserClosed = true; } },
    server: null,
    pool: {},
    async resetDatabase() { throw new Error('synthetic rollback/reset failure'); },
    async closePool() { poolClosed = true; },
  });
  assert.equal(browserClosed, true);
  assert.equal(poolClosed, true);
  assert.deepEqual(errors.map(({ resource }) => resource), ['database-reset']);
});

test('E2E cleanup closes the DB pool and records success after schema cleanup succeeds', async () => {
  let poolClosed = false;
  const errors = await cleanupE2eResources({
    browser: null,
    server: null,
    pool: {},
    async resetDatabase() {},
    async closePool() { poolClosed = true; },
  });
  assert.equal(poolClosed, true);
  assert.deepEqual(errors, []);
});

test('E2E cleanup lets a child Node process exit after successful reset', () => {
  const childScript = `
    const { cleanupE2eResources } = require('./scripts/qa/demo-e2e-cleanup');
    const pending = setInterval(() => {}, 1000);
    cleanupE2eResources({
      pool: {},
      async resetDatabase() {},
      async closePool() { clearInterval(pending); },
    }).then((errors) => {
      if (errors.length !== 0) process.exitCode = 2;
      else process.stdout.write('cleanup-succeeded-and-pool-closed\\n');
    }).catch(() => { process.exitCode = 3; });
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /cleanup-succeeded-and-pool-closed/);
});

test('E2E cleanup lets a child Node process exit after reset failure', () => {
  const childScript = `
    const { cleanupE2eResources } = require('./scripts/qa/demo-e2e-cleanup');
    const pending = setInterval(() => {}, 1000);
    cleanupE2eResources({
      pool: {},
      async resetDatabase() { throw new Error('expected cleanup failure'); },
      async closePool() { clearInterval(pending); },
    }).then((errors) => {
      if (errors.length !== 1 || errors[0].resource !== 'database-reset') process.exitCode = 2;
      else process.stdout.write('cleanup-failed-but-pool-closed\\n');
    }).catch(() => { process.exitCode = 3; });
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /cleanup-failed-but-pool-closed/);
});
