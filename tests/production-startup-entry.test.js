'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGet(baseUrl, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${urlPath}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

async function waitForHttp(baseUrl, urlPath, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Startup process exited early (${child.exitCode}).`);
    try {
      return await httpGet(baseUrl, urlPath);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('Timed out waiting for startup path.');
}

test('Production Startup Reconciliation: package.json main, server.js and app.js exports', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'app.js', 'package.json main must point to app.js');
  assert.match(pkg.scripts.start, /app\.js/, 'npm start must invoke app.js');

  const appEntry = require('../app');
  assert.equal(typeof appEntry, 'function', 'app.js must export the Express application for Phusion Passenger');

  const serverEntry = require('../server');
  assert.equal(typeof serverEntry, 'function', 'server.js must export the Express application as primary export');
  assert.equal(typeof serverEntry.app, 'function', 'server.js must expose app named export');
  assert.equal(typeof serverEntry.startServer, 'function', 'server.js must expose startServer named export');
});

test('Production Startup Guards: direct startup fails closed across environments', () => {
  const root = path.join(__dirname, '..');

  // 1. server.js in development refuses startup
  const devServer = spawnSync(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' }
  });
  assert.notEqual(devServer.status, 0);
  assert.match(devServer.stderr, /direct server\.js startup refuses development defaults/);

  // 2. server.js in test without flag refuses startup
  const testServer = spawnSync(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', APP_ALLOW_TEST_STARTUP: '' }
  });
  assert.notEqual(testServer.status, 0);
  assert.match(testServer.stderr, /NODE_ENV=test cannot start server\.js without the explicit test-only APP_ALLOW_TEST_STARTUP=true flag/);

  // 3. app.js in development refuses startup
  const devApp = spawnSync(process.execPath, ['--no-warnings', 'app.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' }
  });
  assert.notEqual(devApp.status, 0);
  assert.match(devApp.stderr, /app\.js requires NODE_ENV=production/);

  // 4. app.js in test without flag refuses startup
  const testApp = spawnSync(process.execPath, ['--no-warnings', 'app.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', APP_ALLOW_TEST_STARTUP: '' }
  });
  assert.notEqual(testApp.status, 0);
  assert.match(testApp.stderr, /NODE_ENV=test cannot start app\.js without the explicit test-only APP_ALLOW_TEST_STARTUP=true flag/);
});

test('Production Startup Execution: authorized test startup boots on assigned port', async () => {
  const root = path.join(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrtumi-boot-check-'));
  const port = await reserveTcpPort();

  const child = spawn(process.execPath, ['--no-warnings', 'app.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_ALLOW_TEST_STARTUP: 'true',
      DB_CLIENT: 'sqlite',
      SQLITE_PATH: path.join(tempDir, 'boot-test.db'),
      UPLOAD_DIR: tempDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      SEED_DEMO_DATA: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let childOutput = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { childOutput += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { childOutput += d; });

  const childBaseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHttp(childBaseUrl, '/health', child);
    assert.equal(health.statusCode, 200, `Health check failed. Output: ${childOutput} Stderr: ${child.stderr}`);
    const parsed = JSON.parse(health.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.status, 'ok');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) {}
  }
});

test('Phusion Passenger Detection: app.js detects PhusionPassenger global and enforces startup guards', () => {
  const root = path.join(__dirname, '..');

  // Passenger present in test mode without explicit flag must fail-closed
  const passengerGuarded = spawnSync(process.execPath, [
    '-e',
    'global.PhusionPassenger = {}; require("./app.js");'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', APP_ALLOW_TEST_STARTUP: '' }
  });
  assert.notEqual(passengerGuarded.status, 0);
  assert.match(passengerGuarded.stderr, /NODE_ENV=test cannot start app\.js without the explicit test-only APP_ALLOW_TEST_STARTUP=true flag/);
});
