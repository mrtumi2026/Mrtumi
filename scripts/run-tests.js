'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const testFiles = fs.readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('tests', f));

const result = cp.spawnSync(
  process.execPath,
  ['--no-warnings', '--test', '--test-concurrency=1', ...testFiles],
  {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
  }
);

process.exit(result.status !== null ? result.status : 1);
