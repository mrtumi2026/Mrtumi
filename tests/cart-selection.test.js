'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const selection = require('../src/utils/cartSelection');

const cart = [
  { key: 'a', product_id: 1, variant_id: null },
  { key: 'b', product_id: 2, variant_id: 7 },
  { key: 'c', product_id: 2, variant_id: 8 },
];
const keys = (lines) => lines.map((line) => line.key);

test('every cart line is ordered until the customer un-ticks it', () => {
  const session = { cart };
  assert.deepEqual(keys(selection.selectedLines(session)), ['a', 'b', 'c']);
  selection.setSelected(session, [cart[1]], false);
  assert.deepEqual(keys(selection.selectedLines(session)), ['a', 'c']);
  assert.deepEqual(keys(selection.savedLines(session)), ['b']);
  selection.setSelected(session, [cart[1]], true);
  assert.deepEqual(keys(selection.savedLines(session)), []);
});

test('selection survives the new line keys used by a signed-in saved cart', () => {
  const session = { cart };
  selection.setSelected(session, [cart[1]], false);
  const reloaded = cart.map((line) => ({ ...line, key: `saved-${line.product_id}-${line.variant_id || 0}` }));
  assert.deepEqual(keys(selection.savedLines(session, reloaded)), ['saved-2-7']);
});
