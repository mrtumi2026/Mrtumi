'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
const up = fs.readFileSync(path.join(migrationDir, '0025_food_chopper_bengali_content.up.sql'), 'utf8');
const down = fs.readFileSync(path.join(migrationDir, '0025_food_chopper_bengali_content.down.sql'), 'utf8');

test('food chopper Bengali content migration is paired and targets product ID or stable slug', () => {
  assert.match(up, /UPDATE `products`/);
  assert.match(up, /`short_desc_bn` = 'সহজেই রসুন, আদা, পেঁয়াজ/);
  assert.match(up, /`description_bn` = 'ফুড গ্রেড ৩০৪\/৪৫° স্টেইনলেস স্টিল ব্লেড:/);
  assert.match(up, /WHERE `id` = 1 OR `slug` = 'food-chopper'/);
  assert.match(down, /SET `description_bn` = NULL, `short_desc_bn` = NULL/);
  assert.match(down, /WHERE `id` = 1 OR `slug` = 'food-chopper'/);
});
