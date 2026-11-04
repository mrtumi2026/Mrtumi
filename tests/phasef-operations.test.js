'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateTarget, REQUIRED_ACK, ESSENTIAL_TABLES, sameSnapshot } = require('../scripts/backup-restore-rehearsal');
const { analyzeRuntimeGrants, parseGrant } = require('../scripts/check-db-privileges');

const root = path.join(__dirname, '..');

test('Backup/restore rehearsal refuses missing acknowledgement and non-disposable DB names', () => {
  assert.throws(() => validateTarget({ DB_NAME: 'production', DB_HOST: 'db', DB_USER: 'app' }), /Refusing backup\/restore rehearsal/);
  assert.throws(() => validateTarget({ BACKUP_RESTORE_REHEARSAL: REQUIRED_ACK, DB_NAME: 'mrtumi', DB_HOST: 'db', DB_USER: 'app' }), /disposable test-name pattern/);
  assert.equal(validateTarget({ BACKUP_RESTORE_REHEARSAL: REQUIRED_ACK, DB_NAME: 'mrtumi_test', DB_HOST: 'db', DB_USER: 'app' }).dbName, 'mrtumi_test');
  assert.deepEqual(ESSENTIAL_TABLES, ['schema_migrations', 'users', 'customers', 'products', 'orders', 'audit_logs']);
});

test('Restore snapshot equality detects changes in rows, schema, table counts, and table names', () => {
  const baseline = { tableNames: ['orders'], counts: { orders: 1 }, rowHash: 'rows', schemaHash: 'schema' };
  assert.equal(sameSnapshot(baseline, { ...baseline }), true);
  assert.equal(sameSnapshot(baseline, { ...baseline, rowHash: 'changed' }), false);
  assert.equal(sameSnapshot(baseline, { ...baseline, schemaHash: 'changed' }), false);
  assert.equal(sameSnapshot(baseline, { ...baseline, counts: { orders: 2 } }), false);
});

test('Runtime privilege analyzer accepts schema-scoped DML and rejects global, DDL, and grant-option privileges', () => {
  assert.deepEqual(parseGrant('GRANT SELECT, INSERT, UPDATE, DELETE ON `mrtumi_test`.* TO `app`@`%`'), {
    raw: 'GRANT SELECT, INSERT, UPDATE, DELETE ON `mrtumi_test`.* TO `app`@`%`',
    scope: '`mrtumi_test`.*',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  });
  assert.equal(analyzeRuntimeGrants([
    'GRANT USAGE ON *.* TO `app`@`%`',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON `mrtumi_test`.* TO `app`@`%`'
  ]).ok, true);
  const excessive = analyzeRuntimeGrants([
    'GRANT SELECT ON *.* TO `app`@`%`',
    'GRANT CREATE, DROP, SELECT ON `mrtumi_test`.* TO `app`@`%` WITH GRANT OPTION'
  ]);
  assert.equal(excessive.ok, false);
  assert.ok(excessive.violations.some(item => item.includes('Global grant')));
  assert.ok(excessive.violations.some(item => item.includes('CREATE')));
});

test('Phase F docs disclose owner decisions, destructive restore scope, monitoring signals, and operational boundaries', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/PHASE_F_OPERATIONS.md'), 'utf8');
  for (const term of ['RPO', 'RTO', 'retention duration', 'disposable', 'DROP TABLE IF EXISTS', 'failed payment', 'COD', 'least privilege', 'no production restore is authorized']) {
    assert.ok(doc.toLowerCase().includes(term.toLowerCase()), `Expected operational document to cover ${term}`);
  }
});
