'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  checkMaintenanceLock,
  engageMaintenance,
  disengageMaintenance,
  persistOnFailure,
  getPaths,
  HTACCESS_HEADER,
  HTACCESS_FOOTER
} = require('../scripts/ops/maintenance-guard');

function sha256String(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

describe('Workstream D — Maintenance & Worker Isolation Suite (v3.1 Hardened)', () => {
  const sandboxDir = path.join(__dirname, 'helpers', 'tmp-maint-sandbox');

  before(() => {
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test('checkMaintenanceLock returns locked: false when no lockfile exists', () => {
    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, false);
  });

  test('checkMaintenanceLock fails closed on corrupt or unparseable lockfile', () => {
    const { lockPath } = getPaths(sandboxDir);
    fs.writeFileSync(lockPath, 'INVALID_JSON_CORRUPTED_DATA{{{', 'utf8');

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, true, 'Corrupt lockfile must fail-closed as locked: true');
    assert.equal(status.failClosed, true);
    assert.match(status.reason, /FAIL_CLOSED/);

    // Clean up
    fs.unlinkSync(lockPath);
  });

  test('checkMaintenanceLock flags stale lock (>24 hours) for operator review', () => {
    const { lockPath } = getPaths(sandboxDir);
    const staleDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30 hrs ago
    fs.writeFileSync(lockPath, JSON.stringify({
      state: 'ACTIVE_MAINTENANCE',
      timestamp: staleDate,
      reason: 'Old deployment'
    }), 'utf8');

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, true);
    assert.equal(status.isStale, true, 'Lock older than 24h must be flagged isStale: true');
    assert.equal(status.staleWarning, 'STALE_LOCK_REQUIRES_OPERATOR_REVIEW');

    // Clean up
    fs.unlinkSync(lockPath);
  });

  test('engageMaintenance creates 503 .htaccess and atomic lockfile when no prior .htaccess existed', () => {
    const res = engageMaintenance('Unit Test Deployment Fresh', sandboxDir);
    assert.equal(res.status, 'ENGAGED');

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, true);
    assert.equal(status.reason, 'Unit Test Deployment Fresh');

    const { htaccessPath, lockPath } = getPaths(sandboxDir);
    assert.ok(fs.existsSync(lockPath), 'Lockfile must exist');
    assert.ok(fs.existsSync(htaccessPath), '.htaccess must exist');

    const htContent = fs.readFileSync(htaccessPath, 'utf8');
    assert.match(htContent, /503/, 'Must include 503 status code');
    assert.match(htContent, /Retry-After "300"/, 'Must include Retry-After header');
    assert.ok(htContent.includes(HTACCESS_HEADER));
    assert.ok(htContent.includes(HTACCESS_FOOTER));

    // Disengage
    const dis = disengageMaintenance(sandboxDir);
    assert.equal(dis.status, 'DISENGAGED');
    assert.equal(fs.existsSync(htaccessPath), false, 'Fresh .htaccess should be removed if none existed previously');
  });

  test('engageMaintenance and disengageMaintenance preserve pre-existing .htaccess byte-for-byte with SHA-256 integrity', () => {
    const { publicDir, htaccessPath, htaccessBakPath } = getPaths(sandboxDir);
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    // Realistic production .htaccess content
    const originalHtaccess = [
      '# cPanel Passenger Node.js configuration',
      'PassengerAppRoot "/home/mrtumico/mrtumi"',
      'PassengerBaseURI "/"',
      'PassengerNodejs "/home/mrtumico/nodevenv/mrtumi/22/bin/node"',
      'PassengerAppType node',
      'PassengerStartupFile app.js',
      '',
      'RewriteEngine On',
      'RewriteCond %{HTTPS} !=on',
      'RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]',
      '# Custom security headers',
      '<IfModule mod_headers.c>',
      '  Header set X-Content-Type-Options "nosniff"',
      '</IfModule>'
    ].join('\n');

    fs.writeFileSync(htaccessPath, originalHtaccess, 'utf8');
    const originalSha = sha256String(originalHtaccess);

    // 1. Engage maintenance
    const engageRes = engageMaintenance('Preflight Test Preservation', sandboxDir);
    assert.equal(engageRes.status, 'ENGAGED');
    assert.equal(engageRes.preExistingHtaccess, true);
    assert.ok(fs.existsSync(htaccessBakPath), 'Pre-maintenance backup must exist');

    // Backup content must exactly equal original content
    const bakContent = fs.readFileSync(htaccessBakPath, 'utf8');
    assert.equal(bakContent, originalHtaccess);
    assert.equal(sha256String(bakContent), originalSha);

    // Active .htaccess must have maintenance prepended, but preserve original rules below
    const activeContent = fs.readFileSync(htaccessPath, 'utf8');
    assert.ok(activeContent.startsWith(HTACCESS_HEADER), 'Must start with maintenance header');
    assert.ok(activeContent.includes(originalHtaccess), 'Must preserve original rules in active file');

    // 2. Disengage maintenance
    const disengageRes = disengageMaintenance(sandboxDir);
    assert.equal(disengageRes.status, 'DISENGAGED');
    assert.equal(fs.existsSync(htaccessPath), true, 'Pre-existing .htaccess must remain in place');
    assert.equal(fs.existsSync(htaccessBakPath), false, 'Backup must be unlinked after successful restoration');

    // Verify byte-for-byte restoration
    const restoredContent = fs.readFileSync(htaccessPath, 'utf8');
    assert.equal(restoredContent, originalHtaccess, 'Restored .htaccess must be byte-for-byte identical to original');
    assert.equal(sha256String(restoredContent), originalSha, 'Restored SHA-256 must match pre-maintenance SHA-256');

    // Clean up
    fs.unlinkSync(htaccessPath);
  });

  test('persistOnFailure preserves maintenance lockfile and .htaccess intact upon failure', () => {
    engageMaintenance('Simulated Deployment', sandboxDir);
    persistOnFailure(new Error('Simulated Migration Crash'), sandboxDir);

    const { htaccessPath, lockPath } = getPaths(sandboxDir);
    assert.ok(fs.existsSync(lockPath), 'Lockfile must NOT be deleted upon failure');
    assert.ok(fs.existsSync(htaccessPath), '.htaccess must NOT be deleted upon failure');

    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lockData.state, 'FAILED_DEPLOYMENT');
    assert.equal(lockData.error_message, 'Simulated Migration Crash');
    assert.ok(lockData.failure_timestamp);

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, true);

    // Clean up
    disengageMaintenance(sandboxDir);
  });

  test('All background database writers import and invoke maintenance-guard', () => {
    const writers = [
      'scripts/expire-reservations.js',
      'scripts/process-matured-settlements.js',
      'scripts/sync-courier-tracking.js',
      'scripts/apply-approved-business-launch.js',
      'scripts/seed-categories.js',
      'scripts/migrate.js'
    ];

    for (const file of writers) {
      const fullPath = path.resolve(__dirname, '..', file);
      assert.ok(fs.existsSync(fullPath), `Writer file must exist: ${file}`);
      const code = fs.readFileSync(fullPath, 'utf8');
      assert.match(
        code,
        /maintenance-guard/,
        `File ${file} must require maintenance-guard`
      );
      assert.match(
        code,
        /guardWorkerExecution\(/,
        `File ${file} must invoke guardWorkerExecution`
      );
    }
  });

  test('Distinguish production writers from QA/test utilities', () => {
    const qaUtilities = [
      'scripts/run-e2e-matrix.js',
      'scripts/check-foundation.js',
      'scripts/diagnose-migrations.js'
    ];

    for (const file of qaUtilities) {
      const fullPath = path.resolve(__dirname, '..', file);
      if (fs.existsSync(fullPath)) {
        const code = fs.readFileSync(fullPath, 'utf8');
        // QA utilities should NOT be locked by production maintenance guard
        assert.doesNotMatch(
          code,
          /guardWorkerExecution\(/,
          `QA utility ${file} should not be gated as a production background writer`
        );
      }
    }
  });
});

describe('Maintenance document root on cPanel', () => {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mrtumi-docroot-'));
  const appRoot = path.join(home, 'mrtumi');
  const docRoot = path.join(home, 'public_html');
  const original = `PassengerAppRoot "${appRoot}"\nPassengerAppType node\n`;
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, DOC: process.env.DEPLOY_DOCUMENT_ROOT };

  before(() => {
    fs.mkdirSync(path.join(appRoot, 'public'), { recursive: true });
    fs.mkdirSync(docRoot, { recursive: true });
    fs.writeFileSync(path.join(docRoot, '.htaccess'), original);
    process.env.HOME = home;
    process.env.PATH = home; // keeps the real crontab out of this test
    delete process.env.DEPLOY_DOCUMENT_ROOT;
  });

  after(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.DOC !== undefined) process.env.DEPLOY_DOCUMENT_ROOT = saved.DOC;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('uses the public_html .htaccess that serves this app and restores it byte for byte', () => {
    const result = engageMaintenance('docroot test', appRoot);
    assert.equal(result.htaccessPath, path.join(docRoot, '.htaccess'));
    assert.match(fs.readFileSync(result.htaccessPath, 'utf8'), /R=503/);
    disengageMaintenance(appRoot);
    assert.equal(fs.readFileSync(result.htaccessPath, 'utf8'), original);
  });

  test('a second code copy never touches the live document root', () => {
    const rehearsal = path.join(home, 'mrtumi-rehearsal');
    assert.equal(getPaths(rehearsal).htaccessPath, path.join(rehearsal, 'public', '.htaccess'));
  });

  test('deploy.sh lifts maintenance before the health check and can re-engage it', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'deploy.sh'), 'utf8');
    assert.ok(script.indexOf('mg.disengageMaintenance()') < script.indexOf('if node scripts/health-check.js'));
    assert.match(script, /engageMaintenance\("Post-deployment health check failed"\)/);
  });
});
