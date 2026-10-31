'use strict';

process.env.LOG_SILENT = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repositories/adminPartnerDirectoryRepository');

function fixture() {
  const calls=[];
  return { calls, async query(sql,params=[]) { calls.push({sql,params}); return [[],[]]; } };
}

test('vendor directory reads are platform-wide, ordered, minimized and optionally filter to pending verification',async()=>{
  const pool=fixture();
  await repo.listVendors({}, {pool});
  await repo.listVendors({pendingOnly:true},{pool});
  assert.match(pool.calls[0].sql,/FROM vendors\s+ORDER BY id DESC/);
  assert.match(pool.calls[0].sql,/commission_rate_bps\/100 AS commission_rate/);
  assert.match(pool.calls[0].sql,/balance_paisa\/100 AS balance/);
  assert.doesNotMatch(pool.calls[0].sql,/password_hash|email|address|status/);
  assert.match(pool.calls[1].sql,/FROM vendors WHERE verified=\? ORDER BY id DESC/);
  assert.deepEqual(pool.calls.map(call=>call.params),[[],[0]]);
});

test('reseller directory reads are platform-wide, ordered, minimized and optionally filter to pending verification',async()=>{
  const pool=fixture();
  await repo.listResellers({}, {pool});
  await repo.listResellers({pendingOnly:true},{pool});
  assert.match(pool.calls[0].sql,/FROM resellers\s+ORDER BY id DESC/);
  assert.match(pool.calls[0].sql,/balance_paisa\/100 AS balance/);
  assert.doesNotMatch(pool.calls[0].sql,/password_hash|email|status/);
  assert.match(pool.calls[1].sql,/FROM resellers WHERE verified=\? ORDER BY id DESC/);
  assert.deepEqual(pool.calls.map(call=>call.params),[[],[0]]);
});

test('partner directory filter rejects unknown truthy/falsey values before database access',async()=>{
  const pool=fixture();
  await assert.rejects(repo.listVendors({pendingOnly:'yes'},{pool}),{code:'VALIDATION_ERROR'});
  await assert.rejects(repo.listResellers({pendingOnly:0},{pool}),{code:'VALIDATION_ERROR'});
  assert.equal(pool.calls.length,0);
});
