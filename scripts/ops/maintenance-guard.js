'use strict';

/**
 * Mr. Tumi Marketplace — Maintenance & Worker Isolation Guard (v3.1 Hardened)
 *
 * Guarantees:
 * 1. Strict Fail-Closed Lock: Any error reading or parsing the lock blocks workers.
 * 2. Byte-for-byte .htaccess preservation: Existing rules are never destroyed or lost.
 * 3. Safe crontab suspension: Verifies backup before suspension, verifies byte-for-byte restoration.
 * 4. Stale lock safety: Stale locks are never silently wiped; requires operator review.
 * 5. Permanent maintenance persistence upon any deployment or recovery failure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getPaths(customRootDir) {
  const rootDir = customRootDir || path.resolve(__dirname, '..', '..');
  const homeDir = process.env.HOME || process.env.USERPROFILE || rootDir;
  const lockPath = path.join(homeDir, '.mrtumi_maintenance.lock');
  const publicDir = path.join(rootDir, 'public');
  const htaccessPath = path.join(publicDir, '.htaccess');
  const htaccessBakPath = path.join(publicDir, '.htaccess.pre_maint_backup');
  const backupDir = path.join(homeDir, 'db_backups');
  const crontabBakPath = path.join(backupDir, 'crontab_pre_deploy.bak');

  return { rootDir, homeDir, lockPath, publicDir, htaccessPath, htaccessBakPath, backupDir, crontabBakPath };
}

/**
 * Strict Fail-Closed Maintenance Check.
 * If lock exists, or if any error occurs inspecting the lock, it reports locked: true.
 */
function checkMaintenanceLock(customRootDir) {
  const { lockPath } = getPaths(customRootDir);

  try {
    if (!fs.existsSync(lockPath)) {
      return { locked: false };
    }

    let raw;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (readErr) {
      // FAIL-CLOSED on permission or filesystem read error
      return {
        locked: true,
        failClosed: true,
        reason: `FAIL_CLOSED: Cannot read maintenance lock file (${readErr.message})`,
        lockPath
      };
    }

    let info = {};
    try {
      info = JSON.parse(raw);
    } catch (parseErr) {
      // FAIL-CLOSED on corrupted or unparsed lock JSON
      return {
        locked: true,
        failClosed: true,
        reason: `FAIL_CLOSED: Maintenance lock contains corrupted JSON (${parseErr.message})`,
        lockPath
      };
    }

    // Check lock state
    const lockAgeMs = info.timestamp ? (Date.now() - new Date(info.timestamp).getTime()) : 0;
    const isStale = lockAgeMs > (24 * 60 * 60 * 1000); // older than 24 hours

    return {
      locked: true,
      lockPath,
      reason: info.reason || 'Maintenance mode active',
      timestamp: info.timestamp || 'unknown',
      state: info.state || 'ACTIVE_MAINTENANCE',
      pid: info.pid,
      isStale,
      staleWarning: isStale ? 'STALE_LOCK_REQUIRES_OPERATOR_REVIEW' : null
    };
  } catch (err) {
    // Top-level FAIL-CLOSED on any unexpected error
    return {
      locked: true,
      failClosed: true,
      reason: `FAIL_CLOSED: Unexpected error checking maintenance lock: ${err.message}`,
      lockPath
    };
  }
}

/**
 * Worker Gatekeeper: halts background workers immediately if maintenance is locked.
 */
function guardWorkerExecution(workerName, customRootDir) {
  const status = checkMaintenanceLock(customRootDir);
  if (status.locked) {
    console.log(JSON.stringify({
      status: 'PAUSED',
      worker: workerName,
      message: `Execution halted. Maintenance lock is active: ${status.reason}`,
      lockTimestamp: status.timestamp,
      lockState: status.state,
      isStale: status.isStale || false
    }));
    process.exit(0);
  }
}

const HTACCESS_HEADER = '# >>> MR_TUMI_MAINTENANCE_START >>>';
const HTACCESS_FOOTER = '# <<< MR_TUMI_MAINTENANCE_END <<<';

/**
 * Engages full system maintenance reversibly.
 * Preserves the exact bytes, permissions and rules of existing .htaccess.
 */
function engageMaintenance(reason = 'Production Deployment or Recovery in Progress', customRootDir) {
  const { lockPath, publicDir, htaccessPath, htaccessBakPath, backupDir, crontabBakPath } = getPaths(customRootDir);

  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }

  // 1. Preserving .htaccess byte-for-byte
  let htaccessExisted = false;
  let originalHtaccessSha = null;
  let originalHtaccessMode = 0o644;
  let originalHtaccessContent = '';

  if (fs.existsSync(htaccessPath)) {
    htaccessExisted = true;
    const stat = fs.statSync(htaccessPath);
    originalHtaccessMode = stat.mode;
    const buf = fs.readFileSync(htaccessPath);
    originalHtaccessSha = sha256Buffer(buf);
    originalHtaccessContent = buf.toString('utf8');

    // Create verified pre-maintenance backup
    fs.writeFileSync(htaccessBakPath, buf, { mode: originalHtaccessMode });
    const backupSha = sha256Buffer(fs.readFileSync(htaccessBakPath));
    if (backupSha !== originalHtaccessSha) {
      throw new Error('FAIL_CLOSED: Failed to create byte-verified .htaccess backup prior to maintenance!');
    }
  }

  // 2. Prepend maintenance 503 rules reversibly
  const maintenanceBlock = [
    HTACCESS_HEADER,
    'RewriteEngine On',
    'RewriteRule ^ - [R=503,L]',
    'ErrorDocument 503 "<html><head><title>503 Service Unavailable</title></head><body style=\'font-family:sans-serif;text-align:center;padding:50px;\'><h2>System Maintenance in Progress</h2><p>Mr. Tumi is currently performing scheduled system updates. Please retry in a few moments.</p></body></html>"',
    'Header always set Retry-After "300"',
    HTACCESS_FOOTER,
    ''
  ].join('\n');

  const newHtaccessContent = htaccessExisted
    ? `${maintenanceBlock}\n${originalHtaccessContent}`
    : maintenanceBlock;

  // Atomic write of active .htaccess
  const tmpHtaccess = `${htaccessPath}.tmp`;
  fs.writeFileSync(tmpHtaccess, newHtaccessContent, { mode: originalHtaccessMode });
  fs.renameSync(tmpHtaccess, htaccessPath);

  // 3. Crontab suspension with verified backup
  let crontabSuspended = false;
  try {
    const whichCron = spawnSync('which', ['crontab'], { stdio: 'ignore' });
    if (whichCron.status === 0) {
      const dumpCron = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      if (dumpCron.status === 0 && dumpCron.stdout && dumpCron.stdout.trim()) {
        fs.writeFileSync(crontabBakPath, dumpCron.stdout, { mode: 0o600 });
        if (fs.existsSync(crontabBakPath) && fs.statSync(crontabBakPath).size > 0) {
          const pauseRes = spawnSync('crontab', ['-r'], { stdio: 'ignore' });
          if (pauseRes.status === 0) {
            crontabSuspended = true;
          }
        }
      }
    }
  } catch (_) {
    // Crontab CLI not present
  }

  // 4. Create Lockfile atomically via .tmp
  const lockData = {
    schema_version: '3.1',
    run_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    reason,
    pid: process.pid,
    state: 'ACTIVE_MAINTENANCE',
    node_version: process.version,
    htaccess: {
      existed: htaccessExisted,
      original_sha: originalHtaccessSha,
      original_mode: originalHtaccessMode
    },
    crontab: {
      suspended: crontabSuspended
    }
  };

  const tmpLock = `${lockPath}.tmp`;
  fs.writeFileSync(tmpLock, JSON.stringify(lockData, null, 2), { mode: 0o600 });
  fs.renameSync(tmpLock, lockPath);

  return { status: 'ENGAGED', lockPath, htaccessPath, preExistingHtaccess: htaccessExisted, lockData };
}

/**
 * Disengages maintenance cleanly:
 * Restores original .htaccess byte-for-byte.
 * Restores original crontab with exact byte verification.
 */
function disengageMaintenance(customRootDir) {
  const { lockPath, htaccessPath, htaccessBakPath, crontabBakPath } = getPaths(customRootDir);

  let lockInfo = {};
  if (fs.existsSync(lockPath)) {
    try {
      lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (_) {}
  }

  // 1. Reversible .htaccess restoration
  const htaccessInfo = lockInfo.htaccess || {};
  if (htaccessInfo.existed === false) {
    // .htaccess did not exist before; clean up
    if (fs.existsSync(htaccessPath)) {
      try { fs.unlinkSync(htaccessPath); } catch (_) {}
    }
  } else {
    // .htaccess existed previously; MUST restore byte-for-byte
    if (!fs.existsSync(htaccessBakPath)) {
      throw new Error(`FAIL_CLOSED: Cannot disengage maintenance. Pre-maintenance .htaccess backup missing at ${htaccessBakPath}`);
    }

    const backupBuf = fs.readFileSync(htaccessBakPath);
    const backupSha = sha256Buffer(backupBuf);

    if (htaccessInfo.original_sha && backupSha !== htaccessInfo.original_sha) {
      throw new Error(`FAIL_CLOSED: .htaccess backup checksum mismatch! Expected ${htaccessInfo.original_sha}, got ${backupSha}`);
    }

    // Atomic restore
    const tmpRestored = `${htaccessPath}.tmp`;
    fs.writeFileSync(tmpRestored, backupBuf, { mode: htaccessInfo.original_mode || 0o644 });
    fs.renameSync(tmpRestored, htaccessPath);

    // Verify byte-for-byte identity
    const restoredSha = sha256Buffer(fs.readFileSync(htaccessPath));
    if (restoredSha !== backupSha) {
      throw new Error('FAIL_CLOSED: Restored .htaccess does not match original backup!');
    }

    // Clean up backup only after successful verification
    try { fs.unlinkSync(htaccessBakPath); } catch (_) {}
  }

  // 2. Verified Crontab restoration
  if (fs.existsSync(crontabBakPath)) {
    const origCron = fs.readFileSync(crontabBakPath, 'utf8');
    const restoreRes = spawnSync('crontab', [crontabBakPath], { stdio: 'pipe' });
    if (restoreRes.status !== 0) {
      const err = restoreRes.stderr ? restoreRes.stderr.toString() : 'Unknown crontab error';
      throw new Error(`FAIL_CLOSED: Crontab restoration failed (${err}). Crontab backup preserved at ${crontabBakPath}`);
    }

    // Verify restored crontab
    const checkCron = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (checkCron.status === 0 && checkCron.stdout !== origCron) {
      throw new Error(`FAIL_CLOSED: Restored crontab content does not match original backup! Preserving ${crontabBakPath}`);
    }

    try { fs.unlinkSync(crontabBakPath); } catch (_) {}
  }

  // 3. Remove lockfile last
  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }

  return { status: 'DISENGAGED' };
}

/**
 * Persists maintenance mode upon deployment or recovery failure.
 * Updates the lockfile with failure details so all workers and tools remain blocked.
 */
function persistOnFailure(error, customRootDir) {
  const { lockPath, htaccessPath } = getPaths(customRootDir);
  const errMsg = error ? error.message : 'Unknown deployment failure';
  const errStack = error ? error.stack : '';

  try {
    let currentData = {};
    if (fs.existsSync(lockPath)) {
      try {
        currentData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (_) {}
    }

    const failureData = {
      ...currentData,
      state: 'FAILED_DEPLOYMENT',
      failure_timestamp: new Date().toISOString(),
      error_message: errMsg,
      error_stack: errStack
    };

    const tmpLock = `${lockPath}.tmp`;
    fs.writeFileSync(tmpLock, JSON.stringify(failureData, null, 2), { mode: 0o600 });
    fs.renameSync(tmpLock, lockPath);
  } catch (updateErr) {
    console.error(`[LOCK_UPDATE_ERROR]: ${updateErr.message}`);
  }

  console.error(`[MAINTENANCE_LOCKED]: 503 and worker lock permanently active due to failure: ${errMsg}`);
  console.error(`[ACTION_REQUIRED]: Operator manual review required at ${lockPath} and ${htaccessPath}`);
}

module.exports = {
  checkMaintenanceLock,
  guardWorkerExecution,
  engageMaintenance,
  disengageMaintenance,
  persistOnFailure,
  getPaths,
  HTACCESS_HEADER,
  HTACCESS_FOOTER
};
