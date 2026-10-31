'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qa', 'demo-browser-e2e.js'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'demo-browser-e2e.yml'), 'utf8');

test('demo browser harness refuses non-test/non-disposable database targets', () => {
  assert.match(runner, /NODE_ENV === 'test'/);
  assert.match(runner, /DB_CLIENT === 'mysql'/);
  assert.match(runner, /DB_NAME === 'mrtumi_test'.*DB_USER === 'mrtumi_test'.*DB_HOST === '127\.0\.0\.1'/);
  assert.match(runner, /MYSQL_TEST_REQUIRED === 'true'/);
});

test('demo browser CI uses isolated disposable MySQL 8 and MariaDB 10.11 service images', () => {
  assert.match(workflow, /image: mysql:8\.0/);
  assert.match(workflow, /image: mariadb:10\.11/);
  assert.match(workflow, /healthcheck\.sh --connect --innodb_initialized/);
  assert.match(workflow, /mysqladmin ping/);
  assert.match(workflow, /retention-days: 30/);
});

test('demo fixtures use tagged synthetic identities, browser journeys, and guaranteed schema teardown', () => {
  assert.match(runner, /DEMO-E2E-/);
  assert.match(runner, /example\.invalid/);
  assert.match(runner, /chromium\.launch/);
  assert.match(runner, /Customer registration, login\/session, storefront cart, COD checkout and order history/);
  assert.match(runner, /Customer pre-dispatch cancellation/);
  assert.match(runner, /Public storefront: all five DEMO products render/);
  assert.match(runner, /Return request, evidence upload, and policy-authorized review/);
  assert.match(runner, /Vendor login, tenant isolation and assigned order visibility/);
  assert.match(runner, /migrateDown\(pool, \{ steps: 13 \}\)/);
  assert.match(runner, /remainingTables !== 0 \|\| results\.cleanup\.remainingMigrationRows !== 0/);
  assert.doesNotMatch(runner, /refunds\/execute|payouts\/execute|courier.*book/i);
});
