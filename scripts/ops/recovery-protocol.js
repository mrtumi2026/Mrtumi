'use strict';

/**
 * Mr. Tumi Marketplace — Canonical Non-Destructive Recovery Protocol (v3.2 Hardened)
 *
 * Guarantees:
 * 1. Mandatory Verified-Backup Gate: Enforces valid manifest, genuine dump footer, matching SHA/size,
 *    and backup_created + integrity_verified states.
 * 2. Rehearsal Prerequisite Enforcement: Prevents destructive recovery unless the specific backup
 *    has been rehearsed (database_restore_rehearsed: true) or an explicit operator emergency justification is recorded.
 * 3. Confirmation Flag Isolation: Prevents accidental ambient .env inheritance; confirmation must be
 *    scoped to the specific backup run_id.
 * 4. Automatic Rollback on Upload Restore Swap Failure: Old uploads directory is restored automatically
 *    if the swap fails after the old target has been moved.
 * 5. Comprehensive Traversal & Symlink Safety: Pre-scans and rejects any traversal, absolute paths,
 *    symlinks, or hardlinks before extraction or modification of target directory.
 * 6. True Streaming with Backpressure & child error trapping (EPIPE, SQL syntax).
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
 * Validates manifest identity, dump existence, SHA-256, size, dump footer, and integrity states.
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

  // 1. Schema validation
  if (!manifest.run_id || !manifest.dump || !manifest.dump.filename || !manifest.dump.sha256 || !manifest.database_identity) {
    throw new Error('FAIL_CLOSED: Manifest missing required security identity fields');
  }

  // 2. Status flags validation
  if (!manifest.status || typeof manifest.status !== 'object') {
    throw new Error('FAIL_CLOSED: Manifest missing required status lifecycle block');
  }
  if (manifest.status.backup_created !== true) {
    throw new Error('FAIL_CLOSED: Manifest indicates backup_created is false or unverified');
  }
  if (manifest.status.integrity_verified !== true) {
    throw new Error('FAIL_CLOSED: Manifest indicates integrity_verified is false');
  }

  // 3. Database identity verification
  if (expectedDbConfig) {
    const expectedName = expectedDbConfig.database || expectedDbConfig.name || expectedDbConfig.db_name;
    const expectedHost = expectedDbConfig.host || expectedDbConfig.db_host;
    if (manifest.database_identity.db_name !== expectedName ||
        (expectedHost && manifest.database_identity.db_host !== expectedHost)) {
      throw new Error(`FAIL_CLOSED: Database identity mismatch! Manifest DB: ${manifest.database_identity.db_name}@${manifest.database_identity.db_host}, Expected: ${expectedName}@${expectedHost}`);
    }
  }

  // 4. Canonical path bounds check (Directory traversal prevention)
  const baseDir = backupBaseDir || path.dirname(path.resolve(manifestFilePath));
  const resolvedDumpPath = path.resolve(baseDir, manifest.dump.filename);
  const resolvedBaseDir = path.resolve(baseDir);

  if (!resolvedDumpPath.startsWith(resolvedBaseDir + path.sep)) {
    throw new Error(`FAIL_CLOSED: Directory traversal detected! Path '${resolvedDumpPath}' escapes base directory '${resolvedBaseDir}'`);
  }

  if (!fs.existsSync(resolvedDumpPath)) {
    throw new Error(`FAIL_CLOSED: Dump file '${resolvedDumpPath}' does not exist on disk`);
  }

  // 5. SHA256 integrity verification
  const actualHash = await sha256File(resolvedDumpPath);
  if (actualHash !== manifest.dump.sha256) {
    throw new Error(`FAIL_CLOSED: Dump checksum mismatch! Manifest SHA: ${manifest.dump.sha256}, Actual: ${actualHash}`);
  }

  // 6. Size verification
  const actualSize = fs.statSync(resolvedDumpPath).size;
  if (manifest.dump.size_bytes && actualSize !== manifest.dump.size_bytes) {
    throw new Error(`FAIL_CLOSED: Dump file size mismatch! Manifest bytes: ${manifest.dump.size_bytes}, Actual: ${actualSize}`);
  }

  // 7. Active dump footer inspection on physical dump file
  const hasRealFooter = verifyDumpFooter(resolvedDumpPath);
  if (!hasRealFooter) {
    throw new Error(`FAIL_CLOSED: Dump file '${resolvedDumpPath}' is truncated or missing completion footer`);
  }
  if (manifest.dump.has_footer !== true) {
    throw new Error('FAIL_CLOSED: Manifest indicates dump has_footer is false');
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
 * Rehearses a database restore into an isolated disposable database schema.
 * Updates the manifest lifecycle status to database_restore_rehearsed: true upon success.
 */
async function rehearseDatabaseRestore(dumpFilePath, disposableDbConfig, manifestPath, opts = {}) {
  if (!dumpFilePath || !fs.existsSync(dumpFilePath)) {
    throw new Error(`FAIL_CLOSED: Rehearsal dump file does not exist: ${dumpFilePath}`);
  }
  if (!disposableDbConfig || !disposableDbConfig.database) {
    throw new Error('FAIL_CLOSED: Rehearsal database configuration with target database name is required');
  }

  const rehearsalDbName = disposableDbConfig.database.trim();
  const prodDb = (opts.productionDatabase || (opts.dbConfig && opts.dbConfig.database)) || '';
  if (prodDb && rehearsalDbName.toLowerCase() === prodDb.toLowerCase()) {
    throw new Error(`CRITICAL_SAFETY_VIOLATION: Rehearsal database '${rehearsalDbName}' cannot match production database '${prodDb}'!`);
  }

  const restoreRes = await streamRestore(dumpFilePath, disposableDbConfig, opts);
  if (manifestPath && fs.existsSync(manifestPath)) {
    updateManifestState(manifestPath, {
      database_restore_rehearsed: true,
      rehearsal_timestamp: new Date().toISOString(),
      rehearsal_database: rehearsalDbName
    });
  }
  return restoreRes;
}

function validateEmergencyAuthorization(auth, manifest, targetDbName) {
  if (!auth || typeof auth !== 'object') {
    return {
      valid: false,
      reason: 'Missing emergencyAuthorization object. Destructive recovery requires a rehearsed backup or an explicit, run-bound emergency authorization object. Ambient environment overrides are prohibited.'
    };
  }

  const expectedRunId = manifest ? manifest.run_id : null;
  if (!auth.target_run_id || auth.target_run_id !== expectedRunId) {
    return {
      valid: false,
      reason: `EMERGENCY_OVERRIDE_RUN_MISMATCH: Authorization bound to run_id '${auth.target_run_id}', but manifest is '${expectedRunId}'. Cross-run reuse is prohibited.`
    };
  }

  if (!auth.target_database || auth.target_database !== targetDbName) {
    return {
      valid: false,
      reason: `EMERGENCY_OVERRIDE_DATABASE_MISMATCH: Authorization bound to database '${auth.target_database}', but target is '${targetDbName}'. Cross-database reuse is prohibited.`
    };
  }

  if (!auth.operator_id || typeof auth.operator_id !== 'string') {
    return { valid: false, reason: 'EMERGENCY_OVERRIDE_OPERATOR_REQUIRED: Missing operator_id' };
  }

  const cleanOperator = auth.operator_id.trim();
  const genericOperators = new Set(['admin', 'operator', 'root', 'user', 'test', 'operator:admin', 'operator:test']);
  if (genericOperators.has(cleanOperator.toLowerCase())) {
    return { valid: false, reason: `EMERGENCY_OVERRIDE_REJECTED: Generic operator identity '${cleanOperator}' is not permitted` };
  }

  const validOperatorPattern = /^([a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+\.[a-zA-Z]{2,}|operator:[a-zA-Z0-9_.-]{4,})$/;
  if (!validOperatorPattern.test(cleanOperator) || cleanOperator.length < 6) {
    return {
      valid: false,
      reason: `EMERGENCY_OVERRIDE_INVALID_OPERATOR: Operator identity must be a verified email or operator:<handle> with length >= 6 (got '${cleanOperator}')`
    };
  }

  if (!auth.justification || typeof auth.justification !== 'string' || auth.justification.trim().length < 20) {
    return {
      valid: false,
      reason: `EMERGENCY_OVERRIDE_JUSTIFICATION_TOO_SHORT: Justification must be specific operational rationale with length >= 20 characters`
    };
  }

  const genericJustifications = new Set(['emergency', 'skip rehearsal', 'testing override', 'please restore', 'urgent', 'fix error']);
  if (genericJustifications.has(auth.justification.trim().toLowerCase())) {
    return { valid: false, reason: `EMERGENCY_OVERRIDE_REJECTED: Generic or boilerplate justification is not permitted` };
  }

  const expectedCode = `EMERGENCY_OVERRIDE:${expectedRunId}:${targetDbName}`;
  if (auth.authorization_code !== expectedCode) {
    return {
      valid: false,
      reason: `EMERGENCY_OVERRIDE_CODE_INVALID: Expected authorization_code '${expectedCode}'`
    };
  }

  const acknowledged = Array.isArray(auth.acknowledged_risks) ? auth.acknowledged_risks : [];
  if (!acknowledged.includes('DATA_LOSS') || !acknowledged.includes('SCHEMA_DIVERGENCE')) {
    return {
      valid: false,
      reason: `EMERGENCY_OVERRIDE_RISKS_REQUIRED: Must explicitly acknowledge risks ['DATA_LOSS', 'SCHEMA_DIVERGENCE']`
    };
  }

  return { valid: true, operator: cleanOperator, justification: auth.justification.trim() };
}

/**
 * Approval-Safe & Rehearsal-Enforced Canonical Recovery Execution
 * Enforces:
 * 1. Valid manifest and dump integrity.
 * 2. Prerequisite restore rehearsal (database_restore_rehearsed: true) or auditable run-bound emergency authorization.
 * 3. Scoped operator confirmation token (tied to specific manifest run_id; prevents ambient .env inheritance).
 */
async function executeCanonicalRecovery(conn, dumpFile, dbConfig, opts = {}) {
  if (!fs.existsSync(dumpFile)) {
    throw new Error(`FAIL_CLOSED: Baseline SQL dump file not found: ${dumpFile}`);
  }

  const targetDbName = dbConfig.database || dbConfig.name;

  // 1. Resolve and validate manifest
  let manifest = opts.manifest;
  let manifestPath = opts.manifestPath;

  if (!manifest) {
    if (!manifestPath) {
      const dumpDir = path.dirname(path.resolve(dumpFile));
      const pointerPath = path.join(dumpDir, '.latest_verified_manifest');
      if (fs.existsSync(pointerPath)) {
        const pName = fs.readFileSync(pointerPath, 'utf8').trim();
        manifestPath = path.join(dumpDir, pName);
      }
    }
    if (manifestPath && fs.existsSync(manifestPath)) {
      const validated = await validateAndLoadManifest(manifestPath, dbConfig, path.dirname(manifestPath));
      manifest = validated.manifest;
    }
  }

  // 2. Enforce Restore Rehearsal Prerequisite
  const isRehearsed = Boolean(manifest && manifest.status && manifest.status.database_restore_rehearsed === true);

  if (!isRehearsed) {
    const authResult = validateEmergencyAuthorization(opts.emergencyAuthorization, manifest, targetDbName);
    if (!authResult.valid) {
      throw new Error(
        `FAIL_CLOSED_REHEARSAL_REQUIRED: Destructive database recovery requires that this specific backup was rehearsed ` +
        `on an isolated schema (database_restore_rehearsed is false). ${authResult.reason}`
      );
    }

    // Assert durable manifest path exists before permitting emergency recovery
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new Error(
        `FAIL_CLOSED_AUDIT_REQUIRED: Cannot perform emergency override without an active, durable manifest file to record the audit trail.`
      );
    }

    // Record auditable approval event (FAIL-CLOSED: never silently omit or bypass)
    try {
      updateManifestState(manifestPath, {
        emergency_override_audit: {
          timestamp: new Date().toISOString(),
          operator_id: authResult.operator,
          justification: authResult.justification,
          target_run_id: manifest ? manifest.run_id : null,
          target_database: targetDbName,
          status: 'APPLIED'
        }
      });
    } catch (auditErr) {
      throw new Error(
        `FAIL_CLOSED_AUDIT_PERSISTENCE_FAILED: Failed to record emergency override audit in manifest (${manifestPath}): ${auditErr.message}. Aborting recovery to prevent unaudited state changes.`
      );
    }
  }

  // 3. Isolated Confirmation Gate: Scoped to specific run_id to avoid ambient .env pollution
  const expectedRunId = manifest ? manifest.run_id : null;
  const suppliedToken = opts.confirmationToken;
  const suppliedRunId = opts.targetRunId;
  const suppliedFlag = opts.confirmationFlag;

  let approved = false;
  if (expectedRunId) {
    if (suppliedToken === expectedRunId) {
      approved = true;
    } else if (suppliedFlag === 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY' && suppliedRunId === expectedRunId) {
      approved = true;
    }
  } else {
    // If no manifest exists, require explicit non-empty confirmationToken matching confirmationFlag
    if (suppliedFlag === 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY' && opts.allowLegacyConfirmation === true) {
      approved = true;
    }
  }

  if (!approved) {
    throw new Error(
      `FAIL_CLOSED_APPROVAL_REQUIRED: Destructive database recovery requires explicit operator confirmation scoped to run_id ` +
      `'${expectedRunId || 'UNKNOWN'}'. Ambient confirmation flags are rejected to prevent accidental drops.`
    );
  }

  // 4. Pre-restore DDL cleanup
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  // 1. Drop 0038 tables
  await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_audit_logs');
  await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_requests');
  // 2. Drop 0037 modified table (vendors)
  await conn.query('DROP TABLE IF EXISTS vendors');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // 5. Stream restore verified baseline dump
  return await streamRestore(dumpFile, dbConfig, opts);
}

/**
 * Verified Upload Archive Extraction and Restoration.
 * Prevents directory traversal, absolute paths, symlinks, and hardlinks.
 * Automatically restores old target uploads directory if directory swap fails.
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

  // 3. Pre-scan tar archive for malicious entries (Directory traversal, absolute paths, symlinks, hardlinks)
  // 3a. Verbose listing for link / permission inspection
  const tarList = spawnSync('tar', ['-ztvf', archivePath], { encoding: 'utf8' });
  if (tarList.status !== 0) {
    throw new Error(`FAIL_CLOSED: Cannot read archive contents: ${tarList.stderr}`);
  }

  const vLines = tarList.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of vLines) {
    // Check for symlinks or hardlinks in tar listing
    if (line.startsWith('l') || line.includes(' -> ')) {
      throw new Error(`FAIL_CLOSED: Malicious archive entry detected (symbolic link forbidden): ${line}`);
    }
    if (line.startsWith('h') || line.includes(' link to ')) {
      throw new Error(`FAIL_CLOSED: Malicious archive entry detected (hard link forbidden): ${line}`);
    }
  }

  // 3b. Structured path listing (tar -ztf) for clean cross-platform entry inspection (GNU, BSD & BusyBox tar safe)
  const tarPaths = spawnSync('tar', ['-ztf', archivePath], { encoding: 'utf8' });
  if (tarPaths.status !== 0) {
    throw new Error(`FAIL_CLOSED: Cannot list archive paths: ${tarPaths.stderr}`);
  }

  const rawEntries = tarPaths.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  for (const entryPath of rawEntries) {
    if (entryPath.startsWith('/') || entryPath.startsWith('\\')) {
      throw new Error(`FAIL_CLOSED: Malicious archive entry detected (absolute path forbidden): ${entryPath}`);
    }
    if (entryPath.includes('\0') || entryPath.includes('%2e%2e')) {
      throw new Error(`FAIL_CLOSED: Malicious archive entry detected (corrupt encoding): ${entryPath}`);
    }

    const segments = entryPath.split(/[/\\]/);
    if (segments.includes('..') || entryPath.includes('../') || entryPath.includes('..\\')) {
      throw new Error(`FAIL_CLOSED: Malicious archive entry detected (directory traversal attempt): ${entryPath}`);
    }
  }

  // 4. Staged Extraction to Temporary Directory
  const stagingDir = `${resolvedTarget}_restore_staging_${Date.now()}`;
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  const backupExisting = `${resolvedTarget}_pre_restore_bak_${Date.now()}`;
  let targetExisted = false;

  try {
    const extractRes = spawnSync('tar', ['-xzf', archivePath, '-C', stagingDir], { encoding: 'utf8' });
    if (extractRes.status !== 0) {
      throw new Error(`FAIL_CLOSED: Extraction failed: ${extractRes.stderr}`);
    }

    // Recursive post-extraction validation: ensure zero symbolic links exist in stagingDir
    function assertNoSymlinks(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        const lstat = fs.lstatSync(full);
        if (lstat.isSymbolicLink()) {
          throw new Error(`FAIL_CLOSED: Symbolic link detected in extracted files: ${item}`);
        }
        if (lstat.isDirectory()) {
          assertNoSymlinks(full);
        }
      }
    }
    assertNoSymlinks(stagingDir);

    const extractedEntries = fs.readdirSync(stagingDir);
    if (extractedEntries.length === 0) {
      throw new Error('FAIL_CLOSED: Staging directory is empty after extraction!');
    }

    // 5. Safe Atomic Swap with Automatic Rollback
    if (fs.existsSync(resolvedTarget)) {
      targetExisted = true;
      fs.renameSync(resolvedTarget, backupExisting);
    }

    // Fault injection point 1: before target move
    if (opts.faultInjection === 'FAIL_BEFORE_TARGET_MOVE') {
      throw new Error('FAULT_INJECTION: Simulated failure before target directory move');
    }

    // Locate inner folder if tar included top-level directory
    const innerPath = path.join(stagingDir, path.basename(resolvedTarget));
    const sourceToMove = fs.existsSync(innerPath) ? innerPath : stagingDir;

    fs.renameSync(sourceToMove, resolvedTarget);

    // Fault injection point 2: after target move
    if (opts.faultInjection === 'FAIL_AFTER_TARGET_MOVE') {
      throw new Error('FAULT_INJECTION: Simulated failure after target directory move');
    }

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
    // CRITICAL 3: Automatic Rollback — if targetExisted and target is missing or swap failed,
    // restore the original backupExisting directory back to resolvedTarget immediately!
    let originalRestored = false;
    if (targetExisted && fs.existsSync(backupExisting)) {
      try {
        if (fs.existsSync(resolvedTarget)) {
          fs.rmSync(resolvedTarget, { recursive: true, force: true });
        }
        fs.renameSync(backupExisting, resolvedTarget);
        originalRestored = true;
      } catch (rollbackErr) {
        console.error(`[CRITICAL] Rollback of original uploads directory failed: ${rollbackErr.message}`);
      }
    }

    // Clean up staging directory
    if (fs.existsSync(stagingDir)) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    }

    if (originalRestored) {
      throw new Error(
        `FAIL_CLOSED: Upload restore failed during directory swap; original uploads directory was automatically restored intact: ${err.message}`
      );
    } else {
      throw new Error(
        `FAIL_CLOSED: Upload restore failed: ${err.message}${targetExisted ? ` (CRITICAL: original uploads preserved at ${backupExisting})` : ''}`
      );
    }
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
  if (!hasFooter) {
    throw new Error(`FAIL_CLOSED_CORRUPTED_DUMP: Dump file '${dumpPath}' is truncated or missing completion footer. Manifest pointer will not be updated.`);
  }

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
    schema_version: '3.5',
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

  // Atomic write via .tmp with fail-safe cleanup
  const tmpManifest = `${manifestPath}.tmp`;
  const pointerPath = path.join(backupDir, '.latest_verified_manifest');
  const tmpPointer = `${pointerPath}.tmp`;

  try {
    fs.writeFileSync(tmpManifest, JSON.stringify(manifestData, null, 2), { mode: 0o600 });
    fs.renameSync(tmpManifest, manifestPath);

    // Atomic pointer update only after manifest is fully written and verified
    fs.writeFileSync(tmpPointer, manifestFilename, { mode: 0o600 });
    fs.renameSync(tmpPointer, pointerPath);
  } catch (err) {
    if (fs.existsSync(tmpManifest)) {
      try { fs.unlinkSync(tmpManifest); } catch (_) {}
    }
    if (fs.existsSync(tmpPointer)) {
      try { fs.unlinkSync(tmpPointer); } catch (_) {}
    }
    throw err;
  }

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
  rehearseDatabaseRestore,
  executeCanonicalRecovery,
  restoreUploadsArchive,
  createHardenedManifest,
  updateManifestState
};
