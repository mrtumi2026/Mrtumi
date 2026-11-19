'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseTestOutput, generateSummary } = require('../scripts/ci/generate-test-summary');

test('CI Summary Generator — Fail-Closed Suite (v3.6 Hardened)', async (t) => {
  await t.test('Fails closed on empty log content', () => {
    assert.throws(
      () => parseTestOutput('   \n  \t  \n'),
      /TRUNCATED_OR_EMPTY_LOG/
    );
  });

  await t.test('Fails closed on missing summary block', () => {
    const raw = `
      ✔ database connection established (1.2ms)
      ✔ query succeeded (0.5ms)
    `;
    assert.throws(
      () => parseTestOutput(raw),
      /MISSING_SUMMARY_BLOCK/
    );
  });

  await t.test('Fails closed when summary block is malformed or missing required keys', () => {
    const raw = `
      ℹ suites 5
      ℹ duration_ms 120
    `;
    assert.throws(
      () => parseTestOutput(raw),
      /MALFORMED_SUMMARY_BLOCK/
    );
  });

  await t.test('Fails closed when zero tests are reported', () => {
    const raw = `
      ℹ tests 0
      ℹ suites 0
      ℹ pass 0
      ℹ fail 0
      ℹ duration_ms 50
    `;
    assert.throws(
      () => parseTestOutput(raw),
      /ZERO_TESTS_REPORTED/
    );
  });

  await t.test('Fails closed when test count does not equal sum of parts (parity mismatch)', () => {
    const raw = `
      ℹ tests 100
      ℹ suites 5
      ℹ pass 90
      ℹ fail 5
      ℹ skipped 0
      ℹ duration_ms 500
    `;
    assert.throws(
      () => parseTestOutput(raw),
      /TEST_COUNT_PARITY_MISMATCH/
    );
  });

  await t.test('Fails closed when suites count is lower than minExpectedSuites', () => {
    const raw = `
      ℹ tests 50
      ℹ suites 2
      ℹ pass 50
      ℹ fail 0
      ℹ skipped 0
      ℹ duration_ms 500
    `;
    assert.throws(
      () => parseTestOutput(raw, { minExpectedSuites: 5 }),
      /INCOMPLETE_SUITES/
    );
  });

  await t.test('Fails closed when tests count is lower than minExpectedTests', () => {
    const raw = `
      ℹ tests 50
      ℹ suites 5
      ℹ pass 50
      ℹ fail 0
      ℹ skipped 0
      ℹ duration_ms 500
    `;
    assert.throws(
      () => parseTestOutput(raw, { minExpectedTests: 100 }),
      /INCOMPLETE_TESTS/
    );
  });

  await t.test('Correctly parses valid Node spec summary block', () => {
    const raw = `
      ✔ user test 1
      ✔ user test 2
      ℹ tests 617
      ℹ suites 26
      ℹ pass 617
      ℹ fail 0
      ℹ cancelled 0
      ℹ skipped 0
      ℹ todo 0
      ℹ duration_ms 12345.6
    `;
    const res = parseTestOutput(raw);
    assert.strictEqual(res.tests, 617);
    assert.strictEqual(res.suites, 26);
    assert.strictEqual(res.passed, 617);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.skipped, 0);
    assert.strictEqual(res.success, true);
  });

  await t.test('Correctly parses valid TAP summary block', () => {
    const raw = `
      1..617
      ok 1 - auth
      # tests 617
      # suites 26
      # pass 617
      # fail 0
      # cancelled 0
      # skipped 0
      # todo 0
      # duration_ms 15000
    `;
    const res = parseTestOutput(raw);
    assert.strictEqual(res.tests, 617);
    assert.strictEqual(res.suites, 26);
    assert.strictEqual(res.passed, 617);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.success, true);
  });

  await t.test('Picks the canonical root summary when multiple blocks exist', () => {
    const raw = `
      # Subtest 1
      ℹ tests 10
      ℹ suites 1
      ℹ pass 10
      ℹ fail 0
      ℹ skipped 0

      # Final root summary
      ℹ tests 617
      ℹ suites 26
      ℹ pass 617
      ℹ fail 0
      ℹ cancelled 0
      ℹ skipped 0
      ℹ todo 0
      ℹ duration_ms 9999
    `;
    const res = parseTestOutput(raw);
    assert.strictEqual(res.tests, 617);
    assert.strictEqual(res.suites, 26);
    assert.strictEqual(res.passed, 617);
    assert.strictEqual(res.success, true);
  });

  await t.test('generateSummary writes test-summary.json and handles missing log fail-closed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-test-'));
    try {
      const missingLog = path.join(tmpDir, 'does-not-exist.log');
      const res = generateSummary('MySQL 8.0', missingLog, tmpDir);
      assert.strictEqual(res.status, 'FAIL');
      assert.strictEqual(res.exitCode, 1);
      assert.match(res.error, /LOG_FILE_NOT_FOUND/);

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-summary.json'), 'utf8'));
      assert.strictEqual(written.status, 'FAIL');
      assert.strictEqual(written.engine, 'MySQL 8.0');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('generateSummary writes success summary when tests pass', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-test-'));
    try {
      const logFile = path.join(tmpDir, 'test-output.log');
      fs.writeFileSync(logFile, `
        ℹ tests 15
        ℹ suites 2
        ℹ pass 15
        ℹ fail 0
        ℹ skipped 0
        ℹ duration_ms 250
      `);
      const res = generateSummary('MariaDB 10.11', logFile, tmpDir);
      assert.strictEqual(res.status, 'PASS');
      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.tests, 15);

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-summary.json'), 'utf8'));
      assert.strictEqual(written.status, 'PASS');
      assert.strictEqual(written.passed, 15);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
