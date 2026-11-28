'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { stripDefinerFromLine, createDefinerFilter } = require('../scripts/ops/recovery-protocol');

test('rehearsal restore removes DEFINER from triggers, views, routines and events', () => {
  for (const line of [
    '/*!50003 CREATE*/ /*!50017 DEFINER=`prod_user`@`localhost`*/ /*!50003 TRIGGER `t` BEFORE UPDATE ON `a` FOR EACH ROW',
    '/*!50013 DEFINER=`prod_user`@`127.0.0.1` SQL SECURITY DEFINER */',
    '/*!50106 CREATE*/ /*!50117 DEFINER=`prod_user`@`localhost`*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY',
    'CREATE DEFINER=`prod_user`@`localhost` PROCEDURE `p`()'
  ]) {
    assert.doesNotMatch(stripDefinerFromLine(line), /DEFINER=/, line);
  }
});

test('table data is passed through byte for byte, even when split across chunks', async () => {
  const input = Buffer.concat([
    Buffer.from("INSERT INTO `pages` VALUES ('বাংলা DEFINER=`a`@`b`');\n", 'utf8'),
    Buffer.from([0x00, 0xff, 0xfe, 0x0a]),
    Buffer.from('-- Dump completed', 'utf8')
  ]);
  const chunks = [];
  for (let i = 0; i < input.length; i += 7) chunks.push(input.subarray(i, i + 7));
  const output = [];
  for await (const part of Readable.from(chunks).pipe(createDefinerFilter())) output.push(part);
  assert.deepEqual(Buffer.concat(output), input);
});

test('deploy.sh reads the dump path from the field the backup manifest really writes', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'deploy.sh'), 'utf8');
  assert.match(script, /const dumpFile = manifest\.dump\.canonical_path;/);
  assert.doesNotMatch(script, /manifest\.artifacts/);
});
