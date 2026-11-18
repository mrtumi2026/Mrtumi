'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  checkMaintenanceLock,
  engageMaintenance,
  disengageMaintenance,
  persistOnFailure,
  getPaths
} = require('../scripts/ops/maintenance-guard');

describe('Workstream D — Maintenance & Worker Isolation Suite', () => {
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

  test('engageMaintenance creates 503 .htaccess and atomic lockfile', () => {
    const res = engageMaintenance('Unit Test Deployment', sandboxDir);
    assert.equal(res.status, 'ENGAGED');

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, true);
    assert.equal(status.reason, 'Unit Test Deployment');

    const { htaccessPath, lockPath } = getPaths(sandboxDir);
    assert.ok(fs.existsSync(lockPath), 'Lockfile must exist');
    assert.ok(fs.existsSync(htaccessPath), '.htaccess must exist');

    const htContent = fs.readFileSync(htaccessPath, 'utf8');
    assert.match(htContent, /503/, 'Must include 503 status code');
    assert.match(htContent, /Retry-After "300"/, 'Must include Retry-After header');
  });

  test('persistOnFailure preserves maintenance lockfile and .htaccess intact', () => {
    persistOnFailure(new Error('Simulated Migration Crash'), sandboxDir);

    const { htaccessPath, lockPath } = getPaths(sandboxDir);
    assert.ok(fs.existsSync(lockPath), 'Lockfile must NOT be deleted upon failure');
    assert.ok(fs.existsSync(htaccessPath), '.htaccess must NOT be deleted upon failure');

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, true);
  });

  test('disengageMaintenance removes lockfile and 503 rules', () => {
    const res = disengageMaintenance(sandboxDir);
    assert.equal(res.status, 'DISENGAGED');

    const { htaccessPath, lockPath } = getPaths(sandboxDir);
    assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be removed');
    assert.equal(fs.existsSync(htaccessPath), false, '.htaccess must be removed');

    const status = checkMaintenanceLock(sandboxDir);
    assert.equal(status.locked, false);
  });

  test('All background database writers import and invoke maintenance-guard', () => {
    const writers = [
      'scripts/expire-reservations.js',
      'scripts/process-matured-settlements.js',
      'scripts/sync-courier-tracking.js',
      'scripts/apply-approved-business-launch.js'
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
});
