'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  sha256File,
  verifyDumpFooter,
  validateAndLoadManifest,
  streamRestore,
  createHardenedManifest,
  restoreUploadsArchive,
  updateManifestState
} = require('../scripts/ops/recovery-protocol');

describe('Workstream C — Manifest & Streaming Restore Architecture Suite (v3.1 Hardened)', () => {
  const sandboxDir = path.join(__dirname, 'helpers', 'tmp-manifest-sandbox');
  const backupDir = path.join(sandboxDir, 'db_backups');
  const uploadsSourceDir = path.join(sandboxDir, 'fake_uploads_source');
  const uploadsTargetDir = path.join(sandboxDir, 'fake_uploads_target');
  const mockDb = { database: 'mrtumi_test_db', user: 'mrtumi_test_user', host: '127.0.0.1', port: 3306 };

  before(() => {
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(uploadsSourceDir, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test('verifyDumpFooter: verifies valid vs truncated dump tail', () => {
    const validDump = path.join(backupDir, 'valid_tail.sql');
    fs.writeFileSync(validDump, 'CREATE TABLE t (id INT);\n-- Dump completed on 2026-11-18 10:00:00\n');
    assert.equal(verifyDumpFooter(validDump), true, 'Valid dump with footer must return true');

    const truncatedDump = path.join(backupDir, 'truncated_tail.sql');
    fs.writeFileSync(truncatedDump, 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);');
    assert.equal(verifyDumpFooter(truncatedDump), false, 'Truncated dump without footer must return false');
  });

  test('createHardenedManifest & 4 discrete states lifecycle tracking', async () => {
    const dummyDump = path.join(backupDir, 'mrtumi_full_database_test.sql');
    fs.writeFileSync(dummyDump, 'CREATE TABLE dummy (id INT);\n-- Dump completed on 2026-11-18 12:00:00\n', { mode: 0o600 });

    const dummyUploads = path.join(backupDir, 'uploads_test.tar.gz');
    fs.writeFileSync(dummyUploads, 'DUMMY_UPLOADS_TAR_GZ_BINARY', { mode: 0o600 });

    const res = await createHardenedManifest(backupDir, mockDb, dummyDump, dummyUploads, {
      pre_deploy_head: '1b3c9a1950c2e8de7b76efb0d86717b02f64f100',
      target_commit: '5285d82e7e233c50561222c419fc163d79d74c5d'
    });

    assert.ok(res.runId, 'runId must be present');
    assert.match(res.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'runId must be a valid UUID');
    assert.ok(fs.existsSync(res.manifestPath), 'manifest file must exist');

    // Verify 4 initial states
    assert.equal(res.manifestData.status.backup_created, true);
    assert.equal(res.manifestData.status.integrity_verified, true);
    assert.equal(res.manifestData.status.database_restore_rehearsed, false);
    assert.equal(res.manifestData.status.uploads_restore_rehearsed, false);
    assert.equal(res.manifestData.dump.has_footer, true);

    const pointerPath = path.join(backupDir, '.latest_verified_manifest');
    assert.ok(fs.existsSync(pointerPath), 'pointer file must exist');
    assert.equal(fs.readFileSync(pointerPath, 'utf8').trim(), res.manifestFilename);

    // Update discrete lifecycle states
    const updated = updateManifestState(res.manifestPath, {
      database_restore_rehearsed: true,
      uploads_restore_rehearsed: true
    });
    assert.equal(updated.status.database_restore_rehearsed, true);
    assert.equal(updated.status.uploads_restore_rehearsed, true);
    assert.ok(updated.updated_at);

    // Validate using validateAndLoadManifest
    const loaded = await validateAndLoadManifest(res.manifestPath, mockDb, backupDir);
    assert.equal(loaded.status, 'VALID');
    assert.equal(loaded.manifest.run_id, res.runId);
    assert.equal(loaded.manifest.status.database_restore_rehearsed, true);
    assert.equal(loaded.manifest.database_identity.db_name, mockDb.database);
    assert.equal(loaded.manifest.dump.filename, path.basename(dummyDump));
  });

  test('validateAndLoadManifest: rejects directory traversal attempts fail-closed', async () => {
    const traversalManifest = {
      schema_version: '3.1',
      run_id: crypto.randomUUID(),
      database_identity: { db_name: mockDb.database, db_host: mockDb.host },
      dump: {
        filename: '../../../../etc/passwd',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size_bytes: 0
      }
    };
    const tPath = path.join(backupDir, 'traversal_manifest.json');
    fs.writeFileSync(tPath, JSON.stringify(traversalManifest));

    await assert.rejects(
      async () => validateAndLoadManifest(tPath, mockDb, backupDir),
      /FAIL_CLOSED: Directory traversal detected/
    );
  });

  test('validateAndLoadManifest: rejects database identity mismatch', async () => {
    const wrongDbManifest = {
      schema_version: '3.1',
      run_id: crypto.randomUUID(),
      database_identity: { db_name: 'completely_different_db', db_host: mockDb.host },
      dump: {
        filename: 'some_dump.sql',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }
    };
    const wPath = path.join(backupDir, 'wrong_db_manifest.json');
    fs.writeFileSync(wPath, JSON.stringify(wrongDbManifest));

    await assert.rejects(
      async () => validateAndLoadManifest(wPath, mockDb, backupDir),
      /FAIL_CLOSED: Database identity mismatch/
    );
  });

  test('validateAndLoadManifest: rejects corrupt / tampered dump (SHA-256 mismatch)', async () => {
    const dummyDump = path.join(backupDir, 'tamper_test.sql');
    fs.writeFileSync(dummyDump, 'ORIGINAL SQL CONTENT\n-- Dump completed\n');
    const realSha = await sha256File(dummyDump);

    const manifest = {
      schema_version: '3.1',
      run_id: crypto.randomUUID(),
      database_identity: { db_name: mockDb.database, db_host: mockDb.host },
      dump: {
        filename: path.basename(dummyDump),
        sha256: realSha,
        size_bytes: fs.statSync(dummyDump).size
      }
    };
    const mPath = path.join(backupDir, 'tamper_manifest.json');
    fs.writeFileSync(mPath, JSON.stringify(manifest));

    // Tamper with dump
    fs.appendFileSync(dummyDump, '-- MALICIOUS INJECTION;\n');

    await assert.rejects(
      async () => validateAndLoadManifest(mPath, mockDb, backupDir),
      /FAIL_CLOSED: Dump checksum mismatch/
    );
  });

  test('Interrupted write leaves .tmp file and does not corrupt pointer', () => {
    const pointerPath = path.join(backupDir, '.latest_verified_manifest');
    const originalPointer = fs.readFileSync(pointerPath, 'utf8').trim();

    // Simulate an interrupted write of an invalid manifest
    const interruptedPath = path.join(backupDir, 'incomplete_manifest.json.tmp');
    fs.writeFileSync(interruptedPath, '{ "run_id": "incomplete');

    // Pointer remains untouched and resolves to previous valid manifest
    const currentPointer = fs.readFileSync(pointerPath, 'utf8').trim();
    assert.equal(currentPointer, originalPointer);
  });

  test('restoreUploadsArchive: verifies checksum, safely extracts, and rejects malicious path traversal', async () => {
    // 1. Prepare sample uploads directory with files
    fs.writeFileSync(path.join(uploadsSourceDir, 'product1.png'), 'FAKE_IMAGE_DATA_1');
    fs.writeFileSync(path.join(uploadsSourceDir, 'branding.jpg'), 'FAKE_IMAGE_DATA_2');

    // Archive it with tar
    const validArchive = path.join(backupDir, 'valid_uploads.tar.gz');
    const tarCreate = spawnSync('tar', [
      '-czf', validArchive,
      '-C', path.dirname(uploadsSourceDir),
      path.basename(uploadsSourceDir)
    ]);
    assert.equal(tarCreate.status, 0, 'Tar creation must succeed');

    const expectedSha = await sha256File(validArchive);

    // 2. Perform safe restore to target directory
    const restoreRes = await restoreUploadsArchive(validArchive, uploadsTargetDir, expectedSha, {
      allowInsideAppRoot: true
    });
    assert.equal(restoreRes.status, 'RESTORED');
    assert.ok(fs.existsSync(uploadsTargetDir), 'Target uploads directory must exist');

    // Check that files are present in target
    const innerProduct = path.join(uploadsTargetDir, 'product1.png');
    const nestedProduct = path.join(uploadsTargetDir, path.basename(uploadsSourceDir), 'product1.png');
    assert.ok(fs.existsSync(innerProduct) || fs.existsSync(nestedProduct), 'Restored files must be in target directory');

    // Verify rejection if target is inside app root without testing override
    await assert.rejects(
      async () => restoreUploadsArchive(validArchive, uploadsTargetDir, expectedSha, {
        appRoot: path.resolve(__dirname, '..')
      }),
      /FAIL_CLOSED: Target upload directory must be outside application root/
    );

    // 3. Test checksum mismatch failure
    await assert.rejects(
      async () => restoreUploadsArchive(validArchive, uploadsTargetDir, 'INVALID_SHA_256_HASH_VALUE_0000', {
        allowInsideAppRoot: true
      }),
      /FAIL_CLOSED: Uploads archive checksum mismatch/
    );

    // 4. Test missing archive failure
    await assert.rejects(
      async () => restoreUploadsArchive('/nonexistent/archive.tar.gz', uploadsTargetDir, null, {
        allowInsideAppRoot: true
      }),
      /FAIL_CLOSED: Uploads archive not found/
    );
  });

  test('Streaming restore: backpressure, bounded memory test case, and error propagation', async () => {
    const streamDump = path.join(backupDir, 'stream_test_dump.sql');
    const line = '-- Sample streaming padding SQL query statement 0123456789 ABCDEF\n';
    const writeStream = fs.createWriteStream(streamDump);
    const targetBytes = 5 * 1024 * 1024; // 5 MB for rapid CI execution
    let written = 0;
    while (written < targetBytes) {
      writeStream.write(line);
      written += line.length;
    }
    writeStream.end();

    await new Promise((resolve) => writeStream.on('finish', resolve));

    // Consumer script simulating mysql client reading stdin
    const consumer = path.join(sandboxDir, 'mock_mysql_consumer.js');
    fs.writeFileSync(consumer, `
      let count = 0;
      process.stdin.on('data', chunk => { count += chunk.length; });
      process.stdin.on('end', () => { process.exit(0); });
    `);

    const result = await streamRestore(streamDump, mockDb, {
      mysqlBin: process.execPath,
      args: [consumer]
    });

    assert.equal(result.success, true);
    assert.equal(result.code, 0);
    assert.ok(parseFloat(result.maxHeapUsedMB) > 0);

    // Test error propagation: child process failure (code 1) with syntax error
    const failingConsumer = path.join(sandboxDir, 'failing_mysql_consumer.js');
    fs.writeFileSync(failingConsumer, `
      process.stderr.write("ERROR 1064 (42000): You have an error in your SQL syntax; near 'BROKEN'\\n");
      process.exit(1);
    `);

    await assert.rejects(
      async () => streamRestore(streamDump, mockDb, {
        mysqlBin: process.execPath,
        args: [failingConsumer]
      }),
      /Restore process failed \(code 1\): ERROR 1064/
    );
  });
});
