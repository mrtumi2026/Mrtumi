'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  KNOWN_CHECKSUM_ALIASES,
  verifyIntegrity,
  loadMigrationPairs,
  sha256Hex,
  MigrationError,
} = require('../src/db/migrator');

test('Migration Checksums: KNOWN_CHECKSUM_ALIASES contains verified production LF and CRLF hashes', () => {
  // Production cPanel applied checksum for 0034 from commit 4d62d86 (Linux LF)
  const PROD_0034_LF = '5976ee07d7368e7d50b8ddd60c12ea7084eb5321ac505324d1ce699f7000fd17';
  const PROD_0034_CRLF = 'b319440aa224aa8a5202f6c24d4ebe8fdea1ac51e129dcd02ae8abd0e61bedaa';
  assert.ok(
    KNOWN_CHECKSUM_ALIASES['0034'].has(PROD_0034_LF),
    '0034 aliases must contain original production LF checksum 5976ee0...'
  );
  assert.ok(
    KNOWN_CHECKSUM_ALIASES['0034'].has(PROD_0034_CRLF),
    '0034 aliases must contain original CRLF checksum b319440...'
  );

  // Original 0035 hashes from commit 2f2a84b
  const ORIG_0035_LF = 'dc39e04a0f45ff73be5837c60021caa1a0cd6551aeec802b906dec77afde891b';
  const ORIG_0035_CRLF = '5005ec8784babd7df4f3177226e309ead91165edaa0243ee78a2665469b6ecc1';
  assert.ok(
    KNOWN_CHECKSUM_ALIASES['0035'].has(ORIG_0035_LF),
    '0035 aliases must contain original LF checksum'
  );
  assert.ok(
    KNOWN_CHECKSUM_ALIASES['0035'].has(ORIG_0035_CRLF),
    '0035 aliases must contain original CRLF checksum'
  );

  // Original 0036 hashes from commit 56bc9c1
  const ORIG_0036_LF = '926a80da8e96da19ba0daad6a9bdf3a0adffa35d920a35d81b0f52197af79977';
  const ORIG_0036_CRLF = '533e048096b0f4ca85831c34f65fab4463c79c6e7f246f758d26fa87cf0d8170';
  assert.ok(
    KNOWN_CHECKSUM_ALIASES['0036'].has(ORIG_0036_LF),
    '0036 aliases must contain original LF checksum'
  );
  assert.ok(
    KNOWN_CHECKSUM_ALIASES['0036'].has(ORIG_0036_CRLF),
    '0036 aliases must contain original CRLF checksum'
  );

  // Historical 0030, 0032, 0033 hashes
  assert.ok(KNOWN_CHECKSUM_ALIASES['0030'].has('7ceb4304a6d11636410d1aa505feb58de60c4f507fb331bc3927f1d8cd03c0bc'));
  assert.ok(KNOWN_CHECKSUM_ALIASES['0032'].has('d590045213ae8d0f282a6c4b7434a43c9b8d69ddf29293abd06a6e07c44425a4'));
  assert.ok(KNOWN_CHECKSUM_ALIASES['0033'].has('f2b4b93601fdad281829bc15a0e413f5aa5940e2a23e7750d14c0c54277edc04'));
});

test('verifyIntegrity: accepts exact match, LF/CRLF variation, and legitimate aliases', () => {
  const dummyPairs = [
    {
      version: '0034',
      name: 'platform_visitor_analytics',
      upFile: '0034_platform_visitor_analytics.up.sql',
      upSql: 'ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\n',
      checksum: sha256Hex('ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\n'),
    },
  ];

  // 1. Exact match
  const appliedExact = new Map([
    [
      '0034',
      {
        version: '0034',
        name: 'platform_visitor_analytics',
        checksum: dummyPairs[0].checksum,
      },
    ],
  ]);
  assert.doesNotThrow(() => verifyIntegrity(dummyPairs, appliedExact));

  // 2. LF vs CRLF line ending difference (disk has CRLF, applied DB has LF)
  const crlfPairs = [
    {
      version: '0034',
      name: 'platform_visitor_analytics',
      upFile: '0034_platform_visitor_analytics.up.sql',
      upSql: 'ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\r\n',
      checksum: sha256Hex('ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\r\n'),
    },
  ];
  const appliedLf = new Map([
    [
      '0034',
      {
        version: '0034',
        name: 'platform_visitor_analytics',
        checksum: sha256Hex('ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\n'),
      },
    ],
  ]);
  assert.doesNotThrow(() => verifyIntegrity(crlfPairs, appliedLf));

  // 3. Production applied checksum from KNOWN_CHECKSUM_ALIASES (5976ee0...)
  const appliedProd = new Map([
    [
      '0034',
      {
        version: '0034',
        name: 'platform_visitor_analytics',
        checksum: '5976ee07d7368e7d50b8ddd60c12ea7084eb5321ac505324d1ce699f7000fd17',
      },
    ],
  ]);
  assert.doesNotThrow(() => verifyIntegrity(dummyPairs, appliedProd));
});

test('verifyIntegrity: strictly rejects unauthorized or altered checksums', () => {
  const dummyPairs = [
    {
      version: '0034',
      name: 'platform_visitor_analytics',
      upFile: '0034_platform_visitor_analytics.up.sql',
      upSql: 'ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\n',
      checksum: sha256Hex('ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\n'),
    },
  ];

  const fakeApplied = new Map([
    [
      '0034',
      {
        version: '0034',
        name: 'platform_visitor_analytics',
        checksum: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    ],
  ]);

  assert.throws(
    () => verifyIntegrity(dummyPairs, fakeApplied),
    (err) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'MIGRATION_CHECKSUM_MISMATCH');
      return true;
    }
  );
});

test('All disk migration pairs from 0001 to 0036 load and have valid paired down migrations', () => {
  const pairs = loadMigrationPairs();
  assert.ok(pairs.length >= 36, `Expected at least 36 migrations, got ${pairs.length}`);

  const v34 = pairs.find((p) => p.version === '0034');
  const v35 = pairs.find((p) => p.version === '0035');
  const v36 = pairs.find((p) => p.version === '0036');

  assert.ok(v34, '0034 must exist on disk');
  assert.ok(v35, '0035 must exist on disk');
  assert.ok(v36, '0036 must exist on disk');

  // Verify non-empty down migrations
  assert.ok(v34.downSql.trim().length > 0, '0034 down migration must not be empty');
  assert.ok(v35.downSql.trim().length > 0, '0035 down migration must not be empty');
  assert.ok(v36.downSql.trim().length > 0, '0036 down migration must not be empty');
});
