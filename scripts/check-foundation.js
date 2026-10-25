#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');

const ROOT = path.resolve(__dirname, '..');

const ALLOWED_STATUSES = new Set([
  'NOT STARTED',
  'IN PROGRESS',
  'IMPLEMENTED',
  'TESTED AND PASSED',
  'FAILED',
  'BLOCKED',
  'OWNER APPROVAL REQUIRED',
]);

let passed = 0;
let failed = 0;

function check(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  [FAIL] ${msg}`);
  }
}

function walkFiles(dir, extFilter) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extFilter));
    } else if (!extFilter || full.endsWith(extFilter)) {
      results.push(full);
    }
  }
  return results;
}

console.log('1. Checking JavaScript syntax across server, src, scripts, and tests...');
const jsFiles = [
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'app.js'),
  ...walkFiles(path.join(ROOT, 'src'), '.js'),
  ...walkFiles(path.join(ROOT, 'scripts'), '.js'),
  ...walkFiles(path.join(ROOT, 'tests'), '.js'),
];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    check(true, `Syntax OK: ${path.relative(ROOT, file)}`);
  } catch (err) {
    check(false, `Syntax error in ${path.relative(ROOT, file)}: ${err.stderr?.toString() || err.message}`);
  }
}

console.log('2. Compiling all EJS templates...');
const ejsFiles = walkFiles(path.join(ROOT, 'views'), '.ejs');
check(ejsFiles.length >= 40, `Expected >= 40 EJS templates, found ${ejsFiles.length}`);
for (const file of ejsFiles) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    ejs.compile(src, { filename: file });
    check(true, `EJS OK: ${path.relative(ROOT, file)}`);
  } catch (err) {
    check(false, `EJS compile error in ${path.relative(ROOT, file)}: ${err.message}`);
  }
}

console.log('3. Validating required governance & architecture documents...');
const requiredDocs = [
  '.env.example',
  '.gitignore',
  'README.md',
  'PROJECT_STATUS.md',
  'MASTER_CHECKLIST.md',
  'DECISIONS.md',
  'INTEGRATION_STATUS.md',
  'DEPLOYMENT.md',
  'docs/PHASE_01_REFERENCE_AUDIT.md',
  'docs/ARCHITECTURE.md',
  'docs/CPANEL_COMPATIBILITY.md',
];
for (const rel of requiredDocs) {
  const full = path.join(ROOT, rel);
  check(fs.existsSync(full) && fs.statSync(full).size > 100, `Required file present: ${rel}`);
}

const checklist = fs.readFileSync(path.join(ROOT, 'MASTER_CHECKLIST.md'), 'utf8');
const rows = checklist.split(/\r?\n/).filter((l) => /^\| P\d{2}-\d{2}\s*\|/.test(l));
check(rows.length >= 70, `MASTER_CHECKLIST.md tracks ${rows.length} items`);
for (const row of rows) {
  const cols = row.split('|').map((s) => s.trim());
  const st = (cols[3] || '').replace(/^`|`$/g, '');
  check(ALLOWED_STATUSES.has(st), `Valid status "${st}" for ${cols[1]}`);
}

console.log('4. Scanning repository files for secrets, hardcoded demo passwords, or forbidden artifacts...');
const forbiddenContentRegex =
  /(sk_live_[A-Za-z0-9]+|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z\-_]{35}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|BSMS-LIVE-|BDC-PRO-|SF-LIVE-KEY-|PTH-CLIENT-|REDX-TOKEN-|EAAGm0PX4ZCpsBA|admin123|vendor123|reseller123)/;

const filesToScan = [
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'app.js'),
  path.join(ROOT, '.env.example'),
  path.join(ROOT, 'README.md'),
  ...walkFiles(path.join(ROOT, 'src')),
  ...walkFiles(path.join(ROOT, 'views')),
  ...walkFiles(path.join(ROOT, 'docs')),
];
for (const file of filesToScan) {
  const rel = path.relative(ROOT, file);
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(forbiddenContentRegex);
  check(!match, `Secret/demo-password scan clean in ${rel}${match ? ` (matched "${match[0]}")` : ''}`);
}

try {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const rel of tracked) {
    const isForbiddenFile =
      rel === '.env' ||
      rel.endsWith('.db') ||
      rel.endsWith('.db-wal') ||
      rel.endsWith('.db-shm') ||
      rel.endsWith('.sqlite') ||
      rel.endsWith('.jks') ||
      rel.endsWith('.keystore') ||
      rel.endsWith('.pem');
    check(!isForbiddenFile, `Tracked file allowed: ${rel}`);
  }
} catch (_e) {
  // Ignore if git not initialized
}

console.log(`\nFoundation Check Summary: ${passed} checks passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
