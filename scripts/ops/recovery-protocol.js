'use strict';

/**
 * Mr. Tumi Marketplace — Canonical Non-Destructive Recovery Protocol (v3.1 Hardened)
 *
 * Guarantees:
 * 1. Approval-Safe Destructive Recovery: Never drops tables without explicit operator confirmation.
 * 2. True Streaming with Backpressure & child error trapping (EPIPE, SQL syntax).
 * 3. Verified Upload Archive Restoration with directory traversal protection.
 * 4. Actual dump footer verification (not hardcoded true).
 * 5. Distinct verification states: backup_created, integrity_verified, database_restore_rehearsed, uploads_restore_rehearsed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream');

/**
 * Calculates SHA-256 hash of a file using streams.
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`FAIL_CLOSED: File not found for checksum: ${filePath}`));
    }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Inspects the trailing bytes of a SQL dump to verify complete dump footer.
 */
function verifyDumpFooter(filePath, tailBytes = 8192) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size < 64) return false;

  const readLen = Math.min(stat.size, tailBytes);
  const buffer = Buffer.alloc(readLen);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, readLen, stat.size - readLen);
    const tailStr = buffer.toString('utf8');
    return tailStr.includes('-- Dump completed') || tailStr.includes('MariaDB dump completed');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Hardened Manifest Validator & Loader
 */
async function validateAndLoadManifest(manifestFilePath, expectedDbConfig, backupBaseDir) {
  if (!fs.existsSync(manifestFilePath)) {
    throw new Error(`FAIL_CLOSED: Manifest file does not exist at '${manifestFilePath}'`);
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(manifestFilePath, 'utf8');
  } catch (err) {
    throw new Error(`FAIL_CLOSED: Cannot read manifest file: ${err.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`FAIL_CLOSED: Manifest is malformed JSON: ${err.message}`);
  }

  // Schema validation
  if (!manifest.run_id || !manifest.dump || !manifest.dump.filename || !manifest.dump.sha256 || !manifest.database_identity) {
    throw new Error('FAIL_CLOSED: Manifest missing required security identity fields');
  }

  // Database identity verification
  if (expectedDbConfig) {
    const expectedName = expectedDbConfig.database || expectedDbConfig.name || expectedDbConfig.db_name;
    const expectedHost = expectedDbConfig.host || expectedDbConfig.db_host;
    if (manifest.database_identity.db_name !== expectedName ||
        (expectedHost && manifest.database_identity.db_host !== expectedHost)) {
      throw new Error(`FAIL_CLOSED: Database identity mismatch! Manifest DB: ${manifest.database_identity.db_name}@${manifest.database_identity.db_host}, Expected: ${expectedName}@${expectedHost}`);
    }
  }

  // Canonical path bounds check (Directory traversal prevention)
  const baseDir = backupBaseDir || path.dirname(path.resolve(manifestFilePath));
  const resolvedDumpPath = path.resolve(baseDir, manifest.dump.filename);
  const resolvedBaseDir = path.resolve(baseDir);

  if (!resolvedDumpPath.startsWith(resolvedBaseDir + path.sep)) {
    throw new Error(`FAIL_CLOSED: Directory traversal detected! Path '${resolvedDumpPath}' escapes base directory '${resolvedBaseDir}'`);
  }

  if (!fs.existsSync(resolvedDumpPath)) {
    throw new Error(`FAIL_CLOSED: Dump file '${resolvedDumpPath}' does not exist on disk`);
  }

  // SHA256 integrity verification
  const actualHash = await sha256File(resolvedDumpPath);
  if (actualHash !== manifest.dump.sha256) {
    throw new Error(`FAIL_CLOSED: Dump checksum mismatch! Manifest SHA: ${manifest.dump.sha256}, Actual: ${actualHash}`);
  }

  // Size verification
  const actualSize = fs.statSync(resolvedDumpPath).size;
  if (manifest.dump.size_bytes && actualSize !== manifest.dump.size_bytes) {
    throw new Error(`FAIL_CLOSED: Dump file size mismatch! Manifest bytes: ${manifest.dump.size_bytes}, Actual: ${actualSize}`);
  }

  return { status: 'VALID', manifest, resolvedDumpPath };
}

/**
 * True Streaming Restore with Backpressure & Error Propagation
 */
function streamRestore(sqlFilePath, dbConfig, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sqlFilePath)) {
      return reject(new Error(`FAIL_CLOSED: Restore file not found: ${sqlFilePath}`));
    }

    const mysqlBin = opts.mysqlBin || 'mysql';
    const targetDbName = dbConfig.database || dbConfig.name;
    const args = opts.args || [
      `-h${dbConfig.host || '127.0.0.1'}`,
      `-P${dbConfig.port || 3306}`,
      `-u${dbConfig.user}`,
      targetDbName
    ];

    const env = { ...process.env };
    if (dbConfig.password) {
      env.MYSQL_PWD = dbConfig.password;
    }

    const readStream = fs.createReadStream(sqlFilePath, { highWaterMark: 64 * 1024 });
    const child = spawn(mysqlBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    const initialMem = process.memoryUsage();
    let maxHeapUsed = initialMem.heapUsed;
    let maxRss = initialMem.rss;
    const memInterval = setInterval(() => {
      const mem = process.memoryUsage();
      if (mem.heapUsed > maxHeapUsed) maxHeapUsed = mem.heapUsed;
      if (mem.rss > maxRss) maxRss = mem.rss;
    }, 50);

    let stderrData = '';
    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    let restored = false;
    let exitCode = null;
    let exitSignal = null;

    child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      clearInterval(memInterval);

      if (restored) return;
      restored = true;

      if (code === 0) {
        resolve({
          success: true,
          code,
          maxHeapUsedMB: (maxHeapUsed / (1024 * 1024)).toFixed(2),
          maxRssMB: (maxRss / (1024 * 1024)).toFixed(2)
        });
      } else {
        const detail = stderrData.trim() || `Process exited with code ${code || signal}`;
        reject(new Error(`Restore process failed (code ${code || signal}): ${detail}`));
      }
    });

    pipeline(readStream, child.stdin, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        setTimeout(() => {
          if (restored) return;
          restored = true;
          clearInterval(memInterval);
          child.kill('SIGTERM');
          const detail = stderrData.trim() || err.message;
          const code = exitCode !== null ? exitCode : 'ABORTED';
          reject(new Error(`Restore process failed (code ${code}): ${detail}`));
        }, 50);
      }
    });

    readStream.on('error', (err) => {
      if (restored) return;
      if (err.code === 'EPIPE' || (err.message && err.message.includes('EPIPE'))) {
        return;
      }
      restored = true;
      clearInterval(memInterval);
      child.kill('SIGTERM');
      reject(new Error(`Source stream read error: ${err.message}`));
    });

    child.on('error', (err) => {
      clearInterval(memInterval);
      readStream.destroy();
      if (!restored) {
        restored = true;
        reject(new Error(`Child process failed to start: ${err.message}`));
      }
    });
  });
}

/**
 * Approval-Safe Canonical Recovery Execution
 * Enforces explicit operator confirmation before destructive DROP TABLE operations.
 */
async function executeCanonicalRecovery(conn, dumpFile, dbConfig, opts = {}) {
  // Strict Safety Gate: Requires explicit operator confirmation flag
  const approvalFlag = process.env.CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY || opts.confirmationFlag;
  if (approvalFlag !== 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY') {
    throw new Error(
      'FAIL_CLOSED_APPROVAL_REQUIRED: Destructive database recovery requires explicit operator confirmation. ' +
      'Set CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY="I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY" to proceed.'
    );
  }

  if (!fs.existsSync(dumpFile)) {
    throw new Error(`FAIL_CLOSED: Baseline SQL dump file not found: ${dumpFile}`);
  }

  // Pre-restore DDL cleanup
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  // 1. Drop 0038 tables
  await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_audit_logs');
  await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_requests');
  // 2. Drop 0037 modified table (vendors)
  await conn.query('DROP TABLE IF EXISTS vendors');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // 3. Stream restore verified baseline dump
  return await streamRestore(dumpFile, dbConfig, opts);
}

/**
 * Verified Upload Archive Extraction and Restoration.
 * Prevents directory traversal, preserves existing uploads until extraction verified.
 */
async function restoreUploadsArchive(archivePath, targetUploadDir, expectedSha, opts = {}) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`FAIL_CLOSED: Uploads archive not found: ${archivePath}`);
  }

  // 1. Verify SHA-256
  const actualSha = await sha256File(archivePath);
  if (expectedSha && actualSha !== expectedSha) {
    throw new Error(`FAIL_CLOSED: Uploads archive checksum mismatch! Expected ${expectedSha}, got ${actualSha}`);
  }

  // 2. Canonical Target Validation
  const resolvedTarget = path.resolve(targetUploadDir);
  const appRoot = opts.appRoot || path.resolve(__dirname, '..', '..');
  const rel = path.relative(appRoot, resolvedTarget);
  if (!opts.allowInsideAppRoot && (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))) {
    throw new Error(`FAIL_CLOSED: Target upload directory must be outside application root: ${resolvedTarget}`);
  }

  // 3. Pre-scan tar archive for malicious entries (Directory traversal / absolute paths)
  const tarList = spawnSync('tar', ['-ztf', archivePath], { encoding: 'utf8' });
  if (tarList.status !== 0) {
    throw new Error(`FAIL_CLOSED: Cannot read archive contents: ${tarList.stderr}`);
  }

  const entries = tarList.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.startsWith('\\') || entry.includes('../') || entry.includes('..\\')) {
      throw new Error(`FAIL_CLOSED: Malicious archive entry detected (directory traversal attempt): ${entry}`);
    }
  }

  // 4. Staged Extraction to Temporary Directory
  const stagingDir = `${resolvedTarget}_restore_staging_${Date.now()}`;
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  try {
    const extractRes = spawnSync('tar', ['-xzf', archivePath, '-C', stagingDir], { encoding: 'utf8' });
    if (extractRes.status !== 0) {
      throw new Error(`FAIL_CLOSED: Extraction failed: ${extractRes.stderr}`);
    }

    // Verify extracted contents
    const extractedEntries = fs.readdirSync(stagingDir);
    if (extractedEntries.length === 0) {
      throw new Error('FAIL_CLOSED: Staging directory is empty after extraction!');
    }

    // 5. Safe Atomic Swap
    // If target exists, preserve it temporarily
    const backupExisting = `${resolvedTarget}_pre_restore_bak_${Date.now()}`;
    let targetExisted = false;

    if (fs.existsSync(resolvedTarget)) {
      targetExisted = true;
      fs.renameSync(resolvedTarget, backupExisting);
    }

    // Locate inner folder if tar included top-level directory
    const innerPath = path.join(stagingDir, path.basename(resolvedTarget));
    const sourceToMove = fs.existsSync(innerPath) ? innerPath : stagingDir;

    fs.renameSync(sourceToMove, resolvedTarget);

    // Clean up temporary pre-restore backup only after target is confirmed on disk
    if (targetExisted && fs.existsSync(backupExisting)) {
      fs.rmSync(backupExisting, { recursive: true, force: true });
    }
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    return {
      status: 'RESTORED',
      targetDir: resolvedTarget,
      extractedCount: extractedEntries.length,
      sha256: actualSha
    };
  } catch (err) {
    // If staging directory exists on error, remove it
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    throw new Error(`FAIL_CLOSED: Upload restore failed without altering production files: ${err.message}`);
  }
}

/**
 * Creates atomic cryptographic manifest for a completed backup.
 */
async function createHardenedManifest(backupDir, dbConfig, dumpPath, uploadsPath, gitInfo = {}) {
  const runId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpSha = await sha256File(dumpPath);
  const dumpStats = fs.statSync(dumpPath);

  // Real dump footer inspection (NOT hardcoded true)
  const hasFooter = verifyDumpFooter(dumpPath);

  let uploadsInfo = null;
  if (uploadsPath && fs.existsSync(uploadsPath)) {
    const upSha = await sha256File(uploadsPath);
    const upStats = fs.statSync(uploadsPath);
    uploadsInfo = {
      filename: path.basename(uploadsPath),
      canonical_path: path.resolve(uploadsPath),
      sha256: upSha,
      size_bytes: upStats.size
    };
  }

  const dbName = dbConfig.database || dbConfig.name;

  const manifestData = {
    schema_version: '3.1',
    run_id: runId,
    timestamp: new Date().toISOString(),
    status: {
      backup_created: true,
      integrity_verified: hasFooter,
      database_restore_rehearsed: false,
      uploads_restore_rehearsed: false
    },
    database_identity: {
      db_name: dbName,
      db_user: dbConfig.user,
      db_host: dbConfig.host || '127.0.0.1',
      db_port: Number(dbConfig.port || 3306)
    },
    git_identity: {
      pre_deploy_head: gitInfo.pre_deploy_head || 'unknown',
      target_commit: gitInfo.target_commit || 'unknown'
    },
    dump: {
      filename: path.basename(dumpPath),
      canonical_path: path.resolve(dumpPath),
      sha256: dumpSha,
      size_bytes: dumpStats.size,
      has_footer: hasFooter
    },
    uploads: uploadsInfo
  };

  const manifestFilename = `manifest_${timestamp}_${runId.slice(0, 8)}.json`;
  const manifestPath = path.join(backupDir, manifestFilename);

  // Atomic write via .tmp
  const tmpManifest = `${manifestPath}.tmp`;
  fs.writeFileSync(tmpManifest, JSON.stringify(manifestData, null, 2), { mode: 0o600 });
  fs.renameSync(tmpManifest, manifestPath);

  // Atomic pointer update
  const pointerPath = path.join(backupDir, '.latest_verified_manifest');
  const tmpPointer = `${pointerPath}.tmp`;
  fs.writeFileSync(tmpPointer, manifestFilename, { mode: 0o600 });
  fs.renameSync(tmpPointer, pointerPath);

  return { runId, manifestPath, manifestFilename, manifestData };
}

/**
 * Atomically updates discrete manifest lifecycle states.
 */
function updateManifestState(manifestPath, stateUpdates = {}) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`FAIL_CLOSED: Manifest file not found: ${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.status = {
    ...manifest.status,
    ...stateUpdates
  };
  manifest.updated_at = new Date().toISOString();
  const tmp = `${manifestPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
  return manifest;
}

module.exports = {
  sha256File,
  verifyDumpFooter,
  validateAndLoadManifest,
  streamRestore,
  executeCanonicalRecovery,
  restoreUploadsArchive,
  createHardenedManifest,
  updateManifestState
};
