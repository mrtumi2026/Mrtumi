'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { dropDisposableMysqlSchema } = require('../scripts/qa/mysql-test-database');
const { cleanupE2eResources } = require('../scripts/qa/demo-e2e-cleanup');

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

    const wrongSchema = fakePool({ connectedDatabase: 'not_mrtumi_test' });
    await assert.rejects(dropDisposableMysqlSchema(wrongSchema.pool), /connected schema is not mrtumi_test/);
    assert.equal(wrongSchema.released(), true);
    assert.equal(wrongSchema.calls.some((sql) => sql.startsWith('DROP TABLE')), false);
  } finally { restore(); }
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
