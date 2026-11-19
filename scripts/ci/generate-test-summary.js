'use strict';

const fs = require('fs');
const path = require('path');

function generateSummary(engine, logPath, outDir) {
  if (!fs.existsSync(logPath)) {
    console.error(`[generate-test-summary] Log file not found at: ${logPath}`);
    const fallback = {
      engine,
      timestamp: new Date().toISOString(),
      suites: 0,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      error: 'Log file not found'
    };
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'test-summary.json'), JSON.stringify(fallback, null, 2));
    }
    return fallback;
  }

  const log = fs.readFileSync(logPath, 'utf8');

  // Match TAP / Node test runner output (supports '# pass 594' and 'ℹ pass 594')
  const passMatch = log.match(/[#ℹ]\s*pass\s+(\d+)/i);
  const failMatch = log.match(/[#ℹ]\s*fail\s+(\d+)/i);
  const skipMatch = log.match(/[#ℹ]\s*skipped?\s+(\d+)/i);
  const testsMatch = log.match(/[#ℹ]\s*tests\s+(\d+)/i);
  const suitesMatch = log.match(/[#ℹ]\s*suites\s+(\d+)/i);
  const durationMatch = log.match(/[#ℹ]\s*duration_ms\s+([\d.]+)/i);

  const summary = {
    engine,
    timestamp: new Date().toISOString(),
    suites: suitesMatch ? Number(suitesMatch[1]) : 0,
    tests: testsMatch ? Number(testsMatch[1]) : 0,
    passed: passMatch ? Number(passMatch[1]) : 0,
    failed: failMatch ? Number(failMatch[1]) : 0,
    skipped: skipMatch ? Number(skipMatch[1]) : 0,
    duration_ms: durationMatch ? Number(durationMatch[1]) : null
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'test-summary.json');
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`[generate-test-summary] Written ${engine} summary to: ${outPath}`);
  }

  console.log(`[generate-test-summary] ${engine} Results:`, summary);
  return summary;
}

if (require.main === module) {
  const engine = process.argv[2] || 'Unknown Engine';
  const logPath = process.argv[3] || '/tmp/test-output.log';
  const outDir = process.argv[4] || null;
  generateSummary(engine, logPath, outDir);
}

module.exports = { generateSummary };
