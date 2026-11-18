'use strict';

/**
 * Maintenance & Worker Isolation Guard for Mr. Tumi Marketplace
 * Ensures zero concurrent database mutations during deployment or disaster recovery.
 *
 * Web Isolation: 503 Service Unavailable via public/.htaccess
 * Worker Isolation: $HOME/.mrtumi_maintenance.lock checked by all CLI / cron runners
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function getPaths(customRootDir) {
  const rootDir = customRootDir || path.resolve(__dirname, '..', '..');
  const homeDir = process.env.HOME || process.env.USERPROFILE || rootDir;
  const lockPath = path.join(homeDir, '.mrtumi_maintenance.lock');
  const publicDir = path.join(rootDir, 'public');
  const htaccessPath = path.join(publicDir, '.htaccess');
  const htaccessMaintPath = path.join(publicDir, '.htaccess_maint');
  const backupDir = path.join(homeDir, 'db_backups');
  const crontabBakPath = path.join(backupDir, 'crontab_pre_deploy.bak');

  return { rootDir, homeDir, lockPath, publicDir, htaccessPath, htaccessMaintPath, backupDir, crontabBakPath };
}

/**
 * Checks if maintenance mode is active.
 * Used by all background cron jobs and queue workers before initiating DB operations.
 */
function checkMaintenanceLock(customRootDir) {
  const { lockPath } = getPaths(customRootDir);
  if (!fs.existsSync(lockPath)) {
    return { locked: false };
  }

  let info = {};
  try {
    info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    info = { reason: 'Active maintenance lock (unparsed)' };
  }

  return {
    locked: true,
    lockPath,
    reason: info.reason || 'Maintenance in progress',
    timestamp: info.timestamp || 'unknown',
    pid: info.pid
  };
}

/**
 * Gatekeeper helper: if maintenance is active, logs and terminates the worker with exit code 0.
 */
function guardWorkerExecution(workerName, customRootDir) {
  const status = checkMaintenanceLock(customRootDir);
  if (status.locked) {
    console.log(JSON.stringify({
      status: 'PAUSED',
      worker: workerName,
      message: `Execution halted. Maintenance lock is active: ${status.reason}`,
      lockTimestamp: status.timestamp
    }));
    process.exit(0);
  }
}

/**
 * Engages full system maintenance:
 * 1. Creates $HOME/.mrtumi_maintenance.lock
 * 2. Writes 503 Service Unavailable rules to public/.htaccess
 * 3. Safely backs up and pauses crontab (if crontab command exists)
 */
function engageMaintenance(reason = 'Production Deployment or Recovery in Progress', customRootDir) {
  const { lockPath, publicDir, htaccessPath, htaccessMaintPath, backupDir, crontabBakPath } = getPaths(customRootDir);

  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }

  // 1. Create Lockfile atomically via .tmp
  const lockData = {
    schema_version: '3.0',
    timestamp: new Date().toISOString(),
    reason,
    pid: process.pid,
    node_version: process.version
  };
  const tmpLock = `${lockPath}.tmp`;
  fs.writeFileSync(tmpLock, JSON.stringify(lockData, null, 2), { mode: 0o600 });
  fs.renameSync(tmpLock, lockPath);

  // 2. Deploy 503 .htaccess
  const rules = [
    '# ======================================================================',
    '# MR. TUMI 503 SERVICE UNAVAILABLE — ACTIVE MAINTENANCE WINDOW',
    '# ======================================================================',
    'RewriteEngine On',
    'RewriteRule ^ - [R=503,L]',
    'ErrorDocument 503 "<html><head><title>503 Service Unavailable</title></head><body style=\'font-family:sans-serif;text-align:center;padding:50px;\'><h2>System Maintenance in Progress</h2><p>Mr. Tumi is currently performing scheduled system updates. Please retry in a few moments.</p></body></html>"',
    'Header always set Retry-After "300"'
  ].join('\n') + '\n';

  fs.writeFileSync(htaccessMaintPath, rules, { mode: 0o644 });
  fs.copyFileSync(htaccessMaintPath, htaccessPath);

  // 3. Crontab suspension (Linux / cPanel only)
  try {
    const crontabCheck = spawnSync('which', ['crontab'], { stdio: 'ignore' });
    if (crontabCheck.status === 0) {
      const dumpCron = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      if (dumpCron.status === 0 && dumpCron.stdout && dumpCron.stdout.trim()) {
        fs.writeFileSync(crontabBakPath, dumpCron.stdout, { mode: 0o600 });
        // Empty out active crontab to prevent cron launches
        spawnSync('crontab', ['-r'], { stdio: 'ignore' });
      }
    }
  } catch (_) {
    // Crontab not available (e.g. Windows dev), file lock covers workers
  }

  return { status: 'ENGAGED', lockPath, htaccessPath };
}

/**
 * Disengages maintenance cleanly once all health checks pass.
 */
function disengageMaintenance(customRootDir) {
  const { lockPath, htaccessPath, htaccessMaintPath, crontabBakPath } = getPaths(customRootDir);

  // 1. Remove 503 rules
  if (fs.existsSync(htaccessPath)) {
    try { fs.unlinkSync(htaccessPath); } catch (_) {}
  }
  if (fs.existsSync(htaccessMaintPath)) {
    try { fs.unlinkSync(htaccessMaintPath); } catch (_) {}
  }

  // 2. Restore crontab if backup was made
  if (fs.existsSync(crontabBakPath)) {
    try {
      spawnSync('crontab', [crontabBakPath], { stdio: 'ignore' });
      fs.unlinkSync(crontabBakPath);
    } catch (_) {}
  }

  // 3. Remove lockfile last
  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }

  return { status: 'DISENGAGED' };
}

/**
 * Persists maintenance mode upon any unhandled error during deployment or recovery.
 * Fail-Closed: Never re-opens traffic or resumes workers if state is unverified.
 */
function persistOnFailure(error, customRootDir) {
  const { lockPath, htaccessPath } = getPaths(customRootDir);
  const errMsg = error ? error.message : 'Unknown failure';
  console.error(`[MAINTENANCE_PRESERVED]: Preserving 503 and worker lock due to failure: ${errMsg}`);
  console.error(`[MANUAL_INTERVENTION_REQUIRED]: Inspect ${lockPath} and ${htaccessPath}`);
}

module.exports = {
  checkMaintenanceLock,
  guardWorkerExecution,
  engageMaintenance,
  disengageMaintenance,
  persistOnFailure,
  getPaths
};
