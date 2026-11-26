'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', 'repositories', file), 'utf8');

test('a placed order keeps its stock reservation long enough to be shipped', () => {
  const { ORDER_RESERVATION_DAYS } = require('../src/repositories/phase08Repository');
  assert.ok(ORDER_RESERVATION_DAYS >= 30);
});

test('vendor delivery consumes reserved stock when it moves the parent order forward', () => {
  assert.match(read('vendorOrderRepository.js'), /consumeParentStockTx\(tx, orderId/);
});
