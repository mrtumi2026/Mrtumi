'use strict';

/**
 * Mr. Tumi Marketplace — Deterministic CI Test Summary Generator & Verifier (v3.6 Hardened)
 *
 * Guarantees:
 * 1. Reliable TAP and Node.js spec test-runner output parsing.
 * 2. Fail-closed: Detects missing, truncated, empty, malformed, or incomplete logs.
 * 3. Never reports zero tests or missing summary as success.
 * 4. Verifies test total parity (tests === passed + failed + skipped + cancelled + todo).
 * 5. Deterministic exit codes: exits 1 on any test failure or missing/malformed report.
 */

const fs = require('fs');
const path = require('path');

function parseTestOutput(logContent, opts = {}) {
  if (typeof logContent !== 'string' || !logContent.trim()) {
    throw new Error('TRUNCATED_OR_EMPTY_LOG: Test log output is empty or whitespace only');
  }

  const lines = logContent.split(/\r?\n/);
  const blocks = [];
  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^([#ℹ])\s*(tests|pass|fail|cancelled|skipped?|todo|suites|duration_ms)\s+([\d.]+)/i);
    if (match) {
      const prefix = match[1];
      const key = match[2].toLowerCase().replace(/ped$/, '');
      const val = Number(match[3]);
      if (!currentBlock || currentBlock.prefix !== prefix || currentBlock.seenKeys.has(key)) {
        currentBlock = { prefix, seenKeys: new Set(), data: {}, lineStart: i };
        blocks.push(currentBlock);
      }
      currentBlock.seenKeys.add(key);
      currentBlock.data[key] = val;
    }
  }

  if (blocks.length === 0) {
    throw new Error('MISSING_SUMMARY_BLOCK: No valid TAP or spec summary block found in test output');
  }

  const validBlocks = blocks.filter(b => ('tests' in b.data) && ('pass' in b.data));
  if (validBlocks.length === 0) {
    throw new Error('MALFORMED_SUMMARY_BLOCK: Summary block is incomplete (missing tests or pass fields)');
  }

  // Canonical block is the final root summary block
  const canonical = validBlocks[validBlocks.length - 1].data;

  const suites = canonical.suites || 0;
  const tests = canonical.tests !== undefined ? canonical.tests : 0;
  const passed = canonical.pass !== undefined ? canonical.pass : 0;
  const failed = canonical.fail !== undefined ? canonical.fail : 0;
  const skipped = canonical.skip !== undefined ? canonical.skip : (canonical.skipped || 0);
  const cancelled = canonical.cancelled || 0;
  const todo = canonical.todo || 0;
  const duration_ms = canonical.duration_ms || null;

  // Validation 1: Zero tests check
  if (tests === 0) {
    throw new Error('ZERO_TESTS_REPORTED: Test runner reported 0 total tests executed');
  }
  if (passed === 0 && tests > 0 && failed === 0) {
    throw new Error('ZERO_PASSES_REPORTED: Test runner reported 0 passed tests');
  }

  // Validation 2: Total count parity
  const accounted = passed + failed + skipped + cancelled + todo;
  if (tests !== accounted) {
    throw new Error(`TEST_COUNT_PARITY_MISMATCH: Reported total tests (${tests}) does not equal sum: passed(${passed}) + failed(${failed}) + skipped(${skipped}) + cancelled(${cancelled}) + todo(${todo}) = ${accounted}`);
  }

  // Validation 3: Check min expected suites/tests if configured
  if (opts.minExpectedSuites && suites < opts.minExpectedSuites) {
    throw new Error(`INCOMPLETE_SUITES: Expected at least ${opts.minExpectedSuites} suites, found ${suites}`);
  }
  if (opts.minExpectedTests && tests < opts.minExpectedTests) {
    throw new Error(`INCOMPLETE_TESTS: Expected at least ${opts.minExpectedTests} tests, found ${tests}`);
  }

  return {
    suites,
    tests,
    passed,
    failed,
    skipped,
    cancelled,
    todo,
    duration_ms,
    success: failed === 0 && cancelled === 0
  };
}

function generateSummary(engine, logPath, outDir, opts = {}) {
  let result;
  let parsedSuccess = false;

  try {
    if (!fs.existsSync(logPath)) {
      throw new Error(`LOG_FILE_NOT_FOUND: Log file not found at: ${logPath}`);
    }
    const logContent = fs.readFileSync(logPath, 'utf8');
    const parsed = parseTestOutput(logContent, opts);
    result = {
      engine,
      status: parsed.success ? 'PASS' : 'FAIL',
      timestamp: new Date().toISOString(),
      ...parsed
    };
    parsedSuccess = parsed.success;
  } catch (err) {
    result = {
      engine,
      status: 'FAIL',
      timestamp: new Date().toISOString(),
      suites: 0,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      error: err.message
    };
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'test-summary.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`[generate-test-summary] Written ${engine} summary to: ${outPath}`);
  }

  console.log(`[generate-test-summary] ${engine} Results:`, result);

  if (!parsedSuccess || result.status !== 'PASS') {
    if (opts.throwOnError) {
      throw new Error(result.error || `Tests failed with ${result.failed} failures`);
    }
    return { ...result, exitCode: 1 };
  }

  return { ...result, exitCode: 0 };
}

if (require.main === module) {
  const engine = process.argv[2] || 'Unknown Engine';
  const logPath = process.argv[3] || '/tmp/test-output.log';
  const outDir = process.argv[4] || null;
  const res = generateSummary(engine, logPath, outDir);
  if (res.exitCode !== 0) {
    console.error(`[generate-test-summary] FAIL-CLOSED: Test verification failed for ${engine}`);
    process.exit(1);
  }
}

module.exports = { parseTestOutput, generateSummary };
