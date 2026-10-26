'use strict';
const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dbPath = path.join(__dirname, '..', 'data', `mrtumi.phase07.${process.pid}.db`);
process.env.NODE_ENV = 'test';
process.env.SQLITE_PATH = dbPath;
process.env.SEED_DEMO_DATA = 'true';
process.env.LOG_SILENT = 'true';
const { app } = require('../server');
let server;
let baseUrl;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {} }
});
test('Phase 07 account forms render localized views and authenticated account pages require a session', async () => {
  const register = await fetch(`${baseUrl}/customer/register`);
  assert.equal(register.status, 200);
  assert.match(await register.text(), /name="phone"/);
  const login = await fetch(`${baseUrl}/customer/login?lang=en`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Customer login/);
  const account = await fetch(`${baseUrl}/customer/account`, { redirect: 'manual' });
  assert.equal(account.status, 302);
  assert.match(account.headers.get('location'), /^\/customer\/login(?:\?_sid=[a-f0-9]+)?$/);
});
test('Phase 07 customer mutation routes reject requests without CSRF token before persistence', async () => {
  const response = await fetch(`${baseUrl}/customer/register`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'No CSRF', phone: '01712345678', password: 'secure-password-123' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 403);
});
