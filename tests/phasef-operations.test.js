'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateTarget, REQUIRED_ACK, ESSENTIAL_TABLES, run, sameSnapshot, verifyBackupArtifact, restoreAndVerify } = require('../scripts/backup-restore-rehearsal');
const { analyzeRuntimeGrants, parseGrant } = require('../scripts/check-db-privileges');

const root = path.join(__dirname, '..');

test('Backup/restore rehearsal refuses missing acknowledgement and non-disposable DB names', () => {
  assert.throws(() => validateTarget({ DB_NAME: 'production', DB_HOST: 'db', DB_USER: 'app' }), /Refusing backup\/restore rehearsal/);
  assert.throws(() => validateTarget({ BACKUP_RESTORE_REHEARSAL: REQUIRED_ACK, DB_NAME: 'mrtumi', DB_HOST: 'db', DB_USER: 'app' }), /disposable test-name pattern/);
  assert.equal(validateTarget({ BACKUP_RESTORE_REHEARSAL: REQUIRED_ACK, DB_NAME: 'mrtumi_test', DB_HOST: 'localhost', DB_USER: 'app' }).dbName, 'mrtumi_test');
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
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    hasGrantOption: false
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
  assert.ok(excessive.violations.some(item => item.includes('WITH GRANT OPTION')));

  const unreviewed = analyzeRuntimeGrants([
    'GRANT EXECUTE ON `mrtumi_test`.* TO `app`@`%`',
    "GRANT 'reporting_role'@'%' TO `app`@`%`"
  ]);
  assert.equal(unreviewed.ok, false);
  assert.ok(unreviewed.violations.some(item => item.includes('EXECUTE')));
  assert.ok(unreviewed.violations.some(item => item.includes('role assignment')));
});

test('Backup/restore guard rejects remote hosts and invalid ports even with disposable-name acknowledgement', () => {
  const acknowledged = { BACKUP_RESTORE_REHEARSAL: REQUIRED_ACK, DB_NAME: 'mrtumi_test', DB_HOST: 'db.example.invalid', DB_USER: 'test' };
  assert.throws(() => validateTarget(acknowledged), /loopback address/);
  assert.throws(() => validateTarget({ ...acknowledged, DB_HOST: '127.0.0.1', DB_PORT: '70000' }), /DB_PORT/);
  assert.equal(validateTarget({ ...acknowledged, DB_HOST: 'localhost' }).host, 'localhost');
});

test('Backup command failures propagate as errors instead of yielding an empty/false-success artifact', () => {
  assert.throws(() => run(process.execPath, ['-e', 'process.stderr.write("backup failed"); process.exit(17)']), /failed with exit code 17/);
  assert.throws(() => run('mrtumi-no-such-backup-command'), /is unavailable/);
});

test('Backup artifact integrity rejects empty and modified artifacts', () => {
  const expected = require('node:crypto').createHash('sha256').update('valid sql dump').digest('hex');
  assert.equal(verifyBackupArtifact(expected, Buffer.from('valid sql dump')), expected);
  assert.throws(() => verifyBackupArtifact(expected, Buffer.alloc(0)), { code: 'BACKUP_ARTIFACT_INTEGRITY_FAILED' });
  assert.throws(() => verifyBackupArtifact(expected, Buffer.from('truncated dump')), { code: 'BACKUP_ARTIFACT_INTEGRITY_FAILED' });
});

test('Interrupted restore is explicitly classified as partial and unsafe to reuse', async () => {
  await assert.rejects(
    restoreAndVerify({ before: {}, restore: async () => { throw new Error('SIGTERM'); }, snapshot: async () => ({}), checkIntegrity: async () => {} }),
    error => error.code === 'RESTORE_COMMAND_FAILED' && error.message.includes('discarded and recreated')
  );
});

test('Restore rejects mismatched schema and row-content snapshots', async () => {
  const before = { tables: ['orders'], schema: 'schema-a', data: 'rows-a' };
  const unchangedCalls = { restore: 0 };
  const restore = async () => { unchangedCalls.restore += 1; };
  for (const after of [
    { tables: ['orders'], schema: 'schema-b', data: 'rows-a' },
    { tables: ['orders'], schema: 'schema-a', data: 'rows-b' }
  ]) {
    await assert.rejects(
      restoreAndVerify({ before, restore, snapshot: async () => after, checkIntegrity: async () => {} }),
      error => error.code === 'RESTORE_VERIFICATION_MISMATCH'
    );
  }
  assert.equal(unchangedCalls.restore, 2);
});

test('Restore verification distinguishes inaccessible state and failed integrity checks from PASS', async () => {
  const before = { tableNames: ['orders'], counts: { orders: 1 }, rowHash: 'rows', schemaHash: 'schema' };
  await assert.rejects(
    restoreAndVerify({ before, restore: async () => {}, snapshot: async () => { throw new Error('connection lost'); }, checkIntegrity: async () => {} }),
    error => error.code === 'RESTORE_VERIFICATION_UNAVAILABLE'
  );
  await assert.rejects(
    restoreAndVerify({ before, restore: async () => {}, snapshot: async () => before, checkIntegrity: async () => { throw new Error('non-InnoDB'); } }),
    error => error.code === 'RESTORE_INTEGRITY_FAILED'
  );
});

test('CI reports backup/restore as BLOCKED when migration prerequisites fail without masking the failed job', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /Report MySQL backup\/restore rehearsal disposition[\s\S]*?if: always\(\)[\s\S]*?BACKUP\/RESTORE BLOCKED \(not run\)/);
  assert.match(workflow, /Report MariaDB backup\/restore rehearsal disposition[\s\S]*?if: always\(\)[\s\S]*?BACKUP\/RESTORE BLOCKED \(not run\)/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.match(workflow, /BACKUP_RESTORE: \$\{\{ steps\.mysql_backup_restore\.outcome \}\}/);
  assert.match(workflow, /BACKUP_RESTORE: \$\{\{ steps\.mariadb_backup_restore\.outcome \}\}/);
});

test('Phase F docs disclose owner decisions, destructive restore scope, monitoring signals, and operational boundaries', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/PHASE_F_OPERATIONS.md'), 'utf8');
  for (const term of ['RPO', 'RTO', 'retention duration', 'disposable', 'DROP TABLE IF EXISTS', 'failed payment', 'COD', 'least privilege', 'no production restore is authorized', 'Cannot be established without approved host/provider configuration', 'not a complete effective-privilege proof']) {
    assert.ok(doc.toLowerCase().includes(term.toLowerCase()), `Expected operational document to cover ${term}`);
  }
});
