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
  adaptStatementForEngine,
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

  // 3. Production applied alias for 0034 (5976ee0...) combined with the REAL release
  //    bytes on disk. Alias compatibility now requires both sides to be recognised,
  //    so a synthetic on-disk file paired with an aliased applied row is intentionally
  //    rejected - that pairing is exactly the asymmetric-OR vulnerability.
  const real0034Sql = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrations', '0034_platform_visitor_analytics.up.sql'),
    'utf8'
  );
  const real0034Pair = [{
    version: '0034',
    name: 'platform_visitor_analytics',
    upFile: '0034_platform_visitor_analytics.up.sql',
    upSql: real0034Sql,
    checksum: sha256Hex(real0034Sql),
  }];
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
  assert.doesNotThrow(() => verifyIntegrity(real0034Pair, appliedProd));

  // 4. The OLD (vulnerable) behaviour is now explicitly forbidden: synthetic disk
  //    bytes + aliased applied row must throw.
  assert.throws(
    () => verifyIntegrity(dummyPairs, appliedProd),
    (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH'
  );
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

test('adaptStatementForEngine: preserves MariaDB IF NOT EXISTS and adapts for MySQL 8.0', () => {
  const mariaUp = 'ALTER TABLE `vendors` ADD COLUMN IF NOT EXISTS `slug` VARCHAR(191) DEFAULT NULL, ADD UNIQUE KEY IF NOT EXISTS `uq_slug` (`slug`)';
  const mariaDown = 'ALTER TABLE `vendors` DROP INDEX IF EXISTS `uq_slug`, DROP COLUMN IF EXISTS `slug`';

  // 1. MariaDB mode leaves DDL completely unchanged
  assert.equal(adaptStatementForEngine(mariaUp, true), mariaUp);
  assert.equal(adaptStatementForEngine(mariaDown, true), mariaDown);

  // 2. MySQL mode adapts clauses that MySQL 8.0 rejects
  const expectedMysqlUp = 'ALTER TABLE `vendors` ADD COLUMN `slug` VARCHAR(191) DEFAULT NULL, ADD UNIQUE KEY `uq_slug` (`slug`)';
  const expectedMysqlDown = 'ALTER TABLE `vendors` DROP KEY `uq_slug`, DROP COLUMN `slug`';
  assert.equal(adaptStatementForEngine(mariaUp, false), expectedMysqlUp);
  assert.equal(adaptStatementForEngine(mariaDown, false), expectedMysqlDown);

  // 3. Non-ALTER TABLE statements (CREATE TABLE IF NOT EXISTS) remain untouched on both
  const createSql = 'CREATE TABLE IF NOT EXISTS `foo` (`id` INT PRIMARY KEY)';
  assert.equal(adaptStatementForEngine(createSql, true), createSql);
  assert.equal(adaptStatementForEngine(createSql, false), createSql);
});

test('SECURITY: alias compatibility requires BOTH sides to be recognised (asymmetric OR attack)', () => {
  const VERSION = '0033';
  const LEGIT_ALIAS = 'f2b4b93601fdad281829bc15a0e413f5aa5940e2a23e7750d14c0c54277edc04';
  const FRESH_ALIAS = '5fae1e8f79c6c3973a2936d5f9f20955dbe9603438b5f078be145bab7f4e72fe';
  const MALICIOUS_SQL = 'DROP TABLE orders;\n-- attacker supplied\n';
  const MALICIOUS_LF_SQL = 'DROP TABLE orders; -- attacker\n';

  const makePairs = (sql) => [
    {
      version: VERSION,
      name: 'dynamic_mfs_payment_gateways',
      upFile: '0033_dynamic_mfs_payment_gateways.up.sql',
      upSql: sql,
      checksum: sha256Hex(sql),
    },
  ];

  // Sanity: the malicious payload is NOT a historical alias.
  assert.equal(KNOWN_CHECKSUM_ALIASES[VERSION].has(sha256Hex(MALICIOUS_SQL)), false);

  // (a) THE ATTACK: legitimate applied alias + modified/malicious disk file must FAIL.
  assert.throws(
    () => verifyIntegrity(makePairs(MALICIOUS_SQL), new Map([
      [VERSION, { version: VERSION, name: 'x', checksum: LEGIT_ALIAS }],
    ])),
    (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH',
    'modified disk file must not pass by riding on a legitimate applied alias'
  );

  // (b) Same attack via the LF-normalised disk path.
  assert.throws(
    () => verifyIntegrity(makePairs(MALICIOUS_LF_SQL), new Map([
      [VERSION, { version: VERSION, name: 'x', checksum: LEGIT_ALIAS }],
    ])),
    (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH'
  );

  // (c) Mirror attack: recognised disk alias + fabricated applied row must FAIL.
  assert.throws(
    () => verifyIntegrity(makePairs('SELECT 1;\n'), new Map([
      [VERSION, { version: VERSION, name: 'x', checksum: 'b'.repeat(64) }],
    ])),
    (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH'
  );

  // (d) LEGITIMATE upgrade: BOTH sides are recognised aliases for this version -> allowed.
  const freshSql = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'db', 'migrations',
      '0033_dynamic_mfs_payment_gateways.up.sql'),
    'utf8'
  );
  assert.doesNotThrow(
    () => verifyIntegrity(makePairs(freshSql), new Map([
      [VERSION, { version: VERSION, name: 'x', checksum: FRESH_ALIAS }],
    ])),
    'production upgrade path must still be accepted'
  );
});

test('verifyIntegrity: exact and LF-normalised matches still pass independently of aliases', () => {
  const sql = 'ALTER TABLE visitor_events ADD COLUMN device_type VARCHAR(32);\n';
  const exact = sha256Hex(sql);
  const pairOf = (src) => [{
    version: '0034',
    name: 'platform_visitor_analytics',
    upFile: '0034_platform_visitor_analytics.up.sql',
    upSql: src,
    checksum: sha256Hex(src),
  }];

  // 1. exact
  assert.doesNotThrow(() => verifyIntegrity(pairOf(sql), new Map([
    ['0034', { version: '0034', name: 'x', checksum: exact }],
  ])));

  // 2. CRLF on disk vs LF applied -> LF-normalised match
  const crlf = sql.replace(/\n/g, '\r\n');
  assert.doesNotThrow(() => verifyIntegrity(pairOf(crlf), new Map([
    ['0034', { version: '0034', name: 'x', checksum: exact }],
  ])));

  // 3. A one-byte modification must still fail even though LF normalisation is applied
  const tampered = sql.replace('VARCHAR(32)', 'VARCHAR(64)');
  assert.throws(
    () => verifyIntegrity(pairOf(tampered), new Map([
      ['0034', { version: '0034', name: 'x', checksum: exact }],
    ])),
    (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH'
  );
});

test('verifyIntegrity: unknown, fabricated, modified and cross-version checksums fail closed', () => {
  const sql = 'SELECT 1;\n';
  const pair = [{
    version: '0033',
    name: 'dynamic_mfs_payment_gateways',
    upFile: '0033_dynamic_mfs_payment_gateways.up.sql',
    upSql: sql,
    checksum: sha256Hex(sql),
  }];
  const cases = {
    'fabricated': 'a'.repeat(64),
    'unknown': 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    // a real historical hash that belongs to 0030, not 0033
    'cross-version': '86941f4e456c3828620dee883810692f541958ab02c80b61bac6d0b6fe90d216',
  };
  for (const [label, checksum] of Object.entries(cases)) {
    assert.throws(
      () => verifyIntegrity(pair, new Map([['0033', { version: '0033', name: 'x', checksum }]])),
      (err) => err.code === 'MIGRATION_CHECKSUM_MISMATCH',
      `${label} checksum must fail closed`
    );
  }
});
