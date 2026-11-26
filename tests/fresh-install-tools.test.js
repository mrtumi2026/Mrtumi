'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('../src/config/env');
const { assertRehearsalProfile, assertProductionDenied } = require('../scripts/ops/fresh-rehearsal');
const { createFirstSuperAdmin } = require('../scripts/create-first-admin');

test('database config exposes the name the backup and deploy tooling reads', () => {
  assert.equal(typeof env.db.database, 'string');
  assert.equal(env.db.database, env.db.name);
});

test('rehearsal refuses any database, login or folder that is not the rehearsal one', () => {
  const good = { database: 'mrtumico_rehearsal', user: 'mrtumico_rehearsal_usr', root: '/home/x/mrtumi-rehearsal' };
  assert.doesNotThrow(() => assertRehearsalProfile(good));
  assert.throws(() => assertRehearsalProfile({ ...good, database: 'mrtumico_Mrtumi' }), /REFUSED/);
  assert.throws(() => assertRehearsalProfile({ ...good, user: 'mrtumico_mrtumico' }), /REFUSED/);
  assert.throws(() => assertRehearsalProfile({ ...good, root: '/home/x/mrtumi' }), /REFUSED/);
});

test('rehearsal continues only when production access is denied by the server', async () => {
  const failing = (errno) => ({ query: async () => { throw Object.assign(new Error('x'), { errno }); } });
  await assert.doesNotReject(assertProductionDenied(failing(1142)));
  await assert.rejects(assertProductionDenied(failing(1146)), /REFUSED/);
  await assert.rejects(assertProductionDenied({ query: async () => [[]] }), /REFUSED/);
});

test('first Super Admin rejects weak or malformed input before touching the database', async () => {
  await assert.rejects(createFirstSuperAdmin({ name: 'A', email: 'a@b.co', password: 'short' }), /at least 12/);
  await assert.rejects(createFirstSuperAdmin({ name: 'A', email: 'bad', password: 'long-enough-password' }), /Email/);
});
