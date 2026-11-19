'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const {
  sha256File,
  verifyDumpFooter,
  validateAndLoadManifest,
  streamRestore,
  createHardenedManifest,
  restoreUploadsArchive,
  updateManifestState,
  executeCanonicalRecovery
} = require('../scripts/ops/recovery-protocol');

function createTarHeader(name, typeflag = '0', linkname = '', size = 0) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'utf8');
  buf.write('0001750\0', 108, 8, 'utf8');
  buf.write('0001750\0', 116, 8, 'utf8');
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8');
  buf.write(typeflag, 156, 1, 'utf8');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let chk = 0;
  for (let i = 0; i < 512; i++) chk += buf[i];
  buf.write(chk.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

function buildMaliciousTarGz(entries) {
  const chunks = [];
  for (const e of entries) {
    const data = Buffer.from(e.content || '');
    const header = createTarHeader(e.name, e.typeflag || '0', e.linkname || '', data.length);
    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const pad = 512 - (data.length % 512);
      if (pad < 512) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024)); // end of archive
  return zlib.gzipSync(Buffer.concat(chunks));
}

describe('Workstream C — Manifest, Uploads Safety & Recovery Gate Architecture Suite (v3.2 Hardened)', () => {
  const sandboxDir = path.join(__dirname, 'helpers', 'tmp-manifest-sandbox');
  const backupDir = path.join(sandboxDir, 'db_backups');
  const uploadsSourceDir = path.join(sandboxDir, 'fake_uploads_source');
  const uploadsTargetDir = path.join(sandboxDir, 'fake_uploads_target');
  const mockDb = { database: 'mrtumi_test_db', user: 'mrtumi_test_user', host: '127.0.0.1', port: 3306 };

  before(() => {
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(uploadsSourceDir, { recursive: true });
    fs.mkdirSync(uploadsTargetDir, { recursive: true });
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

    // Verify 4 discrete initial states
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

  test('validateAndLoadManifest: mandatory pre-migration backup gate validations', async () => {
    const validDump = path.join(backupDir, 'gate_valid.sql');
    fs.writeFileSync(validDump, 'CREATE TABLE valid_gate (id INT);\n-- Dump completed on 2026-11-19\n');
    const validSha = await sha256File(validDump);
    const validSize = fs.statSync(validDump).size;

    const baseManifest = {
      schema_version: '3.2',
      run_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      status: {
        backup_created: true,
        integrity_verified: true,
        database_restore_rehearsed: false,
        uploads_restore_rehearsed: false
      },
      database_identity: { db_name: mockDb.database, db_host: mockDb.host },
      dump: {
        filename: path.basename(validDump),
        sha256: validSha,
        size_bytes: validSize,
        has_footer: true
      }
    };

    // 1. Valid manifest succeeds
    const mValidPath = path.join(backupDir, 'manifest_gate_valid.json');
    fs.writeFileSync(mValidPath, JSON.stringify(baseManifest, null, 2));
    const validRes = await validateAndLoadManifest(mValidPath, mockDb, backupDir);
    assert.equal(validRes.status, 'VALID');

    // 2. Truncated physical dump file fails-closed even if manifest claims has_footer=true
    const truncDump = path.join(backupDir, 'gate_trunc.sql');
    fs.writeFileSync(truncDump, 'CREATE TABLE trunc_gate (id INT);\nINSERT INTO trunc_gate VALUES(1);');
    const truncSha = await sha256File(truncDump);
    const mTrunc = {
      ...baseManifest,
      run_id: crypto.randomUUID(),
      dump: { filename: path.basename(truncDump), sha256: truncSha, size_bytes: fs.statSync(truncDump).size, has_footer: true }
    };
    const mTruncPath = path.join(backupDir, 'manifest_gate_trunc.json');
    fs.writeFileSync(mTruncPath, JSON.stringify(mTrunc, null, 2));
    await assert.rejects(
      async () => validateAndLoadManifest(mTruncPath, mockDb, backupDir),
      /FAIL_CLOSED: Dump file '.*' is truncated or missing completion footer/
    );

    // 3. backup_created: false fails-closed
    const mNotCreated = {
      ...baseManifest,
      run_id: crypto.randomUUID(),
      status: { ...baseManifest.status, backup_created: false }
    };
    const mNotCreatedPath = path.join(backupDir, 'manifest_not_created.json');
    fs.writeFileSync(mNotCreatedPath, JSON.stringify(mNotCreated, null, 2));
    await assert.rejects(
      async () => validateAndLoadManifest(mNotCreatedPath, mockDb, backupDir),
      /FAIL_CLOSED: Manifest indicates backup_created is false/
    );

    // 4. integrity_verified: false fails-closed
    const mNotVerified = {
      ...baseManifest,
      run_id: crypto.randomUUID(),
      status: { ...baseManifest.status, integrity_verified: false }
    };
    const mNotVerifiedPath = path.join(backupDir, 'manifest_not_verified.json');
    fs.writeFileSync(mNotVerifiedPath, JSON.stringify(mNotVerified, null, 2));
    await assert.rejects(
      async () => validateAndLoadManifest(mNotVerifiedPath, mockDb, backupDir),
      /FAIL_CLOSED: Manifest indicates integrity_verified is false/
    );

    // 5. Database name mismatch fails-closed
    await assert.rejects(
      async () => validateAndLoadManifest(mValidPath, { database: 'wrong_db_name' }, backupDir),
      /FAIL_CLOSED: Database identity mismatch/
    );

    // 6. Missing dump file fails-closed
    const mMissingDump = {
      ...baseManifest,
      run_id: crypto.randomUUID(),
      dump: { filename: 'completely_nonexistent_dump.sql', sha256: validSha, size_bytes: 100, has_footer: true }
    };
    const mMissingPath = path.join(backupDir, 'manifest_missing_dump.json');
    fs.writeFileSync(mMissingPath, JSON.stringify(mMissingDump, null, 2));
    await assert.rejects(
      async () => validateAndLoadManifest(mMissingPath, mockDb, backupDir),
      /FAIL_CLOSED: Dump file '.*' does not exist on disk/
    );

    // 7. Dump size mismatch fails-closed
    const mSizeMismatch = {
      ...baseManifest,
      run_id: crypto.randomUUID(),
      dump: { ...baseManifest.dump, size_bytes: validSize + 999 }
    };
    const mSizePath = path.join(backupDir, 'manifest_size_mismatch.json');
    fs.writeFileSync(mSizePath, JSON.stringify(mSizeMismatch, null, 2));
    await assert.rejects(
      async () => validateAndLoadManifest(mSizePath, mockDb, backupDir),
      /FAIL_CLOSED: Dump file size mismatch/
    );
  });

  test('Broken or stale manifest pointer safety', () => {
    const pointerPath = path.join(backupDir, '.latest_verified_manifest');
    const originalPointer = fs.readFileSync(pointerPath, 'utf8').trim();

    // 1. Interrupted write leaves .tmp without corrupting pointer
    const interruptedPath = path.join(backupDir, 'interrupted_manifest.json.tmp');
    fs.writeFileSync(interruptedPath, '{ "run_id": "incomplete');
    assert.equal(fs.readFileSync(pointerPath, 'utf8').trim(), originalPointer);

    // 2. Broken pointer pointing to nonexistent file is rejected by validateAndLoadManifest
    const brokenPointerPath = path.join(backupDir, 'nonexistent_manifest_file.json');
    assert.rejects(
      async () => validateAndLoadManifest(brokenPointerPath, mockDb, backupDir),
      /FAIL_CLOSED: Manifest file does not exist/
    );
  });

  test('restoreUploadsArchive: automatic rollback restores original target directory on swap failure', async () => {
    // 1. Setup realistic existing uploads target with original files
    const swapTargetDir = path.join(sandboxDir, 'swap_test_target');
    if (fs.existsSync(swapTargetDir)) fs.rmSync(swapTargetDir, { recursive: true, force: true });
    fs.mkdirSync(swapTargetDir, { recursive: true });
    fs.writeFileSync(path.join(swapTargetDir, 'original_file_1.png'), 'ORIGINAL_IMAGE_DATA_1');
    fs.writeFileSync(path.join(swapTargetDir, 'original_file_2.png'), 'ORIGINAL_IMAGE_DATA_2');

    // 2. Create valid archive to extract
    const newUploadsSrc = path.join(sandboxDir, 'new_uploads_src');
    if (fs.existsSync(newUploadsSrc)) fs.rmSync(newUploadsSrc, { recursive: true, force: true });
    fs.mkdirSync(newUploadsSrc, { recursive: true });
    fs.writeFileSync(path.join(newUploadsSrc, 'new_file.png'), 'NEW_IMAGE_DATA');

    const swapArchive = path.join(backupDir, 'swap_test_archive.tar.gz');
    spawnSync('tar', ['-czf', swapArchive, '-C', path.dirname(newUploadsSrc), path.basename(newUploadsSrc)]);
    const archiveSha = await sha256File(swapArchive);

    // 3. Fault injection: fail before moving staged files to target
    await assert.rejects(
      async () => restoreUploadsArchive(swapArchive, swapTargetDir, archiveSha, {
        allowInsideAppRoot: true,
        faultInjection: 'FAIL_BEFORE_TARGET_MOVE'
      }),
      /FAIL_CLOSED: Upload restore failed during directory swap; original uploads directory was automatically restored intact/
    );

    // Assert that target directory exists and STILL contains original files intact
    assert.ok(fs.existsSync(swapTargetDir), 'Target uploads directory must exist after automatic rollback');
    assert.equal(fs.readFileSync(path.join(swapTargetDir, 'original_file_1.png'), 'utf8'), 'ORIGINAL_IMAGE_DATA_1');
    assert.equal(fs.readFileSync(path.join(swapTargetDir, 'original_file_2.png'), 'utf8'), 'ORIGINAL_IMAGE_DATA_2');

    // 4. Fault injection: fail after target move
    await assert.rejects(
      async () => restoreUploadsArchive(swapArchive, swapTargetDir, archiveSha, {
        allowInsideAppRoot: true,
        faultInjection: 'FAIL_AFTER_TARGET_MOVE'
      }),
      /FAIL_CLOSED: Upload restore failed during directory swap; original uploads directory was automatically restored intact/
    );

    // Assert that target directory was rolled back to original files
    assert.ok(fs.existsSync(swapTargetDir));
    assert.equal(fs.readFileSync(path.join(swapTargetDir, 'original_file_1.png'), 'utf8'), 'ORIGINAL_IMAGE_DATA_1');
  });

  test('restoreUploadsArchive: rejects genuine malicious archives (traversal, absolute, symlink, hardlink)', async () => {
    const maliciousTarget = path.join(sandboxDir, 'malicious_test_target');
    if (fs.existsSync(maliciousTarget)) fs.rmSync(maliciousTarget, { recursive: true, force: true });
    fs.mkdirSync(maliciousTarget, { recursive: true });
    fs.writeFileSync(path.join(maliciousTarget, 'canary.txt'), 'SAFE_CANARY');

    // 1. Archive with ../ traversal entry
    const traversalArchive = path.join(backupDir, 'traversal_archive.tar.gz');
    fs.writeFileSync(traversalArchive, buildMaliciousTarGz([
      { name: '../evil_traversal.txt', content: 'MALICIOUS_PAYLOAD' }
    ]));
    const tSha = await sha256File(traversalArchive);

    await assert.rejects(
      async () => restoreUploadsArchive(traversalArchive, maliciousTarget, tSha, { allowInsideAppRoot: true }),
      /FAIL_CLOSED: Malicious archive entry detected \(directory traversal attempt\)/
    );
    assert.equal(fs.existsSync(path.join(sandboxDir, 'evil_traversal.txt')), false, 'Traversal file must not escape');
    assert.equal(fs.readFileSync(path.join(maliciousTarget, 'canary.txt'), 'utf8'), 'SAFE_CANARY');

    // 2. Archive with absolute path entry
    const absArchive = path.join(backupDir, 'abs_archive.tar.gz');
    fs.writeFileSync(absArchive, buildMaliciousTarGz([
      { name: '/etc/evil_abs.txt', content: 'MALICIOUS_PAYLOAD' }
    ]));
    const aSha = await sha256File(absArchive);

    await assert.rejects(
      async () => restoreUploadsArchive(absArchive, maliciousTarget, aSha, { allowInsideAppRoot: true }),
      /FAIL_CLOSED: Malicious archive entry detected \(absolute path forbidden\)/
    );

    // 3. Archive with symlink entry
    const symArchive = path.join(backupDir, 'symlink_archive.tar.gz');
    fs.writeFileSync(symArchive, buildMaliciousTarGz([
      { name: 'symlink_escape', typeflag: '2', linkname: '../../etc/passwd' }
    ]));
    const sSha = await sha256File(symArchive);

    await assert.rejects(
      async () => restoreUploadsArchive(symArchive, maliciousTarget, sSha, { allowInsideAppRoot: true }),
      /FAIL_CLOSED: Malicious archive entry detected \(symbolic link forbidden\)/
    );

    // 4. Archive with hardlink entry
    const hardArchive = path.join(backupDir, 'hardlink_archive.tar.gz');
    fs.writeFileSync(hardArchive, buildMaliciousTarGz([
      { name: 'hardlink_escape', typeflag: '1', linkname: '../../etc/shadow' }
    ]));
    const hSha = await sha256File(hardArchive);

    await assert.rejects(
      async () => restoreUploadsArchive(hardArchive, maliciousTarget, hSha, { allowInsideAppRoot: true }),
      /FAIL_CLOSED: Malicious archive entry detected \(hard link forbidden\)/
    );

    // Ensure canary remains intact
    assert.equal(fs.readFileSync(path.join(maliciousTarget, 'canary.txt'), 'utf8'), 'SAFE_CANARY');
  });

  test('executeCanonicalRecovery: rehearsal prerequisite & confirmation flag isolation', async () => {
    const fakeDump = path.join(backupDir, 'gate_test_dump.sql');
    fs.writeFileSync(fakeDump, 'SELECT 1;\n-- Dump completed\n');
    const fSha = await sha256File(fakeDump);

    const testRunId = crypto.randomUUID();
    const manifestUnrehearsed = {
      schema_version: '3.2',
      run_id: testRunId,
      timestamp: new Date().toISOString(),
      status: {
        backup_created: true,
        integrity_verified: true,
        database_restore_rehearsed: false,
        uploads_restore_rehearsed: false
      },
      database_identity: { db_name: mockDb.database, db_host: mockDb.host },
      dump: { filename: path.basename(fakeDump), sha256: fSha, size_bytes: fs.statSync(fakeDump).size, has_footer: true }
    };

    const mockConn = {
      query: async () => []
    };

    // 1. Unrehearsed restore rejected fail-closed
    await assert.rejects(
      async () => executeCanonicalRecovery(mockConn, fakeDump, mockDb, {
        manifest: manifestUnrehearsed,
        confirmationToken: testRunId
      }),
      /FAIL_CLOSED_REHEARSAL_REQUIRED/
    );

    // 2. Emergency override without justification rejected
    await assert.rejects(
      async () => executeCanonicalRecovery(mockConn, fakeDump, mockDb, {
        manifest: manifestUnrehearsed,
        confirmationToken: testRunId,
        allowUnrehearsedEmergencyRecovery: true,
        emergencyRecoveryJustification: 'short'
      }),
      /FAIL_CLOSED_REHEARSAL_REQUIRED/
    );

    // 3. Ambient confirmation flag without matching run_id rejected
    process.env.CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY = 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY';
    const manifestRehearsed = {
      ...manifestUnrehearsed,
      status: { ...manifestUnrehearsed.status, database_restore_rehearsed: true }
    };

    await assert.rejects(
      async () => executeCanonicalRecovery(mockConn, fakeDump, mockDb, {
        manifest: manifestRehearsed
        // No confirmationToken and no targetRunId matching run_id!
      }),
      /FAIL_CLOSED_APPROVAL_REQUIRED: Destructive database recovery requires explicit operator confirmation scoped to run_id/
    );

    delete process.env.CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY;
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
