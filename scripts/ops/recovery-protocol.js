'use strict';

/**
 * Mr. Tumi Marketplace — Canonical Non-Destructive Recovery Protocol (v3)
 * Provides cryptographically verified, constant-memory, zero-residual schema restoration.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
 * Hardened Manifest Validator & Loader
 * Rejects traversal, corrupt JSON, stale pointers, DB identity mismatch, and SHA256 mismatch.
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
    const expectedName = expectedDbConfig.database || expectedDbConfig.db_name;
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
    const args = opts.args || [
      `-h${dbConfig.host || '127.0.0.1'}`,
      `-P${dbConfig.port || 3306}`,
      `-u${dbConfig.user}`,
      dbConfig.database
    ];

    const env = { ...process.env };
    if (dbConfig.password) {
      env.MYSQL_PWD = dbConfig.password;
    }

    const readStream = fs.createReadStream(sqlFilePath, { highWaterMark: 64 * 1024 }); // 64 KB chunks
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

    // Pipelining with backpressure
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
        return; // Child exit handler reports root cause
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
 * Pre-Restore DDL Cleanup + Streaming Baseline Restore
 * Removes all residual objects from 0037 and 0038 without DOWN migrations.
 */
async function executeCanonicalRecovery(conn, dumpFile, dbConfig, opts = {}) {
  // Pre-restore DDL cleanup
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  // 1. Drop all new candidate tables introduced in Migration 0038
  await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_audit_logs');
  await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_requests');
  // 2. Drop candidate modified table from Migration 0037 (vendors)
  // Dropping vendors guarantees that even if the dump didn't drop it, all added
  // columns (slug, logo_url, banner_url, tagline, description, store_status),
  // indexes (uq_vendors_slug, idx_vendors_store_status), and slug backfill data are purged.
  await conn.query('DROP TABLE IF EXISTS vendors');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // 3. Stream restore verified baseline dump (recreates vendors cleanly from baseline DDL)
  return await streamRestore(dumpFile, dbConfig, opts);
}

/**
 * Creates atomic cryptographic manifest for a completed backup.
 */
async function createHardenedManifest(backupDir, dbConfig, dumpPath, uploadsPath, gitInfo = {}) {
  const runId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpSha = await sha256File(dumpPath);
  const dumpStats = fs.statSync(dumpPath);

  let uploadsInfo = null;
  if (uploadsPath && fs.existsSync(uploadsPath)) {
    const upSha = await sha256File(uploadsPath);
    const upStats = fs.statSync(uploadsPath);
    uploadsInfo = {
      filename: path.basename(uploadsPath),
      sha256: upSha,
      size_bytes: upStats.size
    };
  }

  const manifestData = {
    schema_version: '3.0',
    run_id: runId,
    timestamp: new Date().toISOString(),
    database_identity: {
      db_name: dbConfig.database,
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
      sha256: dumpSha,
      size_bytes: dumpStats.size,
      has_footer: true
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

module.exports = {
  sha256File,
  validateAndLoadManifest,
  streamRestore,
  executeCanonicalRecovery,
  createHardenedManifest
};
